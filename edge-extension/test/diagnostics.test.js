import test from "node:test";
import assert from "node:assert/strict";
import { Diagnostics, timingFromEntry } from "../diagnostics.js";
import { createSchoolApi } from "../api-client.js";
import { CycleController } from "../cycle.js";
import { memoryStorage } from "./storage-fixture.js";

const format = globalThis.AirconReportFormat;
const url = "https://w5.ab.ust.hk/njggt/api/app/prepaid/ac-timer";
const context = () => ({ reportId: "operation-1", source: "tick", queuedAt: 999990, requests: [] });
const trace = () => ({ sequence: 1, path: "/app/prepaid/ac-timer", method: "GET", phase: "headers", startedAt: 1000000 });
const details = (extra = {}) => ({ requestId: "123", method: "GET", url, initiator: "chrome-extension://test", tabId: -1, timeStamp: 1000000, ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const data = {}, updates = [];
  const storage = memoryStorage(data);
  let now = 1000000;
  const recorder = new Diagnostics({ storage, runtimeId: "test", clock: () => now, onUpdate: (id, snapshot) => updates.push({ id, snapshot }), ...options });
  return { recorder, data, storage, updates, advance: ms => { now += ms; } };
}

test("network observers are passive and filter only the existing school host", async () => {
  const h = harness(); await h.recorder.ready;
  const listeners = {};
  const webRequest = Object.fromEntries(["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"].map(name => [name, {
    addListener(...args) { assert.equal(args.length, 2, "no blocking or header access options"); assert.deepEqual(args[1].urls, ["https://w5.ab.ust.hk/njggt/api/app/prepaid/*", "https://w5.ab.ust.hk/njggt/api/app/auth/cas/*"]); listeners[name] = args[0]; }
  }]));
  h.recorder.attach({ webRequest }, undefined, undefined);
  assert.equal(h.recorder.coverage.webRequest, true);
  const ctx = context(); h.recorder.requestEvent(ctx, trace(), "requestPhase");
  for (const name of Object.keys(listeners)) assert.equal(listeners[name](details({ statusCode: 200 })), undefined);
  await h.recorder.flush();
  assert.equal(h.recorder.snapshot().network[0].operationId, ctx.reportId);
});

test("headers, bodies, URL queries and unknown browser errors never enter persistent diagnostics", async () => {
  const h = harness(); await h.recorder.ready;
  h.recorder.observeNetwork("beforeRequest", details({ url: url + "?token=SECRET", requestHeaders: [{ name: "Authorization", value: "SECRET" }], requestBody: "SECRET" }));
  h.recorder.observeNetwork("error", details({ error: "SECRET", responseHeaders: [{ name: "Set-Cookie", value: "SECRET" }] }));
  h.recorder.observeNetwork("beforeRequest", details({ requestId: "456", url: "https://private.example/SECRET" }));
  h.recorder.observeNetwork("beforeRequest", details({ requestId: "789", url: "https://w5.ab.ust.hk/private/SECRET" }));
  await h.recorder.flush();
  assert.equal(h.recorder.snapshot().network.length, 1);
  assert.equal(h.recorder.snapshot().network[0].error, "UNKNOWN");
  assert.equal(JSON.stringify(h.data).includes("SECRET"), false);
});

test("ambiguous or missing initiators never receive a guessed operation association", async () => {
  const h = harness(); await h.recorder.ready;
  h.recorder.requestEvent(context(), trace(), "requestPhase");
  h.recorder.requestEvent({ ...context(), reportId: "other-operation" }, { ...trace(), sequence: 2 }, "requestPhase");
  h.recorder.observeNetwork("beforeRequest", details());
  h.recorder.observeNetwork("beforeRequest", details({ requestId: "124", initiator: undefined }));
  assert.deepEqual(h.recorder.snapshot().network.map(record => [record.operationId, record.correlation]), [[null, "ambiguous"], [null, "unmatched"]]);
});

test("late browser cancellation enriches the same report without replacing the timeout cause", async () => {
  const h = harness(); await h.recorder.ready;
  const ctx = context(), request = trace();
  h.recorder.requestEvent(ctx, request, "requestPhase");
  h.recorder.observeNetwork("beforeRequest", details());
  h.recorder.observeNetwork("sendHeaders", details({ timeStamp: 1000002 }));
  h.recorder.trackReport(ctx.reportId);
  h.recorder.observeNetwork("error", details({ timeStamp: 1008000, error: "net::ERR_ABORTED" }));
  const report = format.makeReport({ ...ctx, error: { code: "E_API_TIMEOUT" }, requests: [{ ...request, errorCode: "E_API_TIMEOUT" }], diagnostics: h.updates.at(-1).snapshot });
  assert.equal(report.faultBoundary.boundary, "headers");
  assert.equal(report.faultBoundary.browserStage, "sendHeaders");
  assert.equal(report.faultBoundary.browserError, "ERR_ABORTED");
  assert.equal(report.faultBoundary.cancellation, "E_API_TIMEOUT");
  assert.equal(report.faultBoundary.serverInternalCause, "unknown");
});

test("worker restart preserves an unfinished operation, previous events and site identity", async () => {
  const h = harness(); await h.recorder.begin(context());
  h.recorder.page({ at: 1000000, contentObservedAt: 1000000, online: false, scripts: ["main.c005f61e.chunk.js"] }, "offline");
  await h.recorder.flush();
  const next = new Diagnostics({ storage: h.storage, runtimeId: "test" }); await next.ready;
  const snapshot = next.snapshot();
  assert.notEqual(snapshot.worker.id, h.recorder.worker.id);
  assert.equal(snapshot.unfinishedOperations[0].operationId, "operation-1");
  assert.ok(snapshot.events.some(event => event.step === "offline"));
  assert.deepEqual(snapshot.site.scripts, ["main.c005f61e.chunk.js"]);
  await h.recorder.end(context());
  const clean = new Diagnostics({ storage: h.storage, runtimeId: "test" }); await clean.ready;
  assert.deepEqual(clean.snapshot().unfinishedOperations, []);
});

test("a late journal load cannot erase browser events observed during hydration", async () => {
  let release;
  const h = harness({ storage: { get: () => new Promise(resolve => { release = resolve; }), set: async () => {} } });
  await flush(); h.recorder.observeNetwork("beforeRequest", details());
  release({ airconDiagnosticJournal: { events: [], network: [], unfinishedOperations: [] } });
  await h.recorder.ready;
  assert.equal(h.recorder.snapshot().network.length, 1);
});

test("journal timeouts are bounded and uncertain writes never race subsequent diagnostic writes", async () => {
  let writes = 0, release;
  const h = harness({ timeoutMs: 10, storage: { get: async () => ({}), set: () => { writes++; return new Promise(resolve => { release = resolve; }); } } });
  await h.recorder.begin(context());
  await h.recorder.queue;
  assert.equal(h.recorder.coverage.journal, "write-failed");
  await h.recorder.end(context()); await h.recorder.begin({ ...context(), reportId: "next-operation" });
  assert.equal(writes, 1);
  release(); await flush();
  assert.equal(h.recorder.snapshot().coverage.journal, "write-failed");
});

test("continuous diagnostic writes cannot extend a control barrier indefinitely", async () => {
  let recorder, writes = 0;
  const h = harness({ timeoutMs: 15, storage: { get: async () => ({}), set: async () => {
    writes++;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (writes < 10) recorder.flush();
  } } });
  recorder = h.recorder;
  await recorder.begin(context());
  assert.equal(recorder.coverage.barrierTimedOut, true);
  assert.ok(writes < 10, "control resumes before the write stream drains");
  await recorder.queue;
});

test("resource timing can supplement a uniquely matched request when webRequest is unavailable", async () => {
  const h = harness(); await h.recorder.ready;
  h.recorder.requestEvent(context(), trace(), "requestPhase");
  h.recorder.trackReport("operation-1");
  h.recorder.resource({ url, timing: { startedAt: 1000000, durationMs: 10, detailsAvailable: false } }, "extension");
  assert.equal(h.updates.at(-1).snapshot.network[0].correlation, "time-window");
  assert.equal(h.updates.at(-1).snapshot.network[0].operationId, "operation-1");
});

test("a recovered read produces one distinct diagnostic report only after successful operation completion", async () => {
  const incidents = [];
  const h = harness({ onIncident: draft => incidents.push(draft) }); await h.recorder.ready;
  const ctx = context();
  h.recorder.requestEvent(ctx, { ...trace(), attempt: 2, errorCode: null }, "endRequest");
  assert.equal(incidents.length, 0);
  await h.recorder.end(ctx); await h.recorder.end(ctx);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].source, "readRecovery");
  assert.equal(incidents[0].recovered, true);
  assert.notEqual(incidents[0].reportId, ctx.reportId);
  assert.equal(incidents[0].originalOperationId, ctx.reportId);
  const failed = { ...context(), recoveredQuery: true };
  await h.recorder.end(failed, "E_HTTP");
  assert.equal(incidents.length, 1, "a later primary failure gets only its normal control report");
});

