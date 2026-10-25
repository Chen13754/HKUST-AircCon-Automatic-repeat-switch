import "./report-format.js";
import { bounded } from "./errors.js";

const format = globalThis.AirconReportFormat;
const JOURNAL_KEY = "airconDiagnosticJournal";
const MAX_EVENTS = 256;
const MAX_NETWORK = 64;

export function timingFromEntry(entry, timeOrigin) {
  const available = entry.requestStart > 0 && entry.responseStart > 0;
  const delta = (end, start) => available && end >= start && start > 0 ? end - start : null;
  return format.resourceTiming({
    startedAt: timeOrigin + entry.startTime, durationMs: entry.duration, detailsAvailable: available,
    dnsMs: delta(entry.domainLookupEnd, entry.domainLookupStart), connectMs: delta(entry.connectEnd, entry.connectStart),
    tlsMs: delta(entry.connectEnd, entry.secureConnectionStart), waitMs: delta(entry.responseStart, entry.requestStart),
    downloadMs: delta(entry.responseEnd, entry.responseStart), protocol: entry.nextHopProtocol
  });
}

// A bounded flight recorder, separate from the control checkpoint. It observes
// only allowlisted school endpoints. Page-world bodies are reduced to numeric
// business codes before crossing into the extension; headers are never read.
export class Diagnostics {
  constructor({ storage, runtimeId, clock = () => Date.now(), onUpdate = () => {}, onIncident = () => {}, timeoutMs = 500 }) {
    Object.assign(this, { storage, runtimeId, clock, onUpdate, onIncident, timeoutMs });
    this.worker = { id: format.newId(), startedAt: clock() };
    this.events = []; this.network = []; this.site = null;
    this.sites = new Map(); this.lifecycleEvents = []; this.pageResponses = [];
    this.inflight = new Map(); this.previousUnfinished = []; this.requests = new Map(); this.reports = new Map(); this.liveNetwork = new Map();
    this.coverage = { webRequest: false, resourceTiming: false, journal: "loading" };
    this.revision = 0; this.dirty = false; this.writing = false; this.queue = Promise.resolve();
    this.lastSampleAt = 0;
    this.ready = this.load();
    this.event(null, { component: "worker", step: "workerStart", outcome: "ok" });
  }

  async load() {
    try {
      const old = (await bounded(() => this.storage.get(JOURNAL_KEY), { ms: this.timeoutMs }))[JOURNAL_KEY];
      if (old) {
        this.revision += Number.isSafeInteger(old.revision) && old.revision >= 0 ? old.revision : 0;
        this.events = [...(old.events ?? []).map(format.traceEvent), ...this.events].slice(-MAX_EVENTS);
        this.network = [...(old.network ?? []).map(format.networkRecord), ...this.network].slice(-MAX_NETWORK);
        this.site ??= format.pageEvidence(old.site);
        for (const value of old.sites ?? []) {
          const site = format.pageEvidence(value);
          if (site && site.tabId !== null && !this.sites.has(site.tabId)) this.sites.set(site.tabId, site);
        }
        this.lifecycleEvents = [...(old.lifecycleEvents ?? []).map(format.traceEvent), ...this.lifecycleEvents].slice(-64);
        this.pageResponses = [...(old.pageResponses ?? []).map(format.pageResponse), ...this.pageResponses].slice(-64);
        for (const link of old.reportLinks ?? []) {
          if (format.identifier(link.id) && this.clock() - link.at >= 0 && this.clock() - link.at <= 60_000 && !this.reports.has(link.id)) {
            this.reports.set(link.id, { at: link.at, operationId: format.identifier(link.operationId), tabId: Number.isSafeInteger(link.tabId) && link.tabId >= 0 ? link.tabId : null });
          }
        }
        this.previousUnfinished = format.diagnostics({ unfinishedOperations: old.unfinishedOperations }).unfinishedOperations;
      }
      this.coverage.journal = "ready";
      this.coverage.historyLoaded = true;
      // A new worker can receive the return navigation before hydration ends.
      // Enrich once after loading links, using a revision newer than the old worker.
      for (const [id, meta] of this.reports) {
        try { Promise.resolve(this.onUpdate(id, this.snapshot(meta.tabId))).catch(() => {}); } catch { /* Best effort. */ }
      }
    } catch { this.coverage.journal = "unavailable"; this.coverage.historyLoaded = false; }
  }

