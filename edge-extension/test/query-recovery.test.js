import test from "node:test";
import assert from "node:assert/strict";
import { CycleController } from "../cycle.js";
import { CycleError, bounded } from "../errors.js";
import { createSchoolApi } from "../api-client.js";
import { createHistory } from "../history.js";
import { memoryStorage } from "./storage-fixture.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

for (const phase of ["on", "off"]) test(`v2 ${phase}: timeout then HTTP 502 then recovery after minutes preserves one switch`, async () => {
  const h = harness({ modern: true }), before = await h.startRecovery(phase), posts = h.posts.length;
  const q = structuredClone(h.run.queryRecovery), original = h.api.readTimer;
  assert.equal(q.policyVersion, 2); assert.equal(q.deadline, before.nextAt + 300000);
  assert.deepEqual(q.attemptTimes, [30,60,120,180,240].map(s => q.startedAt + s * 1000));
  h.api.readTimer = async (_tab, signal) => {
    const e = new CycleError("E_HTTP", "simulated"); e.requestSequence = 7;
    signal.diagnostic.requests.push({ sequence: 7, method: "GET", path: "/app/prepaid/ac-timer", errorCode: "E_HTTP", httpStatus: 502 }); throw e;
  };
  for (const index of [0,1,2]) { h.at(q.attemptTimes[index]); await h.controller.recoveryExpired(before.id, h.run.recovery.nextAttemptAt); assert.equal(h.reports.length, 1); }
  h.api.readTimer = original; h.at(q.attemptTimes[3]);
  await Promise.all([h.controller.recoveryExpired(before.id, h.run.recovery.nextAttemptAt), h.controller.recoveryExpired(before.id, h.run.recovery.nextAttemptAt)]);
  assert.equal(h.posts.length, posts + 1); assert.equal(h.run.id, before.id); assert.equal(h.run.phaseStartedAt, h.now());
  assert.equal(h.run.phase, phase === "on" ? "off" : "on"); assert.equal(h.reports.length, 2);
  assert.equal(h.reports[1].queryRecovery.rounds.length, 5); assert.equal(h.reports[1].queryRecovery.outcome, "recovered");
  assert.equal(h.reports[1].queryRecovery.initialFailure.errorCode, "E_API_TIMEOUT");
});
test("v2 exhausts all five delayed rounds without extending the deadline or reporting each retry", async () => {
  const h = harness({ modern: true }), before = await h.startRecovery(); const q = structuredClone(h.run.queryRecovery);
  h.api.readStatus = async () => { throw new CycleError("E_API_TIMEOUT", "simulated"); };
  for (const at of q.attemptTimes) { h.at(at); await h.controller.recoveryExpired(before.id, h.run.recovery.nextAttemptAt); }
  assert.equal(h.run, null); assert.equal(h.posts.length, 0); assert.equal(h.reports.length, 2);
  assert.equal(h.reports[1].queryRecovery.rounds.length, 6); assert.equal(h.reports[1].queryRecovery.deadline, q.deadline);
});
for (const lateness of [60001, 300000]) test(`v2 cannot enter recovery after first fault at +${lateness}`, async () => {
  const h = harness({ modern: true }); await h.startRecovery("on", lateness);
  assert.equal(h.run, null); assert.equal(h.posts.length, 0);
});
test("v2 late alarm consumes one due slot and skips earlier slots", async () => {
  const h = harness({ modern: true }), before = await h.startRecovery(), q = h.run.queryRecovery;
  h.at(q.attemptTimes[3]); await h.controller.recoveryExpired(before.id, q.nextAttemptAt);
  assert.equal(h.posts.length, 1); assert.deepEqual(h.reports.at(-1).queryRecovery.skippedAttempts, [0,1,2]);
  assert.equal(h.reports.at(-1).queryRecovery.rounds.length, 2);
});
test("v2 cold worker retires a claimed unfinished round and waits for a future slot", async () => {
  const h = harness({ modern: true }), before = await h.startRecovery();
  const run = structuredClone(h.run); run.queryRecovery.nextSlot = 1;
  run.queryRecovery.rounds.push({ operationId: "lost-worker", startedAt: run.queryRecovery.nextAttemptAt, scheduledAt: run.queryRecovery.nextAttemptAt, endedAt: null });
  await h.store.setRun(run); await h.history.save(run); h.at(run.queryRecovery.nextAttemptAt + 1000);
  const cold = h.make(); await cold.reconcile();
  assert.equal(h.run.queryRecovery.rounds.at(-1).outcome, "interrupted"); assert.equal(h.run.queryRecovery.nextAttemptAt, run.queryRecovery.attemptTimes[1]);
  assert.equal(h.posts.length, 0);
  h.at(h.run.recovery.nextAttemptAt); await cold.recoveryExpired(before.id, h.run.recovery.nextAttemptAt); assert.equal(h.posts.length, 1);
});
test("a recovery alarm can wake a cold worker without first replaying reconciliation", async () => {
  const h = harness({ modern: true }), before = await h.startRecovery();
  const run = structuredClone(h.run); run.queryRecovery.nextSlot = 1;
  run.queryRecovery.rounds.push({ operationId: "lost-round", startedAt: run.queryRecovery.nextAttemptAt, endedAt: null });
  await h.store.setRun(run); await h.history.save(run); h.at(run.queryRecovery.nextAttemptAt + 1);
  await h.make().recoveryExpired(before.id, run.queryRecovery.nextAttemptAt);
  assert.equal(h.posts.length, 0); assert.equal(h.run.queryRecovery.rounds.at(-1).outcome, "interrupted");
  assert.equal(h.run.recovery.nextAttemptAt, run.queryRecovery.attemptTimes[1]);
});
for (const code of ["E_AUTH", "E_STATUS_FORMAT", "E_API_REJECTED", "E_NETWORK"]) test(`v2 ${code} stops immediately`, async () => {
  const h = harness({ modern: true }), before = await h.startRecovery(); h.at(h.run.recovery.nextAttemptAt);
  h.api.readTimer = async () => { throw new CycleError(code, "simulated"); };
  await h.controller.recoveryExpired(before.id); assert.equal(h.run, null); assert.equal(h.posts.length, 0);
});
test("native browser control cancels waiting recovery and an old document cannot cancel it", async () => {
  const h = harness({ modern: true }), before = await h.startRecovery();
  await h.controller.externalControl(8, "old-document"); assert.ok(h.run);
  await h.controller.externalControl(8, "doc-1"); assert.equal(h.run, null);
  assert.equal(h.reports.at(-1).queryRecovery.stopReason, "page-control"); assert.equal(h.posts.length, 0);
  await h.controller.recoveryExpired(before.id); assert.equal(h.posts.length, 0);
});
test("native control invalidates a queued recovery before it can issue requests", async () => {
  const h = harness({ modern: true }), before = await h.startRecovery(); h.at(h.run.recovery.nextAttemptAt);
  let release; const blocked = h.controller.enqueue(() => new Promise(resolve => { release = resolve; })); await flush();
  const retry = h.controller.recoveryExpired(before.id).catch(e => e); await flush();
  const external = h.controller.externalControl(8, "doc-1"); release(); await blocked; await retry; await external;
  assert.equal(h.posts.length, 0); assert.equal(h.run, null);
});
for (const offset of [299999, 300000, 300001]) test(`v2 absolute deadline at +${offset}`, async () => {
  const h = harness({ modern: true }), before = await h.startRecovery();
  h.at(before.nextAt + offset); await h.controller.recoveryExpired(before.id, h.run.recovery.nextAttemptAt);
  assert.equal(h.posts.length, offset < 300000 ? 1 : 0);
});
test("v2 unknown POST never schedules another recovery round", async () => {
  const h = harness({ modern: true }), before = await h.startRecovery(); h.at(h.run.recovery.nextAttemptAt);
  h.api.setStatus = async (_tab, _desired, signal) => { signal.diagnostic.command.sent = true; h.posts.push(false); throw new CycleError("E_API_TIMEOUT", "unknown"); };
  await h.controller.recoveryExpired(before.id); assert.equal(h.posts.length, 1); assert.equal(h.run, null);
  await h.controller.recoveryExpired(before.id); assert.equal(h.posts.length, 1);
});
function harness({ modern = false } = {}) {
  let now = 1_000_000, actual = true, run = null, notice = null, count = 0;
  const local = {}, posts = [], reads = [], reports = [], alarms = new Map(), recovery = new Map(), keepalive = new Map();
  const area = memoryStorage(local), history = createHistory(area);
  const store = { getRun: async () => structuredClone(run), setRun: async value => { run = structuredClone(value); }, clearRun: async () => { run = null; },
    getState: async () => ({ run, notice }), setNotice: async value => { notice = value; }, clearNotice: async () => {},
    setKeepAliveNotice: async () => {}, clearKeepAliveNotice: async () => {} };
  const adapter = map => ({ get: async id => map.get(id), create: async (id, when) => map.set(id, { scheduledTime: when }), clear: async id => map.delete(id) });
  const api = { readTimer: async () => { reads.push("timer"); return null; }, readStatus: async () => { reads.push("status"); return actual; },
    setStatus: async (_tab, desired, signal) => { assert.ok(local.cycleCheckpoint.command.sent); signal.diagnostic.command.sent = true; posts.push(desired); actual = desired; } };
  const make = () => { const controller = new CycleController({ store, history, api, page: { isOpen: async () => true },
    alarm: adapter(alarms), recoveryAlarm: adapter(recovery), keepAliveAlarm: adapter(keepalive), clock: () => now, id: () => `run-${++count}`,
    report: draft => { reports.push(globalThis.AirconReportFormat.makeReport(draft)); return draft.reportId; } });
    controller.queryRecoveryPolicyVersion = modern ? 2 : 1; return controller; };
  const controller = make();
  const startRecovery = async (phase = "on", delay = 16000) => {
    await controller.start(8, 1, 10, { documentId: "doc-1" });
    if (phase === "off") { now = run.nextAt; await controller.tick(run.id); }
    now = run.nextAt;
    const before = structuredClone(run), original = api.readStatus;
    api.readStatus = async () => { now += delay; throw new CycleError("E_API_TIMEOUT", "simulated"); };
    await controller.tick(run.id, run.nextAt);
    api.readStatus = original;
    return before;
  };
  return { controller, make, startRecovery, api, store, area, local, history, posts, reads, reports, alarms, recovery, keepalive,
    get run() { return run; }, get notice() { return notice; }, now: () => now, at: value => { now = value; }, set actual(value) { actual = value; } };
}

