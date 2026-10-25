import "./report-format.js";
import { bounded } from "./errors.js";
import { getReportDirectory, writeReportFile } from "./report-directory.js";

const format = globalThis.AirconReportFormat;

function restoreReport(report, snapshotOrigin = report.snapshotOrigin) {
  return format.makeReport({
    reportId: report.reportId, at: Date.parse(report.occurredAt), source: report.source,
    error: report.error, startedAt: report.operation?.startedAt, communication: report.communication,
    queuedAt: report.operation?.queuedAt, executionStartedAt: report.operation?.executionStartedAt,
    originalOperationId: report.operation?.originalOperationId, recovered: report.recovered,
    manualCheck: report.manualCheck, lifecycle: report.lifecycle,
    diagnostics: report.diagnostics,
    run: report.cycle, durations: report.requestedDurations, timingChange: report.timingChange, queryRecovery: report.queryRecovery,
    lastConfirmedStatus: report.lastConfirmedStatus, requests: report.requests,
    command: report.switchCommand, snapshotOrigin,
    outcomeUnknown: report.outcomeUnknown, cachedAt: report.page?.cachedAt, visibility: report.page?.visibility
  }, { version: report.extensionVersion, userAgent: report.browserVersion });
}

export class ErrorReporter {
  constructor({ storage, environment = {}, getDirectory = getReportDirectory, writeFile = writeReportFile, onStatus = () => {}, timeoutMs = 2000 }) {
    Object.assign(this, { storage, environment, getDirectory, writeFile, onStatus, timeoutMs });
    this.queue = Promise.resolve();
    this.cacheQueue = Promise.resolve();
    this.pendingReports = [];
    this.flushing = false;
    this.flushRequested = false;
    this.state = { phase: "loading", pending: 0, directoryName: null, lastFile: null };
  }

  local(work) { return bounded(work, { ms: this.timeoutMs, code: "REPORT_STORAGE_TIMEOUT", stage: "错误报告缓存" }); }
  update(values) {
    if (!Object.entries(values).some(([key, value]) => this.state[key] !== value)) return;
    Object.assign(this.state, values);
    try { this.onStatus({ ...this.state }); } catch { /* Diagnostics cannot affect controls. */ }
  }
  cache(work) {
    const result = this.cacheQueue.then(work, work);
    this.cacheQueue = result.catch(() => {});
    return result;
  }
  persist(report, values = {}) {
    return this.cache(async () => {
      const changes = { ...values };
      let entry = null;
      if (report) {
        const key = format.key(report.reportId);
        entry = (await this.local(() => this.storage.get(key)))[key];
        if (!entry || (entry.report?.snapshotOrigin === "page-cache" && report.snapshotOrigin !== "page-cache")) {
          entry = changes[key] = { report, saved: false };
        }
      }
      if (Object.keys(changes).length) await this.local(() => this.storage.set(changes));
      return entry;
    });
  }
  capture(draft) {
    if (draft.error?.code === "E_CANCELLED") return null;
    const report = format.makeReport(draft, this.environment);
    // Snapshot now; neither subsequent state cleanup nor caller mutations apply.
    this.pendingReports.push(report);
    this.flush();
    return report.reportId;
  }

  enrich(reportId, diagnostics) {
    const clean = format.diagnostics(diagnostics);
    if (!clean) return Promise.resolve();
    for (let i = 0; i < this.pendingReports.length; i++) {
      const report = this.pendingReports[i];
      if (report.reportId === reportId && (report.diagnostics?.revision ?? -1) < clean.revision) this.pendingReports[i] = restoreReport({ ...report, diagnostics: format.mergeDiagnostics(report.diagnostics, clean, report.operation.originalOperationId ?? reportId) });
    }
    return this.cache(async () => {
      const key = format.key(reportId);
      const entry = (await this.local(() => this.storage.get(key)))[key];
      if (!entry || entry.report?.snapshotOrigin !== "background" || (entry.report.diagnostics?.revision ?? -1) >= clean.revision) return;
      const report = restoreReport({ ...entry.report, diagnostics: format.mergeDiagnostics(entry.report.diagnostics, clean, entry.report.operation.originalOperationId ?? reportId) });
      await this.local(() => this.storage.set({ [key]: { report, saved: false } }));
    }).then(() => this.flush());
  }

  flush() {
    this.flushRequested = true;
    if (this.flushing) return this.queue;
    this.flushing = true;
    this.queue = Promise.resolve().then(async () => {
      do {
        this.flushRequested = false;
        while (this.pendingReports.length) {
          const report = this.pendingReports.shift();
          await this.persist(report);
        }
        // The next snapshot includes writes just completed above. Only requests
        // arriving during export need another pass; no timer or retry is added.
        this.flushRequested = false;
        await this.flushRecords();
      } while (this.flushRequested || this.pendingReports.length);
    }).catch(() => { this.update({ phase: "storage-error" }); }).finally(() => {
      this.flushing = false;
      if (this.flushRequested || this.pendingReports.length) this.flush();
    });
    return this.queue;
  }

  async flushRecords() {
    const data = await this.local(() => this.storage.get(null));
    const obsolete = format.obsoleteKeys(data);
    if (obsolete.length) {
      await this.local(() => this.storage.remove(obsolete));
      for (const key of obsolete) delete data[key];
    }
    for (const [key, entry] of Object.entries(data)) {
      if (!format.isFallbackKey(key) || key !== format.fallbackKey(entry?.report?.reportId)) continue;
      const recordKey = format.key(entry.report.reportId);
      data[recordKey] = await this.persist(restoreReport(entry.report, "page-cache"));
      // A page fallback never overwrites an existing backend observation.
      await this.local(() => this.storage.remove([key]));
      delete data[key];
    }
    const records = Object.entries(data).filter(([key, value]) => format.isKey(key) && value?.report?.reportId === key.slice("airconErrorReport:".length));
    records.sort((a, b) => String(b[1].report.occurredAt).localeCompare(String(a[1].report.occurredAt)));
    const pending = records.filter(([, entry]) => !entry.saved);
    this.update({ pending: pending.length });
    let directory;
    try {
      directory = await this.local(() => this.getDirectory());
      if (!directory || await this.local(() => directory.queryPermission({ mode: "readwrite" })) !== "granted") {
        this.update({ phase: "permission", directoryName: directory?.name ?? null });
        return;
      }
    } catch { this.update({ phase: "directory-error" }); return; }
    this.update({ directoryName: directory.name, phase: pending.length ? "saving" : "ready" });
    for (const [key, entry] of pending.reverse()) {
      // Revalidate persisted input, including content-script fallback records.
      const report = restoreReport(entry.report);
      const filename = format.fileName(report);
      try {
        await this.writeFile(directory, report, filename);
        await this.cache(async () => {
          const current = (await this.local(() => this.storage.get(key)))[key];
          if (current?.report?.snapshotOrigin !== report.snapshotOrigin || current?.report?.diagnostics?.revision !== report.diagnostics?.revision) {
            this.flushRequested = true;
            return;
          }
          await this.local(() => this.storage.set({ [key]: { report, saved: true } }));
        });
        this.update({ pending: this.state.pending - 1, lastFile: filename });
      } catch (error) {
        this.update({ phase: error.code === "REPORT_PERMISSION" ? "permission" : "write-error" });
        return;
      }
    }
    this.update({ phase: "ready" });
  }
}
