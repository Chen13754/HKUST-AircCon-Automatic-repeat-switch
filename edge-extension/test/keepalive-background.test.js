import test from "node:test";
import assert from "node:assert/strict";
import { bounded } from "../errors.js";
import { memoryStorage } from "./storage-fixture.js";

let imports = 0;
const home = "https://w5.ab.ust.hk/njggt/app/home";
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(t, initialRun) {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; });
  const session = initialRun ? { cycleRun: initialRun } : {};
  const alarms = new Map();
  const requests = [];
  const tokenReads = [];
  const alarmReads = [];
  let on = true;
  let listener, onAlarm, onRemoved, onUpdated;
  let token = "first-token";
  let failure = false;
  globalThis.chrome = {
    storage: {
      session: {
        get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, session[item]])),
        set: async entries => Object.assign(session, entries),
        remove: async key => { delete session[key]; }
      },
      local: memoryStorage()
    },
    tabs: {
      get: async () => ({ url: home }),
      sendMessage: async (_tab, message) => {
        if (message.type === "aircon:getToken") { tokenReads.push(token); return { token }; }
      },
      onRemoved: { addListener(fn) { onRemoved = fn; } },
      onUpdated: { addListener(fn) { onUpdated = fn; } }
    },
    alarms: {
      get: async name => { alarmReads.push(name); return alarms.get(name); },
      create: async (name, item) => alarms.set(name, { ...item, scheduledTime: item.when }),
      clear: async name => alarms.delete(name),
      onAlarm: { addListener(fn) { onAlarm = fn; } }
    },
    runtime: { id: "keepalive-test", onMessage: { addListener(fn) { listener = fn; } } }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (failure) return { ok: false, status: 401 };
    let data = {};
    if (url.endsWith("ac-status")) data = { ac_status: { DisconnectRelay: on } };
    if (url.endsWith("toggle-status")) {
      on = Boolean(JSON.parse(options.body).toggle.status);
      data = { ac_toggle: { Message: "Execution succeeded" } };
    }
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) };
  };
  await import(`../background.js?keepalive-integration-${++imports}`);
  return {
    session, alarms, requests, tokenReads, alarmReads,
    set token(value) { token = value; }, set failure(value) { failure = value; },
    alarm: name => onAlarm({ name, scheduledTime: alarms.get(name)?.scheduledTime ?? session.cycleRun?.nextAt }), removed: () => onRemoved(8), updated: change => onUpdated(8, change),
    send: (type, data = {}) => new Promise(resolve => listener({ type, onMinutes: 240, offMinutes: 1, ...data }, { id: "keepalive-test", frameId: 0, tab: { id: 8, url: home }, url: home }, resolve)),
    async until(condition) {
      await bounded(async () => { while (!condition()) await flush(); }, { ms: 1000 });
      await flush();
    }
  };
}

test("background heartbeat uses fresh token and only GETs status without initializing", async t => {
  const h = await harness(t);
  await h.send("aircon:start");
  const before = { ...h.session.cycleRun };
  const heartbeat = `keepalive:${before.id}`;
  assert.equal(h.alarms.get(heartbeat).periodInMinutes, 120);
  assert.equal(h.alarms.get(heartbeat).when, before.startedAt + 120 * 60_000);
  h.requests.length = 0;
  h.tokenReads.length = 0;
  h.token = "new-token-from-page";
  h.alarm(heartbeat);
  await h.until(() => h.requests.length === 1);
  assert.equal(h.requests[0].method, "GET");
  assert.ok(h.requests[0].url.endsWith("/app/prepaid/ac-status"));
  assert.equal(h.requests[0].headers.Authorization, "Bearer new-token-from-page");
  assert.deepEqual(h.tokenReads, ["new-token-from-page"]);
  assert.deepEqual(h.session.cycleRun, before);
  h.failure = true;
  h.alarm(heartbeat);
  await h.until(() => h.session.keepAliveNotice);
  const failed = await h.send("aircon:getState");
  assert.equal(failed.view.run.id, before.id);
  assert.match(failed.view.notice.text, /E_AUTH.*原循环仍运行/);
  assert.equal(h.requests.length, 2, "failed heartbeat is not retried");
  h.failure = false;
  h.alarm(heartbeat);
  await h.until(() => !h.session.keepAliveNotice);
  assert.deepEqual(h.session.cycleRun, before);
});

for (const event of ["stop", "removed", "navigate"]) {
  test(`${event} removes heartbeat; a stale browser alarm performs no requests`, async t => {
    const h = await harness(t);
    await h.send("aircon:start");
    const id = h.session.cycleRun.id;
    if (event === "stop") await h.send("aircon:stop");
    if (event === "removed") h.removed();
    if (event === "reload") h.updated({ status: "loading" });
    if (event === "navigate") h.updated({ url: "https://w5.ab.ust.hk/njggt/app/top-up" });
    await h.until(() => !h.session.cycleRun && h.alarms.size === 0);
    h.requests.length = 0;
    h.alarm(`keepalive:${id}`);
    await flush();
    await flush();
    assert.equal(h.requests.length, 0);
    assert.equal(h.alarms.size, 0);
  });
}

for (const heartbeatFirst of [true, false]) {
  test(`cold worker handles simultaneous alarms, heartbeat ${heartbeatFirst ? "first" : "second"}`, async t => {
    const run = { id: "simultaneous", tabId: 8, startedAt: Date.now() - 120 * 60_000,
      onMinutes: 120, offMinutes: 1, phase: "on", expectedOn: true, nextAt: Date.now() - 10 };
    const h = await harness(t, run);
    h.alarms.set("keepalive:simultaneous", { scheduledTime: Date.now() + 120 * 60_000, periodInMinutes: 120 });
    const events = ["keepalive:simultaneous", "cycle:simultaneous"];
    if (!heartbeatFirst) events.reverse();
    for (const event of events) h.alarm(event);
    await h.until(() => h.session.cycleRun?.phase === "off" && h.alarms.has("cycle:simultaneous"));
    const posts = h.requests.filter(item => item.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].body), { toggle: { status: 0 } });
    assert.equal(h.alarmReads.includes("cycle:simultaneous"), false, "only real cycle delivery exempts the consumed alarm");
    assert.equal(h.session.cycleNotice?.kind === "error", false);
  });
}

test("heartbeat waking a cold worker cannot exempt or restore a missing control alarm", async t => {
  const run = { id: "missing", tabId: 8, startedAt: Date.now(), onMinutes: 240, offMinutes: 1,
    phase: "on", expectedOn: true, nextAt: Date.now() + 240 * 60_000 };
  const h = await harness(t, run);
  h.alarms.set("keepalive:missing", { periodInMinutes: 120 });
  h.alarm("keepalive:missing");
  await h.until(() => h.requests.length === 1);
  const reply = await h.send("aircon:getState");
  assert.equal(reply.view.run, null);
  assert.match(reply.view.notice.text, /E_ALARM_MISSING/);
  assert.equal([...h.alarms.keys()].filter(name => !name.startsWith("followup:")).length, 0);
  assert.equal(h.requests.some(item => item.method === "POST"), false);
});