for (const phase of ["on", "off"]) test(`${phase}: timeout waits, fully rechecks and switches once within original deadline`, async () => {
  const h = harness(), before = await h.startRecovery(phase), waiting = structuredClone(h.run), count = h.posts.length;
  assert.equal(waiting.recovery.nextAttemptAt, before.nextAt + 46000);
  assert.equal(waiting.recovery.deadline, before.nextAt + 60000);
  for (const key of ["id", "phaseStartedAt", "nextAt", "timingRevision", "startedAt", "onMinutes", "offMinutes"]) assert.equal(waiting[key], before[key]);
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].queryRecovery.outcome, "waiting");
  const cadence = structuredClone(h.keepalive.get(before.id));
  h.reads.length = 0;
  await h.controller.tick(before.id, before.nextAt);
  await h.controller.recoveryExpired(before.id, waiting.recovery.nextAttemptAt);
  assert.equal(h.reads.length, 0); assert.equal(h.posts.length, count);
  h.at(waiting.recovery.nextAttemptAt);
  await Promise.all([h.controller.recoveryExpired(before.id, waiting.recovery.nextAttemptAt), h.controller.recoveryExpired(before.id, waiting.recovery.nextAttemptAt)]);
  assert.deepEqual(h.reads, ["timer", "status", "status"]);
  assert.equal(h.posts.length, count + 1); assert.equal(h.run.recovery, null);
  assert.equal(h.run.phaseStartedAt, h.now()); assert.equal(h.run.timingRevision, before.timingRevision + 1);
  assert.deepEqual(h.keepalive.get(before.id), cadence); assert.equal(h.recovery.size, 0);
  assert.equal(h.reports.length, 2); assert.equal(h.reports[1].source, "queryRecovery");
  assert.equal(h.reports[1].queryRecovery.id, h.reports[0].reportId);
  assert.equal(h.reports[1].recovered, true); assert.equal(h.reports[1].queryRecovery.rounds.length, 2);
  assert.equal(h.reports[1].queryRecovery.rounds[1].sent, true); assert.equal(h.reports[1].queryRecovery.rounds[1].confirmed, true);
});