test("recovered reports remain linked to late evidence from the original operation", async () => {
  const h = harness(); await h.recorder.ready;
  h.recorder.trackReport("recovery-report", "operation-1");
  h.recorder.event(context(), { component: "request", step: "endRequest", outcome: "ok" });
  assert.equal(h.updates.at(-1).id, "recovery-report");
});

test("throwing diagnostic hooks cannot change a successful school read", async () => {
  const api = createSchoolApi({ getToken: async () => "token", diagnostics: { requestEvent() { throw new Error("diagnostics failed"); } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: { ac_status: { DisconnectRelay: true } } }) }) });
  assert.equal(await api.readStatus(8), true);
});

test("a real controller with diagnostics logs a recovered timeout while starting exactly once", async () => {
  const incidents = [], failures = [], posts = [];
  const h = harness({ onIncident: draft => incidents.push(format.makeReport({ ...draft, diagnostics: h.recorder.snapshot() })) });
  let run = null, notice = null, actual = false, timerCalls = 0;
  const controller = new CycleController({ diagnostics: h.recorder,
    store: { getRun: async () => run, setRun: async value => { run = value; }, clearRun: async () => { run = null; },
      getState: async () => ({ run, notice }), setNotice: async value => { notice = value; }, clearKeepAliveNotice: async () => {} },
    alarm: { create: async () => {}, clear: async () => {} }, keepAliveAlarm: { get: async () => null, create: async () => {}, clear: async () => {} },
    page: { isOpen: async () => true }, report: draft => { failures.push(draft); return draft.reportId; },
    api: createSchoolApi({ getToken: async () => "token", requestTimeoutMs: 10, diagnostics: h.recorder,
      fetchImpl: async (url, options) => {
        if (url.endsWith("ac-timer") && ++timerCalls === 1) return new Promise(() => {});
        if (options.method === "POST") { actual = true; posts.push(true); }
        return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: { ac_status: { DisconnectRelay: actual }, ac_toggle: { Message: "Execution succeeded" } } }) };
      }
    })
  });
  await controller.start(8, 2, 4);
  assert.equal(run.phase, "on");
  assert.deepEqual(posts, [true]);
  assert.equal(failures.length, 0);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].recovered, true);
  assert.equal(incidents[0].source, "readRecovery");
  assert.deepEqual(incidents[0].requests.filter(request => request.path === "/app/prepaid/ac-timer").map(request => request.errorCode), ["E_API_TIMEOUT", null]);
  await controller.stop(8);
});

