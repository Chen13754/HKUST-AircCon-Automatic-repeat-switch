import test from "node:test";
import assert from "node:assert/strict";
import { ErrorReporter } from "../reports.js";
import { writeReportFile } from "../report-directory.js";
import { createHistory } from "../history.js";
import { bounded } from "../errors.js";
import { Diagnostics } from "../diagnostics.js";

const format = globalThis.AirconReportFormat;
const environment = { version: "1.1.5", userAgent: "Chrome/140.0.0.0 Edg/140.0.1.2" };
const draft = (id = "report-1", at = 1000) => ({ reportId: id, at, startedAt: at - 100, source: "manualCheck", error: { code: "E_HTTP" } });

test("slow export cannot replace a newer passive supplement with the old exported snapshot", async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const writes = [], h = harness({ writeFile: async (_dir, report) => {
    writes.push(report);
    if (writes.length === 1) { started(); await new Promise(resolve => { release = resolve; }); }
  } });
  h.reporter.capture(draft()); await entered;
  await h.reporter.updateFollowup("report-1", { reportId: "report-1", revision: 1, state: "ended", reason: "expired", conclusion: "switch-only-success", switches: [], queries: [] });
  release(); await h.reporter.queue;
  assert.equal(h.data[format.key("report-1")].report.incidentFollowup.revision, 1);
  assert.equal(h.data[format.key("report-1")].saved, true);
  assert.equal(writes.at(-1).incidentFollowup.conclusion, "switch-only-success");
});

test("post-command verification enriches the same report across export, restart and concurrent diagnostics without changing the fault", async () => {
  const h = harness(); h.permission = "prompt";
  h.reporter.capture({ ...draft(), error: { code: "E_API_TIMEOUT" }, outcomeUnknown: true,
    command: { desiredOn: true, sent: true, confirmed: false }, requests: [{ sequence: 3, method: "POST", phase: "headers", errorCode: "E_API_TIMEOUT" }] });
  await h.reporter.queue;
  const original = structuredClone(h.data[format.key("report-1")].report);
  const value = { reportId: "report-1", revision: 2, state: "completed", conclusion: "changed", secret: "SECRET",
    rounds: [{ actualOn: false, timerPresent: false }, { actualOn: true, timerPresent: true, requests: [{ sequence: 2, method: "GET", path: "/app/prepaid/ac-status", body: "SECRET" }] }] };
  await Promise.all([h.reporter.updateVerification("report-1", value), h.reporter.enrich("report-1", { revision: 3, site: { observedOn: true, at: 2000 } })]);
  assert.equal(await h.reporter.updateVerification("report-1", { ...value, revision: 1, state: "waiting" }), false);
  assert.equal(await h.reporter.updateVerification("report-1", { ...value, revision: 2, state: "running" }), false);
  h.permission = "granted"; await new ErrorReporter(h.deps).flush();
  const saved = h.writes.at(-1).report;
  assert.deepEqual(saved.requests, original.requests); assert.deepEqual(saved.error, original.error);
  assert.equal(saved.outcomeUnknown, true); assert.equal(saved.switchCommand.confirmed, false);
  assert.equal(saved.postCommandVerification.conclusion, "changed"); assert.equal(saved.postCommandVerification.state, "completed");
  assert.equal(saved.postCommandVerification.rounds[1].requests[0].sequence, 2);
  assert.equal(JSON.stringify(saved).includes("SECRET"), false);
  assert.equal(Object.values(h.data).filter(v => v.report).length, 1);
  assert.equal(await h.reporter.updateVerification("evicted", { ...value, reportId: "evicted" }), false);
  const fallback = format.makeReport({ ...draft(), source: "pageCommunication", snapshotOrigin: "page-cache", postCommandVerification: value });
  assert.equal(fallback.postCommandVerification.conclusion, "changed");
  assert.equal(format.makeReport(draft()).postCommandVerification, null);
  const large = format.postCommandVerification({ ...value, rounds: Array.from({ length: 20 }, () => ({ requests: Array.from({ length: 20 }, () => ({})) })) });
  assert.equal(large.rounds.length, 2); assert.ok(large.rounds.every(r => r.requests.length === 2));
});

test("orphaned verification is marked interrupted when its session job is missing", async () => {
  const h = harness(); h.permission = "prompt";
  h.reporter.capture({ ...draft(), postCommandVerification: { reportId: "report-1", revision: 1, state: "waiting", rounds: [] } });
  await h.reporter.queue;
  await h.reporter.interruptVerifications("report-1");
  assert.equal(h.data[format.key("report-1")].report.postCommandVerification.state, "waiting");
  await h.reporter.interruptVerifications(null);
  assert.equal(h.data[format.key("report-1")].report.postCommandVerification.reason, "session_ended");
});

test("query recovery and cancellation evidence survive cache, restart, export and fallback sanitization", async () => {
  const h = harness(); h.permission = "prompt";
  const queryRecovery = { id: "initial", initialOperationId: "tick-op", startedAt: 1000, originalNextAt: 900, deadline: 60900,
    nextAttemptAt: 31000, endedAt: 31500, outcome: "recovered", secret: "SECRET",
    rounds: [{ operationId: "tick-op", scheduledAt: 900, startedAt: 900, endedAt: 1000, errorCode: "E_API_TIMEOUT", requests: [
      { method: "GET", path: "/app/prepaid/ac-status", cancelledAt: 1000, cancelledBy: "E_API_TIMEOUT", cancellationOrigin: "request-timeout", body: "SECRET" }
    ] }] };
  h.reporter.capture({ ...draft(), source: "queryRecovery", recovered: true, queryRecovery, run: { id: "cycle", queryRecovery }, requests: queryRecovery.rounds[0].requests });
  await h.reporter.queue;
  h.data[format.key("report-1")].report.queryRecovery.secret = "SECRET";
  h.permission = "granted"; await new ErrorReporter(h.deps).flush();
  const saved = h.writes[0].report;
  assert.equal(saved.queryRecovery.id, "initial"); assert.equal(saved.queryRecovery.outcome, "recovered");
  assert.equal(saved.queryRecovery.rounds[0].requests[0].cancelledAt, 1000);
  assert.equal(saved.requests[0].cancellationOrigin, "request-timeout");
  assert.equal(JSON.stringify(saved).includes("SECRET"), false);
  const fallback = format.makeReport({ ...draft("fallback"), snapshotOrigin: "page-cache", run: { queryRecovery } });
  assert.equal(fallback.queryRecovery.id, "initial");
  assert.equal(format.makeReport(draft("legacy")).queryRecovery, null);
  assert.equal(format.makeReport({ ...draft(), requests: [{}] }).requests[0].cancelledAt, null);
});

