import test from "node:test";
import assert from "node:assert/strict";
import { CycleController, KEEP_ALIVE_MINUTES, hasNativeTimer, timerFromSchoolData } from "../cycle.js";
import { bounded, CycleError } from "../errors.js";
import { createSchoolApi } from "../api-client.js";

function harness(options = {}) {
  let now = 1_000_000;
  let run = null;
  let notice = null;
  let keepAliveNotice = null;
  let open = true;
  let status = false;
  let timer = null;
  let failRead = false;
  let failSet = false;
  const posts = [];
  const alarms = new Map();
  const keepAliveAlarms = new Map();
  const store = {
    async getRun() { return run; },
    async setRun(value) { run = value; },
    async clearRun() { run = null; },
    async getState() { return { run, notice, keepAliveNotice }; },
    async setNotice(value) { notice = value; },
    async clearNotice() { notice = null; },
    async setKeepAliveNotice(value) { keepAliveNotice = value; },
    async clearKeepAliveNotice() { keepAliveNotice = null; }
  };
  const alarm = {
    async get(id) { return alarms.has(id) ? { scheduledTime: alarms.get(id) } : undefined; },
    async create(id, when) { alarms.set(id, when); },
    async clear(id) { alarms.delete(id); }
  };
  const keepAliveAlarm = {
    async get(id) { return keepAliveAlarms.get(id); },
    async create(id, when) { keepAliveAlarms.set(id, { scheduledTime: when, periodInMinutes: KEEP_ALIVE_MINUTES }); },
    async clear(id) { keepAliveAlarms.delete(id); }
  };
  const api = {
    async readStatus() {
      if (failRead) throw new Error("network unavailable");
      return status;
    },
    async readTimer() { return timer; },
    async setStatus(_tabId, desired) {
      posts.push(desired);
      if (failSet) throw new Error("network unavailable");
      status = desired;
    }
  };
  const controller = new CycleController({
    store, alarm, keepAliveAlarm, api,
    page: { async isOpen() { return open; } },
    clock: () => now,
    sleep: async () => {},
    id: () => "run-1",
    ...options
  });
  return {
    controller, posts, alarms, keepAliveAlarms, api, store, alarm, keepAliveAlarm,
    get run() { return run; },
    get notice() { return notice; },
    get keepAliveNotice() { return keepAliveNotice; },
    get status() { return status; },
    set status(value) { status = value; },
    set timer(value) { timer = value; },
    set open(value) { open = value; },
    set failRead(value) { failRead = value; },
    set failSet(value) { failSet = value; },
    advance(ms) { now += ms; }
  };
}

const schoolReply = data => ({ ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) });

for (const source of ["start", "tick"]) test(`${source} calls diagnostic hook only after unknown POST has stopped and persisted the fault`, async () => {
  const order = [], reports = [];
  const h = harness({ history: { get: async () => null, save: async () => {}, finish: async () => { order.push("persist"); } }, report: d => { reports.push(d); return d.reportId; } });
  if (source === "tick") { await h.controller.start(8, 1, 1, { documentId: "doc" }); h.advance(60000); }
  h.controller.api = createSchoolApi({ getToken: async () => "fake", switchRequestTimeoutMs: 5, clock: () => 1000000,
    fetchImpl: async (url, options) => options.method === "POST" ? new Promise(() => {}) : schoolReply({ ac_status: { DisconnectRelay: source === "tick" } }) });
  h.controller.onStopped = (d, failure) => {
    assert.equal(h.run, null); assert.equal(h.alarms.size, 0); assert.equal(h.notice.outcomeUnknown, true);
    assert.equal(order[0], "persist"); assert.equal(d.error.code, "E_API_TIMEOUT"); assert.equal(failure, null);
    assert.equal(d.requests.find(r => r.method === "POST").dispatched, true); order.push("hook");
  };
  if (source === "start") await assert.rejects(h.controller.start(8, 1, 1, { documentId: "doc" }), { code: "E_API_TIMEOUT" });
  else await h.controller.tick("run-1");
  assert.deepEqual(order, ["persist", "hook"]); assert.equal(reports.length, 1);
});

