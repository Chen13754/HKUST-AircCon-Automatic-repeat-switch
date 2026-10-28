import test from "node:test";
import assert from "node:assert/strict";
import { CycleController } from "../cycle.js";
import { CycleError } from "../errors.js";
import { createSchoolApi } from "../api-client.js";
import { ErrorReporter } from "../reports.js";
import { memoryStorage } from "./storage-fixture.js";
const f = globalThis.AirconReportFormat;

for (const [text, category] of [["Device request timed out", "reported-timeout"], ["Insufficient balance", "balance"], ["Access denied", "access-restricted"], ["Too many requests", "rate-limit"], ["Device offline", "device-unavailable"], ["Internal server error", "service-error"], ["Session expired", "authentication"], ["Unrecognized rejection", "unknown"]]) {
  test(`business reason classification: ${category}`, () => {
    const value = f.extractBusinessError({ meta: { code: 403, message: text } }, "/app/prepaid/toggle-status", "POST");
    assert.equal(value.category, category); assert.equal(value.text, text); assert.equal(value.source, "meta.message");
    assert.deepEqual(f.businessError(value), value);
  });
}
for (const text of ["Bearer abc123", "token=abc", "cookie: data", "Student ID: 12345", "user Alice", "姓名张三", "user@example.org", "https://server/path?key=x", "13800138000", "eyJheader.signature.payload", "IP 10.0.0.1", "SECRET", "password=x"]) {
  test(`sensitive business text is omitted: ${text.split(' ')[0]}`, () => {
    const value = f.businessError({ code: 403, source: "meta.message", text });
    assert.equal(value.text, null); assert.equal(value.omissionReason, "sensitive");
    assert.equal(JSON.stringify(f.businessError(value)).includes(text), false);
  });
}
test("message bounds, source whitelist, null legacy data and 403 without meaning", () => {
  assert.equal(f.businessError(null), null);
  assert.equal(f.businessError({ code: 403 }).category, "unknown");
  assert.equal(f.businessError({ text: "a".repeat(513) }).omissionReason, "too-long");
  assert.equal(f.businessError({ text: "a".repeat(200) }).text.length, 160);
  for (const text of ["bad\nline", "<script>text</script>", "unsafe\u202etext"]) assert.equal(f.businessError({ text }).omissionReason, "unsafe-format");
  assert.equal(f.businessError({ text: "Denied", source: "secret" }).source, null);
  assert.equal(f.extractBusinessError({ meta: { code: 200 }, data: { ac_toggle: { Message: "Execution succeeded" } } }, "/app/prepaid/toggle-status", "POST"), null);
  assert.equal(f.extractBusinessError({ meta: { code: 403, message: " " }, data: { ac_toggle: { Message: "Device offline" } } }, "/app/prepaid/toggle-status", "POST").source, "data.ac_toggle.Message");
});

test("cross-tab cancellation and repeated cancellation preserve actual abort identity and reason", () => {
  const events = [], c = new CycleController({ store: {}, alarm: {}, keepAliveAlarm: {}, api: {}, page: {}, diagnostics: { event(context, values) { events.push({ operationId: context?.reportId, ...values }); } } });
  const controller = new AbortController(); c.active = { tabId: 8, diagnostic: { reportId: "active" }, controller };
  c.cancel(99, new CycleError("E_PAGE_RELOADING", "other tab"));
  assert.equal(events[0].operationId, undefined); assert.equal(events[0].tabId, 99); assert.equal(events[0].abortApplied, false); assert.equal(controller.signal.aborted, false);
  c.cancel(8, new CycleError("E_CANCELLED", "first")); c.cancel(8, new CycleError("E_PAGE_RELOADING", "later"));
  assert.equal(events[1].operationId, "active"); assert.equal(events[1].abortApplied, true);
  assert.equal(events[2].abortApplied, false); assert.equal(controller.signal.reason.code, "E_CANCELLED");
  const legacy = f.traceEvent({ step: "cancel" }); assert.equal(legacy.abortApplied, null);
});