test("late diagnostic enrichment preserves original fault evidence within fixed limits", async () => {
  const h = harness();
  h.reporter.capture({ ...draft(), error: { code: "E_API_TIMEOUT" }, requests: [{ sequence: 1, phase: "headers", errorCode: "E_API_TIMEOUT" }],
    diagnostics: { revision: 1, events: [{ operationId: "report-1", at: 900, component: "request", step: "endRequest", code: "E_API_TIMEOUT", outcome: "error" }],
      network: [{ id: "original", operationId: "report-1", sequence: 1, startedAt: 900, events: [{ event: "sendHeaders", at: 901 }] }] } });
  await h.reporter.queue;
  await h.reporter.enrich("report-1", { revision: 2,
    events: Array.from({ length: 100 }, (_, i) => ({ operationId: "other", at: 1000 + i, component: "page", step: "resource" })),
    network: Array.from({ length: 40 }, (_, i) => ({ id: `other-${i}`, operationId: "other", sequence: i + 2, startedAt: 1000 + i })) });
  await h.reporter.queue;
  const saved = h.data[format.key("report-1")].report;
  assert.equal(saved.faultBoundary.browserRequestId, "original");
  assert.equal(saved.faultBoundary.browserStage, "sendHeaders");
  assert.ok(saved.diagnostics.events.some(item => item.operationId === "report-1"));
  assert.ok(saved.diagnostics.events.length <= 64 && saved.diagnostics.network.length <= 32);
  assert.equal(saved.diagnostics.coverage.truncated, true);
  assert.equal(saved.diagnostics.coverage.missingTerminalEvents, true);
});

test("partial late network evidence supplements rather than erases original stages", () => {
  const merged = format.mergeDiagnostics({ network: [{ id: "one", operationId: "op", sequence: 1, events: [{ event: "sendHeaders", at: 1 }] }] },
    { network: [{ id: "one", operationId: "op", sequence: 1, endedAt: 2, error: "ERR_ABORTED", events: [{ event: "error", at: 2 }] }] }, "op");
  assert.deepEqual(merged.network[0].events.map(item => item.event), ["sendHeaders", "error"]);
});

test("timing edits survive cache, restart and export with privacy filtering and legacy unknowns", async () => {
  const h = harness(); h.permission = "prompt";
  const change = { at: 1000, runId: "run-1", phase: "on", phaseStartedAt: 100, expectedRevision: 0, previousRevision: 0,
    nextRevision: 1, before: { onMinutes: 10, offMinutes: 10, token: "SECRET" }, requested: { onMinutes: 5, offMinutes: 4 },
    previousNextAt: 600100, computedNextAt: 300100, effectiveNextAt: 500000, immediate: true, outcome: "failed", token: "SECRET" };
  h.reporter.capture({ ...draft(), source: "updateDurations", timingChange: change,
    run: { id: "run-1", phaseStartedAt: 100, timingRevision: 1, lastTimingChange: { ...change, outcome: "applied" } },
    communication: { messageType: "aircon:updateDurations", reason: "ACCEPTED" } });
  await h.reporter.queue;
  const cached = h.data[format.key("report-1")].report;
  assert.equal(cached.source, "updateDurations"); assert.equal(cached.timingChange.outcome, "failed");
  cached.timingChange.secret = "SECRET"; cached.cycle.lastTimingChange.secret = "SECRET";
  h.permission = "granted";
  await new ErrorReporter(h.deps).flush();
  const saved = h.writes[0].report;
  assert.equal(saved.timingChange.computedNextAt, 300100);
  assert.equal(saved.cycle.lastTimingChange.outcome, "applied");
  assert.equal(saved.cycle.phaseStartedAt, 100); assert.equal(saved.cycle.timingRevision, 1);
  assert.equal(JSON.stringify(saved).includes("SECRET"), false);
  const legacy = format.makeReport({ ...draft(), run: { id: "legacy" } });
  assert.equal(legacy.timingChange, null); assert.equal(legacy.cycle.phaseStartedAt, null); assert.equal(legacy.cycle.timingRevision, null);
});

test("an authentication report receives late navigation across worker restart with monotonic revisions", async () => {
  const h = harness(); let now = 1000000;
  const options = { storage: h.storage, runtimeId: "test", clock: () => now, onUpdate: (id, snapshot) => h.reporter.enrich(id, snapshot) };
  const first = new Diagnostics(options); await first.ready;
  first.page({ tabId: 8, documentId: "doc-1", at: now, route: "login" }, "navigation");
  h.reporter.capture({ ...draft("auth-report", now), source: "recovery", error: { code: "E_RECOVERY_TIMEOUT" }, lifecycle: { event: "authentication", route: "login", tabId: 8 },
    run: { id: "run-1", tabId: 8, recovery: { kind: "authentication", at: now - 60000, deadline: now } }, diagnostics: first.snapshot(8) });
  first.trackReport("auth-report", "auth-operation", 8);
  await first.flush(); await h.reporter.queue;
  const revision = h.data[format.key("auth-report")].report.diagnostics.revision;
  now += 5000;
  const next = new Diagnostics(options);
  next.page({ tabId: 8, documentId: "doc-2", at: now, route: "home" }, "navigation");
  await next.ready; await next.flush(); await h.reporter.cacheQueue; await h.reporter.queue;
  const saved = h.data[format.key("auth-report")].report;
  assert.ok(saved.diagnostics.revision > revision);
  assert.equal(saved.error.code, "E_RECOVERY_TIMEOUT");
  assert.equal(saved.cycle.recovery.kind, "authentication");
  assert.equal(saved.faultBoundary.boundary, "authentication-flow");
  assert.deepEqual(saved.diagnostics.lifecycleEvents.map(e => e.route), ["login", "home"]);
  assert.equal(new Set(h.writes.map(write => write.filename)).size, 1);
});

