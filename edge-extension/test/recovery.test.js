import test from "node:test";
import assert from "node:assert/strict";
import { CycleController } from "../cycle.js";
import { createHistory } from "../history.js";
import { bounded } from "../errors.js";
import { memoryStorage } from "./storage-fixture.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let now = 1_000_000, actual = false, autoDiscardable = true, counter = 0;
  let run = null, notice = null, keepAliveNotice = null;
  const local = {}, posts = [], reads = [], reports = [];
  const alarms = new Map(), keepalive = new Map(), recovery = new Map();
  const area = memoryStorage(local);
  const history = createHistory(area, { version: "1.1.10" });
  const store = {
    getRun: async () => structuredClone(run), setRun: async value => { run = structuredClone(value); }, clearRun: async () => { run = null; },
    getState: async () => structuredClone({ run, notice, keepAliveNotice }), setNotice: async value => { notice = value; }, clearNotice: async () => { notice = null; },
    setKeepAliveNotice: async value => { keepAliveNotice = value; }, clearKeepAliveNotice: async () => { keepAliveNotice = null; }
  };
  const adapter = map => ({ get: async id => map.get(id), create: async (id, when) => { map.set(id, { scheduledTime: when }); }, clear: async id => { map.delete(id); } });
  const api = {
    readTimer: async () => { reads.push("timer"); return null; }, readStatus: async () => { reads.push("status"); return actual; },
    setStatus: async (_tab, on, signal) => {
      assert.equal(local.cycleCheckpoint.command.sent, true, "journal precedes dispatch");
      signal.diagnostic.command.sent = true;
      posts.push(on); actual = on;
    }
  };
  const page = {
    isOpen: async () => true, getProtection: async () => autoDiscardable,
    protect: async () => { autoDiscardable = false; }, restore: async (_tab, previous) => { autoDiscardable = previous; }
  };
  const makeController = () => new CycleController({ store, api, page, alarm: adapter(alarms), keepAliveAlarm: adapter(keepalive), recoveryAlarm: adapter(recovery), history,
    clock: () => now, id: () => `run-${++counter}`, localTimeoutMs: 30,
    report: draft => { reports.push(globalThis.AirconReportFormat.makeReport(draft)); return draft.reportId; } });
  const controller = makeController();
  return { controller, makeController, local, area, history, store, api, posts, reads, reports, alarms, keepalive, recovery,
    get run() { return run; }, get notice() { return notice; }, get protected() { return !autoDiscardable; },
    set actual(value) { actual = value; }, set autoDiscardable(value) { autoDiscardable = value; },
    advance(ms) { now += ms; }, now: () => now,
    start: () => controller.start(8, 1, 120, { documentId: "doc-1" }) };
}

test("1/120 cycles retain precise durations over eight virtual hours", async () => {
  const h = harness();
  await h.start();
  for (let i = 0; i < 4; i++) {
    h.advance(60_000);
    await h.controller.tick(h.run.id);
    assert.equal(h.run.phase, "off");
    assert.equal(h.run.nextAt - h.now(), 120 * 60_000);
    h.advance(120 * 60_000);
    await h.controller.tick(h.run.id);
    assert.equal(h.run.phase, "on");
    assert.equal(h.run.nextAt - h.now(), 60_000);
  }
  assert.deepEqual(h.posts, [true, false, true, false, true, false, true, false, true]);
  assert.equal(h.reports.length, 0);
});

test("authentication chains retain one deadline and stopping prevents return from resuming", async () => {
  const h = harness(); await h.start();
  await h.controller.suspend(9, { event: "authentication", route: "login" });
  assert.equal(h.run.recovery, undefined);
  await h.controller.suspend(8, { event: "authentication", route: "login" });
  const deadline = h.run.recovery.deadline;
  for (const route of ["cas", "callback", "login"]) {
    h.advance(10000); await h.controller.suspend(8, { event: "authentication", route });
    assert.equal(h.run.recovery.deadline, deadline);
    await h.controller.tick(h.run.id);
    assert.deepEqual(h.posts, [true]);
  }
  await h.controller.stop(8);
  await h.controller.initialize(8, { documentId: "doc-2" });
  assert.equal(h.run, null); assert.deepEqual(h.posts, [true]);
});

