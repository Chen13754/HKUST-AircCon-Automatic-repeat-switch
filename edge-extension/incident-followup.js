// Pure, bounded reducer for passive browser/page evidence. Never issues I/O.
import "./report-format.js";
const format = globalThis.AirconReportFormat;
const STATUS = "/app/prepaid/ac-status", TIMER = "/app/prepaid/ac-timer", SWITCH = "/app/prepaid/toggle-status";
const success = r => r.httpStatus === 200 && r.schoolCode === 200;
export function followupObservation(value) {
  if (!value || ![STATUS, TIMER, SWITCH].includes(value.path)) return null;
  return { id: value.id ?? value.browserRequestId, ...format.pageResponse(value), error: format.networkRecord(value).error,
    evidenceSource: value.result ? "page-observer" : value.evidenceSource ?? "browser",
    pageEndedAt: value.result ? value.endedAt : value.pageEndedAt ?? null };
}
export function observeFollowup(state, value) {
  const record = followupObservation(value);
  if (!record || !record.id || record.startedAt < state.startedAt || record.startedAt >= state.deadlineAt) return false;
  const same = r => r.id === record.id;
  const combine = old => ({ ...old, ...Object.fromEntries(Object.entries(record).filter(([, v]) => v !== null && v !== undefined)),
    evidenceSource: old.evidenceSource === "page-observer" ? "page-observer" : record.evidenceSource });
  if (record.method === "POST" && record.path === SWITCH) {
    const entry = state.switches.find(same);
    if (entry) Object.assign(entry, combine(entry));
    else state.switches.push(record);
    state.switches = state.switches.sort((a,b) => a.startedAt - b.startedAt).slice(-4);
  } else if (record.method === "GET" && [STATUS, TIMER].includes(record.path)) {
    const entry = state.queries.find(r => r.path === record.path && r.role === "latest");
    const updated = entry && same(entry) ? combine(entry) : record;
    state.queries = state.queries.filter(r => r.path !== record.path || r.role !== "latest");
    state.queries.push({ ...(entry && entry.startedAt > updated.startedAt ? entry : updated), role: "latest" });
    const first = state.queries.find(r => r.path === record.path && r.role === "first-success");
    if (success(updated) && (!first || updated.startedAt < first.startedAt)) {
      state.queries = state.queries.filter(r => r !== first);
      state.queries.push({ ...updated, role: "first-success" });
    }
    const candidates = state.switches.filter(s => s.documentId && s.documentId === record.documentId && (s.pageEndedAt ?? s.endedAt) !== null
      && record.startedAt >= (s.pageEndedAt ?? s.endedAt) - 2 && record.startedAt - (s.pageEndedAt ?? s.endedAt) <= 30000);
    if (record.path === STATUS && candidates.length === 1) {
      const s = candidates[0];
      if (!s.statusAfter || s.statusAfter.id === record.id) s.statusAfter = combine(s.statusAfter ?? {});
    }
  } else return false;
  // Reconcile a later business summary with the retained query/paired status.
  for (const s of state.switches) if (s.statusAfter?.id === record.id) s.statusAfter = combine(s.statusAfter);
  for (const q of state.queries) if (q.id === record.id) Object.assign(q, combine(q));
  // Page completion can precede the browser's terminal event, and summaries can
  // arrive out of order. Reconcile retained GETs using page completion when known.
  for (const q of state.queries.filter(q => q.path === STATUS)) {
    const candidates = state.switches.filter(s => s.documentId && s.documentId === q.documentId && (s.pageEndedAt ?? s.endedAt) !== null
      && q.startedAt >= (s.pageEndedAt ?? s.endedAt) - 2 && q.startedAt - (s.pageEndedAt ?? s.endedAt) <= 30000);
    if (candidates.length === 1 && (!candidates[0].statusAfter || candidates[0].statusAfter.id === q.id)) candidates[0].statusAfter = { ...q };
  }
  const healthy = state.queries.filter(success);
  state.conclusion = healthy.some(r => r.path === state.failurePath && Number.isFinite(state.failureStartedAt) && Math.abs(r.startedAt - state.failureStartedAt) <= 5000) ? "same-endpoint-discrepancy"
    : healthy.some(r => r.path === state.failurePath) ? "endpoint-later-recovered"
    : state.switches.some(r => r.switchAccepted === true) ? "switch-only-success" : "unknown";
  return true;
}