  event(context, values) {
    const entry = format.traceEvent({ at: this.clock(), workerId: this.worker.id, operationId: context?.reportId, source: context?.source,
      tabId: context?.tabId ?? context?.run?.tabId, documentId: context?.documentId ?? context?.run?.documentId, runId: context?.run?.id, ...values });
    this.events.push(entry);
    if (entry.component === "page" && ["loading", "navigation", "closed", "initialize", "visibility", "online", "offline", "pagehide", "pageshow", "freeze", "resume", "route", "observerReady", "recoveryStarted", "recoverySucceeded", "recoveryExpired"].includes(entry.step)) {
      this.lifecycleEvents.push(entry); if (this.lifecycleEvents.length > 64) this.lifecycleEvents.shift();
    }
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.changed(context?.reportId, entry.tabId);
  }

  async begin(context) {
    this.inflight.set(context.reportId, { operationId: context.reportId, source: context.source, at: this.clock() });
    this.event(context, { component: "operation", step: "begin", outcome: "begin", elapsedMs: this.clock() - context.queuedAt });
    await this.barrier();
  }

  async end(context, errorCode) {
    this.inflight.delete(context.reportId);
    this.event(context, { component: "operation", step: "end", outcome: errorCode ? ["E_CANCELLED", "E_PAGE_RELOADING"].includes(errorCode) ? "cancelled" : "error" : "ok", code: errorCode });
    if (!errorCode && context.recoveredQuery && !context.recoveryReported) {
      context.recoveryReported = true;
      try { Promise.resolve(this.onIncident({ ...context, originalOperationId: context.reportId, reportId: format.newId(), source: "readRecovery", recovered: true, error: { code: "E_API_TIMEOUT" } })).catch(() => {}); } catch { /* Diagnostics only. */ }
    }
    if (!errorCode && context.authenticationRecovered && !context.authenticationReported) {
      context.authenticationReported = true;
      try { Promise.resolve(this.onIncident({ ...context, lifecycle: context.authenticationRecovered, originalOperationId: context.reportId,
        reportId: format.newId(), source: "authRecovery", recovered: true, error: { code: "E_AUTH_RECOVERED" } })).catch(() => {}); } catch { /* Diagnostics only. */ }
    }
    await this.barrier();
  }

  async barrier() {
    try { await bounded(() => this.flush(), { ms: this.timeoutMs }); }
    catch { this.coverage.barrierTimedOut = true; }
  }

  requestEvent(context, trace, step) {
    if (!context) return;
    if (step === "endRequest" && trace.attempt === 2 && !trace.errorCode) context.recoveredQuery = true;
    const key = `${context.reportId}:${trace.sequence}`;
    if (trace.phase === "headers" && step === "requestPhase") {
      this.requests.set(key, { context, trace, dispatchAt: this.clock(), networkId: null });
      while (this.requests.size > 32) this.requests.delete(this.requests.keys().next().value);
      this.flush();
    }
    this.event(context, { component: "request", step, sequence: trace.sequence, phase: trace.phase, code: trace.errorCode,
      outcome: step === "endRequest" ? trace.errorCode ? "error" : "ok" : "begin", elapsedMs: trace.elapsedMs });
    if (step === "endRequest") this.flush();
  }

  page(value, step = "tabSnapshot", detail = {}) {
    const clean = format.pageEvidence(value);
    if (!clean) return;
    const previous = clean.tabId === null ? this.site : this.sites.get(clean.tabId);
    // A new browser document must not inherit a previous document's token age,
    // observer coverage, scripts or visibility.
    const sameDocument = !clean.documentId || !previous?.documentId || clean.documentId === previous.documentId;
    this.site = previous && sameDocument ? Object.fromEntries(Object.keys(clean).map(key => [key, Object.hasOwn(value, key) ? clean[key] : previous[key]])) : clean;
    if (!value.contentObservedAt) this.site.tabObservedAt = clean.at;
    if (clean.tabId !== null) {
      this.sites.delete(clean.tabId); this.sites.set(clean.tabId, this.site);
      while (this.sites.size > 16) this.sites.delete(this.sites.keys().next().value);
    }
    this.event(null, { component: "page", step, outcome: "ok", online: clean.online, visibility: clean.visibility, route: clean.route,
      tabId: clean.tabId, documentId: clean.documentId, observer: detail.observer ?? "content", transitionType: detail.transitionType, qualifiers: detail.qualifiers,
      navigationEvent: detail.navigationEvent, navigationError: detail.navigationError,
      frozen: clean.frozen, discarded: clean.discarded, documentStartedAt: clean.documentStartedAt, script: detail.script, line: detail.line, column: detail.column });
    if (["tabSnapshot", "resource"].includes(step)) this.sample(); else this.flush();
  }

