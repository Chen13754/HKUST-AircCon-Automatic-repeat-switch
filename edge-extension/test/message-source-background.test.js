import test from "node:test";
import assert from "node:assert/strict";
import { bounded } from "../errors.js";

const home = "https://w5.ab.ust.hk/njggt/app/home";
const login = "https://w5.ab.ust.hk/njggt/app/login";
const validSender = () => ({ id: "source-test", frameId: 0, tab: { id: 8, url: home }, url: home });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("duration message updates defaults, returns authoritative conflicts and ignores forged sender", async t => {
  const h = await harness(t);
  const now = Date.now();
  const run = { id: "editable-cycle", tabId: 8, phase: "on", expectedOn: true, startedAt: now,
    phaseStartedAt: now, onMinutes: 10, offMinutes: 10, nextAt: now + 600000, timingRevision: 0 };
  h.session.cycleRun = structuredClone(run);
  h.alarms.set(`cycle:${run.id}`, { scheduledTime: run.nextAt });
  const request = { runId: run.id, timingRevision: 0, onMinutes: 12, offMinutes: 4 };
  const refused = await h.send({ ...validSender(), frameId: 1 }, "aircon:updateDurations", request);
  assert.equal(refused.reply.code, "E_MESSAGE_SOURCE"); assert.deepEqual(h.session.cycleRun, run);
  const { reply } = await h.send(validSender(), "aircon:updateDurations", { ...request, reportId: "accepted-edit" });
  assert.equal(reply.ok, true); assert.equal(reply.view.run.timingRevision, 1);
  assert.equal(reply.view.run.phaseStartedAt, now);
  assert.deepEqual(h.local.cycleDurations, { onMinutes: 12, offMinutes: 4 });
  const conflict = await h.send(validSender(), "aircon:updateDurations", { ...request, onMinutes: 5, reportId: "stale-edit" });
  assert.equal(conflict.reply.code, "E_TIMING_STALE");
  assert.equal(conflict.reply.view.run.onMinutes, 12);
  assert.deepEqual(h.local.cycleDurations, { onMinutes: 12, offMinutes: 4 });
  assert.equal(h.stats.schoolRequests, 0);
});
let imports = 0;

async function harness(t) {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; });
  const local = {}, session = {};
  const stats = { sessionReads: 0, schoolRequests: 0, optionsOpened: 0 };
  const alarms = new Map();
  let listener;
  const storage = (data, countReads = false) => ({
    get: async key => {
      if (countReads) stats.sessionReads++;
      return structuredClone(key === null ? data : Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, data[name]])));
    },
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async key => { for (const name of Array.isArray(key) ? key : [key]) delete data[name]; }
  });
  globalThis.chrome = {
    storage: { local: storage(local), session: storage(session, true) },
    tabs: { get: async () => ({ url: home }), sendMessage: async () => undefined, onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name), onAlarm: { addListener() {} } },
    runtime: {
      id: "source-test", getManifest: () => ({ version: "1.1.7" }), getURL: file => `chrome-extension://source-test/${file}`,
      openOptionsPage: async () => { stats.optionsOpened++; }, sendMessage: async () => undefined,
      onMessage: { addListener(fn) { listener = fn; } }
    }
  };
  globalThis.fetch = async () => { stats.schoolRequests++; throw new Error("No school requests expected"); };
  await import(`../background.js?message-source-${++imports}`);
  return { local, session, alarms, stats, listener: (...args) => listener(...args),
    send: async (sender, type = "aircon:initialize", data = {}) => {
      let returned;
      const reply = await bounded(() => new Promise(resolve => {
        returned = listener({ type, reportId: "source-report", startedAt: Date.now(), onMinutes: 3, offMinutes: 6, ...data }, sender, resolve);
      }), { ms: 1000 });
      return { reply, returned };
    }
  };
}

for (const [name, source, tabUrl = home] of [
  ["direct home", home], ["login SPA navigation", login],
  ["CAS callback SPA navigation", "https://w5.ab.ust.hk/njggt/app/callback/cas?ticket=SECRET"],
  ["home with trailing slash and query", `${home}/?SECRET`, `${home}/?SECRET`]
]) {
  test(`${name} initializes once using the current tab route without school requests`, async t => {
    const h = await harness(t);
    const { reply, returned } = await h.send({ ...validSender(), url: source, tab: { id: 8, url: tabUrl } });
    assert.equal(returned, true, "keep the asynchronous reply channel open");
    assert.equal(reply.ok, true);
    assert.equal(reply.view.run, null);
    assert.equal(h.stats.schoolRequests, 0);
    assert.equal(Object.keys(h.local).filter(key => key.startsWith("airconErrorReport:")).length, 0);
  });
}