test("late network diagnostics update the same file and retain the original control error", async () => {
  const h = harness();
  h.reporter.capture({ ...draft(), diagnostics: { revision: 1, coverage: { webRequest: true } } });
  await h.reporter.queue;
  await h.reporter.enrich("report-1", { revision: 2, coverage: { webRequest: true }, network: [{ id: "request-1", path: "/app/prepaid/ac-status", error: "net::ERR_CONNECTION_RESET" }] });
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[0].filename, h.writes[1].filename);
  assert.equal(h.writes[1].report.error.code, "E_HTTP");
  assert.equal(h.writes[1].report.diagnostics.network[0].error, "ERR_CONNECTION_RESET");
  assert.equal(h.data[format.key("report-1")].saved, true);
});

test("enrichment before initial persistence keeps the cached fault boundary consistent", async () => {
  const h = harness(); h.permission = "prompt";
  h.reporter.capture({ ...draft(), error: { code: "E_API_TIMEOUT" }, requests: [{ sequence: 1, errorCode: "E_API_TIMEOUT", phase: "headers" }], diagnostics: { revision: 1 } });
  await h.reporter.enrich("report-1", { revision: 2, network: [{ id: "request-1", operationId: "report-1", sequence: 1, error: "net::ERR_CONNECTION_RESET" }] });
  const entry = h.data[format.key("report-1")];
  assert.equal(entry.saved, false);
  assert.equal(entry.report.faultBoundary.browserError, "ERR_CONNECTION_RESET");
  assert.equal(entry.report.diagnostics.revision, 2);
});

test("an old diagnostic revision finishing file export cannot erase a newer revision", async () => {
  let release, entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const writes = [];
  const h = harness({ writeFile: async (_directory, report, filename) => {
    writes.push({ report, filename });
    if (report.diagnostics.revision === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
  } });
  h.reporter.capture({ ...draft(), diagnostics: { revision: 1 } }); await writing;
  const enriched = h.reporter.enrich("report-1", { revision: 2 });
  await h.reporter.cacheQueue;
  assert.equal(h.data[format.key("report-1")].report.diagnostics.revision, 2);
  release(); await enriched; await h.reporter.queue;
  assert.deepEqual(writes.map(write => write.report.diagnostics.revision), [1, 2]);
  assert.equal(h.data[format.key("report-1")].report.diagnostics.revision, 2);
  assert.equal(h.data[format.key("report-1")].saved, true);
});

test("diagnostic enrichment does not invent absent reports or change page fallback ownership", async () => {
  const h = harness();
  await h.reporter.enrich("missing", { revision: 1 });
  assert.equal(h.data[format.key("missing")], undefined);
  h.reporter.capture({ ...draft(), snapshotOrigin: "page-cache" }); await h.reporter.queue;
  await h.reporter.enrich("report-1", { revision: 1 });
  assert.equal(h.data[format.key("report-1")].report.snapshotOrigin, "page-cache");
  assert.equal(h.data[format.key("report-1")].report.diagnostics, null);
});

function harness(options = {}) {
  const data = {};
  const writes = [];
  let permission = "granted";
  let failure = false;
  const directory = { name: "error-reports", queryPermission: async () => permission };
  const storage = {
    get: async key => structuredClone(key === null ? data : { [key]: data[key] }),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async keys => { for (const key of keys) delete data[key]; }
  };
  const deps = { storage, environment, getDirectory: async () => directory,
    writeFile: async (_directory, report, filename) => { if (failure) throw new Error("disk unavailable"); writes.push({ report, filename }); }, ...options };
  return { data, writes, storage, deps, reporter: new ErrorReporter(deps),
    set permission(value) { permission = value; }, set failure(value) { failure = value; } };
}

test("request attempt accepts only 1 or 2 and leaves missing legacy values unknown", () => {
  const report = format.makeReport({ ...draft(), requests: [1, 2, 0, 3, "2", null, undefined].map(attempt => ({ attempt })) });
  assert.deepEqual(report.requests.map(trace => trace.attempt), [1, 2, null, null, null, null, null]);
});

test("retry attempts survive checkpoint caching, worker restart and file export", async () => {
  const h = harness({ environment: { version: "1.1.12" } }); h.permission = "prompt";
  const history = createHistory(h.storage, { version: "1.1.12" }, (report, values) => h.reporter.persist(report, values));
  const requests = [1, 2].map(attempt => ({ method: "GET", path: "/app/prepaid/ac-timer", attempt, phase: "headers", elapsedMs: 8000, errorCode: "E_API_TIMEOUT" }));
  await history.finish({ id: "run-1" }, { text: "timeout", kind: "error" }, { ...draft(), error: { code: "E_API_TIMEOUT" }, requests });
  await h.reporter.flush();
  assert.equal(h.writes.length, 0);
  assert.equal(h.data.cycleCheckpoint.active, false);
  h.permission = "granted";
  await new ErrorReporter(h.deps).flush();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].report.requests, format.makeReport({ requests }).requests);
  assert.equal(h.writes[0].report.extensionVersion, "1.1.12");
});

test("legacy attempts stay unknown and cached arbitrary attempt text is removed on export", async () => {
  const h = harness();
  const legacy = format.makeReport({ ...draft(), requests: [{ method: "GET", attempt: 1 }, { method: "GET", attempt: 2 }] }, { version: "1.1.11" });
  delete legacy.requests[0].attempt;
  legacy.requests[1].attempt = "SECRET";
  h.data[format.key(legacy.reportId)] = { report: legacy, saved: false };
  await h.reporter.flush();
  assert.deepEqual(h.writes[0].report.requests.map(trace => trace.attempt), [null, null]);
  assert.equal(h.writes[0].report.extensionVersion, "1.1.11");
  assert.equal(h.writes[0].report.schemaVersion, 1);
  assert.equal(JSON.stringify(h.writes).includes("SECRET"), false);
});