for (const source of ["start", "tick", "initialize", "manualCheck", "keepAlive", "confirmation"]) {
  test(`${source} continues after one GET timeout without an interruption report or repeated POST`, async () => {
    const reports = [];
    const h = harness({ report: draft => { reports.push(draft); return draft.reportId; } });
    if (!["start", "confirmation"].includes(source)) await h.controller.start(8, 2, 4);
    let actual = h.status, timedOut = false, finish;
    const calls = [];
    const before = h.run ? { ...h.run } : null;
    h.controller.api = createSchoolApi({ getToken: async () => "token", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
      fetchImpl: async (url, opts) => {
        const path = url.split("/").at(-1);
        calls.push([path, opts.method]);
        if (opts.method === "POST") {
          actual = JSON.parse(opts.body).toggle.status === 1;
          h.posts.push(actual);
          return schoolReply({ ac_toggle: { Message: "Execution succeeded" } });
        }
        const target = ["manualCheck", "keepAlive", "confirmation"].includes(source) ? "ac-status" : "ac-timer";
        if (!timedOut && path === target && (source !== "confirmation" || h.posts.length > 0)) {
          timedOut = true;
          return new Promise(resolve => { finish = resolve; });
        }
        return schoolReply({ ac_status: { DisconnectRelay: actual } });
      }
    });
    if (["start", "confirmation"].includes(source)) await h.controller.start(8, 2, 4);
    else if (source === "tick") { h.advance(120_000); await h.controller.tick("run-1"); }
    else if (source === "initialize") { await h.controller.suspend(8); await h.controller.initialize(8, { documentId: "new-document" }); }
    else await h.controller[source](source === "keepAlive" ? "run-1" : 8);
    assert.equal(timedOut, true);
    assert.equal(reports.length, 0);
    assert.ok(h.run);
    assert.deepEqual(h.posts, source === "tick" ? [true, false] : [true]);
    assert.equal(calls.filter(([, method]) => method === "POST").length, ["start", "tick", "confirmation"].includes(source) ? 1 : 0);
    if (source === "initialize") assert.equal(h.run.nextAt, before.nextAt);
    const after = structuredClone({ run: h.run, calls, posts: h.posts });
    finish(schoolReply({ ac_status: { DisconnectRelay: !actual } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ run: h.run, calls, posts: h.posts }, after);
  });
}

for (const failedPath of ["ac-timer", "ac-status"]) {
  test(`${failedPath} fatal rejection cancels and finalizes its sibling before reporting`, async () => {
    const reports = [];
    const h = harness({ report: draft => { reports.push(globalThis.AirconReportFormat.makeReport(draft)); return draft.reportId; } });
    await h.controller.start(8, 2, 4); h.advance(120_000);
    let finish, transport;
    const calls = [];
    h.controller.api = createSchoolApi({ getToken: async () => "token", requestTimeoutMs: 1000, switchRequestTimeoutMs: 1000,
      fetchImpl: async (url, opts) => {
        calls.push(url);
        if (url.endsWith(failedPath)) return { ok: false, status: failedPath === "ac-timer" ? 500 : 401 };
        transport = opts.signal;
        return new Promise(resolve => { finish = resolve; });
      }
    });
    await h.controller.tick("run-1");
    assert.equal(h.run, null);
    assert.equal(transport.aborted, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(h.posts, [true]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].error.code, failedPath === "ac-timer" ? "E_HTTP" : "E_AUTH");
    assert.ok(reports[0].requests.every(trace => Number.isFinite(trace.elapsedMs) && trace.errorCode));
    assert.equal(reports[0].requests.find(trace => !trace.path.endsWith(failedPath)).errorCode, "E_CANCELLED");
    const before = JSON.stringify(reports);
    finish(schoolReply({})); await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(reports), before);
  });
}

test("both preflight queries time out at most twice and schedule recovery with finalized initial evidence", async () => {
  const reports = [], calls = [], finishes = [];
  const h = harness({ report: draft => { reports.push(globalThis.AirconReportFormat.makeReport(draft)); return draft.reportId; } });
  await h.controller.start(8, 2, 4); h.advance(120_000);
  h.controller.api = createSchoolApi({ getToken: async () => "token", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
    fetchImpl: async (url, opts) => { calls.push([url, opts.signal]); return new Promise(resolve => { finishes.push(resolve); }); }
  });
  await h.controller.tick("run-1");
  assert.equal(h.run.recovery.kind, "query");
  assert.equal(calls.length, 4);
  assert.ok(calls.every(([, signal]) => signal.aborted));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].error.code, "E_API_TIMEOUT");
  assert.equal(reports[0].requests.length, 4);
  assert.ok(reports[0].requests.every(trace => Number.isFinite(trace.elapsedMs) && trace.errorCode));
  assert.equal(reports[0].switchCommand, null);
  assert.equal(reports[0].outcomeUnknown, false);
  const before = JSON.stringify(reports);
  finishes.forEach(finish => finish(schoolReply({})));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(reports), before);
  assert.deepEqual(h.posts, [true]);
});

test("stop aborts a retry response body and its late completion cannot resume switching", async () => {
  const reports = [];
  const h = harness({ report: draft => { reports.push(draft); return draft.reportId; } });
  await h.controller.start(8, 2, 4); h.advance(120_000);
  let timerCalls = 0, entered, finishBody, context, transport;
  const retrying = new Promise(resolve => { entered = resolve; });
  h.controller.api = createSchoolApi({ getToken: async (_tab, signal) => { context = signal.diagnostic; return "token"; }, requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
    fetchImpl: async (url, opts) => {
      if (url.endsWith("ac-status")) return schoolReply({ ac_status: { DisconnectRelay: true } });
      if (++timerCalls === 1) return new Promise(() => {});
      transport = opts.signal;
      return { ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; entered(); }) };
    }
  });
  const ticking = h.controller.tick("run-1");
  await retrying; await h.controller.stop(8); await ticking;
  assert.equal(transport.aborted, true);
  assert.equal(timerCalls, 2);
  assert.equal(reports.length, 0);
  assert.equal(h.run, null);
  const retry = context.requests.find(trace => trace.attempt === 2);
  assert.equal(retry.phase, "body");
  assert.equal(retry.errorCode, "E_CANCELLED");
  assert.ok(context.requests.every(trace => Number.isFinite(trace.elapsedMs)));
  const before = structuredClone(context.requests);
  finishBody({ meta: { code: 200 }, data: {} }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(context.requests, before);
  assert.equal(h.run, null);
  assert.deepEqual(h.posts, [true]);
});

test("a successful parallel status read remains the latest observation when the timer ultimately times out", async () => {
  const reports = [];
  const h = harness({ report: draft => { reports.push(globalThis.AirconReportFormat.makeReport(draft)); return draft.reportId; } });
  await h.controller.start(8, 2, 4); h.advance(120_000);
  h.controller.api = createSchoolApi({ getToken: async () => "token", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
    fetchImpl: async url => url.endsWith("ac-timer") ? new Promise(() => {}) : schoolReply({ ac_status: { DisconnectRelay: false } })
  });
  await h.controller.tick("run-1");
  assert.equal(reports[0].error.code, "E_API_TIMEOUT");
  assert.deepEqual(reports[0].lastConfirmedStatus, { value: false, at: 1_120_000 });
  assert.deepEqual(h.posts, [true]);
});