test("local failures identify the storage method without inventing a network cause", () => {
  const report = format.makeReport({ reportId: "local-op", error: { code: "E_LOCAL_TIMEOUT" }, diagnostics: { events: [{ operationId: "local-op", component: "store", step: "setRun", outcome: "error", code: "E_LOCAL_TIMEOUT" }] } });
  assert.equal(report.faultBoundary.boundary, "local-api");
  assert.equal(report.faultBoundary.component, "store");
  assert.equal(report.faultBoundary.step, "setRun");
  assert.equal(report.faultBoundary.browserError, null);
});

test("same error from another operation is not attributed to the current operation", () => {
  const report = format.makeReport({ reportId: "current", error: { code: "E_LOCAL_TIMEOUT" }, diagnostics: {
    events: [{ operationId: "previous", component: "store", step: "setRun", outcome: "error", code: "E_LOCAL_TIMEOUT" }]
  } });
  assert.equal(report.faultBoundary.boundary, "local-api");
  assert.equal(report.faultBoundary.component, null); assert.equal(report.faultBoundary.step, null);
  const linked = format.makeReport({ reportId: "result", originalOperationId: "previous", error: { code: "E_LOCAL_TIMEOUT" }, diagnostics: report.diagnostics });
  assert.equal(linked.faultBoundary.component, "store");
});