for (const failure of ["timeout", "auth", "timer", "status", "http", "unknown-post"]) test(`recovery ${failure} stops with one associated result and no repeated command`, async () => {
  const h = harness(), before = await h.startRecovery();
  h.at(h.run.recovery.nextAttemptAt);
  if (failure === "timer") h.api.readTimer = async () => "10:00";
  else if (failure === "status") h.actual = false;
  else if (failure === "unknown-post") h.api.setStatus = async (_tab, desired, signal) => { signal.diagnostic.command.sent = true; h.posts.push(desired); throw new CycleError("E_API_TIMEOUT", "unknown"); };
  else h.api.readStatus = async () => { throw new CycleError({ timeout: "E_API_TIMEOUT", auth: "E_AUTH", http: "E_HTTP" }[failure], "failed"); };
  await h.controller.recoveryExpired(before.id);
  assert.equal(h.run, null); assert.equal(h.reports.length, 2);
  assert.equal(h.reports[1].queryRecovery.outcome, "stopped");
  assert.equal(h.reports[1].queryRecovery.id, h.reports[0].reportId);
  assert.equal(h.posts.length, failure === "unknown-post" ? 1 : 0);
  assert.equal(h.reports[1].outcomeUnknown, failure === "unknown-post");
  await h.controller.recoveryExpired(before.id); assert.equal(h.reports.length, 2);
});