for (const action of ["stop", "suspend", "abandon", "deadline"]) {
  test(`${action} during retry token acquisition cancels both reads and prevents late dispatch`, async () => {
    const reports = [], calls = [];
    const h = harness({ report: draft => { reports.push(globalThis.AirconReportFormat.makeReport(draft)); return draft.reportId; } });
    await h.controller.start(8, 2, 4); h.advance(120_000);
    if (action === "deadline") h.controller.operationTimeoutMs = 100;
    let entered, finishToken, context, tokens = 0;
    const retrying = new Promise(resolve => { entered = resolve; });
    h.controller.api = createSchoolApi({ requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
      getToken: (_tab, signal) => {
        context = signal.diagnostic;
        if (++tokens !== 3) return "token";
        return bounded(() => new Promise(resolve => { finishToken = resolve; entered(); }), { signal });
      },
      fetchImpl: async url => { calls.push(url); return url.endsWith("ac-timer") ? new Promise(() => {}) : schoolReply({ ac_status: { DisconnectRelay: true } }); }
    });
    const ticking = h.controller.tick("run-1");
    await retrying;
    if (action !== "deadline") await h.controller[action](8);
    await ticking;
    assert.equal(calls.length, 2);
    assert.ok(context.requests.every(trace => Number.isFinite(trace.elapsedMs)));
    assert.equal(context.requests.find(trace => trace.attempt === 2).errorCode, action === "deadline" ? "E_OPERATION_TIMEOUT" : action === "suspend" ? "E_PAGE_RELOADING" : "E_CANCELLED");
    if (action === "suspend") assert.ok(h.run.recovery);
    else assert.equal(h.run, null);
    if (action === "deadline") assert.equal(reports[0].error.code, "E_OPERATION_TIMEOUT");
    if (["stop", "suspend"].includes(action)) assert.equal(reports.length, 0);
    const before = structuredClone(context.requests);
    finishToken("late-token"); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(context.requests, before);
    assert.equal(calls.length, 2);
    assert.deepEqual(h.posts, [true]);
  });
}

test("fresh page retains a prior timeout notice without contacting the school", async () => {
  const h = harness();
  let reads = 0;
  h.api.readStatus = async () => { reads++; return false; };
  await h.store.setNotice({ tabId: 8, kind: "error", text: "[E_API_TIMEOUT] old error" });
  await h.controller.initialize(8);
  assert.match(h.notice.text, /E_API_TIMEOUT/);
  assert.match((await h.controller.getView(8)).notice.text, /E_API_TIMEOUT/);
  assert.equal(reads, 0);
  assert.deepEqual(h.posts, []);
});

test("fresh page leaves another tab's notice untouched", async () => {
  const h = harness();
  const notice = { tabId: 9, kind: "error", text: "other tab" };
  await h.store.setNotice(notice);
  await h.controller.initialize(8);
  assert.deepEqual(h.notice, notice);
});

test("start turns on, alternates phases, and schedules from confirmed transitions", async () => {
  const h = harness();
  await h.controller.start(8, 1, 2);
  assert.deepEqual(h.posts, [true]);
  assert.equal(h.run.phase, "on");
  assert.equal(h.alarms.get("run-1"), 1_060_000);
  h.advance(60_000);
  await h.controller.tick("run-1");
  assert.equal(h.run.phase, "off");
  assert.equal(h.status, false);
  assert.equal(h.alarms.get("run-1"), 1_180_000);
  h.advance(120_000);
  await h.controller.tick("run-1");
  assert.equal(h.run.phase, "on");
  assert.deepEqual(h.posts, [true, false, true]);
});

test("already-on start does not send another on command", async () => {
  const h = harness();
  h.status = true;
  await h.controller.start(8, 1, 1);
  assert.deepEqual(h.posts, []);
  assert.equal(h.run.phase, "on");
});

test("existing school timer blocks start", async () => {
  const h = harness();
  h.timer = "23:40";
  await assert.rejects(h.controller.start(8, 1, 1), /先在网页中取消/);
  assert.equal(h.run, null);
  assert.deepEqual(h.posts, []);
});

test("school's omitted ac_timer means no timer, as its own page displays", () => {
  assert.equal(timerFromSchoolData({ ac_timer_action: null }), null);
  assert.equal(timerFromSchoolData({}), null);
  assert.equal(hasNativeTimer(timerFromSchoolData({})), false);
  assert.equal(timerFromSchoolData({ ac_timer: "23:40" }), "23:40");
  assert.throws(() => timerFromSchoolData(null), /无法识别/);
});

test("unknown timer shape fails closed", async () => {
  assert.throws(() => hasNativeTimer({ unknown: true }), /无法识别/);
});

test("manual status change pauses without overriding it", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.status = false;
  await h.controller.manualCheck(8);
  assert.equal(h.run, null);
  assert.equal(h.status, false);
  assert.deepEqual(h.posts, [true]);
});

test("stop preserves ON and cancels the alarm without any school request", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.failRead = true;
  h.failSet = true;
  await h.controller.stop(8);
  assert.equal(h.status, true);
  assert.equal(h.run, null);
  assert.equal(h.alarms.size, 0);
  assert.deepEqual(h.posts, [true]);
  assert.match(h.notice.text, /循环已停止/);
});

