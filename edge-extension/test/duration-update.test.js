import test from "node:test";
import assert from "node:assert/strict";
import { CycleController, timingOf } from "../cycle.js";
import { bounded, CycleError } from "../errors.js";
import { createHistory } from "../history.js";
import { memoryStorage } from "./storage-fixture.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function harness(phase = "on") {
  let now = 1_800_000_000_000, actual = true, run = null, notice = null;
  const local = {}, posts = [], reports = [], alarms = new Map(), keepalive = new Map();
  const calls = { reads: 0, saves: 0, alarms: 0 };
  const storage = memoryStorage(local), history = createHistory(storage);
  const store = {
    getRun: async () => structuredClone(run), setRun: async value => { calls.saves++; run = structuredClone(value); },
    clearRun: async () => { run = null; }, getState: async () => ({ run: structuredClone(run), notice }),
    setNotice: async value => { notice = value; }, clearKeepAliveNotice: async () => {}, setKeepAliveNotice: async () => {}
  };
  const alarm = { get: async id => alarms.has(id) ? { scheduledTime: alarms.get(id) } : null,
    create: async (id, at) => { calls.alarms++; alarms.set(id, at); }, clear: async id => alarms.delete(id) };
  const api = {
    readTimer: async () => { calls.reads++; return null; }, readStatus: async () => { calls.reads++; return actual; },
    setStatus: async (_tab, desired, signal) => { signal.diagnostic.command.sent = true; posts.push(desired); actual = desired; }
  };
  const options = { store, alarm, api, history, clock: () => now, sleep: async () => {}, id: () => "timing-run",
    page: { isOpen: async () => true },
    keepAliveAlarm: { get: async id => keepalive.get(id), create: async (id, at) => keepalive.set(id, at), clear: async id => keepalive.delete(id) },
    report: draft => { reports.push(globalThis.AirconReportFormat.makeReport(draft)); return draft.reportId; } };
  const controller = new CycleController(options);
  await controller.start(8, 10, 10, { documentId: "doc-one" });
  if (phase === "off") { now = run.nextAt; await controller.tick(run.id, run.nextAt); }
  posts.length = 0; calls.reads = 0;
  const h = { controller, options, store, history, storage, local, posts, reports, alarms, alarm, keepalive, api, calls,
    get now() { return now; }, get run() { return structuredClone(run); }, get notice() { return notice; },
    advance: ms => { now += ms; }, setActual: value => { actual = value; },
    request: (onMinutes, offMinutes) => ({ runId: run.id, timingRevision: timingOf(run).timingRevision, onMinutes, offMinutes }),
    apply: (on, off) => controller.updateDurations(8, h.request(on, off), { documentId: "doc-one" }) };
  return h;
}

for (const phase of ["on", "off"]) {
  for (const [name, elapsed, minutes, immediate] of [["extend", 7, 12, false], ["shorten", 3, 5, false], ["exactly due", 5, 5, true], ["past by several minutes", 7, 2, true]]) {
    test(`${phase}: ${name} preserves elapsed time and applies future durations`, async () => {
      const h = await harness(phase), before = h.run, heartbeat = h.keepalive.get(before.id);
      h.advance(elapsed * 60000);
      const on = phase === "on" ? minutes : 8, off = phase === "off" ? minutes : 8;
      await h.apply(on, off);
      assert.equal(h.run.id, before.id); assert.equal(h.run.startedAt, before.startedAt);
      assert.equal(h.keepalive.get(before.id), heartbeat);
      assert.equal(h.run.onMinutes, on); assert.equal(h.run.offMinutes, off);
      assert.equal(h.run.lastTimingChange.outcome, "applied");
      if (immediate) {
        assert.deepEqual(h.posts, [phase === "off"]);
        assert.equal(h.run.phaseStartedAt, h.now);
        assert.equal(h.run.nextAt, h.now + 8 * 60000);
      } else {
        assert.deepEqual(h.posts, []); assert.equal(h.calls.reads, 0);
        assert.equal(h.run.phaseStartedAt, before.phaseStartedAt);
        assert.equal(h.run.nextAt, before.phaseStartedAt + minutes * 60000);
      }
      assert.equal(h.alarms.get(before.id), h.run.nextAt);
      h.advance(h.run.nextAt - h.now);
      await h.controller.tick(h.run.id, h.run.nextAt);
      assert.equal(h.run.nextAt, h.now + (h.run.phase === "on" ? on : off) * 60000);
    });
  }
}