test("report is a bounded immutable whitelist, excluding secrets in messages, stacks and responses", () => {
  const secret = "SECRET_TOKEN_OR_ACCOUNT_DATA";
  const input = { ...draft(), error: { code: "E_HTTP", message: secret, stack: `${secret}\n at chrome-extension://private/cycle.js:200:15` },
    run: { id: "run-1", phase: "on", expectedOn: true, token: secret, student: { email: secret } },
    headers: { Authorization: secret }, response: secret,
    requests: [{ method: "GET", path: "/app/prepaid/ac-status", httpStatus: 502, schoolCode: secret, body: secret, headers: secret }]
  };
  const report = format.makeReport(input, environment);
  input.run.phase = "off";
  assert.equal(report.cycle.phase, "on");
  assert.equal(report.browserVersion, "Edg/140.0.1.2");
  assert.equal(report.requests[0].httpStatus, 502);
  assert.deepEqual(report.error.stackLocations, ["cycle.js:200:15"]);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= 32 * 1024);
  assert.equal(report.lastConfirmedStatus.value, null, "expected ON does not imply observed ON");
});

test("untrusted paths, IDs, oversized traces and invalid timestamps cannot escape report format", () => {
  const report = format.makeReport({ ...draft("../escape", 1e100), startedAt: -1,
    error: { code: "arbitrary SECRET" }, requests: Array.from({ length: 100 }, () => ({ method: "DELETE", path: "https://private/?token=SECRET", httpStatus: 999 })) });
  assert.equal(report.error.code, "E_INTERNAL");
  assert.equal(report.requests.length, 10);
  assert.equal(report.requests[0].path, null);
  assert.equal(report.requests[0].method, null);
  assert.equal(format.fileName(report).includes(".."), false);
  assert.equal(format.fileName(report).includes("/"), false);
});

test("communication metadata only accepts known message types and browser reasons", () => {
  const input = { ...draft(), communication: { messageType: "aircon:initialize", reason: "NO_RECEIVER", sourcePage: "SCHOOL_APP", tabIsHome: true, rawMessage: "SECRET" } };
  const report = format.makeReport(input, environment);
  input.communication.reason = "SECRET";
  assert.deepEqual(report.communication, { messageType: "aircon:initialize", reason: "NO_RECEIVER", sourcePage: "SCHOOL_APP", tabIsHome: true });
  const untrusted = format.makeReport({ ...draft(), communication: { messageType: "SECRET", reason: "SECRET", sourcePage: "https://private/?SECRET", tabIsHome: "SECRET", token: "SECRET" } });
  assert.deepEqual(untrusted.communication, { messageType: null, reason: "UNKNOWN", sourcePage: null, tabIsHome: null });
  assert.equal(JSON.stringify([report, untrusted]).includes("SECRET"), false);
});

test("cached communication codes and reasons survive background revalidation and file writing", async () => {
  const h = harness();
  h.permission = "prompt";
  const cases = [
    ["E_BACKGROUND_NO_RECEIVER", "NO_RECEIVER"],
    ["E_BACKGROUND_DISCONNECTED", "CHANNEL_CLOSED"],
    ["E_BACKGROUND_EMPTY_REPLY", "NULL_REPLY"],
    ["E_BACKGROUND_UNAVAILABLE", "UNKNOWN"],
    ["E_BACKGROUND_TIMEOUT", "TIMEOUT"],
    ["E_BACKGROUND_INVALID_REPLY", "INVALID_REPLY"],
    ["E_MESSAGE_SOURCE", "TAB_NOT_HOME"]
  ];
  for (const [code, reason] of cases) h.reporter.capture({
    ...draft(code.replaceAll("_", "-")), source: "pageCommunication", snapshotOrigin: "page-cache", outcomeUnknown: true,
    error: { code }, communication: { messageType: "aircon:start", reason, sourcePage: "HOME", tabIsHome: false }
  });
  await h.reporter.queue;
  assert.equal(h.writes.length, 0);
  h.permission = "granted";
  await h.reporter.flush();
  assert.equal(h.writes.length, cases.length);
  for (const [code, reason] of cases) {
    const id = code.replaceAll("_", "-");
    const report = h.writes.find(item => item.report.reportId === id).report;
    assert.equal(report.error.code, code);
    assert.deepEqual(report.communication, { messageType: "aircon:start", reason, sourcePage: "HOME", tabIsHome: false });
    assert.equal(report.outcomeUnknown, true);
    assert.equal(h.data[format.key(id)].saved, true);
  }
});

test("legacy version 1 reports without communication metadata still flush unchanged", async () => {
  const h = harness();
  const legacy = format.makeReport({ ...draft(), source: "pageCommunication", snapshotOrigin: "page-cache",
    outcomeUnknown: true, error: { code: "E_BACKGROUND_UNAVAILABLE" } }, environment);
  delete legacy.communication;
  h.data[format.key(legacy.reportId)] = { report: legacy, saved: false };
  await h.reporter.flush();
  assert.equal(h.writes.length, 1);
  const report = h.writes[0].report;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.extensionVersion, "1.1.5");
  assert.equal(report.error.code, "E_BACKGROUND_UNAVAILABLE");
  assert.equal(report.communication, null, "do not invent a reason for old reports");
  assert.equal(report.operation.elapsedMs, legacy.operation.elapsedMs);
  assert.equal(report.reportId, legacy.reportId);
});