test("closing the page stops future commands and leaves current status", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.open = false;
  await h.controller.abandon(8);
  assert.equal(h.run, null);
  assert.equal(h.status, true);
  assert.deepEqual(h.posts, [true]);
});

test("late alarm stops without any extra switching or catch-up", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.advance(121_000);
  await h.controller.tick("run-1");
  assert.equal(h.run, null);
  assert.equal(h.status, true);
  assert.deepEqual(h.posts, [true]);
  assert.match(h.notice.text, /E_ALARM_LATE/);
});

test("network failure on off stops cycle and reports unconfirmed off", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.failSet = true;
  h.advance(60_000);
  await h.controller.tick("run-1");
  assert.equal(h.run, null);
  assert.equal(h.status, true);
  assert.match(h.notice.text, /循环已停止/);
  assert.deepEqual(h.posts, [true, false]);
});

test("invalid duration and duplicate start are rejected", async () => {
  const h = harness();
  await assert.rejects(h.controller.start(8, 0, 1), /1–1440/);
  await h.controller.start(8, 1, 1);
  await assert.rejects(h.controller.start(8, 1, 1), /已有循环/);
});

test("stop preserves OFF and stale alarm cannot restart it", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.advance(60_000);
  await h.controller.tick("run-1");
  await h.controller.stop(8);
  h.advance(60_000);
  await h.controller.tick("run-1");
  assert.equal(h.status, false);
  assert.deepEqual(h.posts, [true, false]);
});

test("start read failure never switches an already-on AC off", async () => {
  const h = harness();
  h.status = true;
  h.failRead = true;
  await assert.rejects(h.controller.start(8, 1, 1), /network/);
  assert.equal(h.status, true);
  assert.equal(h.run, null);
  assert.deepEqual(h.posts, []);
});

test("startup timer and status reads overlap, but switching waits for both", async () => {
  const h = harness();
  let finishTimer;
  let statusRead = false;
  h.api.readTimer = () => new Promise(resolve => { finishTimer = resolve; });
  h.api.readStatus = async () => { statusRead = true; return true; };
  const start = h.controller.start(8, 1, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statusRead, true);
  assert.deepEqual(h.posts, []);
  assert.equal(h.run, null);
  finishTimer(null);
  await start;
  assert.equal(h.run.phase, "on");
});

test("failed scheduling leaves AC alone, clears the run, and allows another start", async () => {
  const h = harness();
  const create = h.alarm.create;
  h.alarm.create = async () => { throw new Error("alarm failure"); };
  await assert.rejects(h.controller.start(8, 1, 1), { code: "E_SCHEDULE" });
  assert.equal(h.run, null);
  assert.equal(h.status, true);
  assert.deepEqual(h.posts, [true]);
  h.alarm.create = create;
  await h.controller.start(8, 1, 1);
  assert.equal(h.run.phase, "on");
});

test("storage failure after ON does not create an alarm or issue cleanup OFF", async () => {
  const h = harness();
  h.store.setRun = async () => { throw new Error("storage failed"); };
  await assert.rejects(h.controller.start(8, 1, 1), { code: "E_SCHEDULE" });
  assert.equal(h.alarms.size, 0);
  assert.equal(h.run, null);
  assert.deepEqual(h.posts, [true]);
});

for (const action of ["stop", "abandon"]) {
  test(`${action} cancels pending startup; late read cannot turn AC on`, async () => {
    const h = harness();
    let lateReply;
    h.api.readStatus = (_tab, signal) => bounded(() => new Promise(resolve => { lateReply = resolve; }), { signal });
    const start = h.controller.start(8, 1, 1);
    const rejected = assert.rejects(start, { code: "E_CANCELLED" });
    await new Promise(resolve => setImmediate(resolve));
    await h.controller[action](8);
    await rejected;
    lateReply(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.run, null);
    assert.deepEqual(h.posts, []);
    assert.equal(h.alarms.size, 0);
  });
}

test("total operation timeout frees the queue and late reply cannot start a cycle", async () => {
  const h = harness({ operationTimeoutMs: 15 });
  let lateReply;
  h.api.readStatus = (_tab, signal) => bounded(() => new Promise(resolve => { lateReply = resolve; }), { signal });
  await assert.rejects(h.controller.start(8, 1, 1), { code: "E_OPERATION_TIMEOUT" });
  lateReply(false);
  await h.controller.stop(8);
  assert.equal(h.run, null);
  assert.deepEqual(h.posts, []);
  h.api.readStatus = async () => true;
  await h.controller.start(8, 1, 1);
  assert.equal(h.run.phase, "on");
});

test("stop during a sent ON never issues another command or schedules a cycle", async () => {
  const h = harness();
  let posted;
  const sent = new Promise(resolve => { posted = resolve; });
  h.api.setStatus = (_tab, on, signal) => bounded(() => {
    h.posts.push(on);
    posted();
    return new Promise(() => {});
  }, { signal });
  const rejected = assert.rejects(h.controller.start(8, 1, 1), { code: "E_CANCELLED" });
  await sent;
  await h.controller.stop(8);
  await rejected;
  assert.deepEqual(h.posts, [true]);
  assert.equal(h.run, null);
  assert.equal(h.alarms.size, 0);
});

test("stop cancels a pending timed transition and does not queue a new alarm", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.advance(60_000);
  h.api.readStatus = (_tab, signal) => bounded(() => new Promise(() => {}), { signal });
  const tick = h.controller.tick("run-1");
  await new Promise(resolve => setImmediate(resolve));
  await h.controller.stop(8);
  await tick;
  assert.deepEqual(h.posts, [true]);
  assert.equal(h.run, null);
  assert.equal(h.alarms.size, 0);
});

