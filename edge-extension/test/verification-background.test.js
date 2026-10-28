import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "./storage-fixture.js";

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test("background POST timeout performs only four read-only probes and keeps stopped uncertainty through export", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  const session = {}, local = {}, alarms = new Map(), calls = [];
  let listener, alarmListener, on = true;
  globalThis.chrome = {
    storage: { session: memoryStorage(session), local: memoryStorage(local) },
    runtime: { id: "verification-test", getManifest: () => ({ version: "1.1.20" }), onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { get: async () => ({ url: "https://w5.ab.ust.hk/njggt/app/home" }),
      sendMessage: async (_tab, message, options) => {
        if (message.type !== "aircon:getToken") return;
        assert.equal(options.documentId, "document-1"); return { token: "fake" };
      }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { get: async id => alarms.get(id), create: async (id, value) => alarms.set(id, { scheduledTime: value.when }),
      clear: async id => alarms.delete(id), onAlarm: { addListener(fn) { alarmListener = fn; } } }
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ path: url.split("/").at(-1), method: options.method });
    if (options.method === "POST") { on = false; return new Promise(() => {}); }
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: { ac_status: { DisconnectRelay: on } } }) };
  };
  const send = type => new Promise(resolve => listener({ type, onMinutes: 1, offMinutes: 1 }, {
    id: "verification-test", frameId: 0, documentId: "document-1", url: "https://w5.ab.ust.hk/njggt/app/home",
    tab: { id: 8, url: "https://w5.ab.ust.hk/njggt/app/home" }
  }, resolve));
  try {
    await import("../background.js?verification-integration");
    const started = await send("aircon:start"); assert.equal(started.ok, true);
    const run = started.view.run;
    t.mock.timers.tick(60000);
    alarmListener({ name: `cycle:${run.id}`, scheduledTime: run.nextAt }); await flush();
    assert.equal(calls.filter(c => c.method === "POST").length, 1);
    t.mock.timers.tick(15000); await flush();
    const waiting = await send("aircon:getState");
    assert.equal(waiting.view.run, null); assert.equal(waiting.view.notice.outcomeUnknown, true);
    assert.equal(waiting.view.postCommandVerification.state, "waiting");
    assert.equal(waiting.view.postCommandVerification.rounds[0].actualOn, false);
    const v = waiting.view.postCommandVerification, before = calls.length;
    // Ordinary state polling does not cancel observation. Worker wake retains identity and deadline.
    await import("../background.js?verification-wake");
    assert.equal((await send("aircon:getState")).view.postCommandVerification.deadlineAt, v.deadlineAt);
    t.mock.timers.tick(30000);
    alarmListener({ name: `verification:${v.reportId}`, scheduledTime: v.nextAt }); await flush();
    alarmListener({ name: `verification:${v.reportId}`, scheduledTime: v.nextAt }); await flush();
    assert.equal(calls.length - before, 2); assert.equal(calls.filter(c => c.method === "POST").length, 1);
    const done = await send("aircon:getState");
    assert.equal(done.view.run, null); assert.equal(done.view.notice.outcomeUnknown, true);
    assert.equal(done.view.postCommandVerification.state, "completed");
    const report = local[`airconErrorReport:${v.reportId}`].report;
    assert.equal(report.postCommandVerification.rounds.length, 2);
    assert.equal(report.error.code, "E_API_TIMEOUT"); assert.equal(report.switchCommand.confirmed, false);
    assert.equal(report.outcomeUnknown, true); assert.equal(report.requests.filter(r => r.method === "POST").length, 1);
    const stopped = await send("aircon:stop"); assert.equal(stopped.view.postCommandVerification, null);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