for (const lateness of [60000, 60001, 120000]) test(`recovery delivered at +${lateness}ms never queries or dispatches`, async () => {
  const h = harness(), before = await h.startRecovery(); h.reads.length = 0; h.at(before.nextAt + lateness);
  await h.controller.recoveryExpired(before.id);
  assert.equal(h.run, null); assert.equal(h.reads.length, 0); assert.equal(h.posts.length, 0);
  assert.equal(h.reports.at(-1).error.code, "E_QUERY_RECOVERY_TIMEOUT");
});

test("remaining recovery deadline cancels an active read and ignores its late reply", async () => {
  const h = harness(), before = await h.startRecovery(); h.at(before.nextAt + 59980);
  let finish, requestSignal;
  h.api.readStatus = async (_tab, signal) => { requestSignal = signal; return bounded(() => new Promise(resolve => { finish = resolve; }), { signal, ms: 5000 }); };
  await h.controller.recoveryExpired(before.id);
  assert.equal(requestSignal.aborted, true); assert.equal(h.run, null); assert.equal(h.posts.length, 0);
  assert.equal(h.reports.at(-1).error.code, "E_QUERY_RECOVERY_TIMEOUT");
  finish(true); await flush(); assert.equal(h.run, null); assert.equal(h.posts.length, 0);
});

for (const when of ["waiting", "reading"]) test(`stop during ${when} cancels recovery permanently and records cancellation`, async () => {
  const h = harness(), before = await h.startRecovery(); let finish, task;
  if (when === "reading") {
    h.at(h.run.recovery.nextAttemptAt);
    h.api.readStatus = async (_tab, signal) => bounded(() => new Promise(resolve => { finish = resolve; }), { signal, ms: 5000 });
    task = h.controller.recoveryExpired(before.id); await flush();
  }
  await h.controller.stop(8); await task;
  if (finish) finish(true);
  await h.controller.recoveryExpired(before.id); await h.controller.initialize(8, { documentId: "doc-2" });
  assert.equal(h.run, null); assert.equal(h.posts.length, 0); assert.equal(h.reports.length, 2);
  assert.equal(h.reports.at(-1).queryRecovery.outcome, "cancelled");
  assert.equal(h.reports.at(-1).queryRecovery.rounds.length, when === "waiting" ? 1 : 2);
  const stored = Object.values(h.local).filter(entry => entry?.report).map(entry => entry.report);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].error.code, "E_API_TIMEOUT");
  assert.equal(stored[0].source, "queryRecovery");
  assert.equal(stored[0].queryRecovery.outcome, "cancelled");
});