test("confirmed transition, not delayed page rendering, drives the cycle", async () => {
  const h = harness();
  let reads = 0;
  h.api.readStatus = async () => ++reads < 3 ? false : true;
  await h.controller.start(8, 1, 1);
  assert.equal(reads, 3);
  assert.equal(h.run.phase, "on");
  assert.deepEqual(h.posts, [true]);
});

test("hanging local read times out, frees stop, and its late reply cannot issue commands", async () => {
  const h = harness({ localTimeoutMs: 10 });
  const getRun = h.store.getRun;
  let finish;
  h.store.getRun = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(h.controller.start(8, 1, 1), { code: "E_LOCAL_TIMEOUT" });
  h.store.getRun = getRun;
  await h.controller.stop(8);
  finish(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.posts, []);
  assert.equal(h.run, null);
});

test("stop cancels a pending local read without waiting for its timeout", async () => {
  const h = harness({ localTimeoutMs: 5000 });
  const getRun = h.store.getRun;
  h.store.getRun = () => new Promise(() => {});
  const rejected = assert.rejects(h.controller.start(8, 1, 1), { code: "E_CANCELLED" });
  await new Promise(resolve => setImmediate(resolve));
  h.store.getRun = getRun;
  await h.controller.stop(8);
  await rejected;
  assert.deepEqual(h.posts, []);
});

test("hanging alarm write frees stop and blocks new control even after late completion", async () => {
  const h = harness({ localTimeoutMs: 10 });
  let finish;
  h.alarm.create = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(h.controller.start(8, 1, 1), { code: "E_LOCAL_TIMEOUT" });
  await h.controller.stop(8);
  finish();
  await assert.rejects(h.controller.start(8, 1, 1), { code: "E_LOCAL_TIMEOUT" });
  assert.deepEqual(h.posts, [true]);
  assert.equal(h.run, null);
});

test("failure clearing the alarm still attempts to clear saved run", async () => {
  const h = harness({ localTimeoutMs: 10 });
  await h.controller.start(8, 1, 1);
  h.alarm.clear = () => new Promise(() => {});
  await assert.rejects(h.controller.stop(8), { code: "E_LOCAL_TIMEOUT" });
  assert.equal(h.run, null);
  assert.deepEqual(h.posts, [true]);
});

for (const mode of ["valid", "missing", "mismatch", "delivered"]) {
  test(`worker reconciliation handles ${mode} alarm without school requests`, async () => {
    const h = harness();
    await h.controller.start(8, 1, 1);
    if (mode === "missing" || mode === "delivered") h.alarms.clear();
    if (mode === "mismatch") h.alarms.set("run-1", h.run.nextAt + 5000);
    h.api.readStatus = async () => { throw new Error("must not contact school"); };
    await h.controller.reconcile(mode === "delivered" ? new Map([["run-1", h.run.nextAt]]) : undefined);
    assert.equal(Boolean(h.run), mode === "valid" || mode === "delivered");
    if (!h.run) assert.match(h.notice.text, /E_ALARM_MISSING/);
    assert.deepEqual(h.posts, [true]);
  });
}

test("duplicate alarm delivery cannot toggle the next phase early", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.advance(60000);
  await h.controller.tick("run-1");
  await h.controller.tick("run-1");
  assert.deepEqual(h.posts, [true, false]);
  assert.equal(h.run.phase, "off");
  assert.equal(h.alarms.get("run-1"), h.run.nextAt);
});

test("two-hour heartbeat is read-only and preserves both phase and scheduled switch", async () => {
  const h = harness();
  await h.controller.start(8, 240, 1);
  const before = { ...h.run };
  const alarmBefore = h.alarms.get("run-1");
  assert.deepEqual(h.keepAliveAlarms.get("run-1"), {
    scheduledTime: before.startedAt + 120 * 60_000, periodInMinutes: 120
  });
  let reads = 0;
  h.api.readStatus = async () => { reads++; return false; };
  h.api.readTimer = async () => { throw new Error("heartbeat must not read timer"); };
  h.advance(120 * 60_000);
  await h.controller.keepAlive("run-1");
  assert.equal(reads, 1);
  assert.deepEqual(h.posts, [true]);
  assert.deepEqual(h.run, before);
  assert.equal(h.alarms.get("run-1"), alarmBefore);
});

for (const code of ["E_PAGE_TIMEOUT", "E_PAGE_UNAVAILABLE", "E_API_TIMEOUT", "E_AUTH"]) {
  test(`${code} heartbeat failure warns once without stopping or retrying`, async () => {
    const h = harness();
    await h.controller.start(8, 240, 1);
    const before = { ...h.run };
    let reads = 0;
    h.api.readStatus = async () => { reads++; throw new CycleError(code, "test diagnostic"); };
    h.advance(120 * 60_000);
    await h.controller.keepAlive("run-1");
    assert.equal(reads, 1);
    assert.deepEqual(h.run, before);
    assert.deepEqual(h.posts, [true]);
    assert.equal(h.keepAliveNotice.at, before.startedAt + 120 * 60_000);
    assert.match((await h.controller.getView(8)).notice.text, new RegExp(code));
    assert.match(h.keepAliveNotice.text, /test diagnostic.*原循环仍运行/);
    assert.equal(h.keepAliveAlarms.size, 1);
  });
}