const request = (sequence, path, httpStatus) => ({ sequence, method: "GET", path, errorCode: "E_HTTP", httpStatus });
test("exact causal request survives capture, diagnostic enrichment, export and restore; ambiguous legacy errors stay unknown", async () => {
  const local = {}, writes = [], deps = { storage: memoryStorage(local), getDirectory: async () => ({ queryPermission: async () => "granted" }), writeFile: async (_dir, report) => writes.push(report) };
  const requests = [request(1, "/app/prepaid/ac-timer", 502), request(2, "/app/prepaid/ac-status", 503)];
  const data = { reportId: "incident", source: "tick", error: { code: "E_HTTP", requestSequence: 1 }, requests, diagnostics: { revision: 1, network: requests.map(r => ({ id: `net-${r.sequence}`, operationId: "incident", sequence: r.sequence, correlation: "unique", httpStatus: r.httpStatus })) } };
  const reporter = new ErrorReporter(deps); reporter.capture(data); await reporter.queue;
  await reporter.enrich("incident", { revision: 2, network: data.diagnostics.network }); await reporter.queue;
  await new ErrorReporter(deps).flush();
  const saved = writes.at(-1); assert.equal(saved.error.requestSequence, 1); assert.equal(saved.faultBoundary.requestSequence, 1); assert.equal(saved.faultBoundary.browserHttpStatus, 502);
  const ambiguous = f.makeReport({ ...data, error: { code: "E_HTTP" } });
  assert.equal(ambiguous.faultBoundary.requestSequence, null); assert.equal(ambiguous.businessError, null);
  assert.match(ambiguous.diagnosis.missingEvidence[0], /唯一关联/);
  const wrong = f.makeReport({ ...data, error: { code: "E_HTTP", requestSequence: 99 } }); assert.equal(wrong.faultBoundary.requestSequence, null);
});

test("business rejection records safe text and per-request outcomes without changing runtime rejection", async () => {
  const c = new AbortController(); c.signal.diagnostic = { command: { sent: false }, requests: [] };
  const api = createSchoolApi({ getToken: async () => "FAKE", fetchImpl: async (_url, opts) => ({ ok: true, status: 200,
    json: async () => opts.method === "POST" ? { meta: { code: 403, message: "Device request timed out" } } : { meta: { code: 200 }, data: { ac_status: { DisconnectRelay: false }, ac_timer: null } } }) });
  await api.readTimer(8, c.signal); await api.readStatus(8, c.signal);
  await assert.rejects(api.setStatus(8, true, c.signal), { code: "E_API_REJECTED" });
  const traces = c.signal.diagnostic.requests;
  assert.equal(traces[0].timerPresent, false); assert.equal(traces[1].actualOn, false); assert.equal(traces[2].businessError.category, "reported-timeout");
  const report = f.makeReport({ reportId: "business", error: { code: "E_API_REJECTED", requestSequence: 3 }, requests: traces, command: { desiredOn: true, sent: true, confirmed: false }, outcomeUnknown: true });
  assert.equal(report.businessError.text, "Device request timed out"); assert.equal(report.diagnosis.category, "business-rejection");
  assert.equal(report.switchCommand.confirmed, false); assert.equal(report.outcomeUnknown, true);
  assert.ok(report.diagnosis.hypotheses.some(h => h.confidence === "unknown"));
});
test("unconfirmed status cites the actual successful GET instead of inventing a failed request", () => {
  const report = f.makeReport({ reportId: "unconfirmed", error: { code: "E_STATUS_UNCONFIRMED" },
    requests: [{ sequence: 3, method: "GET", path: "/app/prepaid/ac-status", actualOn: false, httpStatus: 200, schoolCode: 200 }],
    command: { desiredOn: true, sent: true, confirmed: false }, outcomeUnknown: true });
  assert.ok(report.diagnosis.facts.some(item => item.evidence.requestSequence === 3 && item.text.includes("false")));
  assert.equal(report.diagnosis.missingEvidence.some(text => text.includes("唯一关联失败请求")), false);
});
for (const [code, category] of [["E_NETWORK","connection"],["E_API_TIMEOUT","timeout"],["E_HTTP","http-response"],["E_AUTH","authentication-or-access"],["E_JSON","response-format"],["E_NATIVE_TIMER","state-or-timer"],["E_STATUS_UNCONFIRMED","state-or-timer"],["E_ALARM_LATE","scheduling"],["E_LOCAL_STORAGE","control-storage"],["E_BACKGROUND_TIMEOUT","communication"],["E_PAGE_CLOSED","page-or-session"],["E_TIMING_STALE","request-validation"]]) {
  test(`diagnosis ${code} is bounded, evidence-linked and conservative`, () => {
    const report = f.makeReport({ reportId: "op", error: { code } });
    assert.equal(report.diagnosis.category, category); assert.ok(report.diagnosis.facts.length <= 6); assert.ok(report.diagnosis.actions.length <= 3);
    assert.ok(report.diagnosis.facts.every(v => v.evidence.operationId === "op")); assert.equal(report.diagnosis.serverInternalCause, "unknown");
  });
}