test("a cold worker restores the same waiting plan; stale alarms and time edits cannot change it", async () => {
  const h = harness(), before = await h.startRecovery(), waiting = structuredClone(h.run);
  const next = h.make(); h.recovery.clear(); await next.reconcile();
  assert.equal(h.recovery.get(before.id).scheduledTime, waiting.recovery.nextAttemptAt);
  await assert.rejects(next.updateDurations(8, { runId: before.id, timingRevision: before.timingRevision, onMinutes: 2, offMinutes: 20 }), { code: "E_TIMING_UNAVAILABLE" });
  h.at(waiting.recovery.nextAttemptAt);
  await next.recoveryExpired(before.id, before.nextAt); assert.equal(h.posts.length, 0);
  await next.recoveryExpired(before.id, waiting.recovery.nextAttemptAt); assert.equal(h.posts.length, 1);
});

for (const kind of ["reload", "authentication"]) test(`${kind} during waiting preserves the deadline and resumes one scheduled check`, async () => {
  const h = harness(), before = await h.startRecovery(), waiting = structuredClone(h.run);
  await h.controller.suspend(8, { event: kind === "reload" ? "loading" : "authentication", route: kind === "reload" ? "home" : "login" });
  assert.equal(h.run.recovery.deadline, waiting.recovery.deadline);
  await h.controller.initialize(8, { documentId: "doc-2" });
  assert.equal(h.run.recovery.kind, "query"); assert.equal(h.run.queryRecovery.id, waiting.queryRecovery.id);
  assert.equal(h.run.documentId, "doc-2"); assert.equal(h.posts.length, 0);
  h.at(waiting.recovery.nextAttemptAt); await h.controller.recoveryExpired(before.id);
  assert.equal(h.posts.length, 1); assert.equal(h.run.queryRecovery, null);
});

test("extension session loss never reconstructs a run or sends commands", async () => {
  const h = harness(); await h.startRecovery(); await h.store.clearRun(); await h.make().reconcile();
  assert.equal(h.run, null); assert.equal(h.posts.length, 0);
  assert.equal(h.reports.at(-1).error.code, "E_SESSION_ENDED");
  assert.equal(h.reports.at(-1).queryRecovery.outcome, "stopped");
});

test("insufficient remaining window stops immediately instead of extending the deadline", async () => {
  const h = harness(); await h.startRecovery("on", 31000);
  assert.equal(h.run, null); assert.equal(h.recovery.size, 0); assert.equal(h.posts.length, 0);
});

for (const target of ["history", "session", "alarm"]) test(`recovery ${target} write failure stops and reports the actual failure`, async () => {
  const h = harness(); await h.startRecovery(); h.at(h.run.recovery.nextAttemptAt);
  if (target === "history") h.controller.history.save = async () => { throw new CycleError("E_LOCAL_STORAGE", "failed"); };
  if (target === "session") h.controller.store.setRun = async () => { throw new CycleError("E_LOCAL_STORAGE", "failed"); };
  if (target === "alarm") h.controller.recoveryAlarm.create = async () => { throw new CycleError("E_LOCAL_TIMEOUT", "failed"); };
  await h.controller.recoveryExpired(h.run.id);
  assert.equal(h.run, null); assert.equal(h.posts.length, 0);
  assert.equal(h.reports.at(-1).error.code, target === "alarm" ? "E_LOCAL_TIMEOUT" : "E_LOCAL_STORAGE");
  assert.equal(h.reports.at(-1).queryRecovery.outcome, "stopped");
});

test("deadline is rechecked after command journaling and after token lookup", async () => {
  const h = harness(), before = await h.startRecovery(); h.at(h.run.recovery.nextAttemptAt);
  const save = h.controller.history.save;
  h.controller.history.save = async (...args) => { await save(...args); if (args[1]?.sent) h.at(before.nextAt + 60000); };
  await h.controller.recoveryExpired(before.id);
  assert.equal(h.posts.length, 0); assert.equal(h.run, null);
  let posts = 0;
  const parent = new AbortController(); parent.signal.diagnostic = { requests: [], dispatchDeadlineAt: Date.now() - 1 };
  const api = createSchoolApi({ getToken: async () => "token", fetchImpl: async () => { posts++; } });
  await assert.rejects(api.setStatus(8, false, parent.signal), { code: "E_QUERY_RECOVERY_TIMEOUT" });
  assert.equal(posts, 0);
});