const rejected = [
  ["left home", () => ({ ...validSender(), tab: { id: 8, url: login } }), "TAB_NOT_HOME", "HOME", false],
  ["missing tab URL", () => ({ ...validSender(), tab: { id: 8 } }), "TAB_URL_MISSING", "HOME", null],
  ["missing source URL", () => ({ ...validSender(), url: undefined }), "SOURCE_REJECTED", "MISSING", true],
  ["foreign source", () => ({ ...validSender(), url: "https://example.com/?SECRET" }), "SOURCE_REJECTED", "OTHER", true],
  ["source outside school app", () => ({ ...validSender(), url: "https://w5.ab.ust.hk/elsewhere" }), "SOURCE_REJECTED", "OTHER", true],
  ["other extension", () => ({ ...validSender(), id: "another-extension" }), "EXTENSION_MISMATCH", "HOME", true],
  ["child frame", () => ({ ...validSender(), frameId: 1 }), "FRAME_REJECTED", "HOME", true],
  ["missing frame", () => ({ ...validSender(), frameId: undefined }), "FRAME_REJECTED", "HOME", true],
  ["missing tab", () => ({ ...validSender(), tab: undefined }), "TAB_ID_MISSING", "HOME", null]
];
for (const [name, sender, reason, sourcePage, tabIsHome] of rejected) {
  test(`${name} gets an explicit refusal without reading or changing the existing cycle`, async t => {
    const h = await harness(t);
    h.session.cycleRun = { id: "running-cycle", tabId: 8, phase: "on", nextAt: Date.now() + 60000 };
    h.alarms.set("cycle:running-cycle", { when: h.session.cycleRun.nextAt });
    const before = structuredClone(h.session);
    const { reply, returned } = await h.send(sender(), "aircon:start");
    assert.equal(returned, false, "a refusal replies synchronously");
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "E_MESSAGE_SOURCE");
    assert.match(reply.error, /本次指令未执行/);
    assert.equal(reply.reportId, "source-report");
    assert.deepEqual(h.session, before);
    assert.equal(h.alarms.size, 1);
    assert.equal(h.stats.sessionReads, 0);
    assert.equal(h.stats.schoolRequests, 0);
    assert.equal(h.stats.optionsOpened, 0);
    await bounded(async () => { while (!h.local["airconErrorReport:source-report"]) await flush(); }, { ms: 1000 });
    const report = h.local["airconErrorReport:source-report"].report;
    assert.equal(report.extensionVersion, "1.1.7");
    assert.equal(report.error.code, "E_MESSAGE_SOURCE");
    assert.equal(report.outcomeUnknown, false);
    assert.deepEqual(report.communication, { messageType: "aircon:start", reason, sourcePage, tabIsHome });
    assert.equal(JSON.stringify(h.local).includes("SECRET"), false);
  });
}

test("a message claiming a home URL cannot override the browser's non-home tab URL", async t => {
  const h = await harness(t);
  const { reply } = await h.send({ ...validSender(), tab: { id: 8, url: login } }, "aircon:start", { url: home, tabUrl: home });
  assert.equal(reply.code, "E_MESSAGE_SOURCE");
  assert.match(reply.error, /TAB_NOT_HOME/);
  assert.equal(h.stats.sessionReads, 0);
  assert.equal(h.stats.schoolRequests, 0);
});

test("report settings can open after SPA navigation, but not after leaving home", async t => {
  const h = await harness(t);
  const accepted = await h.send({ ...validSender(), url: login }, "aircon:openReportSettings");
  assert.equal(accepted.returned, true);
  assert.equal(accepted.reply.ok, true);
  assert.equal(h.stats.optionsOpened, 1);
  const rejected = await h.send({ ...validSender(), tab: { id: 8, url: login } }, "aircon:openReportSettings");
  assert.equal(rejected.reply.code, "E_MESSAGE_SOURCE");
  assert.equal(h.stats.optionsOpened, 1);
  assert.equal(h.stats.schoolRequests, 0);
});

test("unknown notifications are ignored without producing source errors", async t => {
  const h = await harness(t);
  let responded = false;
  assert.equal(h.listener({ type: "aircon:reportStatusChanged" }, {}, () => { responded = true; }), false);
  assert.equal(responded, false);
  assert.equal(h.stats.sessionReads, 0);
  assert.equal(Object.keys(h.local).length, 0);
});

test("a stale getState after navigation is rejected without a second incident report", async t => {
  const h = await harness(t);
  const result = await h.send({ ...validSender(), tab: { id: 8, url: login } }, "aircon:getState");
  assert.equal(result.reply.code, "E_MESSAGE_SOURCE");
  assert.equal(result.reply.reportId, null);
  await flush();
  assert.equal(Object.values(h.local).filter(value => value?.report).length, 0);
  assert.equal(h.stats.schoolRequests, 0);
});