  snapshot(tabId) {
    const scoped = Number.isSafeInteger(tabId) && tabId >= 0;
    const filter = values => scoped ? values.filter(item => item.tabId === tabId) : values;
    return format.diagnostics({ revision: this.revision, targetTabId: scoped ? tabId : null, worker: this.worker, coverage: this.coverage,
      site: scoped ? this.sites.get(tabId) : this.site, lifecycleEvents: filter(this.lifecycleEvents), pageResponses: filter(this.pageResponses),
      unfinishedOperations: [...this.previousUnfinished, ...this.inflight.values()].slice(-8),
      events: scoped ? this.events.filter(item => item.tabId === tabId || item.tabId === null) : this.events, network: filter(this.network) });
  }

  trackReport(reportId, operationId = reportId, tabId = null) {
    this.reports.set(reportId, { at: this.clock(), operationId, tabId });
    while (this.reports.size > 20) this.reports.delete(this.reports.keys().next().value);
    this.flush();
  }

  changed(operationId, tabId = null) {
    this.revision++;
    for (const [id, meta] of this.reports) {
      if (this.clock() - meta.at > 60_000) this.reports.delete(id);
      else if (operationId && meta.operationId === operationId || tabId !== null && meta.tabId === tabId) {
        try { Promise.resolve(this.onUpdate(id, this.snapshot(meta.tabId))).catch(() => {}); } catch { /* Best effort. */ }
      }
    }
  }

  flush() {
    this.dirty = true;
    if (this.writing) return this.queue;
    this.writing = true;
    this.queue = this.ready.then(async () => {
      while (this.dirty && this.coverage.journal !== "write-failed") {
        this.dirty = false;
        const value = { revision: this.revision, worker: this.worker, events: this.events.slice(-MAX_EVENTS).map(format.traceEvent), network: this.network.slice(-MAX_NETWORK).map(format.networkRecord),
          site: this.site, sites: [...this.sites.values()], lifecycleEvents: this.lifecycleEvents, pageResponses: this.pageResponses,
          reportLinks: [...this.reports].filter(([, meta]) => this.clock() - meta.at <= 60_000).map(([id, meta]) => ({ id, ...meta })),
          unfinishedOperations: [...this.previousUnfinished, ...this.inflight.values()].slice(-8) };
        await bounded(() => this.storage.set({ [JOURNAL_KEY]: structuredClone(value) }), { ms: this.timeoutMs });
        this.coverage.journal = "ready";
      }
    }).catch(() => {
      // A timed-out write might complete late. Do not race it with new journal
      // writes; controls and the independent error-report cache remain usable.
      this.coverage.journal = "write-failed";
      for (const meta of this.reports.values()) this.changed(meta.operationId);
    }).finally(() => {
      this.writing = false;
      if (this.dirty && this.coverage.journal !== "write-failed") this.flush();
    });
    return this.queue;
  }

  sample() {
    if (this.clock() - this.lastSampleAt < 30_000) return;
    this.lastSampleAt = this.clock();
    this.flush();
  }

  observeNetwork(event, details) {
    const path = format.observedPath(details.url);
    if (!path || !["GET", "POST", "OPTIONS"].includes(details.method)) return;
    const id = format.identifier(details.requestId);
    if (!id) return;
    let record = this.liveNetwork.get(id);
    if (!record) {
      const owner = details.initiator === `chrome-extension://${this.runtimeId}` ? "extension"
        : details.initiator === "https://w5.ab.ust.hk" && details.tabId >= 0 ? "page" : "unknown";
      const candidates = owner === "extension" ? [...this.requests.values()].filter(item => !item.networkId && item.trace.path === path && item.trace.method === details.method
        && details.timeStamp >= item.dispatchAt - 2 && (!item.trace.endedAt || details.timeStamp <= item.trace.endedAt)) : [];
      const match = candidates.length === 1 ? candidates[0] : null;
      if (match) match.networkId = id;
      record = format.networkRecord({ id, owner, path, method: details.method, startedAt: details.timeStamp,
        tabId: owner === "extension" ? match?.context.tabId ?? match?.context.run?.tabId : details.tabId, documentId: details.documentId ?? match?.context.documentId ?? match?.context.run?.documentId,
        operationId: match?.context.reportId, sequence: match?.trace.sequence, correlation: match ? "unique" : candidates.length > 1 ? "ambiguous" : "unmatched", events: [] });
      this.network.push(record);
      this.liveNetwork.set(id, record);
      while (this.liveNetwork.size > MAX_NETWORK) this.liveNetwork.delete(this.liveNetwork.keys().next().value);
      if (this.network.length > MAX_NETWORK) this.network.shift();
    }
    record.events.push({ event, at: details.timeStamp }); record.events = record.events.slice(-8);
    if (Number.isInteger(details.statusCode)) record.httpStatus = details.statusCode;
    if (typeof details.fromCache === "boolean") record.fromCache = details.fromCache;
    if (["completed", "error"].includes(event)) { record.endedAt = details.timeStamp; record.error = format.networkRecord({ error: details.error }).error; }
    this.changed(record.operationId, record.tabId);
    if (["error", "completed"].includes(event) || record.owner === "extension" && event === "beforeRequest") this.flush();
  }