test("school API replay: two eight-second stalls then healthy at +46s produces one confirmed POST", async () => {
  const h = harness(); await h.controller.start(8, 1, 10); const due = h.run.nextAt; h.at(due);
  let healthy = false, actual = true; const calls = [];
  const reply = data => ({ ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) });
  h.controller.api = createSchoolApi({ clock: h.now, requestTimeoutMs: 5, switchRequestTimeoutMs: 5, getToken: async () => "token",
    fetchImpl: async (url, opts) => {
      const path = url.split("/").at(-1); calls.push([path, opts.method]);
      if (path === "ac-status" && !healthy) { h.at(h.now() + 8000); return new Promise(() => {}); }
      if (opts.method === "POST") { actual = JSON.parse(opts.body).toggle.status === 1; return reply({ ac_toggle: { Message: "Execution succeeded" } }); }
      return reply({ ac_status: { DisconnectRelay: actual } });
    } });
  await h.controller.tick(h.run.id, due);
  assert.equal(h.run.recovery.nextAttemptAt, due + 46000);
  assert.equal(h.reports[0].requests.length, 3);
  const timeouts = h.reports[0].requests.filter(request => request.errorCode === "E_API_TIMEOUT");
  assert.equal(timeouts.length, 2); assert.ok(timeouts.every(request => request.cancellationOrigin === "request-timeout" && request.cancelledAt));
  healthy = true; h.at(due + 46000); await h.controller.recoveryExpired(h.run.id);
  assert.equal(calls.filter(([, method]) => method === "POST").length, 1);
  assert.equal(h.run.phase, "off"); assert.equal(h.run.nextAt, h.now() + 600000);
  assert.equal(h.reports[1].queryRecovery.rounds[1].requests.length, 4);
  assert.equal(h.reports[1].queryRecovery.rounds[1].confirmed, true);
});

test("a command sent before the recovery deadline may confirm afterwards without retry", async () => {
  const h = harness(), before = await h.startRecovery(); h.at(before.nextAt + 59900);
  const setStatus = h.api.setStatus;
  h.api.setStatus = async (...args) => { await setStatus(...args); h.at(before.nextAt + 65000); };
  await h.controller.recoveryExpired(before.id);
  assert.equal(h.posts.length, 1); assert.equal(h.run.phase, "off");
  assert.equal(h.run.phaseStartedAt, before.nextAt + 65000); assert.equal(h.reports.at(-1).recovered, true);
});

test("recovery waiting in the serial queue cannot start after its deadline", async () => {
  const h = harness(), before = await h.startRecovery(); h.reads.length = 0;
  let release;
  const busy = h.controller.enqueue(() => new Promise(resolve => { release = resolve; })); await flush();
  const pending = h.controller.recoveryExpired(before.id); await flush();
  h.at(before.nextAt + 60000); release(); await busy; await pending;
  assert.equal(h.run, null); assert.equal(h.reads.length, 0); assert.equal(h.posts.length, 0);
});

for (const event of ["loading", "closed"]) test(`${event} during recovery I/O cancels its old response without duplicate results`, async () => {
  const h = harness(), before = await h.startRecovery(); h.at(h.run.recovery.nextAttemptAt);
  const read = h.api.readStatus; let finish;
  h.api.readStatus = async (_tab, signal) => bounded(() => new Promise(resolve => { finish = resolve; }), { signal, ms: 5000 });
  const attempt = h.controller.recoveryExpired(before.id); await flush();
  if (event === "loading") await h.controller.suspend(8); else await h.controller.abandon(8);
  await attempt; finish(true); await flush(); assert.equal(h.posts.length, 0);
  h.api.readStatus = read;
  if (event === "loading") {
    assert.equal(h.run.recovery.deadline, before.nextAt + 60000);
    await h.controller.initialize(8, { documentId: "doc-2" });
    assert.equal(h.posts.length, 1); assert.equal(h.run.queryRecovery, null);
  } else {
    assert.equal(h.run, null); assert.equal(h.reports.at(-1).queryRecovery.outcome, "stopped");
    assert.equal(h.reports.at(-1).error.code, "E_PAGE_CLOSED");
  }
  assert.equal(h.reports.length, 2);
});

test("cold worker with a pending command refuses to resend even within the recovery window", async () => {
  const h = harness(); await h.startRecovery();
  await h.history.save(h.run, { desiredOn: false, sent: true, confirmed: false });
  await h.make().reconcile();
  assert.equal(h.run, null); assert.equal(h.posts.length, 0);
  assert.equal(h.reports.at(-1).error.code, "E_COMMAND_UNKNOWN"); assert.equal(h.reports.at(-1).outcomeUnknown, true);
});