test("other-phase edits, repeated edits and no-op do not reset the phase or heartbeat", async () => {
  const h = await harness(), origin = h.run.phaseStartedAt, originalAt = h.run.nextAt;
  h.advance(60000); await h.apply(10, 4);
  assert.equal(h.run.nextAt, originalAt);
  await h.apply(14, 4); h.advance(60000); await h.apply(8, 4);
  assert.equal(h.run.phaseStartedAt, origin); assert.equal(h.run.nextAt, origin + 8 * 60000);
  const before = { run: h.run, calls: { ...h.calls } };
  assert.equal((await h.apply(8, 4)).changed, false);
  assert.deepEqual({ run: h.run, calls: h.calls }, before);
  assert.deepEqual(h.posts, []);
});

for (const bad of [0, -1, 1441, 1.5, NaN, Infinity, "5", null]) test(`invalid duration ${bad} cannot change a running plan`, async () => {
  const h = await harness(), before = h.run;
  await assert.rejects(h.apply(bad, 4), { code: "E_DURATION" });
  assert.deepEqual(h.run, before); assert.deepEqual(h.posts, []);
});

test("late original plan is stopped even if new duration would put it in the future", async () => {
  const h = await harness(); h.advance(12 * 60000);
  await assert.rejects(h.apply(20, 10), { code: "E_ALARM_LATE" });
  assert.equal(h.run, null); assert.deepEqual(h.posts, []);
});

test("old alarm cannot operate a changed plan even when its new deadline has arrived", async () => {
  const h = await harness(), oldAt = h.run.nextAt;
  await h.apply(12, 10); h.advance(12 * 60000);
  await h.controller.tick(h.run.id, oldAt);
  assert.deepEqual(h.posts, []);
  await h.controller.tick(h.run.id, h.run.nextAt);
  await h.controller.tick(h.run.id, oldAt);
  assert.deepEqual(h.posts, [false]);
});

test("concurrent submissions of the same version accept only one", async () => {
  const h = await harness(), req = h.request(12, 4);
  const results = await Promise.allSettled([h.controller.updateDurations(8, req), h.controller.updateDurations(8, { ...req, onMinutes: 8 })]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "E_TIMING_STALE");
  assert.equal(h.run.onMinutes, 12); assert.deepEqual(h.posts, []);
});

test("a natural transition winning the queue rejects a stale edit without stopping the new phase", async () => {
  const h = await harness(), gate = deferred(), entered = deferred(), req = h.request(12, 5);
  h.api.readTimer = async () => { entered.resolve(); await gate.promise; return null; };
  h.advance(10 * 60000);
  const tick = h.controller.tick(h.run.id, h.run.nextAt); await entered.promise;
  const edit = h.controller.updateDurations(8, req);
  const rejected = assert.rejects(edit, { code: "E_TIMING_STALE" });
  gate.resolve(); await tick; await rejected;
  assert.equal(h.run.phase, "off"); assert.equal(h.run.offMinutes, 10); assert.deepEqual(h.posts, [false]);
});

test("queue wait consumes the modification deadline and expired work never starts", async () => {
  const h = await harness(), gate = deferred(), before = h.run;
  const blocker = h.controller.enqueue(() => gate.promise);
  const edit = assert.rejects(h.apply(12, 4), { code: "E_OPERATION_TIMEOUT" });
  h.advance(30001); gate.resolve(); await blocker; await edit;
  assert.deepEqual(h.run, before); assert.deepEqual(h.posts, []); assert.equal(h.calls.reads, 0);
});

test("stop invalidates queued modifications before they write or send commands", async () => {
  const h = await harness(), gate = deferred();
  const blocker = h.controller.enqueue(() => gate.promise);
  const edit = assert.rejects(h.apply(12, 4), { code: "E_CANCELLED" });
  const stopped = h.controller.stop(8); gate.resolve(); await blocker; await edit; await stopped;
  assert.equal(h.run, null); assert.deepEqual(h.posts, []);
});

for (const cause of ["stop", "reload", "authentication"]) test(`${cause} cancels immediate-switch reads; no late POST`, async () => {
  const h = await harness(), gate = deferred(), entered = deferred();
  h.advance(7 * 60000);
  h.api.readTimer = async (_tab, signal) => { entered.resolve(); return bounded(() => gate.promise, { signal, ms: 1000 }); };
  const edit = h.apply(5, 4); const failed = assert.rejects(edit, { code: cause === "stop" ? "E_CANCELLED" : "E_PAGE_RELOADING" });
  await entered.promise;
  await (cause === "stop" ? h.controller.stop(8) : h.controller.suspend(8, cause === "authentication" ? { event: "authentication", route: "login" } : { event: "loading" }));
  await failed; gate.resolve(null); await flush();
  assert.deepEqual(h.posts, []);
  if (cause !== "stop") {
    assert.equal(h.run.onMinutes, 5);
    h.api.readTimer = async () => null;
    await h.controller.initialize(8, { documentId: "doc-two" });
    await h.controller.tick(h.run.id, h.run.nextAt);
    assert.equal(h.run.phase, "off"); assert.deepEqual(h.posts, [false]);
  } else assert.equal(h.run, null);
});