test("authentication deadline cancels an in-flight verification instead of granting another API timeout", async () => {
  const h = harness(); await h.start();
  await h.controller.suspend(8, { event: "authentication", route: "login" });
  h.advance(59980);
  let cancelled = false;
  h.api.readTimer = async (_tab, signal) => {
    signal.addEventListener("abort", () => { cancelled = true; });
    return bounded(() => new Promise(() => {}), { signal, ms: 5000 });
  };
  await h.controller.initialize(8, { documentId: "doc-2" });
  assert.equal(cancelled, true);
  assert.equal(h.run, null);
  assert.ok(h.reports.some(report => report.error.code === "E_RECOVERY_TIMEOUT"));
  assert.deepEqual(h.posts, [true]);
});

for (const failure of ["timeout", "status", "timer", "auth", "unknown-command", "leave", "unrelated-cas"]) {
  test(`authentication recovery stops on ${failure} and never sends a corrective switch`, async () => {
    const h = harness(); await h.start();
    if (failure === "unknown-command") h.local.cycleCheckpoint.command = { sent: true, confirmed: false, targetOn: false };
    await h.controller.suspend(8, { event: "authentication", route: failure === "unrelated-cas" ? "cas" : "login" });
    if (failure === "timeout") { h.advance(60001); await h.controller.recoveryExpired(h.run.id); }
    else if (failure === "leave") await h.controller.abandon(8, "navigation", { route: "other" });
    else if (!["unknown-command", "unrelated-cas"].includes(failure)) {
      if (failure === "status") h.actual = false;
      if (failure === "timer") h.api.readTimer = async () => ({ timer: "active" });
      if (failure === "auth") h.api.readTimer = async () => { throw Object.assign(new Error("expired"), { code: "E_AUTH" }); };
      await h.controller.initialize(8, { documentId: "doc-2" });
    }
    assert.equal(h.run, null); assert.deepEqual(h.posts, [true]);
    assert.equal(h.local.cycleCheckpoint.active, false);
    const codes = { timeout: "E_RECOVERY_TIMEOUT", status: "E_STATUS_CHANGED", timer: "E_NATIVE_TIMER", auth: "E_AUTH", "unknown-command": "E_COMMAND_UNKNOWN", leave: "E_PAGE_CLOSED", "unrelated-cas": "E_PAGE_CLOSED" };
    assert.ok(h.reports.some(report => report.error.code === codes[failure]));
  });
}

for (const phase of ["on", "off"]) {
  test(`${phase} reload keeps original identity, switch time and heartbeat cadence`, async () => {
    const h = harness();
    await h.start();
    if (phase === "off") { h.advance(60_000); await h.controller.tick(h.run.id); }
    const before = structuredClone(h.run), posts = [...h.posts];
    const heartbeat = structuredClone(h.keepalive.get(before.id));
    h.advance(5_000);
    await h.controller.suspend(8, { event: "loading" });
    await h.controller.initialize(8, { documentId: "doc-2", lifecycle: { event: "initialize", navigationType: "reload" } });
    assert.equal(h.run.id, before.id);
    assert.equal(h.run.phase, before.phase);
    assert.equal(h.run.nextAt, before.nextAt);
    assert.equal(h.run.startedAt, before.startedAt);
    assert.deepEqual(h.keepalive.get(before.id), heartbeat);
    assert.deepEqual(h.posts, posts);
    assert.equal(h.run.recovery, null);
    assert.equal(h.recovery.size, 0);
    assert.equal(h.protected, true);
    const reads = h.reads.length;
    await h.controller.initialize(8, { documentId: "doc-2" });
    await h.controller.initialize(8, { documentId: "doc-1" });
    assert.equal(h.reads.length, reads, "duplicate and retired documents do not revalidate");
  });
}

test("a control alarm consumed during reload performs at most one transition after verification", async () => {
  const h = harness(); await h.start();
  h.advance(59_000); await h.controller.suspend(8);
  h.advance(2_000); h.alarms.clear();
  const reads = h.reads.length;
  await h.controller.tick(h.run.id);
  assert.equal(h.reads.length, reads);
  await h.makeController().reconcile();
  await h.controller.initialize(8, { documentId: "doc-2" });
  assert.equal(h.alarms.get(h.run.id).scheduledTime, 1_060_000);
  await h.controller.tick(h.run.id);
  await h.controller.tick(h.run.id);
  assert.deepEqual(h.posts, [true, false]);
});

