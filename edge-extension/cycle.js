import { bounded, CycleError, describeError } from "./errors.js";
import "./report-format.js";

export const MAX_MINUTES = 1440;
export const LATE_LIMIT_MS = 60_000;
export const OPERATION_TIMEOUT_MS = 30_000;
export const KEEP_ALIVE_MINUTES = 120;
export const RECOVERY_LIMIT_MS = 60_000;
export const QUERY_RETRY_DELAY_MS = 30_000;
export const QUERY_RETRY_OFFSETS = [30_000, 60_000, 120_000, 180_000, 240_000];

// A cancellation or reload is not a fault by itself. Keep a report only when a
// switch may have been dispatched and left unconfirmed.
const NON_FAULT_CODES = new Set(["E_CANCELLED", "E_PAGE_RELOADING"]);

export function validMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES;
}

export function timingOf(run) {
  return {
    phaseStartedAt: Number.isFinite(run.phaseStartedAt) ? run.phaseStartedAt : run.nextAt - (run.phase === "on" ? run.onMinutes : run.offMinutes) * 60_000,
    timingRevision: Number.isSafeInteger(run.timingRevision) && run.timingRevision >= 0 ? run.timingRevision : 0
  };
}

export function timerFromSchoolData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CycleError("E_TIMER_FORMAT", "无法识别学校返回的定时器状态。");
  }
  // The school's own page reads data.ac_timer directly. An absent property
  // becomes undefined and is displayed as "Select time" (no timer).
  return data.ac_timer ?? null;
}

export function hasNativeTimer(value) {
  if (value === null || value === undefined || value === false || value === "" || value === 0) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object" && !Array.isArray(value) && "timer" in value) {
    return hasNativeTimer(value.timer);
  }
  throw new CycleError("E_TIMER_FORMAT", "无法识别学校原有定时器状态，已停止以免冲突。");
}

