import "./report-format.js";

// Diagnostic checkpoint only. A missing session run must never be recreated
// from this record after a browser restart or extension reload.
export function createHistory(storage, environment = {}, persistReport) {
  const key = "cycleCheckpoint";
  const format = globalThis.AirconReportFormat;
  return {
    async get() { return (await storage.get(key))[key] ?? null; },
    async save(run, command = null) {
      await storage.set({ [key]: { active: true, run, command, notice: null } });
    },
    async finish(run, notice, draft) {
      const report = draft ? format.makeReport(draft, environment) : null;
      const values = { [key]: { active: false, run, notice, command: draft?.command ?? null } };
      if (persistReport) return persistReport(report, values);
      const existing = report ? (await storage.get(format.key(report.reportId)))[format.key(report.reportId)] : null;
      // Persist the terminal reason and its report atomically, before session
      // cleanup. File export stays in the reporter's independent queue.
      await storage.set({
        ...values,
        ...(report && !existing ? { [format.key(report.reportId)]: { report, saved: false } } : {})
      });
    }
  };
}