test("repeated loading events cannot extend the recovery deadline; expiration is durable", async () => {
  const h = harness(); await h.start();
  await h.controller.suspend(8);
  const deadline = h.run.recovery.deadline;
  h.advance(30_000); await h.controller.suspend(8, { event: "discarded", discarded: true });
  assert.equal(h.run.recovery.deadline, deadline);
  h.advance(30_001); await h.controller.recoveryExpired(h.run.id);
  assert.equal(h.run, null);
  assert.equal(h.notice.kind, "error");
  assert.equal(h.local.cycleCheckpoint.active, false);
  assert.equal(h.protected, false);
  const report = Object.values(h.local).find(entry => entry?.report)?.report;
  assert.equal(report.error.code, "E_RECOVERY_TIMEOUT");
  assert.equal(report.lifecycle.discarded, true);
  await h.controller.initialize(8, { documentId: "doc-2" });
  assert.match((await h.controller.getView(8)).notice.text, /E_RECOVERY_TIMEOUT/);
  assert.deepEqual(h.posts, [true]);
});

for (const failure of ["expired", "late", "status", "timer", "auth"]) {
  test(`reload ${failure} cannot send a command or silently discard the reason`, async () => {
    const h = harness(); await h.start(); await h.controller.suspend(8);
    if (failure === "expired") h.advance(60_001);
    if (failure === "late") { h.advance(120_001); await h.store.setRun({ ...h.run, recovery: null }); }
    if (failure === "status") h.actual = false;
    if (failure === "timer") h.api.readTimer = async () => "30";
    if (failure === "auth") h.api.readStatus = async () => { throw Object.assign(new Error("expired login"), { code: "E_AUTH" }); };
    await h.controller.initialize(8, { documentId: "doc-2" });
    assert.equal(h.run, null);
    assert.equal(h.local.cycleCheckpoint.notice.kind, "error");
    assert.equal(Object.values(h.local).filter(entry => entry?.report).length, 1);
    assert.deepEqual(h.posts, [true]);
  });
}

test("reload cancels pending reads and a late read cannot send a switch", async () => {
  const h = harness(); await h.start(); h.advance(60_000);
  let finish;
  const read = h.api.readStatus;
  h.api.readStatus = (_tab, signal) => bounded(() => new Promise(resolve => { finish = resolve; }), { signal });
  const tick = h.controller.tick(h.run.id); await flush();
  await h.controller.suspend(8); await tick;
  finish(true); await flush(); h.api.readStatus = read;
  assert.deepEqual(h.posts, [true]);
  await h.controller.initialize(8, { documentId: "doc-2" });
  await h.controller.tick(h.run.id);
  assert.deepEqual(h.posts, [true, false]);
});

test("reload after POST leaves an unknown result, persists one report and blocks restart until stop", async () => {
  const h = harness(); await h.start(); h.advance(60_000);
  const set = h.api.setStatus;
  h.api.setStatus = async (tab, on, signal) => { await set(tab, on, signal); return bounded(() => new Promise(() => {}), { signal }); };
  const tick = h.controller.tick(h.run.id); await flush();
  await h.controller.suspend(8); await tick;
  assert.equal(h.run, null);
  assert.equal(h.notice.outcomeUnknown, true);
  assert.equal(h.local.cycleCheckpoint.notice.outcomeUnknown, true);
  assert.equal(Object.values(h.local).find(entry => entry?.report).report.error.code, "E_COMMAND_UNKNOWN");
  await h.controller.initialize(8, { documentId: "doc-2" });
  await assert.rejects(h.start(), { code: "E_COMMAND_UNKNOWN" });
  assert.deepEqual(h.posts, [true, false]);
  h.api.setStatus = set;
  await h.controller.stop(8); await h.start();
  assert.equal(h.run.phase, "on");
});

test("cold worker with an unconfirmed journal never resends its command", async () => {
  const h = harness(); await h.start();
  await h.history.save(h.run, { desiredOn: false, sent: true, confirmed: false });
  const reads = h.reads.length;
  const cold = h.makeController(); await cold.reconcile(h.run.id);
  assert.equal(h.run, null);
  assert.equal(h.reads.length, reads);
  assert.match((await cold.getView(8)).notice.text, /E_COMMAND_UNKNOWN/);
  assert.deepEqual(h.posts, [true]);
});

test("browser session loss retains a previous-cycle reason in a new tab and restores protection", async () => {
  const h = harness(); await h.start();
  await h.store.clearRun(); await h.store.clearNotice();
  const reads = h.reads.length;
  const cold = h.makeController(); await cold.reconcile();
  assert.equal(h.reads.length, reads);
  assert.equal(h.protected, false);
  const view = await cold.getView(99);
  assert.equal(view.notice.previous, true);
  assert.match(view.notice.text, /E_SESSION_ENDED/);
  assert.equal(view.run, null);
});

