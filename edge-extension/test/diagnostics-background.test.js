import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "./storage-fixture.js";

test("background joins browser request IDs, page evidence and local control history in one automatic report", async t => {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch, addEventListener: globalThis.addEventListener };
  t.after(() => Object.assign(globalThis, previous));
  const local = {}, session = {}, network = {}, globals = {};
  let listener, failed = false, requestNumber = 0, onUpdated;
  const alarms = new Map(), calls = [];
  globalThis.addEventListener = (name, callback) => { globals[name] = callback; };
  globalThis.chrome = {
    storage: { local: memoryStorage(local), session: memoryStorage(session) },
    webRequest: Object.fromEntries(["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"].map(name => [name, { addListener(callback) { network[name] = callback; } }])),
    tabs: {
      get: async () => ({ url: "https://w5.ab.ust.hk/njggt/app/home", discarded: false, frozen: false }),
      sendMessage: async (_tab, message) => message.type === "aircon:getToken" ? { token: "SECRET", evidence: { at: Date.now(), contentObservedAt: Date.now(), online: true, visibility: "visible", route: "home", tokenPresent: true, loginAgeMs: 1000, scripts: ["main.c005f61e.chunk.js"], token: "SECRET" } } : undefined,
      onRemoved: { addListener() {} }, onUpdated: { addListener(callback) { onUpdated = callback; } }
    },
    alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, { ...value, scheduledTime: value.when }), clear: async name => alarms.delete(name), onAlarm: { addListener() {} } },
    runtime: { id: "diagnostic-test", getManifest: () => ({ version: "1.1.13" }), getURL: file => `chrome-extension://diagnostic-test/${file}`, sendMessage: async () => {}, onMessage: { addListener(callback) { listener = callback; } } }
  };
  globalThis.fetch = async (url, options) => {
    calls.push(options.method);
    const details = { url, method: options.method, requestId: String(++requestNumber), initiator: "chrome-extension://diagnostic-test", tabId: -1, timeStamp: Date.now() };
    network.onBeforeRequest(details); network.onSendHeaders(details);
    network.onHeadersReceived({ ...details, statusCode: failed ? 503 : 200 }); network.onCompleted({ ...details, statusCode: failed ? 503 : 200 });
    return { ok: !failed, status: failed ? 503 : 200, json: async () => ({ meta: { code: 200 }, data: url.endsWith("ac-status") ? { ac_status: { DisconnectRelay: true } } : {} }) };
  };
  await import("../background.js?automatic-diagnostics");
  const sender = { id: "diagnostic-test", frameId: 0, url: "https://w5.ab.ust.hk/njggt/app/home", tab: { id: 8, url: "https://w5.ab.ust.hk/njggt/app/home" } };
  const send = (type, data = {}) => new Promise(resolve => listener({ type, reportId: "automatic-report", onMinutes: 2, offMinutes: 4, ...data }, sender, resolve));
  await send("aircon:start", { reportId: "initial-operation" });
  const before = structuredClone(session.cycleRun);
  const requestsBefore = calls.length;
  assert.equal(listener({ type: "aircon:telemetry", evidence: { online: false } }, { ...sender, frameId: 1 }, () => {}), false);
  await send("aircon:telemetry", { step: "visibility", evidence: { at: Date.now(), contentObservedAt: Date.now(), online: true, visibility: "hidden", scripts: ["main.c005f61e.chunk.js"] } });
  assert.deepEqual(session.cycleRun, before);
  assert.equal(calls.length, requestsBefore, "telemetry issues no school requests");
  failed = true;
  await send("aircon:manualCheck", { trigger: "click", observedOn: true });
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  const report = local["airconErrorReport:automatic-report"].report;
  assert.equal(report.error.code, "E_HTTP");
  assert.equal(report.diagnostics.coverage.webRequest, true);
  assert.ok(report.diagnostics.network.some(request => request.operationId === report.reportId && request.id === "3"));
  assert.equal(report.faultBoundary.browserRequestId, "3");
  assert.equal(report.faultBoundary.browserStage, "headersReceived");
  assert.ok(report.diagnostics.events.some(event => event.component === "history" && event.step === "finish"));
  assert.deepEqual(report.diagnostics.site.scripts, ["main.c005f61e.chunk.js"]);
  assert.equal(JSON.stringify(local).includes("SECRET"), false);
  assert.equal(calls.some(method => method === "POST"), false);
  assert.equal(session.cycleRun, undefined);
  assert.ok(local.airconDiagnosticJournal);
  onUpdated(8, { frozen: true }, { url: sender.url, frozen: true, discarded: false });
  globals.unhandledrejection({ reason: new Error("SECRET") });
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  const unhandled = Object.values(local).find(entry => entry?.report?.source === "background")?.report;
  assert.equal(unhandled.error.code, "E_INTERNAL");
  assert.equal(unhandled.diagnostics.site.frozen, true);
  assert.equal(JSON.stringify(local).includes("SECRET"), false);
});
