// Called by Playwright CLI run-code with its isolated test page. All URLs are
// intercepted; this script must never contact the real school or send a toggle.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { memoryStorage } from "../edge-extension/test/storage-fixture.js";
import { ErrorReporter } from "../edge-extension/reports.js";
import { pathToFileURL } from "node:url";

export async function verifyObserverBrowser(page) {
  const url = "https://w5.ab.ust.hk/njggt/app/home", api = "https://w5.ab.ust.hk/njggt/api";
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  const local = {}, session = {}, alarms = new Map(), listeners = new Map(), messages = [], exports = [];
  const add = name => ({ addListener(fn) { const set = listeners.get(name) ?? []; set.push(fn); listeners.set(name, set); } });
  const emit = (name, details) => { for (const fn of listeners.get(name) ?? []) fn(details); };
  let messageListener, alarmListener, browserPosts = 0, extensionPosts = 0, cdp;
  const now = Date.now(), run = { id: "browser-run", tabId: 8, documentId: "browser-doc", phase: "on", expectedOn: true,
    onMinutes: 2, offMinutes: 4, nextAt: now - 46000, phaseStartedAt: now-166000, startedAt: now-600000,
    queryRecovery: { id: "first-incident", initialOperationId: "first-operation", startedAt: now-30000, originalNextAt: now-46000,
      deadline: now+14000, nextAttemptAt: now-1, initialFailure: { path: "/app/prepaid/ac-timer", errorCode: "E_API_TIMEOUT" }, rounds: [] },
    recovery: { kind: "query", deadline: now+14000, nextAttemptAt: now-1 } };
  session.cycleRun = structuredClone(run); local.cycleCheckpoint = { active: true, run: structuredClone(run), command: null };
  globalThis.chrome = { storage: { local: memoryStorage(local), session: memoryStorage(session) },
    runtime: { id: "browser-verification", getManifest: () => ({ version: "1.1.21" }), onMessage: { addListener(fn) { messageListener = fn; } } },
    tabs: { get: async () => ({ url }), sendMessage: async (_tab, msg) => msg.type === "aircon:getToken" ? { token: "FAKE-TEST-TOKEN" } : undefined,
      onRemoved: add("removed"), onUpdated: add("updated") },
    alarms: { get: async id => alarms.get(id), create: async (id, value) => alarms.set(id, { scheduledTime: value.when }), clear: async id => alarms.delete(id),
      onAlarm: { addListener(fn) { alarmListener = fn; } } },
    webRequest: Object.fromEntries(["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"].map(n => [n, add(n)])) };
  globalThis.fetch = async (_url, options) => { if (options.method === "POST") extensionPosts++; return { ok: false, status: 502 }; };
  const sender = { id: "browser-verification", frameId: 0, documentId: "browser-doc", url, tab: { id: 8, url } };
  const send = message => new Promise(resolve => messageListener(message, sender, resolve));
  const settle = async () => { for (let i=0;i<12;i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    await page.route("**/*", async route => {
      const request = route.request();
      if (request.url() === url) return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated school mock</title><div>Mock only</div>" });
      if (!request.url().startsWith(api + "/app/prepaid/")) return route.abort();
      if (request.method() === "POST") browserPosts++;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ meta: { code: 200 }, data: {
        ac_toggle: { Message: "Execution succeeded" }, ac_status: { DisconnectRelay: false }, ac_timer: null, token: "SECRET-NOT-EXPORTED" } }) });
    });
    const ids = new Map(); let sequence = 0;
    page.on("request", request => {
      if (!request.url().startsWith(api)) return;
      const id = `browser-${++sequence}`; ids.set(request, id);
      emit("onBeforeRequest", { requestId: id, initiator: "https://w5.ab.ust.hk", tabId: 8, frameId: 0, documentId: "browser-doc", url: request.url(), method: request.method(), timeStamp: Date.now() });
    });
    page.on("requestfinished", async request => {
      if (!ids.has(request)) return;
      const response = await request.response();
      emit("onCompleted", { requestId: ids.get(request), initiator: "https://w5.ab.ust.hk", tabId: 8, documentId: "browser-doc", url: request.url(), method: request.method(), timeStamp: Date.now(), statusCode: response.status() });
    });
    await import(`../edge-extension/background.js?browser-verification=${Date.now()}`);
    await send({ type: "aircon:getState" });
    alarmListener({ name: `recovery:${run.id}`, scheduledTime: run.recovery.nextAttemptAt });
    await settle();
    assert.equal(session.cycleRun, undefined);
    assert.equal(session.incidentFollowups.length, 1);
    await page.goto(url);
    cdp = await page.context().newCDPSession(page);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    await cdp.send("Runtime.enable");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "aircon-test-isolated" });
    await cdp.send("Runtime.addBinding", { name: "sendToMockBackground", executionContextId });
    cdp.on("Runtime.bindingCalled", event => {
      if (event.name !== "sendToMockBackground") return;
      const message = JSON.parse(event.payload); messages.push(message);
      messageListener(message, sender, () => {});
    });
    const read = name => readFile(new URL(`../edge-extension/${name}.js`, import.meta.url), "utf8");
    await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression:
      `globalThis.chrome={runtime:{sendMessage:message=>{sendToMockBackground(JSON.stringify(message));return Promise.resolve({ok:true});}}};\n${await read("report-format")}\n${await read("page-bridge")}` });
    await page.addScriptTag({ content: await read("page-observer") });
    const result = await page.evaluate(async base => {
      const toggle = await new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open("POST", base+"/app/prepaid/toggle-status");
        xhr.setRequestHeader("Content-Type", "application/json"); xhr.onload = () => resolve(JSON.parse(xhr.responseText)); xhr.onerror = reject; xhr.send(JSON.stringify({ toggle: { status: 0 } })); });
      const status = await (await fetch(base+"/app/prepaid/ac-status")).json();
      const timer = await (await fetch(base+"/app/prepaid/ac-timer")).json();
      return { accepted: toggle.data.ac_toggle.Message, actual: status.data.ac_status.DisconnectRelay, timer: timer.data.ac_timer };
    }, api);
    for (let i=0;i<30 && messages.filter(m => m.kind === "response").length<3;i++) await new Promise(resolve => setTimeout(resolve, 25));
    await settle();
    assert.equal(result.accepted, "Execution succeeded"); assert.equal(result.actual, false);
    assert.equal(messages.filter(m => m.kind === "response").length, 3);
    const reporter = new ErrorReporter({ storage: memoryStorage(local), getDirectory: async () => ({ queryPermission: async () => "granted" }), writeFile: async (_dir, report) => exports.push(report) });
    await reporter.flush();
    const report = exports.find(r => r.incidentFollowup?.switches[0]?.switchAccepted === true);
    assert.ok(report, "page XHR summary must reach persisted/exported production report");
    assert.equal(report.error.code, "E_HTTP"); assert.equal(report.incidentFollowup.switches[0].statusAfter.actualOn, false);
    assert.ok(report.incidentFollowup.queries.some(q => q.path === "/app/prepaid/ac-timer" && q.schoolCode === 200));
    assert.equal(JSON.stringify(report).includes("SECRET-NOT-EXPORTED"), false);
    assert.equal(extensionPosts, 0); assert.equal(browserPosts, 1);
    // Browser identity, not a page diagnostic payload, owns manual cancellation.
    const pending = structuredClone(run); pending.recovery.nextAttemptAt = Date.now() + 30000;
    pending.recovery.deadline = Date.now()+60000; pending.queryRecovery.nextAttemptAt = pending.recovery.nextAttemptAt;
    pending.queryRecovery.deadline = pending.recovery.deadline;
    session.cycleRun = pending; local.cycleCheckpoint = { active: true, run: structuredClone(pending), command: null };
    await send({ type: "aircon:pageDiagnostic", kind: "response", response: { path: "/app/prepaid/toggle-status", method: "POST", httpStatus: 200, switchAccepted: true } });
    const native = { requestId: "native-cancel", initiator: "https://w5.ab.ust.hk", tabId: 8, documentId: "browser-doc", url: api+"/app/prepaid/toggle-status", method: "POST", timeStamp: Date.now() };
    emit("onBeforeRequest", { ...native, frameId: 1 }); await settle(); assert.ok(session.cycleRun);
    emit("onBeforeRequest", { ...native, frameId: 0, initiator: "chrome-extension://browser-verification" }); await settle(); assert.ok(session.cycleRun);
    emit("onBeforeRequest", { ...native, frameId: 0 }); await settle(); assert.equal(session.cycleRun, undefined);
    assert.equal(extensionPosts, 0);
    return { passed: true, pageResponses: 3, exportedFollowup: report.incidentFollowup.conclusion, extensionPosts, simulatedPagePosts: browserPosts, browserIdentityCancellation: true };
  } finally { await cdp?.detach(); await page.unroute("**/*"); globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
}

// CLI's run-code VM cannot import modules. This standalone fallback reuses the
// project-local Playwright package; it does not add a dependency or test runner.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("Pass the project-local Playwright module path.");
  const { chromium } = await import(pathToFileURL(process.argv[2]).href);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try { console.log(JSON.stringify(await verifyObserverBrowser(await browser.newPage()))); }
  finally { await browser.close(); }
}