test("journal write failure prevents POST and further control in that worker", async () => {
  const h = harness();
  h.history.save = async () => { throw new Error("quota exhausted"); };
  await assert.rejects(h.start(), { code: "E_LOCAL_STORAGE" });
  assert.deepEqual(h.posts, []);
  await assert.rejects(h.start(), { code: "E_LOCAL_STORAGE" });
  assert.equal(h.protected, false);
});

test("a stopped cycle restores an initially disabled auto-discard setting unchanged", async () => {
  const h = harness(); h.autoDiscardable = false;
  await h.start(); await h.controller.stop(8);
  assert.equal(h.protected, true);
});

test("a terminal checkpoint wins if the worker died before session cleanup", async () => {
  const h = harness(); await h.start();
  await h.history.finish(h.run, { tabId: 8, kind: "warning", text: "previous stop", at: h.now() });
  await h.makeController().reconcile(h.run.id);
  assert.equal(h.run, null);
  assert.equal(h.notice.text, "previous stop");
  assert.deepEqual(h.posts, [true]);
});

test("a checkpoint/session phase mismatch stops instead of replaying a completed transition", async () => {
  const h = harness(); await h.start();
  await h.history.save({ ...h.run, phase: "off", expectedOn: false, nextAt: h.now() + 120 * 60_000 });
  await h.makeController().reconcile(h.run.id);
  assert.equal(h.run, null);
  assert.match(h.notice.text, /E_CYCLE_INTERRUPTED/);
  assert.deepEqual(h.posts, [true]);
});

test("closing the page after a startup POST persists the unknown result even before a run was scheduled", async () => {
  const h = harness();
  const set = h.api.setStatus;
  h.api.setStatus = async (tab, on, signal) => { await set(tab, on, signal); return bounded(() => new Promise(() => {}), { signal }); };
  const rejected = assert.rejects(h.start(), { code: "E_CANCELLED" });
  await flush(); await h.controller.abandon(8); await rejected;
  const report = Object.values(h.local).find(entry => entry?.report)?.report;
  assert.equal(report.error.code, "E_PAGE_CLOSED");
  assert.equal(report.outcomeUnknown, true);
  assert.equal(h.notice.outcomeUnknown, true);
  assert.deepEqual(h.posts, [true]);
});

test("failed terminal storage still clears all alarms and restores the original tab setting", async () => {
  const h = harness(); await h.start();
  h.history.finish = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(h.controller.stop(8), { code: "E_LOCAL_STORAGE" });
  assert.equal(h.run, null);
  assert.equal(h.alarms.size + h.keepalive.size + h.recovery.size, 0);
  assert.equal(h.protected, false);
  await assert.rejects(h.start(), { code: "E_LOCAL_STORAGE" });
});

for (const event of ["suspend", "abandon"]) {
  test(`a cold worker's first ${event} event cannot erase an unresolved command`, async () => {
    const h = harness(); await h.start();
    await h.history.save(h.run, { desiredOn: false, sent: true, confirmed: false });
    await h.makeController()[event](8);
    assert.equal(h.run, null);
    assert.equal(h.notice.outcomeUnknown, true);
    assert.equal(h.local.cycleCheckpoint.notice.outcomeUnknown, true);
    assert.deepEqual(h.posts, [true]);
  });
}

test("failure arranging the recovery alarm stops visibly and retains a durable report", async () => {
  const h = harness(); await h.start();
  h.controller.recoveryAlarm.create = async () => { throw new Error("alarm unavailable"); };
  await h.controller.suspend(8);
  assert.equal(h.run, null);
  assert.match(h.notice.text, /恢复准备失败/);
  assert.equal(h.local.cycleCheckpoint.active, false);
  assert.equal(Object.values(h.local).filter(entry => entry?.report).length, 1);
  assert.deepEqual(h.posts, [true]);
});

for (const target of ["storage", "alarm"]) {
  test(`immediate ${target} cleanup rejection blocks subsequent alarms and queued starts`, async () => {
    const h = harness(); await h.start();
    const runId = h.run.id;
    if (target === "storage") h.store.clearRun = async () => { throw new Error("storage rejected"); };
    else h.controller.alarm.clear = async () => { throw new Error("alarm rejected"); };
    await assert.rejects(h.controller.stop(8), { code: "E_LOCAL_STORAGE" });
    const view = await h.controller.getView(8);
    assert.equal(view.blocked, true);
    assert.equal(view.notice.kind, "error");
    assert.match(view.notice.text, /已禁止后续空调指令/);
    assert.equal(h.local.cycleCheckpoint.notice.kind, "error");
    h.advance(60_000);
    await assert.rejects(h.controller.tick(runId), { code: "E_LOCAL_STORAGE" });
    await assert.rejects(h.start(), { code: "E_LOCAL_STORAGE" });
    assert.deepEqual(h.posts, [true]);
  });
}