test("real request timeout aborts heartbeat I/O while retaining the control loop", async () => {
  const h = harness();
  await h.controller.start(8, 240, 1);
  let requestSignal;
  h.controller.api = createSchoolApi({
    getToken: async () => "test-token", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
    fetchImpl: async (_url, options) => { requestSignal = options.signal; return new Promise(() => {}); }
  });
  await h.controller.keepAlive("run-1");
  assert.equal(requestSignal.aborted, true);
  assert.match(h.keepAliveNotice.text, /E_API_TIMEOUT.*ac-status/);
  assert.equal(h.run.phase, "on");
  assert.deepEqual(h.posts, [true]);
});

test("successful heartbeat clears only its warning and preserves newer control notices", async () => {
  const h = harness();
  await h.controller.start(8, 240, 1);
  h.failRead = true;
  await h.controller.keepAlive("run-1");
  assert.equal((await h.controller.getView(8)).notice.kind, "warning");
  const controlNotice = { tabId: 8, kind: "error", text: "new control error" };
  await h.store.setNotice(controlNotice);
  await h.controller.keepAlive("run-1");
  assert.deepEqual((await h.controller.getView(8)).notice, controlNotice);
  h.failRead = false;
  await h.controller.keepAlive("run-1");
  assert.equal(h.keepAliveNotice, null);
  assert.deepEqual((await h.controller.getView(8)).notice, controlNotice);
});

for (const action of ["stop", "abandon", "initialize"]) {
  test(`${action} cancels heartbeat and stale delivery sends no school requests`, async () => {
    const h = harness();
    await h.controller.start(8, 240, 1);
    h.failRead = true;
    await h.controller.keepAlive("run-1");
    await h.controller[action](8);
    let reads = 0;
    h.api.readStatus = async () => { reads++; return true; };
    await h.controller.keepAlive("run-1");
    assert.equal(reads, 0);
    assert.equal(h.keepAliveAlarms.size, 0);
    assert.equal(h.keepAliveNotice, null);
    assert.equal(h.run, null);
    assert.deepEqual(h.posts, [true]);
  });
}

test("normal switching failure also removes heartbeat and its warning", async () => {
  const h = harness();
  await h.controller.start(8, 1, 1);
  h.failRead = true;
  await h.controller.keepAlive("run-1");
  h.advance(60_000);
  await h.controller.tick("run-1");
  assert.equal(h.run, null);
  assert.equal(h.keepAliveAlarms.size, 0);
  assert.equal(h.keepAliveNotice, null);
  assert.match(h.notice.text, /循环已停止/);
});

test("cancelled heartbeat's late reply cannot overwrite stop or a later cycle", async () => {
  let nextId = 0;
  const h = harness({ id: () => `run-${++nextId}` });
  await h.controller.start(8, 240, 1);
  let finish;
  h.api.readStatus = (_tab, signal) => bounded(() => new Promise(resolve => { finish = resolve; }), { signal });
  const heartbeat = h.controller.keepAlive("run-1");
  await new Promise(resolve => setImmediate(resolve));
  await h.controller.stop(8);
  await heartbeat;
  assert.match(h.notice.text, /循环已停止/);
  h.api.readStatus = async () => true;
  await h.controller.start(8, 240, 1);
  finish(false);
  await h.controller.keepAlive("run-1");
  assert.equal(h.run.id, "run-2");
  assert.equal(h.keepAliveNotice, null);
  assert.equal(h.keepAliveAlarms.has("run-1"), false);
  assert.equal(h.keepAliveAlarms.has("run-2"), true);
});