test("successful page terminal and business events survive a restart within the sample interval", async () => {
  const data = {}, storage = { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) };
  let now = 1_000_000;
  const recorder = new Diagnostics({ storage, runtimeId: "test", clock: () => now }); await recorder.ready;
  const detail = { requestId: "sample-1", url: "https://w5.ab.ust.hk/njggt/api/app/prepaid/ac-status", method: "GET", initiator: "https://w5.ab.ust.hk", tabId: 8, documentId: "doc-1", timeStamp: now };
  recorder.observeNetwork("beforeRequest", detail);
  recorder.page({ tabId: 8, documentId: "doc-1", at: now, route: "home" }, "resource"); await recorder.queue;
  now += 100;
  recorder.observeNetwork("completed", { ...detail, timeStamp: now, statusCode: 200 });
  recorder.response({ tabId: 8, documentId: "doc-1", path: "/app/prepaid/ac-status", method: "GET", transport: "xhr", startedAt: detail.timeStamp, endedAt: now, httpStatus: 200, schoolCode: 200, result: "json" });
  await recorder.queue;
  const restarted = new Diagnostics({ storage, runtimeId: "test", clock: () => now + 31000 }); await restarted.ready;
  assert.equal(restarted.snapshot(8).network[0].endedAt, now);
  assert.equal(restarted.snapshot(8).network[0].httpStatus, 200);
  assert.equal(restarted.snapshot(8).pageResponses[0].schoolCode, 200);
});

test("a completed API trace is journaled without needing a subsequent operation", async () => {
  const h = harness(); await h.recorder.ready;
  const ctx = context(), request = { ...trace(), phase: "complete", elapsedMs: 10 };
  h.recorder.requestEvent(ctx, request, "endRequest"); await h.recorder.queue;
  const next = new Diagnostics({ storage: h.storage, runtimeId: "test" }); await next.ready;
  assert.ok(next.snapshot().events.some(event => event.step === "endRequest" && event.operationId === ctx.reportId));
});

test("missing previous journal data stays explicitly marked even after current writes work", async () => {
  const h = harness({ timeoutMs: 10, storage: { get: () => new Promise(() => {}), set: async () => {} } });
  await h.recorder.begin(context());
  assert.equal(h.recorder.snapshot().coverage.historyLoaded, false);
  assert.equal(h.recorder.snapshot().coverage.journal, "ready");
});

test("resource timing restrictions remain unknown instead of inventing zero-duration DNS or TLS", () => {
  const restricted = timingFromEntry({ startTime: 10, duration: 8000, requestStart: 0, responseStart: 0, connectStart: 0, connectEnd: 0, secureConnectionStart: 0 }, 1000);
  assert.equal(restricted.detailsAvailable, false);
  assert.equal(restricted.dnsMs, null); assert.equal(restricted.tlsMs, null);
  const measured = timingFromEntry({ startTime: 10, duration: 100, domainLookupStart: 10, domainLookupEnd: 15, connectStart: 15, secureConnectionStart: 20, connectEnd: 35, requestStart: 36, responseStart: 90, responseEnd: 110, nextHopProtocol: "h2" }, 1000);
  assert.deepEqual([measured.dnsMs, measured.connectMs, measured.tlsMs, measured.waitMs, measured.downloadMs], [5, 20, 15, 54, 20]);
});