test("a timed-out cleanup cannot permit commands even when the browser write finishes late", async () => {
  const h = harness(); await h.start();
  const clear = h.store.clearRun;
  let finish;
  h.store.clearRun = () => new Promise(resolve => { finish = async () => { await clear(); resolve(); }; });
  const runId = h.run.id;
  await assert.rejects(h.controller.stop(8), { code: "E_LOCAL_TIMEOUT" });
  h.advance(60_000);
  await assert.rejects(h.controller.tick(runId), { code: "E_LOCAL_TIMEOUT" });
  await finish(); await flush();
  await assert.rejects(h.start(), { code: "E_LOCAL_TIMEOUT" });
  h.store.clearRun = clear;
  await h.controller.stop(8);
  assert.equal((await h.controller.getView(8)).blocked, true, "manual cleanup remains available but cannot unlock the worker");
  assert.deepEqual(h.posts, [true]);
});

test("cleanup rejection blocks control tasks already queued behind stop", async () => {
  const h = harness(); await h.start();
  const runId = h.run.id;
  let rejectCleanup;
  h.store.clearRun = () => new Promise((_resolve, reject) => { rejectCleanup = reject; });
  const stopping = assert.rejects(h.controller.stop(8), { code: "E_LOCAL_STORAGE" });
  await flush(); h.advance(60_000);
  const starting = assert.rejects(h.start(), { code: "E_LOCAL_STORAGE" });
  const ticking = assert.rejects(h.controller.tick(runId), { code: "E_LOCAL_STORAGE" });
  await flush(); rejectCleanup(new Error("cleanup rejected"));
  await Promise.all([stopping, starting, ticking]);
  assert.deepEqual(h.posts, [true]);
});

function pendingTransition(h) {
  h.advance(60_000);
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  h.api.readTimer = (_tab, signal) => { entered(); return bounded(() => new Promise(() => {}), { signal, ms: 5000 }); };
  return { reading, tick: h.controller.tick(h.run.id, h.run.nextAt) };
}

test("normal stop during a transition without a dispatched switch leaves no fault report", async () => {
  const h = harness(); await h.start();
  const { reading, tick } = pendingTransition(h);
  await reading;
  const stopping = h.controller.stop(8);
  await tick; await stopping;
  assert.equal(h.run, null);
  assert.deepEqual(Object.values(h.local).filter(entry => entry?.report), []);
  assert.deepEqual(h.posts, [true]);
  assert.equal(h.notice.kind, "info");
});

test("closing the page during a transition records only the page-close fault", async () => {
  const h = harness(); await h.start();
  const { reading, tick } = pendingTransition(h);
  await reading;
  const abandoning = h.controller.abandon(8);
  await tick; await abandoning;
  const reports = Object.values(h.local).filter(entry => entry?.report).map(entry => entry.report);
  assert.equal(h.run, null);
  assert.deepEqual(reports.map(report => report.error.code), ["E_PAGE_CLOSED"]);
  assert.equal(reports[0].outcomeUnknown, false);
  assert.deepEqual(h.posts, [true]);
  assert.equal(h.notice.kind, "warning");
});

test("stopping after an unconfirmed switch keeps one unknown-outcome report", async () => {
  const h = harness(); await h.start();
  h.advance(60_000);
  let dispatched;
  const sent = new Promise(resolve => { dispatched = resolve; });
  h.api.setStatus = async (_tab, on, signal) => {
    signal.diagnostic.command.sent = true;
    h.posts.push(on);
    dispatched();
    return bounded(() => new Promise(() => {}), { signal, ms: 5000 });
  };
  const tick = h.controller.tick(h.run.id, h.run.nextAt);
  await sent;
  const stopping = h.controller.stop(8);
  await tick; await stopping;
  const reports = Object.values(h.local).filter(entry => entry?.report).map(entry => entry.report);
  assert.equal(h.run, null);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].error.code, "E_CANCELLED");
  assert.equal(reports[0].outcomeUnknown, true);
  assert.deepEqual(h.posts, [true, false]);
});