  resource(value, owner = "page") {
    const path = format.observedPath(value?.url);
    if (!path) return;
    const timing = format.resourceTiming(value.timing);
    if (!timing) return;
    const matches = this.network.filter(item => item.owner === owner && item.path === path && !item.timing && (owner !== "page" || item.tabId === (value.tabId ?? null)) && Math.abs(item.startedAt - timing.startedAt) < 100);
    if (matches.length === 1) {
      matches[0].timing = timing;
      this.changed(matches[0].operationId, matches[0].tabId);
    } else {
      const candidates = owner === "extension" ? [...this.requests.values()].filter(item => item.trace.path === path && Math.abs(item.dispatchAt - timing.startedAt) < 100) : [];
      const match = matches.length === 0 && candidates.length === 1 ? candidates[0] : null;
      this.network.push(format.networkRecord({ id: format.newId(), owner, path, startedAt: timing.startedAt, timing,
        tabId: owner === "extension" ? match?.context.tabId ?? match?.context.run?.tabId : value.tabId, documentId: value.documentId,
        operationId: match?.context.reportId, sequence: match?.trace.sequence, correlation: match ? "time-window" : matches.length > 1 || candidates.length > 1 ? "ambiguous" : "unmatched" }));
      if (this.network.length > MAX_NETWORK) this.network.shift();
      if (match) this.changed(match.context.reportId);
    }
    this.sample();
  }

  response(value) {
    const clean = format.pageResponse(value);
    if (!clean.path || clean.tabId === null) return;
    const matches = this.network.filter(item => item.owner === "page" && item.tabId === clean.tabId && item.path === clean.path && item.method === clean.method
      && (!item.documentId || !clean.documentId || item.documentId === clean.documentId) && Math.abs(item.startedAt - clean.startedAt) < 250);
    clean.correlation = matches.length === 1 ? "unique" : matches.length ? "ambiguous" : "unmatched";
    clean.browserRequestId = matches.length === 1 ? matches[0].id : null;
    this.pageResponses.push(clean); if (this.pageResponses.length > 64) this.pageResponses.shift();
    this.changed(null, clean.tabId);
    this.flush();
  }

  attach(chromeApi, Observer = globalThis.PerformanceObserver, perf = globalThis.performance) {
    const events = { onBeforeRequest: "beforeRequest", onBeforeSendHeaders: "beforeSendHeaders", onSendHeaders: "sendHeaders", onHeadersReceived: "headersReceived",
      onResponseStarted: "responseStarted", onBeforeRedirect: "redirect", onCompleted: "completed", onErrorOccurred: "error" };
    try {
      for (const [name, event] of Object.entries(events)) chromeApi.webRequest[name].addListener(details => {
        try { this.observeNetwork(event, details); } catch { /* Unsupported event data must not affect traffic. */ }
      }, { urls: ["https://w5.ab.ust.hk/njggt/api/app/prepaid/*", "https://w5.ab.ust.hk/njggt/api/app/auth/cas/*"] });
      this.coverage.webRequest = true;
    } catch { this.coverage.webRequest = false; }
    try {
      this.observer = new Observer(list => {
        try {
          for (const entry of list.getEntries()) if (format.observedPath(entry.name)) this.resource({ url: entry.name, timing: timingFromEntry(entry, perf.timeOrigin) }, "extension");
        } catch { /* Unsupported timing fields. */ }
      });
      this.observer.observe({ type: "resource", buffered: true });
      this.coverage.resourceTiming = true;
    } catch { this.coverage.resourceTiming = false; }
  }
}