test("stopping a duration edit during its read leaves no cancellation report", async () => {
  const h = await harness(), gate = deferred(), entered = deferred();
  h.advance(7 * 60000);
  h.api.readTimer = async (_tab, signal) => { entered.resolve(); return bounded(() => gate.promise, { signal, ms: 5000 }); };
  const edit = h.apply(5, 4);
  const failed = assert.rejects(edit, { code: "E_CANCELLED" });
  await entered.promise;
  const stopping = h.controller.stop(8);
  await failed; await stopping; gate.resolve(null); await flush();
  assert.equal(h.run, null);
  assert.deepEqual(Object.values(h.local).filter(entry => entry?.report), []);
  assert.deepEqual(h.posts, []);
});

test("reload after dispatched immediate POST records unknown result and never replays", async () => {
  const h = await harness(), gate = deferred(), sent = deferred();
  h.advance(7 * 60000);
  h.api.setStatus = async (_tab, desired, signal) => {
    signal.diagnostic.command.sent = true; h.posts.push(desired); sent.resolve();
    await bounded(() => gate.promise, { signal, ms: 1000 });
  };
  const failed = assert.rejects(h.apply(5, 4), { code: "E_COMMAND_UNKNOWN" });
  await sent.promise; await h.controller.suspend(8); await failed;
  gate.resolve(); await h.controller.initialize(8, { documentId: "doc-two" });
  assert.equal(h.run, null); assert.deepEqual(h.posts, [false]);
  assert.equal(h.reports.at(-1).outcomeUnknown, true);
});

test("read finishing beyond total deadline cannot dispatch an immediate switch", async () => {
  const h = await harness(); h.advance(7 * 60000);
  h.api.readTimer = async () => { h.advance(30001); return null; };
  await assert.rejects(h.apply(5, 4), { code: "E_OPERATION_TIMEOUT" });
  assert.equal(h.run, null); assert.deepEqual(h.posts, []);
});

for (const fault of ["history", "session", "alarm"]) test(`${fault} failure during apply stops without a switch or false success`, async () => {
  const h = await harness();
  if (fault === "history") h.history.save = async () => { throw new Error("write failed"); };
  if (fault === "session") h.store.setRun = async () => { throw new Error("write failed"); };
  if (fault === "alarm") h.alarm.create = async () => { throw new Error("alarm failed"); };
  await assert.rejects(h.apply(12, 4));
  assert.equal(h.run, null); assert.deepEqual(h.posts, []);
  assert.equal(h.reports[0].source, "updateDurations");
  assert.equal(h.reports[0].timingChange.outcome, "failed");
});

for (const cause of ["timer", "status", "network"]) test(`${cause} preflight failure stops an immediate switch and retains requested times`, async () => {
  const h = await harness(); h.advance(7 * 60000);
  if (cause === "timer") h.api.readTimer = async () => "scheduled";
  if (cause === "status") h.setActual(false);
  if (cause === "network") h.api.readTimer = async () => { throw new CycleError("E_NETWORK", "unavailable"); };
  await assert.rejects(h.apply(5, 4));
  assert.equal(h.run, null); assert.deepEqual(h.posts, []);
  assert.deepEqual(h.reports.at(-1).timingChange.requested, { onMinutes: 5, offMinutes: 4 });
});

test("recovery and retired-document edits leave the current plan unchanged", async () => {
  const h = await harness(), req = h.request(12, 4);
  await assert.rejects(h.controller.updateDurations(8, req, { documentId: "doc-old" }), { code: "E_TIMING_STALE" });
  await h.controller.suspend(8);
  const before = h.run;
  await assert.rejects(h.apply(12, 4), { code: "E_TIMING_UNAVAILABLE" });
  assert.deepEqual(h.run, before); assert.deepEqual(h.posts, []);
});

test("legacy live run is normalized and updated timings survive a cold worker and later report", async () => {
  const h = await harness(), legacy = h.run;
  delete legacy.phaseStartedAt; delete legacy.timingRevision;
  await h.store.setRun(legacy); await h.history.save(legacy);
  h.advance(3 * 60000); await h.apply(12, 4);
  const saved = h.run, cold = new CycleController(h.options);
  await cold.reconcile(); assert.deepEqual(h.run, saved);
  assert.equal(h.run.phaseStartedAt, legacy.nextAt - 10 * 60000);
  h.api.readTimer = async () => { throw new CycleError("E_NETWORK", "failed later"); };
  h.advance(saved.nextAt - h.now); await cold.tick(saved.id, saved.nextAt);
  assert.equal(h.reports.at(-1).timingChange.outcome, "applied");
  assert.deepEqual(h.reports.at(-1).timingChange.before, { onMinutes: 10, offMinutes: 10 });
});