test("unavailable observer permissions are explicit and do not disable the recorder", async () => {
  const h = harness(); await h.recorder.ready;
  h.recorder.attach({}, class { constructor() { throw new Error("unsupported"); } });
  await h.recorder.begin(context()); await h.recorder.end(context());
  assert.equal(h.recorder.snapshot().coverage.webRequest, false);
  assert.equal(h.recorder.snapshot().coverage.resourceTiming, false);
});

test("diagnostic history stays bounded over days and reports remain under 128 KiB", async () => {
  const h = harness(); await h.recorder.ready;
  for (let i = 0; i < 2000; i++) {
    h.recorder.event(context(), { component: "alarm", step: "alarmDelivered", scheduledAt: i, latenessMs: 1, outcome: "ok" });
    if (i % 10 === 0) h.recorder.observeNetwork("sendHeaders", details({ requestId: String(i) }));
  }
  await h.recorder.flush();
  assert.equal(h.data.airconDiagnosticJournal.events.length, 256);
  assert.equal(h.data.airconDiagnosticJournal.network.length, 64);
  const report = format.makeReport({ ...context(), error: { code: "E_API_TIMEOUT" }, diagnostics: h.recorder.snapshot() });
  assert.equal(report.diagnostics.events.length, 64);
  assert.equal(report.diagnostics.network.length, 32);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 128 * 1024);
});

test("untrusted cached diagnostic fields are filtered before export, including the fault boundary", () => {
  const report = format.makeReport({ ...context(), error: { code: "E_API_TIMEOUT" }, requests: [{ sequence: 1, phase: "SECRET", errorCode: "E_API_TIMEOUT" }],
    diagnostics: { site: { scripts: ["SECRET"], token: "SECRET" }, events: [{ step: "SECRET", code: "SECRET", script: "SECRET" }],
      network: [{ operationId: "operation-1", sequence: 1, error: "SECRET", events: [{ event: "SECRET", at: "SECRET" }], url: "SECRET", headers: "SECRET" }] } });
  assert.equal(JSON.stringify(report).includes("SECRET"), false);
});

test("real response text separates body, parse and validation without storing the payload", async () => {
  let mono = 0;
  const controller = new AbortController(); controller.signal.diagnostic = context();
  const api = createSchoolApi({ performanceImpl: { now: () => mono }, getToken: async () => { mono += 2; return "SECRET"; },
    fetchImpl: async () => { mono += 5; return { status: 200, ok: true, url, redirected: false,
      headers: { get: name => name === "Content-Type" ? "application/json" : "123" },
      text: async () => { mono += 7; return JSON.stringify({ meta: { code: 200 }, data: { ac_status: { DisconnectRelay: true }, private: "SECRET" } }); } }; }
  });
  assert.equal(await api.readStatus(8, controller.signal), true);
  const request = controller.signal.diagnostic.requests[0];
  assert.deepEqual([request.timings.tokenMs, request.timings.headersMs, request.timings.bodyMs], [2, 5, 7]);
  assert.equal(request.phase, "complete");
  assert.equal(request.response.contentType, "json");
  assert.equal(JSON.stringify(request).includes("SECRET"), false);
});

test("HTML login redirects pinpoint JSON parsing and invalid state pinpoints validation", async () => {
  for (const invalidState of [false, true]) {
    const controller = new AbortController(); controller.signal.diagnostic = context();
    const api = createSchoolApi({ getToken: async () => "token", fetchImpl: async () => ({ ok: true, status: 200, redirected: true,
      url: "https://w5.ab.ust.hk/njggt/app/login?ticket=SECRET", headers: { get: () => "text/html" },
      text: async () => invalidState ? '{"meta":{"code":200},"data":{"ac_status":{}}}' : "<html>SECRET</html>" }) });
    await assert.rejects(api.readStatus(8, controller.signal), { code: invalidState ? "E_STATUS_FORMAT" : "E_JSON" });
    const request = controller.signal.diagnostic.requests[0];
    assert.equal(request.phase, invalidState ? "validation" : "parse");
    assert.equal(request.response.route, "login");
    assert.equal(JSON.stringify(request).includes("SECRET"), false);
  }
});