test("legacy 1.1.6 reports do not invent source observations when flushed", async () => {
  const h = harness();
  const legacy = format.makeReport({ ...draft(), source: "pageCommunication", snapshotOrigin: "page-cache",
    error: { code: "E_BACKGROUND_EMPTY_REPLY" }, communication: { messageType: "aircon:initialize", reason: "UNDEFINED_REPLY" }
  }, { ...environment, version: "1.1.6" });
  delete legacy.communication.sourcePage;
  delete legacy.communication.tabIsHome;
  h.data[format.key(legacy.reportId)] = { report: legacy, saved: false };
  await h.reporter.flush();
  const report = h.writes[0].report;
  assert.equal(report.extensionVersion, "1.1.6");
  assert.equal(report.error.code, "E_BACKGROUND_EMPTY_REPLY");
  assert.deepEqual(report.communication, { messageType: "aircon:initialize", reason: "UNDEFINED_REPLY", sourcePage: null, tabIsHome: null });
});

test("unconfigured directory caches reports and later authorization automatically flushes them", async () => {
  const h = harness();
  h.permission = "prompt";
  h.reporter.capture(draft());
  await h.reporter.queue;
  assert.equal(h.reporter.state.phase, "permission");
  assert.equal(h.reporter.state.pending, 1);
  assert.equal(h.data[format.key("report-1")].saved, false);
  assert.equal(h.writes.length, 0);
  h.permission = "granted";
  await h.reporter.flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.data[format.key("report-1")].saved, true);
  assert.equal(h.reporter.state.phase, "ready");
});

test("directory failure does not discard persisted report and a new worker can save it", async () => {
  const h = harness({ getDirectory: async () => { throw new Error("IDB unavailable"); } });
  h.reporter.capture(draft());
  await h.reporter.queue;
  assert.equal(h.reporter.state.phase, "directory-error");
  const restarted = new ErrorReporter({ ...h.deps, getDirectory: async () => ({ name: "error-reports", queryPermission: async () => "granted" }) });
  await restarted.flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].report.occurredAt, new Date(1000).toISOString());
  assert.equal(h.writes[0].report.extensionVersion, "1.1.5");
});

test("write failure remains pending, retry uses the same file and no recursive report", async () => {
  const h = harness();
  h.failure = true;
  h.reporter.capture(draft());
  await h.reporter.queue;
  assert.equal(h.reporter.state.phase, "write-error");
  assert.equal(Object.keys(h.data).length, 1);
  h.failure = false;
  await h.reporter.flush();
  assert.equal(h.writes[0].filename, format.fileName(h.data[format.key("report-1")].report));
  assert.equal(h.reporter.state.pending, 0);
});

test("duplicate layers record one fault and late backend detail replaces a cached page observation", async () => {
  const h = harness();
  h.reporter.capture({ ...draft(), snapshotOrigin: "page-cache", outcomeUnknown: true, error: { code: "E_BACKGROUND_TIMEOUT" } });
  await h.reporter.queue;
  h.reporter.capture({ ...draft(), requests: [{ method: "GET", path: "/app/prepaid/ac-status", httpStatus: 502 }] });
  await h.reporter.queue;
  h.reporter.capture(draft());
  await h.reporter.queue;
  assert.equal(Object.keys(h.data).length, 1);
  assert.equal(h.writes.length, 2, "one initial cache file, then authoritative replacement");
  assert.equal(h.writes[0].filename, h.writes[1].filename);
  assert.equal(h.writes[1].report.requests[0].httpStatus, 502);
});

test("only newest 20 reports are cached and unrelated settings are preserved", async () => {
  const h = harness();
  h.permission = "denied";
  h.data.cycleDurations = { onMinutes: 3, offMinutes: 6 };
  for (let i = 0; i < 23; i++) h.reporter.capture(draft(`report-${i}`, 1000 + i));
  await h.reporter.queue;
  assert.equal(Object.keys(h.data).filter(format.isKey).length, 20);
  assert.equal(h.data[format.key("report-0")], undefined);
  assert.ok(h.data[format.key("report-22")]);
  assert.deepEqual(h.data.cycleDurations, { onMinutes: 3, offMinutes: 6 });
});

test("normal cancellation creates no report", async () => {
  const h = harness();
  assert.equal(h.reporter.capture({ ...draft(), error: { code: "E_CANCELLED" } }), null);
  await h.reporter.queue;
  assert.equal(Object.keys(h.data).length, 0);
});

test("hanging local storage times out in its own queue and reports storage failure", async () => {
  const h = harness({ storage: { get: () => new Promise(() => {}) }, timeoutMs: 10 });
  h.reporter.capture(draft());
  await h.reporter.queue;
  assert.equal(h.reporter.state.phase, "storage-error");
});

test("revoked directory permission preserves next fault and does not re-save earlier files", async () => {
  const h = harness();
  h.reporter.capture(draft());
  await h.reporter.queue;
  h.permission = "denied";
  h.reporter.capture(draft("report-2", 2000));
  await h.reporter.queue;
  assert.equal(h.writes.length, 1);
  assert.equal(h.reporter.state.pending, 1);
  h.permission = "granted";
  await h.reporter.flush();
  assert.equal(h.writes.length, 2);
});

test("file is not considered written until the stream closes", async () => {
  let close;
  let began;
  let contents;
  let finished = false;
  const opened = new Promise(resolve => { began = resolve; });
  const directory = {
    queryPermission: async () => "granted",
    getFileHandle: async () => ({ createWritable: async () => ({
      write: async text => { contents = text; began(); },
      close: () => new Promise(resolve => { close = resolve; }), abort: async () => {}
    }) })
  };
  const pending = writeReportFile(directory, format.makeReport(draft()), "safe.json").then(() => { finished = true; });
  await opened;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(JSON.parse(contents).schemaVersion, 1);
  close();
  await pending;
  assert.equal(finished, true);
});

test("file permission denial never creates a file", async () => {
  let touched = false;
  const directory = { queryPermission: async () => "denied", getFileHandle: async () => { touched = true; } };
  await assert.rejects(writeReportFile(directory, {}, "safe.json"), { code: "REPORT_PERMISSION" });
  assert.equal(touched, false);
});

