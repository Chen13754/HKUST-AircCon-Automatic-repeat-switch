import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "./storage-fixture.js";
import { bounded } from "../errors.js";

const home = "https://w5.ab.ust.hk/njggt/app/home";
const flush = () => new Promise(resolve => setImmediate(resolve));
let imports = 0;

async function harness(t, holdAlarmRead = false) {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  const run = { id: "alarm-race", tabId: 8, onMinutes: 1, offMinutes: 120, phase: "on", expectedOn: true,
    startedAt: Date.now() - 60_000, nextAt: Date.now() - 5 };
  const session = { cycleRun: run }, local = {}, alarms = new Map(), posts = [];
  let listener, onAlarm, actual = true, release;
  globalThis.chrome = {
    storage: { session: memoryStorage(session), local: memoryStorage(local) },
    runtime: { id: "alarm-race", onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      get: async () => ({ url: home }), sendMessage: async (_tab, msg) => msg.type === "aircon:getToken" ? { token: "fake-test-token" } : undefined,
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
    },
    alarms: {
      get: async name => holdAlarmRead && name.startsWith("cycle:") ? new Promise(resolve => { release = () => resolve(undefined); }) : alarms.get(name),
      create: async (name, item) => alarms.set(name, { ...item, scheduledTime: item.when }), clear: async name => alarms.delete(name),
      onAlarm: { addListener(fn) { onAlarm = fn; } }
    }
  };
  globalThis.fetch = async (url, options) => {
    if (options.method === "POST") { actual = JSON.parse(options.body).toggle.status === 1; posts.push(actual); }
    const data = url.endsWith("ac-status") ? { ac_status: { DisconnectRelay: actual } } : url.endsWith("toggle-status") ? { ac_toggle: { Message: "Execution succeeded" } } : {};
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) };
  };
  await import(`../background.js?alarm-race-${++imports}`);
  return { session, local, alarms, posts, run,
    read: () => new Promise(resolve => listener({ type: "aircon:getState" }, { id: "alarm-race", frameId: 0, url: home, tab: { id: 8, url: home } }, resolve)),
    deliver: (scheduledTime = run.nextAt) => onAlarm({ name: `cycle:${run.id}`, scheduledTime }),
    release: () => release(),
    until: condition => bounded(async () => { while (!condition()) await flush(); }, { ms: 1000 }),
    get waitingForAlarmRead() { return Boolean(release); } };
}

for (const first of ["state", "alarm", "during-read"]) {
  test(`cold worker handles delivery ${first} without a false missing-alarm report`, async t => {
    const h = await harness(t, first === "during-read");
    let response;
    if (first === "alarm") { h.deliver(); response = h.read(); }
    else {
      response = h.read();
      if (first === "during-read") await h.until(() => h.waitingForAlarmRead);
      h.deliver();
      if (first === "during-read") h.release();
    }
    await response;
    await h.until(() => h.session.cycleRun?.phase === "off");
    assert.deepEqual(h.posts, [false]);
    assert.equal(Object.values(h.local).some(entry => entry?.report?.error.code === "E_ALARM_MISSING"), false);
  });
}

for (const event of ["missing", "stale"]) {
  test(`${event} delivery cannot exempt a genuinely missing current alarm`, async t => {
    const h = await harness(t);
    const response = h.read();
    if (event === "stale") h.deliver(h.run.nextAt - 60_000);
    await response; await flush();
    assert.equal(h.session.cycleRun, undefined);
    assert.match(h.session.cycleNotice.text, /E_ALARM_MISSING/);
    assert.deepEqual(h.posts, []);
  });
}

test("duplicate delivered alarms perform one switch and retain the next schedule", async t => {
  const h = await harness(t);
  const response = h.read();
  h.deliver(); h.deliver();
  await response;
  await h.until(() => h.session.cycleRun?.phase === "off");
  await flush();
  assert.deepEqual(h.posts, [false]);
  assert.equal(h.alarms.get(`cycle:${h.run.id}`).scheduledTime, h.session.cycleRun.nextAt);
});