test("the initial recovery alarm failure retains initial evidence and reports the scheduling failure", async () => {
  const h = harness();
  h.controller.recoveryAlarm.create = async () => { throw new CycleError("E_LOCAL_TIMEOUT", "alarm failed"); };
  await h.startRecovery();
  assert.equal(h.run, null); assert.equal(h.posts.length, 0); assert.equal(h.reports.length, 2);
  assert.equal(h.reports[0].error.code, "E_API_TIMEOUT"); assert.equal(h.reports[1].error.code, "E_LOCAL_TIMEOUT");
  assert.equal(h.reports[1].queryRecovery.outcome, "stopped");
});

async function httpRecovery(status = 502, failedPath = "ac-timer", phase = "on") {
  const h = harness(); await h.controller.start(8, 1, 10, { documentId: "doc-1" });
  if (phase === "off") { h.at(h.run.nextAt); await h.controller.tick(h.run.id); }
  let healthy = false, actual = phase === "on";
  const calls = [], reply = data => ({ ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) });
  Object.assign(h.api, createSchoolApi({ getToken: async () => "mock", clock: h.now, fetchImpl: async (url, options) => {
    const path = url.split("/").at(-1); calls.push([path, options.method]);
    if (!healthy && (failedPath === "both" || failedPath === path)) return { ok: false, status };
    if (options.method === "POST") { actual = JSON.parse(options.body).toggle.status === 1; return reply({ ac_toggle: { Message: "Execution succeeded" } }); }
    return reply({ ac_status: { DisconnectRelay: actual } });
  } }));
  const before = structuredClone(h.run); h.at(before.nextAt);
  await h.controller.tick(before.id, before.nextAt);
  return { h, calls, before, healthy: () => { healthy = true; } };
}

for (const status of [502, 503, 504]) for (const path of ["ac-timer", "ac-status"]) for (const phase of ["on", "off"]) {
  test(`${phase} ${path} HTTP ${status} waits 30s, fully rechecks once and retains initial evidence`, async () => {
    const { h, calls, before, healthy } = await httpRecovery(status, path, phase);
    assert.equal(calls.length, 2, "HTTP failures have no immediate retry");
    assert.equal(h.run.recovery.nextAttemptAt, before.nextAt + 30000);
    assert.equal(h.run.recovery.deadline, before.nextAt + 60000);
    const initial = structuredClone(h.reports[0]);
    assert.equal(initial.queryRecovery.initialFailure.httpStatus, status);
    assert.equal(initial.queryRecovery.initialFailure.path, `/app/prepaid/${path}`);
    assert.equal(initial.error.code, "E_HTTP");
    healthy(); calls.length = 0; h.at(h.run.recovery.nextAttemptAt);
    await Promise.all([h.controller.recoveryExpired(before.id), h.controller.recoveryExpired(before.id)]);
    assert.equal(calls.filter(([, method]) => method === "POST").length, 1);
    assert.deepEqual(calls.slice(0, 2).map(([name]) => name), ["ac-timer", "ac-status"]);
    assert.equal(h.run.phase, phase === "on" ? "off" : "on");
    assert.equal(h.reports.length, 2); assert.deepEqual(h.reports[0], initial);
    assert.equal(h.reports[1].error.code, "E_HTTP"); assert.equal(h.reports[1].recovered, true);
    assert.deepEqual(h.reports[1].queryRecovery.initialFailure, initial.queryRecovery.initialFailure);
  });
}

for (const status of [400, 401, 403, 404, 429, 500]) test(`HTTP ${status} is not eligible for delayed recovery`, async () => {
  const { h, calls } = await httpRecovery(status);
  assert.equal(h.run, null); assert.equal(calls.length, 2); assert.equal(h.recovery.size, 0);
});

test("both HTTP 502 responses retain the causal request; a failed delayed round stops", async () => {
  const { h, calls, before } = await httpRecovery(502, "both");
  assert.equal(h.reports.length, 1);
  const cause = h.reports[0].queryRecovery.initialFailure;
  const failed = h.reports[0].requests.find(trace => trace.sequence === cause.sequence);
  assert.equal(failed.errorCode, "E_HTTP"); assert.equal(failed.path, cause.path);
  assert.ok(h.reports[0].requests.every(trace => trace.httpStatus === 502));
  h.at(h.run.recovery.nextAttemptAt); await h.controller.recoveryExpired(before.id);
  assert.equal(h.run, null); assert.equal(h.reports.length, 2);
  assert.equal(h.reports[1].queryRecovery.outcome, "stopped");
  await h.controller.recoveryExpired(before.id);
  assert.equal(calls.filter(([, method]) => method === "POST").length, 0);
  assert.equal(h.reports.length, 2);
});

