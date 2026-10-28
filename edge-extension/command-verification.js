import { bounded, CycleError } from "./errors.js";
import { hasNativeTimer } from "./cycle.js";
import "./report-format.js";

const format = globalThis.AirconReportFormat;
const ACTIVE = new Set(["pending", "running", "waiting"]);
const TERMINAL_PAGE_ERRORS = new Set(["E_AUTH", "E_PAGE_CLOSED", "E_PAGE_RELOADING", "E_PAGE_UNAVAILABLE"]);
export const VERIFICATION_KEY = "postCommandVerificationJob";

export function verificationCandidate(draft) {
  if (!draft?.command?.sent || draft.command.confirmed || typeof draft.command.desiredOn !== "boolean") return null;
  if (!["E_API_TIMEOUT", "E_OPERATION_TIMEOUT"].includes(draft.error?.code)) return null;
  const matches = (draft.requests ?? []).filter(r => r.sequence === draft.error.requestSequence
    && r.path === "/app/prepaid/toggle-status" && r.method === "POST" && r.dispatched
    && r.errorCode === draft.error.code && Number.isFinite(r.cancelledAt)
    && r.cancelledBy === draft.error.code && ["headers", "body"].includes(r.phase));
  return matches.length === 1 ? matches[0] : null;
}

export function verificationConclusion(rounds, desiredOn) {
  const values = rounds.map(r => r.actualOn).filter(v => typeof v === "boolean");
  if (new Set(values).size > 1) return "changed";
  return values.length ? values.at(-1) === desiredOn ? "target_observed" : "original_observed" : "unknown";
}

