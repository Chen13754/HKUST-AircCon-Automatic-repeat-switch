import test from "node:test";
import assert from "node:assert/strict";
import { bounded } from "../errors.js";
import { memoryStorage } from "./storage-fixture.js";

test("background integration returns promptly despite unresponsive UI notification or settings save", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let listener;
  let on = false;
  const posts = [];
  const session = {};
  const alarms = new Map();
  let alarmReads = 0;
  let snapshotReads = 0;
  const localArea = memoryStorage();
  globalThis.chrome = {
    storage: {
      session: {
        get: async key => {
          if (Array.isArray(key)) snapshotReads++;
          return Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, session[item]]));
        },
        set: async entries => Object.assign(session, entries),
        remove: async key => { delete session[key]; }
      },
      local: { ...localArea, set: values => values.cycleDurations ? new Promise(() => {}) : localArea.set(values) }
    },
    tabs: {
      get: async () => ({ url: "https://w5.ab.ust.hk/njggt/app/home" }),
      sendMessage: async (_tab, message) => message.type === "aircon:getToken" ? { token: "fake-test-token" } : new Promise(() => {}),
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
    },
    alarms: {
      get: async name => { alarmReads++; const item = alarms.get(name); return item && { scheduledTime: item.when }; },
      create: async (name, alarm) => alarms.set(name, alarm),
      clear: async name => alarms.delete(name), onAlarm: { addListener() {} }
    },
    runtime: { id: "background-test", onMessage: { addListener(fn) { listener = fn; } } }
  };
  globalThis.fetch = async (url, options) => {
    let data = {};
    if (url.endsWith("ac-status")) data = { ac_status: { DisconnectRelay: on } };
    if (url.endsWith("toggle-status")) {
      on = Boolean(JSON.parse(options.body).toggle.status);
      posts.push(on);
      data = { ac_toggle: { Message: "Execution succeeded" } };
    }
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) };
  };
  try {
    await import("../background.js");
    const send = type => new Promise(resolve => listener({ type, onMinutes: 1, offMinutes: 1 }, {
      id: "background-test", frameId: 0, tab: { id: 8, url: "https://w5.ab.ust.hk/njggt/app/home" }, url: "https://w5.ab.ust.hk/njggt/app/home"
    }, resolve));
    const started = await send("aircon:start");
    assert.equal(started.ok, true);
    assert.equal(started.view.run.phase, "on");
    assert.equal(alarms.size, 2);
    await import("../background.js?worker-restart-valid");
    const resumed = await send("aircon:getState");
    assert.equal(resumed.view.run.phase, "on");
    const snapshotsBefore = snapshotReads;
    await send("aircon:getState");
    assert.equal(snapshotReads - snapshotsBefore, 1, "one storage snapshot per state reply");
    assert.equal(alarmReads, 3, "startup heartbeat lookup plus one reconciliation of both alarms");
    const stopped = await send("aircon:stop");
    assert.equal(stopped.ok, true);
    assert.equal(stopped.view.run, null);
    assert.equal(alarms.size, 0);
    assert.equal(on, true);
    assert.deepEqual(posts, [true]);
    await send("aircon:start");
    alarms.clear();
    await import("../background.js?worker-restart-missing");
    const missing = await send("aircon:getState");
    assert.equal(missing.ok, true);
    assert.equal(missing.view.run, null);
    assert.match(missing.view.notice.text, /E_ALARM_MISSING/);
    assert.deepEqual(posts, [true], "startup recovery must not issue school switches");
    await send("aircon:start");
    await import("../background.js?worker-cold-stop");
    const readsBeforeStop = alarmReads;
    assert.equal((await send("aircon:stop")).view.run, null);
    assert.equal(alarmReads, readsBeforeStop, "stop bypasses startup alarm checks");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("cold worker woken by consumed alarm completes one transition without a missing-alarm false positive", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const session = { cycleRun: { id: "wake-test", tabId: 8, onMinutes: 1, offMinutes: 1,
    phase: "on", expectedOn: true, nextAt: Date.now() - 100 } };
  let onAlarm;
  let on = true;
  let alarmReads = 0;
  let notify;
  const notified = new Promise(resolve => { notify = resolve; });
  const posts = [];
  const alarms = new Map();
  globalThis.chrome = {
    storage: {
      session: {
        get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, session[item]])),
        set: async entries => Object.assign(session, entries),
        remove: async key => { delete session[key]; }
      }, local: memoryStorage()
    },
    tabs: {
      get: async () => ({ url: "https://w5.ab.ust.hk/njggt/app/home" }),
      sendMessage: async (_tab, message) => {
        if (message.type === "aircon:getToken") return { token: "fake-test-token" };
        notify();
      },
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
    },
    alarms: {
      get: async () => { alarmReads++; return undefined; },
      create: async (name, item) => alarms.set(name, item),
      clear: async name => alarms.delete(name),
      onAlarm: { addListener(fn) { onAlarm = fn; } }
    },
    runtime: { onMessage: { addListener() {} } }
  };
  globalThis.fetch = async (url, options) => {
    let data = {};
    if (url.endsWith("ac-status")) data = { ac_status: { DisconnectRelay: on } };
    if (url.endsWith("toggle-status")) {
      on = Boolean(JSON.parse(options.body).toggle.status);
      posts.push(on);
      data = { ac_toggle: { Message: "Execution succeeded" } };
    }
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) };
  };
  try {
    await import("../background.js?worker-woken-by-alarm");
    onAlarm({ name: "cycle:wake-test", scheduledTime: session.cycleRun.nextAt });
    await bounded(() => notified, { ms: 1000 });
    assert.equal(alarmReads, 1, "only the independent heartbeat alarm is checked");
    assert.equal(session.cycleRun.phase, "off");
    assert.deepEqual(posts, [false]);
    assert.equal(alarms.size, 2);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