for (const action of ["stop", "cold", "reload", "authentication", "expired", "storage", "unknown-post", "state-conflict"]) {
  test(`HTTP recovery ${action} preserves deadlines, cause and single-dispatch rules`, async () => {
    const { h, calls, before, healthy } = await httpRecovery();
    const deadline = h.run.recovery.deadline; healthy();
    if (action === "stop") {
      await h.controller.stop(8); await h.controller.recoveryExpired(before.id);
      assert.equal(h.run, null); assert.equal(h.reports.at(-1).error.code, "E_HTTP");
      assert.equal(h.reports.at(-1).queryRecovery.outcome, "cancelled");
    } else {
      let controller = h.controller;
      if (action === "cold") { controller = h.make(); await controller.reconcile(); }
      if (["reload", "authentication"].includes(action)) {
        await controller.suspend(8, { event: action === "reload" ? "loading" : "authentication", route: action === "reload" ? "home" : "login" });
        await controller.initialize(8, { documentId: "doc-2" });
      }
      assert.equal(h.run.recovery.deadline, deadline);
      h.at(action === "expired" ? deadline : h.run.recovery.nextAttemptAt);
      if (action === "storage") controller.history.save = async () => { throw new CycleError("E_LOCAL_STORAGE", "simulated"); };
      if (action === "state-conflict") h.api.readStatus = async () => false;
      if (action === "unknown-post") h.api.setStatus = async (_tab, _desired, signal) => {
        calls.push(["toggle-status", "POST"]); signal.diagnostic.command.sent = true; throw new CycleError("E_API_TIMEOUT", "simulated");
      };
      await controller.recoveryExpired(before.id);
      if (["cold", "reload", "authentication"].includes(action)) assert.equal(h.run.phase, "off"); else assert.equal(h.run, null);
      if (action === "unknown-post") assert.equal(h.reports.at(-1).outcomeUnknown, true);
    }
    assert.equal(h.reports.at(-1).queryRecovery.initialFailure.httpStatus, 502);
    assert.equal(calls.filter(([, method]) => method === "POST").length, ["cold", "reload", "authentication", "unknown-post"].includes(action) ? 1 : 0);
  });
}

test("HTTP recovery never borrows another request's status or infers it from error text", async () => {
  const h = harness(); await h.controller.start(8, 1, 10); h.at(h.run.nextAt);
  h.api.readTimer = async (_tab, signal) => {
    signal.diagnostic.requests.push({ sequence: 999, method: "GET", path: "/app/prepaid/ac-timer", httpStatus: 502, errorCode: "E_HTTP" });
    const error = new CycleError("E_HTTP", "HTTP 502"); error.requestSequence = 1000; throw error;
  };
  await h.controller.tick(h.run.id); assert.equal(h.run, null); assert.equal(h.recovery.size, 0);
});

test("HTTP failure cancels an unfinished sibling before saving its recovery report", async () => {
  const h = harness(); await h.controller.start(8, 1, 10); h.at(h.run.nextAt);
  let finish, transport;
  Object.assign(h.api, createSchoolApi({ getToken: async () => "mock", fetchImpl: async (url, options) => {
    if (url.endsWith("ac-timer")) return { ok: false, status: 503 };
    transport = options.signal; return new Promise(resolve => { finish = resolve; });
  } }));
  await h.controller.tick(h.run.id);
  assert.equal(transport.aborted, true);
  assert.equal(h.reports[0].queryRecovery.initialFailure.httpStatus, 503);
  assert.equal(h.reports[0].requests[1].cancelledBy, "E_CANCELLED");
  assert.equal(h.reports[0].requests[1].cancellationOrigin, "parent");
  const original = structuredClone(h.reports[0]);
  finish({ ok: false, status: 504 }); await flush();
  assert.deepEqual(h.reports[0], original);
  await h.controller.stop(8);
});