test("timed-out file creation cannot write a late report", async () => {
  let finish;
  let writes = 0;
  const directory = {
    queryPermission: async () => "granted",
    getFileHandle: () => new Promise(resolve => { finish = resolve; })
  };
  await assert.rejects(writeReportFile(directory, {}, "safe.json", 10), { code: "REPORT_FILE_TIMEOUT" });
  finish({ createWritable: async () => { writes++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("manual-check observations and request phases reject arbitrary cached text", () => {
  const report = format.makeReport({ ...draft(), manualCheck: { trigger: "SECRET", observedOn: "SECRET", rawValue: "SECRET" },
    requests: [{ method: "GET", path: "/app/prepaid/ac-status", phase: "SECRET" }] }, environment);
  assert.deepEqual(report.manualCheck, { trigger: "unknown", observedOn: null });
  assert.equal(report.requests[0].phase, null);
  assert.equal(JSON.stringify(report).includes("SECRET"), false);
  assert.equal(format.makeReport({ ...draft(), manualCheck: ["click"] }).manualCheck, null);
  assert.equal(format.makeReport({ ...draft(), manualCheck: "click" }).manualCheck, null);
});

for (const source of ["manualCheck", "pageCommunication"]) {
  test(`${source} metadata and phases survive permission cache, worker restart and file save`, async () => {
    const h = harness({ environment: { version: "1.1.9", userAgent: "Edg/155.0.0.0" } });
    h.permission = "prompt";
    const input = { ...draft(), source,
      snapshotOrigin: source === "pageCommunication" ? "page-cache" : "background",
      manualCheck: { trigger: source === "manualCheck" ? "stateChange" : "click", observedOn: false },
      requests: ["token", "headers", "body", "validation", "complete"].map(phase => ({ method: "GET", path: "/app/prepaid/ac-status", phase }))
    };
    const expected = { ...input.manualCheck };
    h.reporter.capture(input);
    input.manualCheck.trigger = "SECRET";
    input.requests[0].phase = "SECRET";
    await h.reporter.queue;
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.data[format.key("report-1")].report.manualCheck, expected);
    h.permission = "granted";
    const restarted = new ErrorReporter({ ...h.deps, environment: { version: "1.1.10" } });
    await restarted.flush();
    assert.equal(h.writes.length, 1);
    const saved = h.writes[0].report;
    assert.deepEqual(saved.manualCheck, expected);
    assert.deepEqual(saved.requests.map(request => request.phase), ["token", "headers", "body", "validation", "complete"]);
    assert.equal(saved.extensionVersion, "1.1.9", "retain the version which created the report");
    assert.equal(saved.snapshotOrigin, input.snapshotOrigin);
    assert.equal(JSON.stringify(saved).includes("SECRET"), false);
  });
}

test("legacy 1.1.8 report does not infer manual trigger or phase during flush", async () => {
  const h = harness();
  const legacy = format.makeReport({ ...draft(),
    requests: [{ method: "GET", path: "/app/prepaid/ac-status", httpStatus: null, errorCode: "E_API_TIMEOUT" }] }, { version: "1.1.8" });
  delete legacy.manualCheck;
  delete legacy.requests[0].phase;
  h.data[format.key(legacy.reportId)] = { report: legacy, saved: false };
  await h.reporter.flush();
  const saved = h.writes[0].report;
  assert.equal(saved.manualCheck, null);
  assert.equal(saved.requests[0].phase, null);
  assert.equal(saved.requests[0].errorCode, "E_API_TIMEOUT");
  assert.equal(saved.extensionVersion, "1.1.8");
  assert.equal(saved.reportId, legacy.reportId);
});

test("persisted untrusted manual metadata is filtered again before file writing", async () => {
  const h = harness();
  const cached = format.makeReport(draft(), environment);
  cached.manualCheck = { trigger: "SECRET", observedOn: "SECRET", raw: "SECRET" };
  cached.requests = [{ method: "GET", path: "/app/prepaid/ac-status", phase: "SECRET" }];
  h.data[format.key(cached.reportId)] = { report: cached, saved: false };
  await h.reporter.flush();
  const saved = h.writes[0].report;
  assert.deepEqual(saved.manualCheck, { trigger: "unknown", observedOn: null });
  assert.equal(saved.requests[0].phase, null);
  assert.equal(JSON.stringify(saved).includes("SECRET"), false);
});

test("lifecycle observations survive report caching and export with the original version", async () => {
  const h = harness({ environment: { version: "1.1.10" } });
  h.permission = "prompt";
  h.reporter.capture({ ...draft(), source: "recovery", error: { code: "E_RECOVERY_TIMEOUT" },
    lifecycle: { event: "initialize", navigationType: "reload", wasDiscarded: true, frozen: false, token: "SECRET" } });
  await h.reporter.queue;
  h.permission = "granted";
  await new ErrorReporter({ ...h.deps, environment: { version: "2.0.0" } }).flush();
  const saved = h.writes[0].report;
  assert.equal(saved.extensionVersion, "1.1.10");
  assert.deepEqual(saved.lifecycle, { event: "initialize", route: null, tabId: null, documentId: null, navigationType: "reload", wasDiscarded: true, frozen: false, discarded: null });
  assert.equal(JSON.stringify(saved).includes("SECRET"), false);
});

test("legacy lifecycle stays unknown and malicious cached lifecycle data is filtered on export", async () => {
  const h = harness();
  h.reporter.capture(draft("legacy")); await h.reporter.queue;
  assert.equal(h.writes[0].report.lifecycle, null);
  const cached = format.makeReport(draft("unsafe"), environment);
  cached.lifecycle = { event: "SECRET", navigationType: "SECRET", wasDiscarded: "SECRET", frozen: "SECRET", rawUrl: "SECRET" };
  h.data[format.key(cached.reportId)] = { report: cached, saved: false };
  await h.reporter.flush();
  const saved = h.writes.at(-1).report;
  assert.equal(saved.lifecycle.event, "unknown");
  assert.equal(JSON.stringify(saved).includes("SECRET"), false);
});

const pageFallback = (id, at = 2000) => format.makeReport({ ...draft(id, at), startedAt: 900, source: "pageCommunication", snapshotOrigin: "page-cache",
  error: { code: "E_BACKGROUND_TIMEOUT" }, outcomeUnknown: true }, { version: "1.1.11" });

test("a staged page timeout cannot overwrite or re-export an already saved backend fault", async () => {
  const h = harness();
  h.reporter.capture({ ...draft(), requests: [{ method: "GET", path: "/app/prepaid/ac-timer", httpStatus: 502 }] });
  await h.reporter.queue;
  const original = structuredClone(h.data[format.key("report-1")]);
  h.data[format.fallbackKey("report-1")] = { report: pageFallback("report-1"), saved: false };
  await h.reporter.flush();
  assert.deepEqual(h.data[format.key("report-1")], original);
  assert.equal(h.data[format.fallbackKey("report-1")], undefined);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].report.requests[0].httpStatus, 502);
});

test("staged reports survive a cold worker and permission loss, then upgrade to backend detail", async () => {
  const h = harness({ environment: { version: "1.1.11" } }); h.permission = "prompt";
  h.data[format.fallbackKey("report-1")] = { report: pageFallback("report-1"), saved: false };
  await h.reporter.flush();
  assert.equal(h.data[format.key("report-1")].report.snapshotOrigin, "page-cache");
  assert.equal(h.data[format.fallbackKey("report-1")], undefined);
  assert.equal(h.writes.length, 0);
  h.reporter.capture({ ...draft(), requests: [{ method: "GET", path: "/app/prepaid/ac-status", phase: "headers", errorCode: "E_API_TIMEOUT" }] });
  await h.reporter.queue;
  h.permission = "granted";
  await new ErrorReporter({ ...h.deps, environment: { version: "2.0.0" } }).flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].report.snapshotOrigin, "background");
  assert.equal(h.writes[0].report.extensionVersion, "1.1.11");
  assert.equal(h.writes[0].report.requests[0].phase, "headers");
});

