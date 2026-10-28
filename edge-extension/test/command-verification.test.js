import test from "node:test";
import assert from "node:assert/strict";
import { CommandVerification, verificationCandidate, VERIFICATION_KEY } from "../command-verification.js";
import { createSchoolApi } from "../api-client.js";
import { CycleError } from "../errors.js";
import { memoryStorage } from "./storage-fixture.js";
import { ErrorReporter } from "../reports.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
function draft(code = "E_API_TIMEOUT") {
  return { reportId: "incident", verificationGeneration: 0, error: { code, requestSequence: 3 },
    run: { id: "original-cycle", tabId: 8, documentId: "original-document" }, command: { sent: true, confirmed: false, desiredOn: true },
    requests: [{ sequence: 3, method: "POST", path: "/app/prepaid/toggle-status", dispatched: true,
      errorCode: code, phase: "headers", cancelledAt: 100000, cancelledBy: code }] };
}
function harness(overrides = {}) {
  let now = 100000, on = false;
  const data = {}, snapshots = [], reads = [], alarms = new Map();
  const deps = { storage: memoryStorage(data), clock: () => now,
    alarm: { create: async (id, time) => alarms.set(id, time), clear: async id => alarms.delete(id) },
    updateReport: async (id, value) => { snapshots.push(structuredClone(value)); return true; },
    readStatus: async () => { reads.push("status"); return on; }, readTimer: async () => { reads.push("timer"); return null; }, ...overrides };
  const verifier = new CommandVerification(deps);
  return { verifier, deps, data, snapshots, reads, alarms, set now(v) { now = v; }, set on(v) { on = v; } };
}
async function first(h, value = draft()) { await h.verifier.start(value); await h.verifier.work; }
async function second(h, at = 130000) { h.now = at; await h.verifier.onAlarm("incident", 130000); await h.verifier.work; }

for (const code of ["E_API_REJECTED", "E_SWITCH_REJECTED", "E_NETWORK", "E_HTTP", "E_JSON"]) test(`post-dispatch ${code} reuses two read-only rounds with failure time anchor`, async () => {
  const h = harness(), d = draft(code); d.at = 100000;
  Object.assign(d.requests[0], { phase: code === "E_NETWORK" ? "headers" : "validation", cancelledAt: null, cancelledBy: null });
  assert.equal(verificationCandidate(d), d.requests[0]); await first(h, d); await second(h);
  assert.equal(h.reads.length, 4); assert.equal(h.verifier.job.deadlineAt, 145000); assert.equal(h.verifier.job.triggeredAt, 100000);
  assert.equal(h.verifier.job.state, "completed");
});
for (const code of ["E_API_TIMEOUT", "E_HTTP", "E_JSON", "E_STATUS_FORMAT", "E_STATUS_UNCONFIRMED"]) test(`successful POST followed by ${code} verifies without another POST`, async () => {
  const h = harness(), d = draft(code); d.at = 100000;
  Object.assign(d.requests[0], { errorCode: null, phase: "complete", schoolCode: 200, switchAccepted: true, cancelledAt: null, cancelledBy: null });
  d.error.requestSequence = 4;
  if (code !== "E_STATUS_UNCONFIRMED") d.requests.push({ sequence: 4, method: "GET", path: "/app/prepaid/ac-status", errorCode: code, cancelledAt: code === "E_API_TIMEOUT" ? 100000 : null });
  assert.equal(verificationCandidate(d), d.requests[0]); await first(h, d); await second(h);
  assert.equal(h.reads.length, 4); assert.equal(h.verifier.job.triggerSequence, 3);
});
for (const [code, reason] of [["E_AUTH", "authentication"], ["E_CANCELLED", "user_action"], ["E_PAGE_RELOADING", "page_changed"], ["E_LOCAL_STORAGE", "storage_failure"]]) test(`${code} records why post-dispatch queries were not started`, async () => {
  const h = harness(), d = draft(code); d.at = 100000; await first(h, d);
  assert.equal(h.reads.length, 0); assert.equal(h.snapshots.at(-1).state, "not_run"); assert.equal(h.snapshots.at(-1).reason, reason);
});
test("new native page control cancels an already waiting diagnostic", async () => {
  const h = harness(); await first(h); await h.verifier.cancel(8, "page_control"); await second(h);
  assert.equal(h.reads.length, 2); assert.equal(h.verifier.job.reason, "page_control");
});
test("a known login redirect records why no active reads are allowed", async () => {
  const h = harness(), d = draft("E_JSON"); d.at = 100000; d.requests[0].response = { route: "login" };
  await first(h, d); assert.equal(h.reads.length, 0); assert.equal(h.snapshots.at(-1).reason, "authentication");
});