test("heartbeat rechecks identity after waiting behind a later cycle start", async () => {
  let nextId = 0;
  const h = harness({ id: () => `run-${++nextId}` });
  await h.controller.start(8, 240, 1);
  let release;
  const blocked = h.controller.enqueue(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const stopped = h.controller.stop(8);
  const started = h.controller.start(8, 240, 1);
  const heartbeat = h.controller.keepAlive("run-1");
  await new Promise(resolve => setImmediate(resolve));
  let reads = 0;
  h.api.readStatus = async () => { reads++; return true; };
  release();
  await Promise.all([blocked, stopped, started, heartbeat]);
  assert.equal(reads, 1, "only the later start reads status");
  assert.equal(h.run.id, "run-2");
  assert.equal(h.keepAliveNotice, null);
});

test("worker restores only missing heartbeat at original cadence without school requests", async () => {
  const h = harness();
  await h.controller.start(8, 600, 1);
  const before = { ...h.run };
  h.keepAliveAlarms.clear();
  h.advance(130 * 60_000);
  h.api.readStatus = async () => { throw new Error("must not contact school"); };
  await h.controller.reconcile();
  assert.deepEqual(h.run, before);
  assert.equal(h.keepAliveAlarms.get("run-1").scheduledTime, before.startedAt + 240 * 60_000);
  const scheduled = h.keepAliveAlarms.get("run-1");
  await h.controller.reconcile();
  assert.equal(h.keepAliveAlarms.get("run-1"), scheduled, "existing heartbeat is not reset");
  await h.controller.stop(8);
  await h.controller.reconcile();
  assert.equal(h.keepAliveAlarms.size, 0);
});

test("missing control alarm is never repaired by heartbeat recovery", async () => {
  const h = harness();
  await h.controller.start(8, 240, 1);
  h.alarms.clear();
  h.keepAliveAlarms.clear();
  await h.controller.reconcile();
  assert.equal(h.run, null);
  assert.equal(h.keepAliveAlarms.size, 0);
  assert.match(h.notice.text, /E_ALARM_MISSING/);
});

test("heartbeat scheduling timeout warns without poisoning subsequent switching", async () => {
  const h = harness({ localTimeoutMs: 10 });
  let finish;
  h.keepAliveAlarm.create = () => new Promise(resolve => { finish = resolve; });
  await h.controller.start(8, 1, 1);
  assert.match(h.keepAliveNotice.text, /E_LOCAL_TIMEOUT/);
  assert.equal(h.controller.writeFault, null);
  h.advance(60_000);
  await h.controller.tick("run-1");
  assert.equal(h.run.phase, "off");
  assert.deepEqual(h.posts, [true, false]);
  finish();
});

test("total heartbeat timeout warns and leaves stop available", async () => {
  const h = harness({ operationTimeoutMs: 15 });
  await h.controller.start(8, 240, 1);
  h.api.readStatus = (_tab, signal) => bounded(() => new Promise(() => {}), { signal });
  await h.controller.keepAlive("run-1");
  assert.match(h.keepAliveNotice.text, /E_OPERATION_TIMEOUT/);
  assert.equal(h.run.phase, "on");
  await h.controller.stop(8);
  assert.equal(h.run, null);
});

test("heartbeat snapshot timeout warns without contacting school or blocking stop", async () => {
  const h = harness({ localTimeoutMs: 10 });
  await h.controller.start(8, 240, 1);
  h.store.getState = () => new Promise(() => {});
  h.api.readStatus = async () => { throw new Error("must not contact school"); };
  await h.controller.keepAlive("run-1");
  assert.match(h.keepAliveNotice.text, /E_LOCAL_TIMEOUT.*getState/);
  assert.equal(h.run.phase, "on");
  assert.deepEqual(h.posts, [true]);
  await h.controller.stop(8);
  assert.equal(h.run, null);
});

test("502 snapshot captures the old cycle and actual last observation before cleanup", async () => {
  const reports = [];
  const h = harness({ report: value => { reports.push(globalThis.AirconReportFormat.makeReport(value)); return value.reportId; } });
  await h.controller.start(8, 3, 6);
  h.controller.api = createSchoolApi({ getToken: async () => "SENSITIVE_TEST_TOKEN", fetchImpl: async () => ({ ok: false, status: 502 }) });
  await h.controller.manualCheck(8);
  assert.equal(h.run, null);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].cycle.phase, "on");
  assert.equal(reports[0].cycle.onMinutes, 3);
  assert.equal(reports[0].lastConfirmedStatus.value, true);
  assert.equal(reports[0].requests[0].httpStatus, 502);
  assert.equal(reports[0].source, "manualCheck");
  assert.equal(JSON.stringify(reports).includes("SENSITIVE_TEST_TOKEN"), false);
});

test("start POST timeout preserves requested settings and distinguishes sent from confirmed", async () => {
  const reports = [];
  const h = harness({ report: value => { reports.push(globalThis.AirconReportFormat.makeReport(value)); return value.reportId; } });
  h.controller.api = createSchoolApi({ getToken: async () => "secret", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
    fetchImpl: async (url, options) => options.method === "POST" ? new Promise(() => {}) : {
      ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: url.endsWith("ac-status") ? { ac_status: { DisconnectRelay: false } } : {} })
    }
  });
  await assert.rejects(h.controller.start(8, 3, 6), { code: "E_API_TIMEOUT" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].cycle.onMinutes, 3);
  assert.deepEqual(reports[0].requestedDurations, { onMinutes: 3, offMinutes: 6 });
  assert.deepEqual(reports[0].switchCommand, { desiredOn: true, sent: true, confirmed: false });
  assert.equal(reports[0].outcomeUnknown, true);
  assert.equal(reports[0].lastConfirmedStatus.value, false);
});

test("throwing report callback cannot change control failure cleanup", async () => {
  const h = harness({ report: () => { throw new Error("report failed"); } });
  await h.controller.start(8, 1, 1);
  h.failRead = true;
  await h.controller.manualCheck(8);
  assert.equal(h.run, null);
  assert.match(h.notice.text, /无法确认空调状态/);
});

test("heartbeat fault records a snapshot but retains the original cycle", async () => {
  const reports = [];
  const h = harness({ report: value => { reports.push(globalThis.AirconReportFormat.makeReport(value)); return value.reportId; } });
  await h.controller.start(8, 240, 1);
  h.failRead = true;
  await h.controller.keepAlive("run-1");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "keepAlive");
  assert.equal(h.run.phase, "on");
  await h.controller.stop(8);
  assert.equal(reports.length, 1, "normal stop is not a fault");
});

test("late-alarm and missing-alarm paths each record their original cycle once", async () => {
  for (const mode of ["late", "missing"]) {
    const reports = [];
    const h = harness({ report: value => { reports.push(globalThis.AirconReportFormat.makeReport(value)); return value.reportId; } });
    await h.controller.start(8, 1, 1);
    if (mode === "late") { h.advance(121_000); await h.controller.tick("run-1"); }
    else { h.alarms.clear(); await h.controller.reconcile(); }
    assert.equal(reports.length, 1);
    assert.equal(reports[0].error.code, mode === "late" ? "E_ALARM_LATE" : "E_ALARM_MISSING");
    assert.equal(reports[0].cycle.phase, "on");
    assert.equal(h.run, null);
  }
});