test("canonical and staged caches share a limit of twenty report IDs and preserve unrelated state", async () => {
  const h = harness(); h.permission = "prompt";
  h.data.cycleCheckpoint = { active: true, run: { id: "keep-this-run" } };
  for (let i = 0; i < 23; i++) {
    const id = `mixed-${i}`;
    h.data[format.key(id)] = { report: format.makeReport(draft(id, 1000 + i)), saved: false };
    h.data[format.fallbackKey(id)] = { report: pageFallback(id, 1000 + i), saved: false };
  }
  await h.reporter.flush();
  assert.equal(Object.keys(h.data).filter(format.isCacheKey).length, 20);
  assert.equal(Object.keys(h.data).some(format.isFallbackKey), false);
  assert.equal(h.data[format.key("mixed-0")], undefined);
  assert.equal(h.data[format.key("mixed-22")].report.error.code, "E_HTTP");
  assert.equal(h.data.cycleCheckpoint.run.id, "keep-this-run");
});

test("fallback import revalidates private fields and cannot claim a backend origin", async () => {
  const h = harness();
  const report = pageFallback("report-1");
  Object.assign(report, { snapshotOrigin: "background", token: "SECRET", lifecycle: { event: "SECRET", rawUrl: "SECRET" } });
  h.data[format.fallbackKey("report-1")] = { report, saved: false };
  await h.reporter.flush();
  assert.equal(h.writes[0].report.snapshotOrigin, "page-cache");
  assert.equal(JSON.stringify(h.writes).includes("SECRET"), false);
});

test("five simultaneous captures and storage notifications share one scan and permission check", async () => {
  const h = harness();
  let scans = 0, permissions = 0, statuses = 0;
  const get = h.storage.get, set = h.storage.set;
  h.storage.get = key => { if (key === null) scans++; return get(key); };
  h.storage.set = async values => { await set(values); if (Object.values(values).some(entry => entry?.saved === false)) h.reporter.flush(); };
  h.reporter.getDirectory = async () => ({ name: "mock", queryPermission: async () => { permissions++; return "granted"; } });
  h.reporter.onStatus = () => { statuses++; };
  for (let i = 0; i < 5; i++) h.reporter.capture(draft(`batch-${i}`));
  await h.reporter.queue;
  assert.equal(h.writes.length, 5);
  assert.equal(scans, 1);
  assert.equal(permissions, 1);
  const before = statuses;
  h.reporter.update({ phase: "ready", pending: 0 });
  assert.equal(statuses, before, "unchanged state does not broadcast again");
});

test("reports arriving during a file write are saved in the following pass without duplicates", async () => {
  const h = harness();
  let release, started;
  const writing = new Promise(resolve => { started = resolve; });
  h.reporter.writeFile = async (_directory, report) => {
    h.writes.push(report.reportId);
    if (report.reportId === "first") { started(); await new Promise(resolve => { release = resolve; }); }
  };
  h.reporter.capture(draft("first")); await writing;
  h.reporter.capture(draft("second")); h.reporter.capture(draft("third"));
  for (let i = 0; i < 5; i++) h.reporter.flush();
  release(); await h.reporter.queue;
  assert.deepEqual(h.writes.sort(), ["first", "second", "third"]);
  assert.equal(h.reporter.state.pending, 0);
});

test("critical checkpoint caching does not wait for file export and an old export cannot erase backend detail", async () => {
  const h = harness();
  let release, started;
  const writing = new Promise(resolve => { started = resolve; });
  h.reporter.writeFile = async (_directory, report, filename) => {
    h.writes.push({ report, filename });
    if (report.snapshotOrigin === "page-cache") { started(); await new Promise(resolve => { release = resolve; }); }
  };
  h.data[format.fallbackKey("report-1")] = { report: pageFallback("report-1"), saved: false };
  h.reporter.flush(); await writing;
  const history = createHistory(h.storage, environment, (report, values) => h.reporter.persist(report, values));
  await bounded(() => history.finish({ id: "cycle-1" }, { kind: "error", text: "backend failure" }, draft()), { ms: 200 });
  assert.equal(h.data.cycleCheckpoint.active, false);
  assert.equal(h.data[format.key("report-1")].report.snapshotOrigin, "background");
  release(); await h.reporter.queue;
  assert.deepEqual(h.writes.map(entry => entry.report.snapshotOrigin), ["page-cache", "background"]);
  assert.equal(h.writes[0].filename, h.writes[1].filename, "backend detail updates the same report file");
  assert.equal(h.data[format.key("report-1")].report.error.code, "E_HTTP");
  assert.equal(h.data[format.key("report-1")].saved, true);
});