for (const code of ["E_API_TIMEOUT", "E_OPERATION_TIMEOUT"]) for (const phase of ["headers", "body"]) {
  test(`only exact dispatched POST ${code} in ${phase} qualifies`, () => {
    const d = draft(code); d.requests[0].phase = phase;
    assert.equal(verificationCandidate(d), d.requests[0]);
    for (const mutation of [
      v => v.command.confirmed = true, v => v.command.sent = false,
      v => v.error.requestSequence = 2, v => v.error.code = "E_CANCELLED", v => v.error.code = "E_PAGE_RELOADING",
      v => v.error.code = "E_STATUS_UNCONFIRMED", v => v.requests[0].method = "GET",
      v => v.requests[0].dispatched = false, v => v.requests[0].cancelledBy = "E_CANCELLED",
      v => v.requests[0].phase = "complete", v => v.requests.push({ ...v.requests[0] })
    ]) { const invalid = structuredClone(d); mutation(invalid); assert.equal(verificationCandidate(invalid), null); }
  });
}
for (const [a, b, conclusion] of [[false, false, "original_observed"], [true, true, "target_observed"], [false, true, "changed"], [true, false, "changed"]]) {
  test(`two observations ${a}/${b}: ${conclusion}, fixed deadline and max four reads`, async () => {
    const h = harness(); h.on = a; await first(h);
    assert.equal(h.verifier.job.deadlineAt, 145000); assert.equal(h.alarms.get("incident"), 130000);
    await h.verifier.onAlarm("incident", 130000); assert.equal(h.reads.length, 2);
    h.on = b; await second(h);
    await h.verifier.onAlarm("incident", 130000); await h.verifier.work;
    assert.equal(h.reads.length, 4); assert.equal(h.verifier.job.conclusion, conclusion);
    assert.equal(h.verifier.job.state, "completed"); assert.equal(h.alarms.size, 0);
    assert.equal(h.verifier.job.runId, "original-cycle");
  });
}
for (const at of [129999, 130000, 144999, 145000, 150000]) test(`second-round admission at ${at}`, async () => {
  const h = harness(); await first(h); await second(h, at);
  assert.equal(h.reads.length, at >= 130000 && at < 145000 ? 4 : 2);
  if (at >= 145000) assert.equal(h.verifier.job.state, "expired");
});
test("timer failure preserves status and the next round; native timer never triggers a control", async () => {
  let count = 0;
  const h = harness({ readTimer: async () => { if (++count === 1) throw new CycleError("E_HTTP", "simulated"); return "10"; } });
  await first(h); await second(h);
  assert.equal(h.verifier.job.rounds[0].actualOn, false);
  assert.equal(h.verifier.job.rounds[0].timerPresentError, "E_HTTP");
  assert.equal(h.verifier.job.rounds[1].timerPresent, true);
});
for (const code of ["E_AUTH", "E_PAGE_CLOSED", "E_PAGE_UNAVAILABLE", "E_PAGE_RELOADING"]) test(`${code} terminates later verification`, async () => {
  const h = harness({ readStatus: async () => { throw new CycleError(code, "simulated"); } });
  await first(h); await second(h);
  assert.equal(h.verifier.job.state, "cancelled"); assert.equal(h.verifier.job.rounds.length, 1);
  assert.equal(h.verifier.job.rounds[0].timerPresent, false);
});
for (const reason of ["user_action", "page_changed", "page_closed", "session_ended"]) test(`${reason} cancels waiting work; late alarm cannot restart`, async () => {
  const h = harness(); await first(h); await h.verifier.cancel(8, reason); await second(h);
  assert.equal(h.verifier.job.state, "cancelled"); assert.equal(h.reads.length, 2);
  if (reason === "user_action") assert.equal(h.verifier.view(8), null);
});
test("stop before delayed stop callback does not create a job or queries", async () => {
  const h = harness(); await h.verifier.cancel(8); await first(h);
  assert.equal(h.verifier.job, null); assert.equal(h.reads.length, 0); assert.equal(h.snapshots.at(-1).state, "not_run");
});
test("unrelated tab navigation cannot cancel a pending or active observation", async () => {
  const h = harness(); await h.verifier.cancel(99, "page_changed"); await first(h);
  assert.equal(h.verifier.job.state, "waiting");
  await h.verifier.cancel(99, "page_closed"); await second(h);
  assert.equal(h.reads.length, 4); assert.equal(h.verifier.job.state, "completed");
});
test("refresh before the stop callback records the actual cancellation reason without querying", async () => {
  const h = harness(); await h.verifier.cancel(8, "page_changed"); await first(h);
  assert.equal(h.reads.length, 0); assert.equal(h.snapshots.at(-1).reason, "page_changed");
});
test("waiting work survives worker wake without changing the fixed schedule", async () => {
  const h = harness(); await first(h); h.now = 132000;
  const woke = new CommandVerification(h.deps); await woke.ready();
  assert.equal(woke.job.deadlineAt, 145000); assert.equal(woke.job.nextAt, 130000);
  await woke.onAlarm("incident", 130000); await woke.work;
  assert.equal(h.reads.length, 4); assert.equal(woke.job.state, "completed");
});
test("worker lost during a claimed round does not replay it", async () => {
  const h = harness(); await first(h);
  h.data[VERIFICATION_KEY].state = "running";
  const woke = new CommandVerification(h.deps); await woke.ready();
  await woke.onAlarm("incident", 130000); await woke.work;
  assert.equal(woke.job.state, "interrupted"); assert.equal(h.reads.length, 2);
});
test("wrong report or scheduled time and concurrent duplicate alarms cannot add rounds", async () => {
  const h = harness(); await first(h); h.now = 130000;
  await h.verifier.onAlarm("other", 130000); await h.verifier.onAlarm("incident", 130001);
  assert.equal(h.reads.length, 2);
  await Promise.all([h.verifier.onAlarm("incident", 130000), h.verifier.onAlarm("incident", 130000)]);
  await flush(); await h.verifier.queue;
  assert.equal(h.reads.length, 4);
});
for (const reason of ["storage_failure", "identity"]) test(`${reason} prevents diagnostic I/O`, async () => {
  const h = harness(), d = draft(); if (reason === "identity") delete d.run.documentId;
  await h.verifier.start(d, reason === "storage_failure" ? reason : null); await h.verifier.work;
  assert.equal(h.reads.length, 0); assert.equal(h.verifier.job.state, "not_run");
});
test("report update failure stops further reads and leaves the original operation alone", async () => {
  let writes = 0;
  const h = harness({ updateReport: async () => { if (++writes >= 3) throw new Error("storage"); return true; } });
  await first(h); await second(h);
  assert.equal(h.reads.length, 2); assert.equal(h.verifier.job.reason, "storage_failure");
});
test("session write failure before a round prevents all requests", async () => {
  const h = harness({ storage: { get: async () => ({}), set: async () => { throw new Error("storage"); } } });
  await first(h); assert.equal(h.reads.length, 0); assert.equal(h.verifier.job.reason, "storage_failure");
});
test("a changed control checkpoint retires stale waiting work without another query", async () => {
  let current = true;
  const h = harness({ canVerify: async () => current }); await first(h);
  current = false; await second(h);
  assert.equal(h.reads.length, 2); assert.equal(h.verifier.job.state, "cancelled");
});
test("a stale waiting session cannot revive a newer cancelled report after worker wake", async () => {
  const local = {}, reporter = new ErrorReporter({ storage: memoryStorage(local), getDirectory: async () => null });
  reporter.capture({ ...draft(), source: "tick", at: 100000, startedAt: 85000 }); await reporter.queue;
  const h = harness({ updateReport: (id, value) => reporter.updateVerification(id, value) });
  await first(h);
  const waiting = structuredClone(h.data[VERIFICATION_KEY]);
  await h.verifier.cancel(8);
  h.data[VERIFICATION_KEY] = waiting; h.now = 130000;
  const woke = new CommandVerification(h.deps); await woke.ready(); await woke.onAlarm("incident", 130000); await woke.work;
  assert.equal(h.reads.length, 2); assert.equal(woke.job.reason, "storage_failure");
  assert.equal(local["airconErrorReport:incident"].report.switchCommand.confirmed, false);
});
for (const body of [false, true]) test(`eight-second ${body ? "body" : "headers"} timeout has no GET retry and records both failures`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  let calls = 0;
  const api = createSchoolApi({ getToken: async () => "fake", retryGetTimeouts: false, fetchImpl: async () => {
    calls++; return body ? { ok: true, status: 200, json: () => new Promise(() => {}) } : new Promise(() => {});
  } });
  const h = harness({ readStatus: api.readStatus, readTimer: api.readTimer, clock: () => Date.now() });
  await h.verifier.start(draft()); await flush(); t.mock.timers.tick(8000); await h.verifier.work;
  assert.equal(calls, 2); assert.equal(h.verifier.job.conclusion, "unknown");
  const r = h.verifier.job.rounds[0];
  assert.equal(r.actualOnError, "E_API_TIMEOUT"); assert.equal(r.timerPresentError, "E_API_TIMEOUT");
  assert.equal(r.requests.length, 2); assert.ok(r.requests.every(v => v.timeoutMs === 8000 && v.attempt === 1));
});
test("stop aborts in-flight reads; late replies cannot replace cancellation or affect a new job", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const replies = [];
  const api = createSchoolApi({ getToken: async () => "fake", retryGetTimeouts: false,
    fetchImpl: () => new Promise(resolve => replies.push(resolve)) });
  const h = harness({ readStatus: api.readStatus, readTimer: api.readTimer });
  await h.verifier.start(draft()); await flush(); await h.verifier.cancel(8);
  assert.equal(h.verifier.job.state, "cancelled"); assert.equal(h.verifier.job.rounds[0].requests.length, 2);
  for (const reply of replies) reply({ ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: { ac_status: { DisconnectRelay: true } } }) });
  await flush(); await second(h);
  assert.equal(h.verifier.job.conclusion, "unknown"); assert.equal(h.verifier.job.state, "cancelled");
});
test("hard deadline bounds the second round including stalled token access", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  let hang = false;
  const api = createSchoolApi({ getToken: async (_tab, signal) => hang ? new Promise((_res, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) : "fake",
    retryGetTimeouts: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: { ac_status: { DisconnectRelay: false } } }) }) });
  const h = harness({ clock: () => Date.now(), readStatus: api.readStatus, readTimer: api.readTimer });
  await first(h); hang = true; t.mock.timers.tick(44999);
  await h.verifier.onAlarm("incident", 130000); await flush(); t.mock.timers.tick(1); await h.verifier.work;
  assert.equal(h.verifier.job.state, "expired"); assert.equal(h.verifier.job.deadlineAt, 145000);
  assert.ok(h.verifier.job.rounds[1].requests.every(r => !r.dispatched));
});