for (const bodyHangs of [false, true]) {
  test(`manual ${bodyHangs ? "body" : "headers"} timeout retries once then stops without POST or late recovery`, async () => {
    const reports = [];
    const h = harness({ report: value => { reports.push(globalThis.AirconReportFormat.makeReport(value, { version: "1.1.9" })); return value.reportId; } });
    await h.controller.start(8, 2, 5);
    const previousPosts = [...h.posts];
    let finish;
    let transport;
    const calls = [];
    const late = new Promise(resolve => { finish = resolve; });
    h.controller.api = createSchoolApi({ getToken: async () => "SECRET_TOKEN", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
      fetchImpl: async (_url, options) => {
        calls.push(options.method);
        transport = options.signal;
        return bodyHangs ? { ok: true, status: 200, json: () => late } : late;
      }
    });
    await h.controller.manualCheck(8, { manualCheck: { trigger: "click", observedOn: true } });
    assert.equal(h.run, null);
    assert.equal(h.alarms.size, 0);
    assert.equal(h.keepAliveAlarms.size, 0);
    assert.equal(transport.aborted, true);
    assert.match(h.notice.text, /无法确认空调状态，循环已停止.*E_API_TIMEOUT/);
    assert.deepEqual(calls, ["GET", "GET"]);
    assert.deepEqual(h.posts, previousPosts, "no cleanup switch request");
    assert.equal(reports.length, 1);
    const report = reports[0];
    assert.equal(report.extensionVersion, "1.1.9");
    assert.equal(report.cycle.onMinutes, 2);
    assert.equal(report.cycle.offMinutes, 5);
    assert.equal(report.requests[0].phase, bodyHangs ? "body" : "headers");
    assert.equal(report.requests[0].httpStatus, bodyHangs ? 200 : null);
    assert.deepEqual(report.requests.map(trace => trace.attempt), [1, 2]);
    assert.ok(report.requests.every(trace => trace.errorCode === "E_API_TIMEOUT" && Number.isFinite(trace.elapsedMs)));
    assert.deepEqual(report.manualCheck, { trigger: "click", observedOn: true });
    assert.equal(report.switchCommand, null);
    assert.equal(report.outcomeUnknown, false);
    assert.equal(report.lastConfirmedStatus.value, true, "last observation remains historical");
    const before = JSON.stringify(reports);
    finish(bodyHangs ? { meta: { code: 200 }, data: { ac_status: { DisconnectRelay: true } } }
      : { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: { ac_status: { DisconnectRelay: true } } }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.run, null);
    assert.equal(h.alarms.size, 0);
    assert.equal(JSON.stringify(reports), before);
    assert.deepEqual(calls, ["GET", "GET"]);
    assert.deepEqual(h.posts, previousPosts);
    assert.equal(before.includes("SECRET_TOKEN"), false);
  });
}

for (const source of ["start", "manualCheck", "keepAlive", "updateDurations"]) test(`${source} HTTP 502 does not enter automatic tick recovery`, async () => {
  const reports = [];
  const h = harness({ report: draft => { reports.push(draft); return draft.reportId; } });
  if (source !== "start") await h.controller.start(8, 2, 4);
  let calls = 0;
  h.controller.api = createSchoolApi({ getToken: async () => "mock", fetchImpl: async () => { calls++; return { ok: false, status: 502 }; } });
  if (source === "start") await assert.rejects(h.controller.start(8, 2, 4), { code: "E_HTTP" });
  else if (source === "manualCheck") await h.controller.manualCheck(8);
  else if (source === "keepAlive") await h.controller.keepAlive("run-1");
  else {
    h.advance(90000);
    await assert.rejects(h.controller.updateDurations(8, { runId: h.run.id, timingRevision: h.run.timingRevision, onMinutes: 1, offMinutes: 4 }), { code: "E_HTTP" });
  }
  assert.equal(h.run?.queryRecovery ?? null, null);
  assert.ok(reports.every(report => !report.queryRecovery));
  assert.ok(calls > 0 && calls <= 2);
});

test("30s operation budget aborts a 15s POST after slow preflight without resend", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const h = harness({ clock: () => Date.now() }); await h.controller.start(8, 2, 4);
  t.mock.timers.tick(120000);
  const reads = new Map(); let postCalls = 0, postSignal, finishPost;
  h.controller.api = createSchoolApi({ getToken: async () => "mock", performanceImpl: { now: () => Date.now() }, fetchImpl: async (url, options) => {
    if (options.method === "POST") {
      postCalls++; postSignal = options.signal; return new Promise(resolve => { finishPost = resolve; });
    }
    const path = url.split("/").at(-1), attempt = (reads.get(path)?.attempt ?? 0) + 1;
    return new Promise(resolve => reads.set(path, { attempt, resolve }));
  } });
  const task = h.controller.tick(h.run.id, h.run.nextAt);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(7900);
  for (const { attempt, resolve } of reads.values()) { assert.equal(attempt, 2); resolve(schoolReply({ ac_status: { DisconnectRelay: true } })); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(postCalls, 1);
  t.mock.timers.tick(14100); await task;
  assert.equal(postSignal.aborted, true); assert.equal(h.run, null);
  assert.equal(h.notice.outcomeUnknown, true); assert.match(h.notice.text, /E_OPERATION_TIMEOUT/);
  finishPost(schoolReply({ ac_toggle: { Message: "Execution succeeded" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(postCalls, 1); assert.equal(h.run, null);
});

test("POST HTTP 502 is unknown and never enters preflight recovery", async () => {
  const h = harness(); await h.controller.start(8, 2, 4); h.advance(120000);
  let posts = 0;
  h.controller.api = createSchoolApi({ getToken: async () => "mock", fetchImpl: async (_url, options) => {
    if (options.method === "POST") { posts++; return { ok: false, status: 502 }; }
    return schoolReply({ ac_status: { DisconnectRelay: true } });
  } });
  await h.controller.tick("run-1");
  assert.equal(h.run, null); assert.equal(posts, 1); assert.equal(h.notice.outcomeUnknown, true);
});