// One bounded diagnostic job. The injected interface intentionally has no POST.
// The queue serializes metadata, never the network wait or the 30-second delay.
export class CommandVerification {
  constructor({ storage, alarm, readStatus, readTimer, updateReport, canVerify = async () => true, interruptOrphans = async () => {},
    notify = () => {}, clock = () => Date.now(), roundTimeoutMs = 15000 }) {
    Object.assign(this, { storage, alarm, readStatus, readTimer, updateReport, canVerify, interruptOrphans, notify, clock, roundTimeoutMs });
    this.generation = 0;
    this.cancellations = new Map();
    this.sessionCancellation = { generation: 0, reason: "session_ended" };
    this.queue = Promise.resolve();
    this.job = null;
    this.active = null;
    this.work = Promise.resolve();
  }
  local(work) { return bounded(work, { ms: 2000, code: "E_LOCAL_TIMEOUT" }); }
  cancellationFor(tabId) { return this.cancellations.get(tabId) ?? this.sessionCancellation; }
  generationFor(tabId) { return this.cancellationFor(tabId).generation; }
  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  ready() {
    return this.readyPromise ??= this.enqueue(async () => {
      this.job = (await this.local(() => this.storage.get(VERIFICATION_KEY)))[VERIFICATION_KEY] ?? null;
      await this.local(() => this.interruptOrphans(this.job?.reportId));
      if (!this.job || !ACTIVE.has(this.job.state)) return;
      if (this.job.state !== "waiting") await this.finish("interrupted", "worker_interrupted");
      else if (this.clock() >= this.job.deadlineAt) await this.finish("expired", "deadline");
      else await this.local(() => this.alarm.create(this.job.reportId, this.job.nextAt));
    }).catch(() => this.storageFailure());
  }
  view(tabId) { return this.job?.tabId === tabId && !this.job.dismissed ? format.postCommandVerification(this.job) : null; }
  async save() {
    this.job.revision++;
    const snapshot = structuredClone(this.job);
    snapshot.conclusion = verificationConclusion(snapshot.rounds, snapshot.desiredOn);
    this.job.conclusion = snapshot.conclusion;
    if (!await this.local(() => this.updateReport(snapshot.reportId, snapshot))) throw new CycleError("E_LOCAL_STORAGE", "原报告不可用。");
    await this.local(() => this.storage.set({ [VERIFICATION_KEY]: snapshot }));
    this.notify(snapshot.tabId);
  }
  async finish(state, reason) {
    if (!this.job) return;
    this.job.state = state; this.job.reason = reason; this.job.endedAt = this.clock();
    await this.local(() => this.alarm.clear(this.job.reportId));
    await this.save();
  }
  async storageFailure() {
    this.active?.abort(new CycleError("E_CANCELLED", "核验记录保存失败。"));
    if (!this.job) return;
    this.job.state = "interrupted"; this.job.reason = "storage_failure"; this.job.endedAt = this.clock();
    this.job.conclusion = verificationConclusion(this.job.rounds, this.job.desiredOn);
    this.job.revision++;
    await this.local(() => this.alarm.clear(this.job.reportId)).catch(() => {});
    await this.local(() => this.updateReport(this.job.reportId, structuredClone(this.job))).catch(() => {});
    await this.local(() => this.storage.set({ [VERIFICATION_KEY]: this.job })).catch(() => {});
    this.notify(this.job.tabId);
  }
  async start(draft, cleanupFailure = null) {
    const request = verificationCandidate(draft);
    if (!request) return;
    const epoch = draft.verificationGeneration;
    try {
      await this.ready();
      await this.enqueue(async () => {
        const cancelled = epoch !== this.generationFor(draft.run?.tabId);
        const missingIdentity = !draft.run?.documentId;
        const candidate = { reportId: draft.reportId, operationId: draft.reportId, runId: draft.run?.id,
          tabId: draft.run?.tabId, documentId: draft.run?.documentId, desiredOn: draft.command.desiredOn,
          triggerCode: draft.error.code, triggerSequence: request.sequence, cancelledAt: request.cancelledAt,
          deadlineAt: request.cancelledAt + 45000, nextAt: request.cancelledAt + 30000,
          state: "pending", rounds: [], revision: 0 };
        if (cancelled) {
          await this.local(() => this.updateReport(candidate.reportId, { ...candidate, revision: 1, state: "not_run", reason: this.cancellationFor(candidate.tabId).reason, endedAt: this.clock(), conclusion: "unknown" }));
          return;
        }
        this.job = candidate;
        if (cleanupFailure || missingIdentity) {
          await this.finish("not_run", cleanupFailure ?? "page_identity_missing");
        } else if (this.clock() >= this.job.deadlineAt) await this.finish("expired", "deadline");
        else { await this.save(); this.launch(0, epoch); }
      });
    } catch { await this.storageFailure(); }
  }
  launch(index, epoch) {
    if (this.roundPending) return;
    this.roundPending = true;
    this.work = this.round(index, epoch).catch(() => this.storageFailure()).finally(() => { this.roundPending = false; });
  }
  async round(index, epoch) {
    let context, signal, job, endAt;
    await this.enqueue(async () => {
      job = this.job;
      if (!job || epoch !== this.generationFor(job.tabId) || !ACTIVE.has(job.state) || job.rounds.length !== index) return;
      if (this.clock() >= job.deadlineAt) { await this.finish("expired", "deadline"); return; }
      // The control checkpoint is authoritative even if a session cancellation
      // write was lost. A newly started or acknowledged cycle retires this job.
      if (!await this.local(() => this.canVerify(job))) { await this.finish("cancelled", "user_action"); return; }
      context = { reportId: format.newId(), source: "postCommandVerification", readOnlyVerification: true,
        originalOperationId: job.operationId, run: { id: job.runId, tabId: job.tabId, documentId: job.documentId }, requests: [] };
      job.rounds.push({ operationId: context.reportId, scheduledAt: index ? job.nextAt : job.cancelledAt, startedAt: this.clock() });
      job.state = "running";
      await this.save(); // Durable claim precedes all network I/O.
      if (epoch !== this.generationFor(job.tabId)) return;
      if (this.clock() >= job.deadlineAt) { await this.finish("expired", "deadline"); return; }
      this.active = new AbortController(); signal = this.active.signal;
      endAt = Math.min(job.deadlineAt, this.clock() + this.roundTimeoutMs);
      context.readDeadlineAt = endAt;
    });
    if (!signal) return;
    const round = job.rounds[index];
    try {
      await bounded(async roundSignal => {
        roundSignal.diagnostic = context;
        const read = async (fn, key) => {
          try {
            const value = await fn(job.tabId, roundSignal);
            roundSignal.throwIfAborted();
            if (this.clock() >= endAt) throw new CycleError("E_OPERATION_TIMEOUT", "核验结果到达时已过期限。");
            round[key] = key === "timerPresent" ? hasNativeTimer(value) : value;
          } catch (error) {
            round[`${key}Error`] = error.code ?? "E_INTERNAL";
          }
        };
        await Promise.all([read(this.readStatus, "actualOn"), read(this.readTimer, "timerPresent")]);
      }, { signal, ms: Math.max(0, endAt - this.clock()), code: "E_OPERATION_TIMEOUT" });
    } catch (error) { round.errorCode = error.code ?? "E_INTERNAL"; }
    // Let request wrappers finalize cancellation traces before taking the snapshot.
    await Promise.resolve(); await Promise.resolve();
    round.requests = context.requests.map(r => format.requestTrace(r)).slice(0, 2);
    round.endedAt = this.clock();
    await this.enqueue(async () => {
      this.active = null;
      if (this.job !== job || epoch !== this.generationFor(job.tabId) || job.state !== "running") return;
      if ([round.actualOnError, round.timerPresentError].some(code => TERMINAL_PAGE_ERRORS.has(code))) await this.finish("cancelled", "page_unavailable");
      else if (this.clock() >= job.deadlineAt) await this.finish("expired", "deadline");
      else if (index === 1) await this.finish("completed", "two_rounds");
      else {
        job.state = "waiting";
        await this.save();
        await this.local(() => this.alarm.create(job.reportId, job.nextAt));
      }
    });
  }
  async onAlarm(id, scheduledTime) {
    try {
      await this.ready();
      await this.enqueue(async () => {
        const job = this.job;
        if (!job || job.reportId !== id || job.state !== "waiting" || scheduledTime !== job.nextAt || this.clock() < job.nextAt) return;
        if (this.clock() >= job.deadlineAt) await this.finish("expired", "deadline");
        else this.launch(1, this.generationFor(job.tabId));
      });
    } catch { await this.storageFailure(); }
  }
  async cancel(tabId, reason = "user_action") {
    const cancellation = { generation: ++this.generation, reason };
    if (tabId === null) { this.sessionCancellation = cancellation; this.cancellations.clear(); }
    else this.cancellations.set(tabId, cancellation);
    // Invalidate a pending callback for this tab, but leave other tabs alone.
    if (this.job && tabId !== null && this.job.tabId !== tabId) return;
    this.active?.abort(new CycleError("E_CANCELLED", "只读核验已取消。"));
    try {
      await this.ready();
      if (this.job && tabId !== null && this.job.tabId !== tabId) return;
      await this.work;
      await this.enqueue(async () => {
        if (!this.job || (tabId !== null && this.job.tabId !== tabId)) return;
        this.job.dismissed = reason === "user_action";
        if (ACTIVE.has(this.job.state)) await this.finish("cancelled", reason);
        else await this.local(() => this.storage.set({ [VERIFICATION_KEY]: this.job }));
      });
    } catch { await this.storageFailure(); }
  }
}
