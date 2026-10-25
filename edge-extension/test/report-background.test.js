import test from "node:test";
import assert from "node:assert/strict";

test("background persists 502 snapshots, filters manual-check metadata and restricts settings messages", async t => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; });
  const local = {};
  const session = {};
  const alarms = new Map();
  const requests = [];
  let listener;
  let fail = false;
  let opened = 0;
  const storage = data => ({
    get: async key => structuredClone(key === null ? data : Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, data[item]]))),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  });
  globalThis.chrome = {
    storage: { local: storage(local), session: storage(session) },
    tabs: {
      get: async () => ({ url: "https://w5.ab.ust.hk/njggt/app/home" }),
      sendMessage: async (_tab, message) => message.type === "aircon:getToken" ? { token: "SENSITIVE_TOKEN" } : undefined,
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
    },
    alarms: {
      get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, { ...value, scheduledTime: value.when }),
      clear: async name => alarms.delete(name), onAlarm: { addListener() {} }
    },
    runtime: {
      id: "report-test", getURL: file => `chrome-extension://report-test/${file}`, getManifest: () => ({ version: "1.1.9" }),
      sendMessage: async () => undefined, openOptionsPage: async () => { opened++; },
      onMessage: { addListener(fn) { listener = fn; } }
    }
  };
  globalThis.fetch = async (url, options) => {
    requests.push(options.method);
    return fail ? { ok: false, status: 502 } : { ok: true, status: 200,
      json: async () => ({ meta: { code: 200 }, data: url.endsWith("ac-status") ? { ac_status: { DisconnectRelay: true } } : {} }) };
  };
  const page = { frameId: 0, tab: { id: 8, url: "https://w5.ab.ust.hk/njggt/app/home" }, url: "https://w5.ab.ust.hk/njggt/app/home", id: "report-test" };
  const send = (type, sender = page, data = {}) => new Promise(resolve => listener({ type, onMinutes: 3, offMinutes: 6, reportId: "same-operation", startedAt: Date.now(), ...data }, sender, resolve));
  await import("../background.js?report-integration");
  await send("aircon:start");
  fail = true;
  const failed = await send("aircon:manualCheck", page, { trigger: "click", observedOn: false });
  assert.equal(failed.view.run, null);
  for (let i = 0; i < 10 && !local["airconErrorReport:same-operation"]; i++) await new Promise(resolve => setImmediate(resolve));
  const report = local["airconErrorReport:same-operation"].report;
  assert.equal(report.error.code, "E_HTTP");
  assert.equal(report.requests[0].httpStatus, 502);
  assert.equal(report.requests[0].phase, "validation");
  assert.deepEqual(report.manualCheck, { trigger: "click", observedOn: false });
  assert.equal(report.cycle.phase, "on");
  assert.equal(report.lastConfirmedStatus.value, true);
  assert.equal(report.extensionVersion, "1.1.9");
  assert.deepEqual(report.communication, { messageType: "aircon:manualCheck", reason: "ACCEPTED", sourcePage: "HOME", tabIsHome: true });
  assert.equal(JSON.stringify(local).includes("SENSITIVE_TOKEN"), false);
  assert.equal(Object.keys(local).filter(key => key.startsWith("airconErrorReport:")).length, 1);
  const before = requests.length;
  const status = await send("aircon:reportsStatus", { id: "report-test", url: "chrome-extension://report-test/report-settings.html" });
  assert.equal(status.ok, true);
  assert.equal(listener({ type: "aircon:reportsStatus" }, { id: "other-extension", url: "chrome-extension://report-test/report-settings.html" }, () => {}), false);
  await send("aircon:openReportSettings");
  assert.equal(opened, 1);
  assert.equal(requests.length, before, "report settings cannot query or control AC");
  fail = false;
  await send("aircon:start", page, { reportId: "next-start" });
  fail = true;
  await send("aircon:manualCheck", page, { reportId: "unknown-trigger", trigger: "UNTRUSTED_SECRET", observedOn: "UNTRUSTED_SECRET" });
  for (let i = 0; i < 10 && !local["airconErrorReport:unknown-trigger"]; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(local["airconErrorReport:unknown-trigger"].report.manualCheck, { trigger: "unknown", observedOn: null });
  assert.equal(JSON.stringify(local).includes("UNTRUSTED_SECRET"), false);
  await import("../background.js?report-integration-restarted");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(local["airconErrorReport:same-operation"], "worker restart preserves report");
  assert.equal(requests.some(method => method === "POST"), false);
});