export class CycleController {
  constructor({ store, alarm, keepAliveAlarm, recoveryAlarm = { create: async () => {}, clear: async () => {} }, history = { get: async () => null, save: async () => {}, finish: async () => {} }, api, page, diagnostics, clock = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), id = () => crypto.randomUUID(), notify = async () => {}, report = () => null, operationTimeoutMs = OPERATION_TIMEOUT_MS, localTimeoutMs = 2000 }) {
    Object.assign(this, { store, alarm, api, page, clock, sleep, id, notify, operationTimeoutMs });
    this.report = report;
    this.onStopped = () => {};
    this.verificationGeneration = () => 0;
    this.queryRecoveryPolicyVersion = 2;
    this.diagnostics = diagnostics;
    // Bound each local API separately. Do not race the entire control task:
    // its cleanup must finish before the next queued operation can run.
    this.writeFault = null;
    const writes = new Set(["setRun", "clearRun", "create", "clear", "save", "finish"]);
    const wrap = (target, prefix, component, controlWrites = true) => Object.fromEntries(Object.keys(target).map(name => [name, async (...args) => {
      const signal = !writes.has(name) && args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined;
      const context = this.active?.diagnostic;
      const at = this.clock();
      this.trace(context, { component, step: name, outcome: "begin" });
      try {
        const value = await bounded(() => target[name](...args), { signal, ms: localTimeoutMs, code: "E_LOCAL_TIMEOUT", stage: `${prefix} ${name} ` });
        this.trace(context, { component, step: name, outcome: "ok", elapsedMs: this.clock() - at });
        return value;
      } catch (error) {
        // A dispatched Chrome write cannot be withdrawn. After a write timeout,
        // refuse further control in this worker so a late write cannot race a
        // new cycle. Stop/cleanup remain available; reload resets the worker.
        if (controlWrites && writes.has(name) && (error.code === "E_LOCAL_TIMEOUT" || ["save", "finish"].includes(name))) {
          this.writeFault = new CycleError(error.code === "E_LOCAL_TIMEOUT" ? "E_LOCAL_TIMEOUT" : "E_LOCAL_STORAGE", `${prefix} ${name} 写入失败，已禁止后续空调指令；请重新加载扩展并确认空调状态。`);
          this.trace(context, { component, step: name, outcome: "error", code: this.writeFault.code, elapsedMs: this.clock() - at });
          throw this.writeFault;
        }
        this.trace(context, { component, step: name, outcome: "error", code: error.code, elapsedMs: this.clock() - at });
        throw error;
      }
    }]));
    this.store = wrap(store, "扩展存储", "store");
    this.alarm = wrap(alarm, "浏览器定时器", "alarm");
    this.recoveryAlarm = wrap(recoveryAlarm, "页面恢复定时器", "recovery");
    this.history = wrap(history, "循环记录", "history");
    // Auxiliary alarm failures must not disable the actual control loop.
    this.keepAliveAlarm = wrap(keepAliveAlarm, "保活定时器", "keepalive", false);
    this.pending = Promise.resolve();
    this.active = null;
    this.revisions = new Map();
    this.loadingTabs = new Set();
    this.queryRecoveryDocuments = new Map();
  }

  diagnostic(source, options = {}) {
    const context = { ...options, source, queuedAt: this.clock(), reportId: globalThis.AirconReportFormat.identifier(options.reportId) ?? globalThis.AirconReportFormat.newId(), startedAt: options.startedAt ?? this.clock(), requests: [] };
    this.trace(context, { component: "operation", step: "queued", outcome: "begin" });
    return context;
  }

  trace(context, values) {
    try { this.diagnostics?.event(context, values); } catch { /* Diagnostics cannot change controls. */ }
  }

  recordError(error, context, run) {
    if (NON_FAULT_CODES.has(error?.code) || context?.reported) return;
    const snapshot = context ?? this.diagnostic("cleanup");
    snapshot.error = error;
    if (run?.queryRecovery && !snapshot.queryRecovery?.endedAt) {
      snapshot.queryRecovery = this.querySnapshot(run.queryRecovery, snapshot, snapshot.queryRecovery?.outcome ?? "stopped");
      snapshot.recoveryReported = true;
    }
    try {
      const reportId = this.report({ ...snapshot, at: this.clock(), error, run: run ?? snapshot.run,
        outcomeUnknown: Boolean(snapshot.command?.sent && !snapshot.command?.confirmed) });
      snapshot.reported = true;
      if (error && reportId) error.reportId = reportId;
    } catch { /* Reporting must never affect control or cancellation. */ }
  }

  observeStatus(signal, value) {
    if (signal?.diagnostic) signal.diagnostic.lastConfirmedStatus = { value, at: this.clock() };
    return value;
  }

  async readPreflight(tabId, signal, deadlineAt) {
    signal.throwIfAborted();
    const group = new AbortController();
    group.signal.diagnostic = signal.diagnostic;
    const abort = () => group.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const deadlineTimer = deadlineAt === undefined ? null : setTimeout(() => group.abort(new CycleError("E_QUERY_RECOVERY_TIMEOUT", "查询恢复已到期限。")), Math.max(0, deadlineAt - this.clock()));
    let failure;
    const read = async work => {
      try { return await work(); }
      catch (error) {
        failure ??= { error };
        group.abort(new CycleError("E_CANCELLED", "并行核验失败，取消其余查询。"));
        throw error;
      }
    };
    try {
      const results = await Promise.allSettled([
        read(() => this.api.readTimer(tabId, group.signal)),
        read(async () => {
          const actual = await this.api.readStatus(tabId, group.signal);
          group.signal.throwIfAborted();
          return this.observeStatus(group.signal, actual);
        })
      ]);
      // API request wrappers settle on cancellation even if transport ignores
      // abort. Capture diagnostics only after their catch/finally has run.
      if (failure) throw failure.error;
      group.signal.throwIfAborted();
      return results.map(result => result.value);
    } finally { clearTimeout(deadlineTimer); signal.removeEventListener("abort", abort); }
  }

  querySnapshot(recovery, context, outcome = "waiting") {
    const rounds = [...recovery.rounds];
    const index = rounds.findIndex(round => round.operationId === context.reportId);
    // Closing a waiting incident is not another school query attempt.
    if (index < 0 && context.source !== "tick" && !context.requests?.length && !context.preflight) {
      return globalThis.AirconReportFormat.queryRecovery({ ...recovery, outcome, endedAt: outcome === "waiting" ? null : this.clock() });
    }
    const round = { ...(index >= 0 ? rounds[index] : {}), operationId: context.reportId,
      scheduledAt: recovery.nextAttemptAt ?? recovery.originalNextAt,
      outcome: "completed",
      startedAt: context.executionStartedAt ?? context.startedAt, endedAt: this.clock(),
      waitMs: index >= 0 ? rounds[index].waitMs : Math.max(0, (context.executionStartedAt ?? context.startedAt) - (rounds.at(-1)?.endedAt ?? recovery.startedAt)),
      errorCode: context.error?.code, requests: context.requests,
      actualOn: context.preflight?.actual, timerPresent: context.preflight?.timerPresent,
      sent: Boolean(context.command?.sent), confirmed: Boolean(context.command?.confirmed) };
    if (index >= 0) rounds[index] = round; else rounds.push(round);
    return globalThis.AirconReportFormat.queryRecovery({ ...recovery, rounds, outcome, endedAt: outcome === "waiting" ? null : this.clock() });
  }

  queryRecoveryError(run, message) {
    const recovery = run.queryRecovery;
    return new CycleError(recovery?.initialFailure?.errorCode ?? recovery?.rounds?.[0]?.errorCode ?? "E_INTERNAL", message);
  }

  transientQueryFailure(error, context) {
    const request = context.requests.find(item => item.sequence === error.requestSequence && item.errorCode === error.code);
    const eligibleRead = request?.method === "GET"
      && ["/app/prepaid/ac-timer", "/app/prepaid/ac-status"].includes(request.path)
      && (error.code === "E_API_TIMEOUT" || error.code === "E_HTTP" && [502, 503, 504].includes(request.httpStatus));
    // Mock adapters and pre-structured legacy timeout errors remain supported.
    return !context.command?.sent && (eligibleRead || error.code === "E_API_TIMEOUT" && error.requestSequence === undefined);
  }

  async beginQueryRecovery(run, error, signal, context) {
    if (!this.transientQueryFailure(error, context) || signal.aborted || this.clock() - run.nextAt > LATE_LIMIT_MS) return false;
    const request = context.requests.find(item => item.sequence === error.requestSequence && item.errorCode === error.code);
    const modern = this.queryRecoveryPolicyVersion === 2;
    const failedAt = this.clock();
    const nextAttemptAt = failedAt + QUERY_RETRY_DELAY_MS, deadline = run.nextAt + (modern ? 300_000 : LATE_LIMIT_MS);
    if (nextAttemptAt >= deadline) return false;
    context.error = error;
    const recovery = this.querySnapshot({ id: globalThis.AirconReportFormat.newId(), initialOperationId: context.reportId,
      startedAt: failedAt, originalNextAt: run.nextAt, deadline,
      ...(modern ? { policyVersion: 2, attemptTimes: QUERY_RETRY_OFFSETS.map(offset => failedAt + offset), nextSlot: 0, skippedAttempts: [] } : {}),
      initialFailure: { errorCode: error.code, httpStatus: request?.httpStatus, path: request?.path, sequence: request?.sequence },
      rounds: [] }, context);
    recovery.nextAttemptAt = nextAttemptAt;
    run = { ...run, queryRecovery: recovery, recovery: { kind: "query", at: recovery.startedAt, deadline, nextAttemptAt } };
    context.run = run;
    // Separate immutable initial evidence from the eventual result report.
    this.recordError(error, { ...context, reportId: recovery.id, originalOperationId: context.reportId,
      queryRecovery: recovery, recoveryReported: true }, { ...run, queryRecovery: null });
    await this.saveRun(run);
    this.checkDeadline(signal);
    await this.recoveryAlarm.create(run.id, nextAttemptAt);
    this.checkDeadline(signal);
    await this.notify(run.tabId);
    return true;
  }

  async attemptQueryRecovery(run, signal, context) {
    context.run = run;
    context.recoveryReported = true;
    context.dispatchDeadlineAt = run.queryRecovery.deadline;
    try {
      this.checkDeadline(signal);
      if (run.queryRecovery.policyVersion === 2) {
        const recovery = structuredClone(run.queryRecovery);
        let slot = recovery.nextSlot;
        while (slot + 1 < recovery.attemptTimes.length && recovery.attemptTimes[slot + 1] <= this.clock()) {
          recovery.skippedAttempts.push(slot++);
        }
        if (slot >= recovery.attemptTimes.length) throw new CycleError("E_QUERY_RECOVERY_TIMEOUT", "恢复轮次已用完。");
        recovery.nextSlot = slot + 1;
        recovery.nextAttemptAt = recovery.attemptTimes[slot];
        run = { ...run, queryRecovery: recovery };
      }
      // A cold worker must see an in-progress read even if its alarm was consumed.
      const round = { operationId: context.reportId, scheduledAt: run.queryRecovery.nextAttemptAt,
        startedAt: this.clock(), waitMs: Math.max(0, this.clock() - (run.queryRecovery.rounds.at(-1)?.endedAt ?? this.clock())) };
      run = { ...run, queryRecovery: { ...run.queryRecovery, rounds: [...run.queryRecovery.rounds, round].slice(-6) } };
      context.run = run;
      await this.saveRun(run);
      this.checkDeadline(signal);
      await this.recoveryAlarm.create(run.id, run.queryRecovery.deadline);
      this.checkDeadline(signal);
      await this.advancePhase(run, signal, context);
      const result = this.querySnapshot(run.queryRecovery, context, "recovered");
      try { this.report({ ...context, at: this.clock(), source: "queryRecovery", recovered: true,
        queryRecovery: result, error: this.queryRecoveryError(run, "查询异常后已恢复。") }); } catch { /* Diagnostic only. */ }
    } catch (error) {
      context.error = error;
      if (run.queryRecovery.policyVersion === 2 && !signal.aborted && this.transientQueryFailure(error, context)) {
        const recovery = this.querySnapshot(run.queryRecovery, context);
        const nextAt = recovery.attemptTimes[recovery.nextSlot];
        if (Number.isFinite(nextAt) && nextAt < recovery.deadline && this.clock() < recovery.deadline) {
          run = { ...run, queryRecovery: { ...recovery, nextAttemptAt: nextAt },
            recovery: { ...run.recovery, kind: "query", nextAttemptAt: nextAt } };
          context.run = run;
          try { await this.saveRun(run); await this.recoveryAlarm.create(run.id, nextAt); await this.notify(run.tabId); return; }
          catch (failure) { error = failure; context.error = failure; }
        }
      }
      await this.handleTransitionError(run, error, context);
    }
  }

  async restoreQueryRound(run) {
    const recovery = run.queryRecovery;
    if (recovery?.policyVersion !== 2 || !recovery.rounds.at(-1)?.startedAt || recovery.rounds.at(-1).endedAt != null) return run;
    const restored = structuredClone(recovery);
    Object.assign(restored.rounds.at(-1), { endedAt: this.clock(), outcome: "interrupted" });
    while (restored.nextSlot < restored.attemptTimes.length && restored.attemptTimes[restored.nextSlot] <= this.clock()) restored.skippedAttempts.push(restored.nextSlot++);
    const nextAt = restored.attemptTimes[restored.nextSlot];
    if (!Number.isFinite(nextAt) || nextAt >= restored.deadline) throw new CycleError("E_QUERY_RECOVERY_TIMEOUT", "恢复轮次已用完。");
    restored.nextAttemptAt = nextAt;
    const next = { ...run, queryRecovery: restored, recovery: { ...run.recovery, nextAttemptAt: nextAt } };
    await this.saveRun(next);
    return next;
  }

  externalControl(tabId, documentId) {
    const active = this.active?.diagnostic?.run;
    const known = this.queryRecoveryDocuments.get(tabId);
    if ((active?.tabId === tabId && active.queryRecovery || this.queryRecoveryDocuments.has(tabId)) && (!documentId || !known || documentId === known)) {
      if (this.active?.tabId === tabId) this.active.diagnostic.externalControl = true;
      this.cancel(tabId);
    }
    return this.enqueue(async () => {
      const run = await this.store.getRun();
      if (!run?.queryRecovery || run.tabId !== tabId || documentId && run.documentId && run.documentId !== documentId) return;
      const context = this.diagnostic("queryRecovery", { run });
      context.queryRecovery = { ...run.queryRecovery, outcome: "cancelled", endedAt: this.clock(), stopReason: "page-control" };
      this.recordError(this.queryRecoveryError(run, "网页原生操作已取消自动恢复。"), context, run);
      await this.clearRun(run, "检测到网页原生开关或定时器操作，自动恢复已取消；请自行确认空调状态。", "info", context);
    });
  }

  operation(tabId, work, context = this.diagnostic("getState")) {
    context.tabId = tabId;
    context.verificationGeneration = this.verificationGeneration(tabId);
    const revision = this.revisions.get(tabId) || 0;
    return this.enqueue(async () => {
      if (this.writeFault) throw this.writeFault;
      if (revision !== (this.revisions.get(tabId) || 0)) throw new CycleError("E_CANCELLED", "操作已取消。");
      if (context.deadlineAt !== undefined && this.clock() >= context.deadlineAt) throw new CycleError("E_OPERATION_TIMEOUT", "修改等待已超时，未应用修改。");
      const controller = new AbortController();
      context.executionStartedAt = this.clock();
      controller.signal.diagnostic = context;
      this.active = { tabId, controller, diagnostic: context };
      const timeoutMs = Math.min(this.operationTimeoutMs, context.deadlineAt === undefined ? Infinity : context.deadlineAt - this.clock());
      const timer = setTimeout(() => controller.abort(new CycleError("E_OPERATION_TIMEOUT", `本次循环操作超过 ${this.operationTimeoutMs / 1000} 秒，已取消后续步骤；请手动确认空调状态。`)), timeoutMs);
      let operationError;
      try {
        try { await this.diagnostics?.begin(context); } catch { /* Best effort. */ }
        controller.signal.throwIfAborted();
        return await work(controller.signal);
      }
      catch (error) { operationError = error; throw error; }
      finally {
        clearTimeout(timer);
        const code = context.error?.code ?? operationError?.code ?? (controller.signal.aborted ? controller.signal.reason?.code : undefined);
        controller.abort(new CycleError("E_CANCELLED", "本次操作已结束。"));
        try { await this.diagnostics?.end(context, code); } catch { /* Best effort. */ }
        this.active = null;
      }
    }).catch(error => { this.recordError(error, context); throw error; });
  }

  cancel(tabId, reason = new CycleError("E_CANCELLED", "操作已取消；已发送的指令无法撤回，请自行确认空调状态。")) {
    this.trace(this.active?.diagnostic, { component: "operation", step: "cancel", outcome: "cancelled", code: reason.code });
    this.revisions.set(tabId, (this.revisions.get(tabId) || 0) + 1);
    if (this.active?.tabId === tabId) this.active.controller.abort(reason);
  }

  enqueue(work) {
    const result = this.pending.then(work, work);
    this.pending = result.catch(() => {});
    return result;
  }

  async getView(tabId) {
    const { run, notice, keepAliveNotice } = await this.store.getState();
    const warning = keepAliveNotice?.runId === run?.id ? keepAliveNotice : null;
    let visibleNotice = notice?.kind === "error" ? notice : warning || notice;
    if (!run && (!visibleNotice || visibleNotice.tabId !== tabId)) {
      const previous = await this.history.get();
      if (!previous?.active && previous?.notice) visibleNotice = { ...previous.notice, tabId, previous: true };
    }
    if (this.writeFault) visibleNotice = { ...visibleNotice, tabId, kind: "error", text: describeError(this.writeFault) };
    return {
      blocked: Boolean(this.writeFault),
      run: run?.tabId === tabId ? { ...run, ...timingOf(run) } : null,
      elsewhere: Boolean(run && run.tabId !== tabId),
      notice: visibleNotice?.tabId === tabId ? visibleNotice : null
    };
  }

  async saveRun(run) {
    await this.history.save(run);
    await this.store.setRun(run);
    if (run.queryRecovery) this.queryRecoveryDocuments.set(run.tabId, run.documentId);
    else this.queryRecoveryDocuments.delete(run.tabId);
  }

  async restoreProtection(run) {
    if (typeof run?.autoDiscardableBefore === "boolean") {
      this.trace(this.active?.diagnostic, { component: "page", step: "restore", outcome: "begin" });
      try { await this.page.restore?.(run.tabId, run.autoDiscardableBefore); this.trace(this.active?.diagnostic, { component: "page", step: "restore", outcome: "ok" }); }
      catch (error) { this.trace(this.active?.diagnostic, { component: "page", step: "restore", outcome: "error", code: error.code }); if (error.code === "E_LOCAL_TIMEOUT") this.writeFault = error; throw error; }
    }
  }

  async protect(run) {
    this.trace(this.active?.diagnostic, { component: "page", step: "protect", outcome: "begin" });
    try { await this.page.protect?.(run.tabId); this.trace(this.active?.diagnostic, { component: "page", step: "protect", outcome: "ok" }); }
    catch (error) { this.trace(this.active?.diagnostic, { component: "page", step: "protect", outcome: "error", code: error.code }); if (error.code === "E_LOCAL_TIMEOUT") this.writeFault = error; throw error; }
  }

  initialize(tabId, options = {}) {
    const context = this.diagnostic("initialize", options);
    return this.operation(tabId, async signal => {
      let run = await this.store.getRun(signal);
      if (!run || run.tabId !== tabId) {
        this.loadingTabs.delete(tabId);
        if (!run) {
          const { notice } = await this.store.getState(signal);
          if (notice?.tabId === tabId) await this.store.setNotice({ ...notice, previous: true });
        }
        return;
      }
      if (options.documentId && run.retiredDocuments?.includes(options.documentId)) return;
      if (!run.recovery && options.documentId && options.documentId === run.documentId) return;
      context.run = { ...run, documentId: options.documentId };
      context.lifecycle = run.recovery?.kind === "authentication" ? run.lifecycle : options.lifecycle ?? run.lifecycle;
      if (run.queryRecovery) {
        try {
          if ((await this.checkHistory(run, context)).stopped) return;
          if (this.clock() >= run.recovery.deadline) throw new CycleError("E_RECOVERY_TIMEOUT", "页面恢复期限已到。");
          run = await this.restoreQueryRound(run);
          context.dispatchDeadlineAt = run.queryRecovery.deadline;
          this.checkDeadline(signal);
          const resumed = { ...run, documentId: options.documentId ?? run.documentId, lifecycle: context.lifecycle,
            retiredDocuments: [...(run.retiredDocuments ?? []), ...(run.documentId && run.documentId !== options.documentId ? [run.documentId] : [])].slice(-8),
            recovery: { kind: "query", at: run.queryRecovery.startedAt, deadline: run.queryRecovery.deadline, nextAttemptAt: run.queryRecovery.nextAttemptAt } };
          await this.protect(resumed);
          await this.saveRun(resumed);
          this.checkDeadline(signal);
          this.loadingTabs.delete(tabId);
          // Fresh control preflight belongs to the scheduled query round.
          if (this.clock() >= resumed.recovery.nextAttemptAt) await this.attemptQueryRecovery(resumed, signal, context);
          else await this.recoveryAlarm.create(run.id, resumed.recovery.nextAttemptAt);
          await this.notify(tabId);
        } catch (error) { await this.handleTransitionError(run, error, context); }
        return;
      }
      const currentOperation = this.active.controller;
      const deadlineTimer = run.recovery ? setTimeout(() => currentOperation.abort(new CycleError("E_RECOVERY_TIMEOUT", "恢复核验已到期限，取消本次查询。")), Math.max(0, run.recovery.deadline - this.clock())) : null;
      try {
        if (run.recovery && this.clock() >= run.recovery.deadline) throw new CycleError("E_RECOVERY_TIMEOUT", "页面未在 60 秒内恢复，循环已停止。");
        if (this.clock() - run.nextAt > LATE_LIMIT_MS) throw new CycleError("E_ALARM_LATE", "恢复时已错过切换时间超过 1 分钟。");
        const [timer, actual] = await this.readPreflight(tabId, signal);
        signal.throwIfAborted();
        if (run.recovery && this.clock() >= run.recovery.deadline) throw new CycleError("E_RECOVERY_TIMEOUT", "页面恢复核验超过期限。");
        if (this.clock() - run.nextAt > LATE_LIMIT_MS) throw new CycleError("E_ALARM_LATE", "恢复核验期间已超过切换时间 1 分钟。");
        if (hasNativeTimer(timer)) throw new CycleError("E_NATIVE_TIMER", "学校原有定时器仍生效，不能接续循环。");
        if (actual !== run.expectedOn) throw new CycleError("E_STATUS_CHANGED", "空调状态与原循环不符，循环已停止。");
        const resumed = { ...run, recovery: null, documentId: options.documentId,
          retiredDocuments: [...(run.retiredDocuments ?? []), ...(run.documentId && run.documentId !== options.documentId ? [run.documentId] : [])].slice(-8),
          lifecycle: context.lifecycle, lastConfirmedStatus: context.lastConfirmedStatus };
        await this.protect(run);
        signal.throwIfAborted();
        await this.saveRun(resumed);
        signal.throwIfAborted();
        await this.alarm.create(run.id, run.nextAt);
        await this.recoveryAlarm.clear(run.id);
        this.loadingTabs.delete(tabId);
        await this.store.setNotice({ tabId, kind: "info", text: "页面已恢复，继续原循环与原切换时间。" });
        await this.notify(tabId);
        if (run.recovery?.kind === "authentication") {
          context.authenticationRecovered = { ...run.lifecycle, event: "authentication", tabId, documentId: options.documentId };
          this.trace(context, { component: "page", step: "recoverySucceeded", route: "home", outcome: "ok" });
        }
      } catch (error) {
        if (["E_PAGE_RELOADING", "E_CANCELLED"].includes(error.code)) return;
        this.recordError(error, context, run);
        await this.clearRun(run, `页面恢复失败：${describeError(error)} 请自行确认空调状态。`, "error", context);
      } finally { clearTimeout(deadlineTimer); }
    }, context);
  }

  suspend(tabId, lifecycle = { event: "loading" }) {
    this.loadingTabs.add(tabId);
    this.cancel(tabId, new CycleError("E_PAGE_RELOADING", "页面正在重新加载。"));
    return this.enqueue(async () => {
      const run = await this.store.getRun();
      if (!run || run.tabId !== tabId) return;
      const context = this.diagnostic("lifecycle", { run, lifecycle });
      try {
        const { stopped } = await this.checkHistory(run, context);
        if (stopped) return;
        if (lifecycle.route === "cas" && run.recovery?.kind !== "authentication") {
          const error = new CycleError("E_PAGE_CLOSED", "标签页离开主页，且没有已记录的学校认证跳转。");
          this.recordError(error, context, run);
          await this.clearRun(run, describeError(error), "warning", context);
          return;
        }
        const authentication = lifecycle.event === "authentication" || run.recovery?.kind === "authentication";
        const recovery = { ...(run.recovery ?? { at: this.clock(), deadline: Math.min(this.clock() + RECOVERY_LIMIT_MS, run.nextAt + LATE_LIMIT_MS) }),
          kind: authentication ? "authentication" : "reload" };
        if (run.queryRecovery?.policyVersion === 2) recovery.deadline = Math.min(recovery.deadline, this.clock() + RECOVERY_LIMIT_MS);
        const reason = authentication ? { ...lifecycle, event: "authentication", tabId } : lifecycle;
        const suspended = { ...run, recovery, lifecycle: reason };
        context.run = suspended; context.lifecycle = reason;
        this.trace(context, { component: "page", step: "recoveryStarted", route: lifecycle.route, outcome: "ok" });
        await this.saveRun(suspended);
        await this.recoveryAlarm.create(run.id, recovery.deadline);
        await this.notify(tabId);
      } catch (error) {
        this.recordError(error, context, run);
        await this.clearRun(run, `页面恢复准备失败：${describeError(error)}`, "error", context);
      }
    });
  }

  recoveryExpired(runId, scheduledAt) {
    const context = this.diagnostic("queryRecovery");
    return this.store.getRun().then(initial => this.operation(initial?.tabId, async signal => {
      let run = await this.store.getRun(signal);
      if (!run || run.id !== runId || !run.recovery) return;
      context.run = run; context.lifecycle = run.lifecycle;
      try {
        if ((await this.checkHistory(run, context)).stopped) return;
        this.queryRecoveryDocuments.set(run.tabId, run.documentId);
        if (run.queryRecovery?.policyVersion === 2 && run.queryRecovery.rounds.at(-1)?.endedAt == null) {
          run = await this.restoreQueryRound(run);
          await this.recoveryAlarm.create(run.id, run.recovery.kind === "query" ? run.recovery.nextAttemptAt : run.recovery.deadline);
          return;
        }
        const nextAt = run.recovery.kind === "query" ? run.recovery.nextAttemptAt : run.recovery.deadline;
        if (this.clock() >= run.recovery.deadline) throw new CycleError(run.queryRecovery ? "E_QUERY_RECOVERY_TIMEOUT" : "E_RECOVERY_TIMEOUT", "恢复已到期限，循环已停止。");
        if (Number.isFinite(scheduledAt) && Math.abs(scheduledAt - nextAt) > 1000) return;
        if (this.clock() < nextAt) return this.recoveryAlarm.create(run.id, nextAt);
        if (run.recovery.kind === "query" && !this.loadingTabs.has(run.tabId)) return this.attemptQueryRecovery(run, signal, context);
      } catch (error) { await this.handleTransitionError(run, error, context); }
    }, context));
  }

  reconcile(deliveredCycles = new Map()) {
    const context = this.diagnostic("reconcile");
    return this.enqueue(async () => {
      let run = await this.store.getRun();
      context.run = run;
      const { checkpoint, stopped } = await this.checkHistory(run, context);
      if (stopped || !run) return;
      if (run.recovery) {
        try { run = await this.restoreQueryRound(run); }
        catch (error) { await this.handleTransitionError(run, error, context); return; }
        if (this.clock() >= run.recovery.deadline) {
          const error = new CycleError(run.queryRecovery ? "E_QUERY_RECOVERY_TIMEOUT" : "E_RECOVERY_TIMEOUT", "恢复已到期限，循环已停止。");
          this.recordError(error, context, run);
          await this.clearRun(run, describeError(error), "error", context);
          return;
        }
        await this.recoveryAlarm.create(run.id, run.recovery.kind === "query" ? run.recovery.nextAttemptAt : run.recovery.deadline);
        return;
      }
      const delivered = () => Math.abs(deliveredCycles.get(run.id) - run.nextAt) <= 1000;
      if (!delivered()) {
        const scheduled = await this.alarm.get(run.id);
        // A delivery can arrive while this browser read is pending.
        if (!delivered() && (!scheduled || !Number.isFinite(scheduled.scheduledTime) || Math.abs(scheduled.scheduledTime - run.nextAt) > 1000)) {
          this.recordError(new CycleError("E_ALARM_MISSING", ""), context, run);
          await this.clearRun(run, "[E_ALARM_MISSING] 浏览器定时器丢失或不一致，循环已停止；请自行确认空调状态并重新开始。", "error", context);
          return;
        }
      }
      await this.ensureKeepAlive(run);
      if (!checkpoint) await this.history.save(run);
      await this.protect(run);
    }).catch(error => { this.recordError(error, context); throw error; });
  }

  async checkHistory(run, context) {
    const checkpoint = await this.history.get();
    const recoveryState = value => JSON.stringify([value?.recovery?.kind, value?.recovery?.deadline, value?.recovery?.nextAttemptAt,
      value?.queryRecovery?.id, value?.queryRecovery?.deadline, value?.queryRecovery?.nextAttemptAt, value?.queryRecovery?.rounds?.at(-1)?.operationId,
      value?.queryRecovery?.policyVersion, value?.queryRecovery?.attemptTimes, value?.queryRecovery?.nextSlot, value?.queryRecovery?.skippedAttempts]);
    if (run && checkpoint?.active === false && checkpoint.run?.id === run.id) {
      await this.clearRun(run, checkpoint.notice.text, checkpoint.notice.kind, { command: checkpoint.command });
      return { checkpoint, stopped: true };
    }
    if (checkpoint?.active && (!run || checkpoint.command || checkpoint.run?.id !== run.id || checkpoint.run?.nextAt !== run.nextAt || checkpoint.run?.phase !== run.phase || timingOf(checkpoint.run).timingRevision !== timingOf(run).timingRevision || checkpoint.run.onMinutes !== run.onMinutes || checkpoint.run.offMinutes !== run.offMinutes || recoveryState(checkpoint.run) !== recoveryState(run))) {
      const interrupted = checkpoint.run;
      context.command = checkpoint.command;
      context.lifecycle ??= interrupted?.lifecycle;
      const code = checkpoint.command ? "E_COMMAND_UNKNOWN" : run ? "E_CYCLE_INTERRUPTED" : "E_SESSION_ENDED";
      const message = checkpoint.command ? "上次开关操作结果未确认，禁止自动重发。" : run ? "持久检查点与会话阶段不一致，已禁止继续切换。" : "浏览器或扩展会话已结束；上次循环未恢复。具体退出原因未知。";
      const error = new CycleError(code, message);
      this.recordError(error, context, interrupted);
      await this.clearRun(interrupted, `上次循环已中断：${describeError(error)} 请自行确认空调状态。`, "error", context);
      return { checkpoint, stopped: true };
    }
    return { checkpoint, stopped: false };
  }

  start(tabId, onMinutes, offMinutes, options = {}) {
    const context = this.diagnostic("start", { ...options, durations: { onMinutes, offMinutes } });
    return this.operation(tabId, async signal => {
      try {
        if (!validMinutes(onMinutes) || !validMinutes(offMinutes)) throw new CycleError("E_DURATION", "开机和关机时间都必须是 1–1440 分钟的整数。");
        const existing = await this.store.getRun(signal);
        context.run = existing;
        signal.throwIfAborted();
        if (existing) throw new CycleError("E_ALREADY_RUNNING", "已有循环正在运行，请先停止它。");
        const checkpoint = await this.history.get(signal);
        if (checkpoint?.notice?.outcomeUnknown) throw new CycleError("E_COMMAND_UNKNOWN", "上次开关结果未确认；请确认空调状态后点击停止，再重新开始。");
        if (this.loadingTabs.has(tabId)) throw new CycleError("E_PAGE_RELOADING", "页面正在加载，请等待恢复完成。");
        context.prepared = true;
        context.run = { id: this.id(), tabId, onMinutes, offMinutes, phase: "on", expectedOn: true,
          startedAt: this.clock(), nextAt: this.clock() + onMinutes * 60_000, documentId: options.documentId,
          lifecycle: options.lifecycle };
        if (!await this.page.isOpen(tabId, signal)) throw new CycleError("E_PAGE_CLOSED", "请在学校空调主页打开时启动循环。");
        signal.throwIfAborted();
        const [timer, actual] = await this.readPreflight(tabId, signal);
        signal.throwIfAborted();
        if (hasNativeTimer(timer)) throw new CycleError("E_NATIVE_TIMER", "学校原有定时关闭仍在生效，请先在网页中取消。");
        context.run.autoDiscardableBefore = await this.page.getProtection?.(tabId);
        await this.history.save(context.run);
        await this.protect(context.run);
        signal.throwIfAborted();
        await this.ensureStatus(tabId, true, actual, signal);
        signal.throwIfAborted();

        const startedAt = this.clock();
        const run = {
          ...context.run,
          phase: "on", expectedOn: true, startedAt, phaseStartedAt: startedAt, timingRevision: 0, lastConfirmedStatus: context.lastConfirmedStatus,
          nextAt: startedAt + onMinutes * 60_000
        };
        context.run = run;
        try {
          await this.saveRun(run);
          signal.throwIfAborted();
          await this.alarm.create(run.id, run.nextAt);
          signal.throwIfAborted();
        } catch (error) {
          await Promise.allSettled([this.alarm.clear(run.id), this.store.clearRun()]);
          throw new CycleError(error.code || "E_SCHEDULE", `循环未启动：${error.message}；请自行确认空调状态。`);
        }
        // A cosmetic notice failure must not report a scheduled cycle as failed.
        await this.store.setNotice({ tabId, kind: "info", text: "循环已启动。" }).catch(() => {});
        await this.ensureKeepAlive(run, signal);
        await this.notify(tabId);
        return run;
      } catch (error) {
        // A rejected duplicate start must not terminate an existing run.
        if (!context.prepared) throw error;
        if (error.code === "E_PAGE_RELOADING") {
          error = new CycleError(context.command?.sent && !context.command.confirmed ? "E_COMMAND_UNKNOWN" : "E_START_INTERRUPTED", "启动被中断，请确认空调状态后手动重新开始。");
        }
        this.recordError(error, context, context.run);
        await this.clearRun(context.run, `循环未启动：${describeError(error)}`, "error", context);
        throw error;
      }
    }, context);
  }

  checkDeadline(signal) {
    signal.throwIfAborted();
    if (signal.diagnostic?.dispatchDeadlineAt !== undefined && !signal.diagnostic.command?.sent && this.clock() >= signal.diagnostic.dispatchDeadlineAt) {
      throw new CycleError("E_QUERY_RECOVERY_TIMEOUT", "查询恢复已到期限，不再发送开关指令。");
    }
    if (signal.diagnostic?.deadlineAt !== undefined && this.clock() >= signal.diagnostic.deadlineAt) {
      throw new CycleError("E_OPERATION_TIMEOUT", "修改已超过总期限，取消后续步骤。");
    }
  }

  updateDurations(tabId, request, options = {}) {
    const context = this.diagnostic("updateDurations", { ...options,
      durations: { onMinutes: request.onMinutes, offMinutes: request.offMinutes },
      deadlineAt: options.deadlineAt ?? this.clock() + this.operationTimeoutMs,
      timingChange: { at: this.clock(), runId: request.runId, expectedRevision: request.timingRevision,
        requested: { onMinutes: request.onMinutes, offMinutes: request.offMinutes }, outcome: "rejected" } });
    return this.operation(tabId, async signal => {
      if (!validMinutes(request.onMinutes) || !validMinutes(request.offMinutes)) throw new CycleError("E_DURATION", "开机和关机时间都必须是 1–1440 分钟的整数。");
      let run = await this.store.getRun(signal);
      context.run = run;
      this.checkDeadline(signal);
      if (!run || run.tabId !== tabId || run.id !== request.runId || timingOf(run).timingRevision !== request.timingRevision
        || (run.documentId && options.documentId && run.documentId !== options.documentId)) {
        throw new CycleError("E_TIMING_STALE", "循环或阶段已变化，本次修改未执行；请核对新的剩余时间后再次应用。");
      }
      if (run.recovery || this.loadingTabs.has(tabId)) throw new CycleError("E_TIMING_UNAVAILABLE", "页面正在恢复，暂不能修改时间。");
      if ((await this.checkHistory(run, context)).stopped) throw context.error ?? new CycleError("E_CYCLE_INTERRUPTED", "循环已中断，未应用修改。");
      run = { ...run, ...timingOf(run) };
      context.run = run;
      const change = context.timingChange;
      Object.assign(change, { phase: run.phase, phaseStartedAt: run.phaseStartedAt,
        before: { onMinutes: run.onMinutes, offMinutes: run.offMinutes }, previousNextAt: run.nextAt,
        previousRevision: run.timingRevision });
      let committed = false;
      try {
        this.checkDeadline(signal);
        if (this.clock() - run.nextAt > LATE_LIMIT_MS) throw new CycleError("E_ALARM_LATE", "原切换时间已延误超过 1 分钟，不能通过修改时间接续。");
        if (run.onMinutes === request.onMinutes && run.offMinutes === request.offMinutes) { change.outcome = "unchanged"; return { changed: false, run }; }
        if (!await this.page.isOpen(tabId, signal)) throw new CycleError("E_PAGE_CLOSED", "学校主页已关闭或离开。");
        this.checkDeadline(signal);
        if (this.clock() - run.nextAt > LATE_LIMIT_MS) throw new CycleError("E_ALARM_LATE", "核对页面时原切换时间已延误超过 1 分钟。");
        const computedNextAt = run.phaseStartedAt + (run.phase === "on" ? request.onMinutes : request.offMinutes) * 60_000;
        Object.assign(change, { computedNextAt, immediate: computedNextAt <= this.clock(),
          effectiveNextAt: Math.max(computedNextAt, this.clock()), nextRevision: run.timingRevision + 1, outcome: "pending" });
        run = { ...run, onMinutes: request.onMinutes, offMinutes: request.offMinutes,
          timingRevision: change.nextRevision, nextAt: change.effectiveNextAt, lastTimingChange: { ...change, outcome: "applied" } };
        context.run = run;
        // Persist the new plan before replacing its alarm or sending a command.
        // Any partial write is handled by the same fail-closed path as a tick.
        committed = true;
        await this.saveRun(run);
        this.checkDeadline(signal);
        await this.alarm.create(run.id, run.nextAt);
        this.checkDeadline(signal);
        if (change.immediate) run = await this.advancePhase(run, signal, context);
        change.outcome = "applied";
        change.nextRevision = run.timingRevision;
        this.trace(context, { component: "operation", step: "timingUpdated", outcome: "ok", timingChange: change });
        await this.store.setNotice({ tabId, kind: "info", text: "时长已更新，当前及后续循环使用新设置。" }).catch(() => {});
        await this.notify(tabId);
        return { changed: true, run };
      } catch (error) {
        change.outcome = ["E_CANCELLED", "E_PAGE_RELOADING"].includes(error.code) ? "cancelled" : "failed";
        if (committed && run.lastTimingChange) run = { ...run, lastTimingChange: { ...change } };
        error = await this.handleTransitionError(run, error, context);
        throw error;
      }
    }, context);
  }

  tick(runId, scheduledAt) {
    const context = this.diagnostic("tick");
    return this.store.getRun().then(initial => this.operation(initial?.tabId, async signal => {
      const run = await this.store.getRun(signal);
      context.run = run;
      signal.throwIfAborted();
      if (!run || run.id !== runId) return;
      if (run.recovery || this.loadingTabs.has(run.tabId)) return;
      // A superseded delivery never controls a different plan, even if overdue.
      if (Number.isFinite(scheduledAt) && Math.abs(scheduledAt - run.nextAt) > 1000) return;
      if (this.clock() < run.nextAt) {
        await this.alarm.create(run.id, run.nextAt);
        return;
      }
      try { await this.advancePhase(run, signal, context); }
      catch (error) {
        try { if (await this.beginQueryRecovery(run, error, signal, context)) return; }
        catch (preparationError) { error = preparationError; }
        await this.handleTransitionError(context.run ?? run, error, context);
      }
    }, context));
  }

  async advancePhase(run, signal, context) {
    if (!await this.page.isOpen(run.tabId, signal)) throw new CycleError("E_PAGE_CLOSED", "学校主页已关闭或离开。");
    this.checkDeadline(signal);
    if (!run.queryRecovery && this.clock() - run.nextAt > LATE_LIMIT_MS) throw new CycleError("E_ALARM_LATE", "定时切换延误超过 1 分钟，不再发送开关指令。");
    const [timer, actual] = await this.readPreflight(run.tabId, signal, context.dispatchDeadlineAt);
    this.checkDeadline(signal);
    if (!run.queryRecovery && this.clock() - run.nextAt > LATE_LIMIT_MS) throw new CycleError("E_ALARM_LATE", "查询期间已超过切换时间 1 分钟，取消本次切换。");
    context.preflight = { actual, timerPresent: hasNativeTimer(timer) };
    if (context.preflight.timerPresent) throw new CycleError("E_NATIVE_TIMER", "学校原有定时器仍生效。");
    if (actual !== run.expectedOn) throw new CycleError("E_STATUS_CHANGED", "空调状态与循环预期不符。");
    const nextOn = run.phase === "off";
    await this.ensureStatus(run.tabId, nextOn, actual, signal);
    this.checkDeadline(signal);
    const phaseStartedAt = this.clock();
    const next = { ...run, phase: nextOn ? "on" : "off", expectedOn: nextOn,
      ...(run.queryRecovery ? { recovery: null, queryRecovery: null } : {}),
      phaseStartedAt, timingRevision: timingOf(run).timingRevision + 1,
      lastConfirmedStatus: context.lastConfirmedStatus,
      nextAt: phaseStartedAt + (nextOn ? run.onMinutes : run.offMinutes) * 60_000 };
    if (context.timingChange) next.lastTimingChange = { ...context.timingChange, outcome: "applied", nextRevision: next.timingRevision };
    context.run = next;
    await this.saveRun(next);
    this.checkDeadline(signal);
    await this.alarm.create(next.id, next.nextAt);
    this.checkDeadline(signal);
    if (run.queryRecovery) await this.recoveryAlarm.clear(run.id);
    await this.notify(next.tabId);
    return next;
  }

  async handleTransitionError(run, error, context) {
    if (context.externalControl) {
      error = new CycleError("E_PAGE_CONTROL", "网页原生操作已取消自动恢复，请自行确认空调状态。");
      context.queryRecovery = { ...this.querySnapshot(run.queryRecovery, context, "cancelled"), stopReason: "page-control" };
    }
    context.error = error;
    if (run.queryRecovery) context.recoveryReported = true;
    if (error.code === "E_PAGE_RELOADING" && !context.command?.sent) {
      await this.history.save(run);
      return error;
    }
    if (error.code === "E_PAGE_RELOADING") error = new CycleError(context.command?.confirmed ? "E_CYCLE_INTERRUPTED" : "E_COMMAND_UNKNOWN", "页面重载打断了开关操作，循环已停止；请自行确认空调状态。");
    this.recordError(error, context, run);
    const warnings = {
      E_PAGE_CLOSED: describeError(error),
      E_ALARM_LATE: "[E_ALARM_LATE] 定时切换延误超过 1 分钟，循环已停止；不再发送开关指令。",
      E_NATIVE_TIMER: "检测到学校原有定时关闭，循环已暂停；空调状态保持不变。",
      E_STATUS_CHANGED: "空调状态被手动更改，循环已暂停；空调状态保持不变。"
    };
    await this.clearRun(run, warnings[error.code] ?? ('循环已停止：' + describeError(error) + ' 请自行确认空调状态。'), warnings[error.code] ? "warning" : "error", context);
    return error;
  }

  manualCheck(tabId, options = {}) {
    const context = this.diagnostic("manualCheck", options);
    return this.operation(tabId, async signal => {
      const run = await this.store.getRun(signal);
      context.run = run;
      signal.throwIfAborted();
      if (!run || run.tabId !== tabId || run.recovery || this.loadingTabs.has(tabId)) return;
      try {
        const actual = await this.api.readStatus(tabId, signal);
        this.observeStatus(signal, actual);
        signal.throwIfAborted();
        if (actual !== run.expectedOn) {
          this.recordError(new CycleError("E_STATUS_CHANGED", "空调状态与循环预期不符。"), context, run);
          await this.clearRun(run, "空调状态被手动更改，循环已暂停；空调状态保持不变。", "warning", context);
        }
      } catch (error) {
        if (error.code === "E_PAGE_RELOADING") return;
        this.recordError(error, context, run);
        await this.clearRun(run, `无法确认空调状态，循环已停止：${describeError(error)}`, "error", context);
      }
    }, context);
  }

  async ensureKeepAlive(run, signal) {
    try {
      const scheduled = await this.keepAliveAlarm.get(run.id, signal);
      signal?.throwIfAborted();
      if (scheduled) return;
      const interval = KEEP_ALIVE_MINUTES * 60_000;
      const now = this.clock();
      const firstAt = (run.startedAt ?? now) + interval;
      // Restore the original cadence, without replaying missed heartbeats.
      const when = firstAt > now ? firstAt : firstAt + (Math.floor((now - firstAt) / interval) + 1) * interval;
      await this.keepAliveAlarm.create(run.id, when);
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) return;
      await this.warnKeepAlive(run, error);
    }
  }

  async warnKeepAlive(run, error) {
    const active = this.active?.diagnostic;
    const context = active?.source === "keepAlive" ? active : this.diagnostic("keepAliveSchedule", { run, lastConfirmedStatus: active?.lastConfirmedStatus, command: active?.command });
    this.recordError(error, context, run);
    const at = this.clock();
    await this.store.setKeepAliveNotice({
      tabId: run.tabId, runId: run.id, kind: "warning", at,
      text: `保活失败（${new Date(at).toLocaleString()}）：${describeError(error)} 原循环仍运行；本次不立即重试。`
    }).catch(() => {});
    await this.notify(run.tabId);
  }

  keepAlive(runId) {
    const context = this.diagnostic("keepAlive");
    return this.store.getRun().then(initial => {
      if (!initial || initial.id !== runId) return this.keepAliveAlarm.clear(runId).catch(() => {});
      return this.operation(initial.tabId, async signal => {
        try {
          const { run, keepAliveNotice } = await this.store.getState(signal);
          context.run = run;
          signal.throwIfAborted();
          if (!run || run.id !== runId) {
            await this.keepAliveAlarm.clear(runId).catch(() => {});
            return;
          }
          if (run.recovery || this.loadingTabs.has(run.tabId)) return;
          // Read only: never initialize the page, check manual changes, or toggle.
          await this.api.readStatus(run.tabId, signal);
          signal.throwIfAborted();
          if (keepAliveNotice?.runId === runId) {
            await this.store.clearKeepAliveNotice();
            await this.notify(run.tabId);
          }
        } catch (error) {
          if (!["E_CANCELLED", "E_PAGE_RELOADING"].includes(error.code)) await this.warnKeepAlive(initial, error);
        }
      }, context).catch(error => { if (error.code !== "E_CANCELLED") throw error; });
    });
  }

  stop(tabId) {
    this.cancel(tabId);
    this.loadingTabs.delete(tabId);
    return this.enqueue(async () => {
      const run = await this.store.getRun();
      if (run && run.tabId !== tabId) throw new CycleError("E_OTHER_TAB", "循环在另一标签页运行，请在那里停止。");
      if (run) await this.clearRun(run, "循环已停止；不再发送开关指令，请自行确认空调状态。", "info");
      else {
        const checkpoint = await this.history.get();
        if (checkpoint?.active) {
          await this.clearRun(checkpoint.run, "循环已停止；请自行确认空调状态。", "info");
        } else {
          const notice = { tabId, kind: "info", text: "循环已停止；请自行确认空调状态。", at: this.clock() };
          if (checkpoint?.run) await this.history.finish(checkpoint.run, notice);
          await this.store.setNotice(notice);
        }
        await this.notify(tabId);
      }
    });
  }

  abandon(tabId, event = "closed", detail = {}) {
    const interrupted = this.active?.tabId === tabId ? this.active.diagnostic : null;
    this.cancel(tabId, interrupted?.run?.queryRecovery ? new CycleError("E_PAGE_CLOSED", "学校主页已关闭或离开。") : undefined);
    return this.enqueue(async () => {
      const run = await this.store.getRun();
      this.loadingTabs.delete(tabId);
      const ended = run?.tabId === tabId ? run : interrupted?.run;
      if (ended) {
        const checkpoint = await this.history.get();
        // The interrupted query may already have durably reported this closure.
        if (ended.queryRecovery && !run && checkpoint?.active === false && checkpoint.run?.id === ended.id) return;
        const command = interrupted?.command ?? (checkpoint?.run?.id === ended.id ? checkpoint.command : null);
        const context = this.diagnostic("lifecycle", { run: ended, lifecycle: { ...detail, event, tabId }, command, lastConfirmedStatus: interrupted?.lastConfirmedStatus });
        this.trace(context, { component: "page", step: event === "closed" ? "closed" : "navigation", route: detail.route, outcome: "ok" });
        this.recordError(new CycleError("E_PAGE_CLOSED", "学校主页已关闭或离开。"), context, ended);
        await this.clearRun(ended, "页面已关闭或离开，循环已停止；请自行确认空调状态。", "warning", context);
      }
    });
  }

  async clearRun(run, text, kind, context = this.active?.diagnostic) {
    this.queryRecoveryDocuments.delete(run.tabId);
    if (run.queryRecovery && !context?.queryRecovery?.endedAt) {
      const prior = context;
      context = this.diagnostic("queryRecovery", { run, command: prior?.command, lastConfirmedStatus: prior?.lastConfirmedStatus,
        originalOperationId: prior?.reportId });
      context.queryRecovery = this.querySnapshot(run.queryRecovery, prior ?? context,
        kind === "info" || prior?.error?.code === "E_CANCELLED" ? "cancelled" : "stopped");
      this.recordError(this.queryRecoveryError(run, "查询恢复已结束。"), context, run);
    }
    const notice = { tabId: run.tabId, text, kind, at: this.clock(), outcomeUnknown: Boolean(context?.command?.sent && !context.command.confirmed) };
    const cancellation = NON_FAULT_CODES.has(context?.error?.code) && !notice.outcomeUnknown;
    const draft = context?.error && !cancellation ? { ...context, run, at: notice.at, outcomeUnknown: notice.outcomeUnknown } : null;
    let historyError;
    try { await this.history.finish(run, notice, draft); }
    catch (error) { historyError = error; this.recordError(error, this.diagnostic("cleanup"), run); }
    this.loadingTabs.delete(run.tabId);
    const results = await Promise.allSettled([
      this.alarm.clear(run.id), this.store.clearRun(),
      this.recoveryAlarm.clear(run.id), this.restoreProtection(run),
      this.keepAliveAlarm.clear(run.id).catch(() => {}), this.store.clearKeepAliveNotice().catch(() => {})
    ]);
    const failed = results.find(result => result.status === "rejected");
    if (failed) {
      this.writeFault ??= new CycleError("E_LOCAL_STORAGE", "循环清理失败，已禁止后续空调指令；请重新加载扩展并确认空调状态。");
      notice.kind = "error";
      notice.text = describeError(this.writeFault);
      const cleanup = this.diagnostic("cleanup", { run, command: context?.command });
      this.recordError(this.writeFault, cleanup, run);
      if (!historyError) await this.history.finish(run, notice, { ...cleanup, at: notice.at, outcomeUnknown: notice.outcomeUnknown }).catch(() => {});
    }
    let noticeError;
    try { await this.store.setNotice(notice); await this.notify(run.tabId); }
    catch (error) { noticeError = error; }
    // Diagnostics starts only after the original report and stop cleanup settle.
    // This callback must not await read-only network work inside the control queue.
    try { this.onStopped(draft, failed || historyError || noticeError ? "storage_failure" : null); } catch { /* Diagnostic only. */ }
    if (failed) throw this.writeFault;
    if (historyError) throw historyError;
    if (noticeError) throw noticeError;
  }

  async ensureStatus(tabId, desired, knownStatus, signal) {
    signal?.throwIfAborted();
    const current = this.observeStatus(signal, knownStatus === undefined ? await this.api.readStatus(tabId, signal) : knownStatus);
    if (current === desired) return;
    signal?.throwIfAborted();
    if (signal?.diagnostic) signal.diagnostic.command = { desiredOn: desired, sent: false, confirmed: false };
    if (signal?.diagnostic) await this.history.save(signal.diagnostic.run, { desiredOn: desired, sent: true, confirmed: false });
    this.checkDeadline(signal);
    if (this.loadingTabs.has(tabId)) throw new CycleError("E_PAGE_RELOADING", "页面正在加载，暂不发送开关指令。");
    await this.api.setStatus(tabId, desired, signal);
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) await bounded(() => this.sleep(1500), { signal, ms: 2000, stage: "等待状态更新" });
      if (this.observeStatus(signal, await this.api.readStatus(tabId, signal)) === desired) {
        if (signal?.diagnostic) signal.diagnostic.command.confirmed = true;
        return;
      }
    }
    throw new CycleError("E_STATUS_UNCONFIRMED", desired ? "开机后未读到开机状态。" : "关机后未读到关机状态。");
  }
}