test("two school tabs cannot overwrite each other's site, response or navigation evidence", async () => {
  const h = harness(); await h.recorder.ready;
  h.recorder.page({ at: 1000000, tabId: 8, documentId: "doc-8", route: "home", responseObserver: true }, "initialize");
  h.recorder.page({ at: 1000001, tabId: 9, documentId: "doc-9", route: "login" }, "navigation");
  h.recorder.observeNetwork("beforeRequest", details({ initiator: "https://w5.ab.ust.hk", tabId: 8, documentId: "doc-8" }));
  h.recorder.response({ tabId: 8, documentId: "doc-8", path: "/app/prepaid/ac-timer", method: "GET", startedAt: 1000000, endedAt: 1000010, schoolCode: 4031, result: "json", body: "SECRET" });
  h.recorder.response({ tabId: 9, documentId: "doc-9", path: "/app/prepaid/ac-status", method: "GET", startedAt: 1000000, schoolCode: 4032 });
  assert.equal(h.recorder.snapshot(8).site.route, "home");
  assert.equal(h.recorder.snapshot(8).lifecycleEvents.length, 1);
  assert.equal(h.recorder.snapshot(8).pageResponses.length, 1);
  assert.equal(h.recorder.snapshot(8).pageResponses[0].browserRequestId, "123");
  assert.equal(h.recorder.snapshot(9).pageResponses[0].correlation, "unmatched");
  assert.equal(h.recorder.snapshot(10).site, null);
  await h.recorder.flush();
  assert.equal(JSON.stringify(h.data).includes("SECRET"), false);
  const next = new Diagnostics({ storage: h.storage, runtimeId: "test", clock: () => 1000020 }); await next.ready;
  assert.equal(next.snapshot(8).site.route, "home");
  assert.equal(next.snapshot(9).site.route, "login");
  next.page({ tabId: 8, documentId: "new-doc", route: "callback" }, "navigation");
  assert.equal(next.snapshot(8).site.responseObserver, null, "a new document must establish its own coverage");
});

test("authentication trail survives routine traffic and late return enriches after worker restart", async () => {
  const h = harness(); await h.recorder.ready;
  h.recorder.page({ at: 1000000, tabId: 8, documentId: "doc-1", route: "login" }, "navigation");
  h.recorder.trackReport("auth-report", "auth-operation", 8);
  for (let i = 0; i < 400; i++) h.recorder.event({ ...context(), tabId: 8 }, { component: "request", step: "requestPhase", phase: "headers" });
  await h.recorder.flush();
  const updates = [];
  const next = new Diagnostics({ storage: h.storage, runtimeId: "test", clock: () => 1005000, onUpdate: (id, snapshot) => updates.push({ id, snapshot }) });
  await next.ready;
  updates.length = 0;
  next.page({ at: 1005000, tabId: 9, route: "home" }, "navigation");
  assert.equal(updates.length, 0);
  next.page({ at: 1005001, tabId: 8, documentId: "doc-2", route: "home" }, "navigation");
  assert.equal(updates.at(-1).id, "auth-report");
  assert.deepEqual(updates.at(-1).snapshot.lifecycleEvents.map(e => e.route), ["login", "home"]);
});

test("ambiguous concurrent page requests retain business code without claiming a network match", async () => {
  const h = harness(); await h.recorder.ready;
  for (const id of ["a", "b"]) h.recorder.observeNetwork("beforeRequest", details({ requestId: id, initiator: "https://w5.ab.ust.hk", tabId: 8 }));
  h.recorder.response({ tabId: 8, path: "/app/prepaid/ac-timer", method: "GET", startedAt: 1000000, schoolCode: 4032 });
  assert.equal(h.recorder.snapshot(8).pageResponses[0].correlation, "ambiguous");
  assert.equal(h.recorder.snapshot(8).pageResponses[0].browserRequestId, null);
});
