import test from "node:test";
import assert from "node:assert/strict";
import { Diagnostics } from "../diagnostics.js";
import { ErrorReporter } from "../reports.js";
import { observeFollowup } from "../incident-followup.js";
import { memoryStorage } from "./storage-fixture.js";
const fmt = globalThis.AirconReportFormat;
const STATUS = "/app/prepaid/ac-status", TIMER = "/app/prepaid/ac-timer", SWITCH = "/app/prepaid/toggle-status";
const state = () => ({ reportId: "incident", tabId: 8, documentId: "doc-1", startedAt: 100000, deadlineAt: 1000000,
  failurePath: TIMER, failureStartedAt: 99000, switches: [], queries: [], revision: 0, state: "observing" });
const record = (path = STATUS, extra = {}) => ({ id: "request-1", tabId: 8, documentId: "doc-1", path, method: "GET", startedAt: 101000, endedAt: 101100, httpStatus: 200, schoolCode: 200, ...extra });

test("native POST success does not imply timer health; later same-endpoint success is distinct", () => {
  const s = state();
  observeFollowup(s, record(SWITCH, { method: "POST", switchAccepted: true }));
  assert.equal(s.conclusion, "switch-only-success");
  observeFollowup(s, record(STATUS, { id: "status-after", startedAt: 102000, actualOn: false }));
  assert.equal(s.switches[0].statusAfter.actualOn, false); assert.equal(s.conclusion, "switch-only-success");
  observeFollowup(s, record(TIMER, { id: "timer-later", startedAt: 250000 }));
  assert.equal(s.conclusion, "endpoint-later-recovered");
  assert.equal(fmt.incidentFollowup(s).serverInternalCause, "unknown");
});
test("same-endpoint near-time success is a discrepancy clue, not a server-root conclusion", () => {
  const s = state(); observeFollowup(s, record(TIMER)); assert.equal(s.conclusion, "same-endpoint-discrepancy");
});
test("late business summaries do not replace the latest request and can recover the true first success", () => {
  const s = state();
  observeFollowup(s, record(TIMER, { id: "earlier", startedAt: 110000, schoolCode: null }));
  observeFollowup(s, record(TIMER, { id: "later", startedAt: 120000 }));
  observeFollowup(s, record(TIMER, { id: "earlier", startedAt: 110000, result: "json" }));
  assert.equal(s.queries.find(q => q.role === "latest").id, "later");
  assert.equal(s.queries.find(q => q.role === "first-success").id, "earlier");
});
for (const extra of [{ documentId: "doc-2" }, { startedAt: 140000 }, { startedAt: 100900 }]) test(`status pairing rejects wrong document/time ${JSON.stringify(extra)}`, () => {
  const s = state(); observeFollowup(s, record(SWITCH, { method: "POST", switchAccepted: true }));
  observeFollowup(s, record(STATUS, { id: "different-status", ...extra }));
  assert.equal(s.switches[0].statusAfter, undefined);
});
test("ambiguous switches do not claim the same later status as confirmation", () => {
  const s = state();
  for (let i=0;i<2;i++) observeFollowup(s, record(SWITCH, { id: `switch-${i}`, method: "POST", startedAt: 101000 + i, endedAt: 101100 + i }));
  observeFollowup(s, record(STATUS, { id: "status", startedAt: 102000 }));
  assert.ok(s.switches.every(r => !r.statusAfter));
});
test("out-of-order page summary pairs status with page completion rather than the later browser terminal timestamp", () => {
  const s = state();
  observeFollowup(s, record(SWITCH, { method: "POST", endedAt: 102010 }));
  observeFollowup(s, record(STATUS, { id: "after", startedAt: 102000, actualOn: false }));
  assert.equal(s.switches[0].statusAfter, undefined);
  observeFollowup(s, record(SWITCH, { method: "POST", result: "json", endedAt: 101999, switchAccepted: true }));
  assert.equal(s.switches[0].statusAfter.actualOn, false);
});
test("polling cannot evict retained switches; first endpoint success survives bounded latest samples", () => {
  const s = state();
  for (let i=0;i<20;i++) {
    observeFollowup(s, record(SWITCH, { id: `switch-${i}`, method: "POST", switchAccepted: true, startedAt: 101000+i*1000, endedAt: 101010+i*1000 }));
    observeFollowup(s, record(STATUS, { id: `status-${i}`, startedAt: 101100+i*1000 }));
    observeFollowup(s, record(TIMER, { id: `timer-${i}`, startedAt: 101200+i*1000 }));
  }
  for (let i=0;i<100;i++) observeFollowup(s, record(STATUS, { id: `poll-${i}`, startedAt: 500000+i }));
  const clean = fmt.incidentFollowup(s);
  assert.equal(clean.switches.length, 4); assert.ok(clean.queries.length <= 4);
  assert.equal(clean.queries.find(r => r.path === STATUS && r.role === "first-success").id, "status-0");
  assert.equal(observeFollowup(s, record(STATUS, { startedAt: 1000000 })), false);
  assert.equal(observeFollowup(s, record("/private")), false);
});
test("passive evidence survives worker wake, report enrichment, export and page-cache sanitization", async () => {
  const local = {}, session = {}, writes = [], alarms = new Map(); let now = 100000;
  const reporter = new ErrorReporter({ storage: memoryStorage(local), getDirectory: async () => ({ queryPermission: async () => "granted" }), writeFile: async (_dir, report) => writes.push(report) });
  const draft = { reportId: "incident", source: "queryRecovery", at: now, startedAt: now-1000, error: { code: "E_HTTP" },
    run: { id: "run", tabId: 8, documentId: "doc-1" }, requests: [{ method: "GET", path: TIMER, startedAt: 99000, sequence: 1, httpStatus: 502, errorCode: "E_HTTP" }],
    queryRecovery: { endedAt: now, outcome: "stopped", initialFailure: { path: TIMER }, rounds: [] } };
  reporter.capture(draft); await reporter.queue;
  const deps = { storage: memoryStorage(local), sessionStorage: memoryStorage(session), runtimeId: "test", clock: () => now,
    onFollowup: (id, value) => reporter.updateFollowup(id, value), onOrphanFollowups: ids => reporter.interruptFollowups(ids),
    followupAlarm: { create: async (id, when) => alarms.set(id, when), clear: async id => alarms.delete(id) } };
  let d = new Diagnostics(deps); await d.ready; await d.startFollowup(draft); await d.flush();
  await new Promise(resolve => setImmediate(resolve));
  now += 240000; d = new Diagnostics(deps); await d.ready;
  assert.equal(d.followups.get(8).deadlineAt, 1000000);
  d.passiveEvidence(record(SWITCH, { method: "POST", id: "native", startedAt: now, endedAt: now+10 }), false);
  d.passiveEvidence(record(SWITCH, { method: "POST", browserRequestId: "native", id: undefined, switchAccepted: true, startedAt: now, endedAt: now+10, body: "SECRET" }), true);
  await d.flush(); await d.followupUpdates; await reporter.queue;
  const r = local[fmt.key("incident")].report;
  assert.equal(r.incidentFollowup.conclusion, "switch-only-success", JSON.stringify({ state: d.followups.get(8), saved: r.incidentFollowup })); assert.equal(r.error.code, "E_HTTP");
  assert.equal(r.requests[0].httpStatus, 502); assert.equal(JSON.stringify(r).includes("SECRET"), false);
  assert.equal(r.incidentFollowup.coverage.receivedCount, 1);
  await d.endFollowup(8, "new-cycle"); await d.flush(); await d.followupUpdates; await reporter.queue;
  assert.equal(local[fmt.key("incident")].report.incidentFollowup.reason, "new-cycle");
  assert.ok(writes.some(r => r.incidentFollowup?.conclusion === "switch-only-success"));
  const fallback = fmt.makeReport({ ...draft, snapshotOrigin: "page-cache", incidentFollowup: r.incidentFollowup });
  assert.equal(fallback.incidentFollowup.switches[0].switchAccepted, true);
  assert.equal(fmt.makeReport({}).incidentFollowup, null);
});
test("session loss marks orphan followup ended and cannot recreate the control cycle", async () => {
  const local = {}, reporter = new ErrorReporter({ storage: memoryStorage(local), getDirectory: async () => null });
  reporter.capture({ reportId: "orphan", error: { code: "E_HTTP" }, incidentFollowup: { ...state(), reportId: "orphan" } }); await reporter.queue;
  await reporter.interruptFollowups([]);
  assert.equal(local[fmt.key("orphan")].report.incidentFollowup.reason, "session-ended");
  assert.equal(local.cycleCheckpoint, undefined);
});