test("a backend commit during a stale cache snapshot still wins fallback import", async () => {
  const h = harness();
  h.data[format.fallbackKey("report-1")] = { report: pageFallback("report-1"), saved: false };
  const get = h.storage.get;
  let release, started;
  const reading = new Promise(resolve => { started = resolve; });
  let first = true;
  h.storage.get = async key => {
    const snapshot = await get(key);
    if (key === null && first) { first = false; started(); await new Promise(resolve => { release = resolve; }); }
    return snapshot;
  };
  h.reporter.flush(); await reading;
  const backend = format.makeReport(draft(), environment);
  await h.reporter.persist(backend);
  release(); await h.reporter.queue;
  assert.equal(h.data[format.key("report-1")].report.snapshotOrigin, "background");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].report.error.code, "E_HTTP");
});

test("late browser HTTP 200 survives cache/restart/export without confirming a timed-out command", async () => {
  const h = harness(); h.permission = "prompt";
  const request = { sequence: 3, method: "POST", path: "/app/prepaid/toggle-status", errorCode: "E_API_TIMEOUT",
    phase: "headers", timeoutMs: 15000, cancelledAt: 1000, cancelledBy: "E_API_TIMEOUT", cancellationOrigin: "request-timeout" };
  h.reporter.capture({ ...draft(), error: { code: "E_API_TIMEOUT" }, requests: [request], outcomeUnknown: true,
    command: { desiredOn: false, sent: true, confirmed: false },
    diagnostics: { revision: 1, network: [{ id: "net-3", operationId: "report-1", sequence: 3, correlation: "unique", events: [{ event: "sendHeaders", at: 900 }] }] } });
  await h.reporter.queue;
  const original = structuredClone(h.data[format.key("report-1")].report);
  assert.equal(original.faultBoundary.browserHttpStatus, null);
  await h.reporter.enrich("report-1", { revision: 2, site: { at: 2000, observedOn: false },
    network: [{ id: "net-3", operationId: "report-1", sequence: 3, correlation: "unique", httpStatus: 200,
      events: [{ event: "headersReceived", at: 1000.4 }, { event: "responseStarted", at: 1000.8 }, { event: "completed", at: 1001 }] }] });
  h.permission = "granted"; await new ErrorReporter(h.deps).flush();
  const saved = h.writes.at(-1).report;
  assert.equal(saved.faultBoundary.browserHttpStatus, 200);
  assert.equal(saved.faultBoundary.responseHeadersAt, 1000.4);
  assert.equal(saved.faultBoundary.browserCompletedAt, 1001);
  assert.ok(Math.abs(saved.faultBoundary.responseHeadersAfterCancellationMs - 0.4) < 1e-9);
  assert.deepEqual(saved.requests, original.requests);
  assert.equal(saved.switchCommand.confirmed, false); assert.equal(saved.outcomeUnknown, true);
  assert.equal(saved.error.code, "E_API_TIMEOUT"); assert.equal(saved.faultBoundary.boundary, "headers");
});

for (const association of ["other-operation", "other-sequence", "ambiguous"]) test(`browser summary ignores ${association} evidence`, () => {
  const report = format.makeReport({ ...draft(), requests: [{ sequence: 1, errorCode: "E_HTTP" }], diagnostics: {
    network: [{ id: "network", operationId: association === "other-operation" ? "elsewhere" : "report-1",
      sequence: association === "other-sequence" ? 2 : 1, correlation: association === "ambiguous" ? "ambiguous" : "unique",
      httpStatus: 502, events: [{ event: "headersReceived", at: 1000 }, { event: "completed", at: 1001 }] }] } });
  for (const key of ["browserHttpStatus", "responseHeadersAt", "browserCompletedAt", "responseHeadersAfterCancellationMs"]) assert.equal(report.faultBoundary[key], null);
});

test("HTTP recovery cause is sanitized across cache, checkpoint, export and page fallback", async () => {
  const h = harness(); h.permission = "prompt";
  const initialFailure = { errorCode: "E_HTTP", httpStatus: 502, path: "/app/prepaid/ac-timer", sequence: 1, token: "SECRET" };
  const queryRecovery = { id: "recovery-id", initialOperationId: "first-op", initialFailure, rounds: [], outcome: "waiting" };
  h.reporter.capture({ ...draft(), queryRecovery, run: { id: "run", queryRecovery } }); await h.reporter.queue;
  const history = createHistory(h.deps.storage); await history.save({ id: "run", queryRecovery });
  assert.equal((await history.get()).run.queryRecovery.initialFailure.httpStatus, 502);
  h.permission = "granted"; await new ErrorReporter(h.deps).flush();
  const exported = h.writes.at(-1).report;
  assert.deepEqual(exported.queryRecovery.initialFailure, { errorCode: "E_HTTP", httpStatus: 502, path: "/app/prepaid/ac-timer", sequence: 1 });
  assert.equal(JSON.stringify(exported).includes("SECRET"), false);
  const fallback = format.makeReport({ ...draft(), snapshotOrigin: "page-cache", run: { queryRecovery } });
  assert.deepEqual(fallback.queryRecovery.initialFailure, exported.queryRecovery.initialFailure);
  assert.equal(format.queryRecovery({}).initialFailure, null);
  assert.equal(format.queryRecovery({ initialFailure: { httpStatus: 999, path: "/private", sequence: -1 } }).initialFailure.httpStatus, null);
});
