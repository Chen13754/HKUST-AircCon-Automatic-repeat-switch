// Shared by the isolated content script and the extension's ES modules.
(() => {
  const messages = {
    E_HTTP: "学校接口返回错误 HTTP 状态。", E_NETWORK: "网络请求失败。",
    E_AUTH: "登录或认证失效。", E_API_TIMEOUT: "学校接口请求超时。",
    E_AUTH_RECOVERED: "学校认证跳转后已核验并接续原循环。",
    E_API_REJECTED: "学校接口返回业务错误。", E_JSON: "响应不是有效 JSON。",
    E_STATUS_FORMAT: "空调状态格式无法识别。", E_TIMER_FORMAT: "定时器格式无法识别。",
    E_SWITCH_REJECTED: "学校未确认开关请求成功。", E_STATUS_UNCONFIRMED: "尚未确认目标开关状态。",
    E_PAGE_CLOSED: "学校主页已关闭或离开。", E_PAGE_UNAVAILABLE: "无法与学校页面通信。",
    E_PAGE_TIMEOUT: "读取学校页面状态超时。", E_BACKGROUND_UNAVAILABLE: "扩展后台无法通信。",
    E_BACKGROUND_NO_RECEIVER: "浏览器报告找不到扩展消息接收端。",
    E_BACKGROUND_DISCONNECTED: "扩展通信通道在回复前关闭，操作可能已经执行。",
    E_BACKGROUND_EMPTY_REPLY: "扩展后台返回空回复，未收到有效结果。",
    E_BACKGROUND_INVALID_REPLY: "扩展后台回复格式不完整或无效。",
    E_MESSAGE_SOURCE: "页面消息来源未通过校验，本次指令未执行。",
    E_BACKGROUND_TIMEOUT: "等待扩展后台超时，结果未确认。", E_OPERATION_TIMEOUT: "控制操作超时。",
    E_LOCAL_TIMEOUT: "扩展存储或闹钟调用超时。", E_ALARM_LATE: "切换延误超过一分钟。",
    E_ALARM_MISSING: "切换闹钟丢失或时间不一致。", E_SCHEDULE: "保存或安排循环失败。",
    E_RECOVERY_TIMEOUT: "学校页面未在恢复期限内完成核验。", E_QUERY_RECOVERY_TIMEOUT: "查询恢复已到期限，不再发送开关指令。", E_SESSION_ENDED: "浏览器或扩展会话已结束，具体原因未知。",
    E_COMMAND_UNKNOWN: "中断时存在尚未确认的开关指令，禁止自动重发。", E_CYCLE_INTERRUPTED: "页面重载打断了开关操作。",
    E_START_INTERRUPTED: "页面重载打断了循环启动。", E_STATUS_CHANGED: "空调状态与循环预期不符。",
    E_LOCAL_STORAGE: "关键循环记录写入失败，已禁止后续空调指令。",
    E_PAGE_RELOADING: "学校页面正在重新加载，暂不发送新指令。",
    E_DURATION: "循环分钟数无效。", E_ALREADY_RUNNING: "已有循环运行。",
    E_TIMING_STALE: "循环或阶段已变化，本次修改未执行；请核对后再次应用。",
    E_TIMING_UNAVAILABLE: "页面正在恢复，暂不能修改时间。",
    E_OTHER_TAB: "循环在另一标签页运行。", E_NATIVE_TIMER: "学校原有定时器仍生效。",
    E_CANCELLED: "操作已取消。", E_TIMEOUT: "内部等待超时。", E_INTERNAL: "扩展内部异常。"
  };
  const sources = new Set(["start", "updateDurations", "tick", "manualCheck", "keepAlive", "keepAliveSchedule", "initialize", "reconcile", "getState", "stop", "cleanup", "pageCommunication", "openReportSettings", "lifecycle", "recovery", "background", "readRecovery", "authRecovery", "queryRecovery"]);
  sources.add("postCommandVerification");
  const paths = new Set(["/app/prepaid/ac-status", "/app/prepaid/ac-timer", "/app/prepaid/toggle-status"]);
  const messageTypes = new Set(["aircon:initialize", "aircon:getState", "aircon:start", "aircon:updateDurations", "aircon:stop", "aircon:manualCheck", "aircon:openReportSettings"]);
  const communicationReasons = new Set(["NO_RECEIVER", "PORT_CLOSED", "CHANNEL_CLOSED", "CONTEXT_INVALIDATED", "NULL_REPLY", "UNDEFINED_REPLY", "TIMEOUT", "UNKNOWN", "INVALID_REPLY", "ACCEPTED", "EXTENSION_MISMATCH", "TAB_ID_MISSING", "FRAME_REJECTED", "SOURCE_REJECTED", "TAB_URL_MISSING", "TAB_NOT_HOME"]);
  const sourcePages = new Set(["HOME", "SCHOOL_APP", "OTHER", "MISSING"]);
  const requestPhases = new Set(["token", "headers", "body", "parse", "validation", "complete"]);
  const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  const time = value => number(value) !== null && value >= 0 && value < 8.64e15 ? value : null;
  const bool = value => typeof value === "boolean" ? value : null;
  const identifier = value => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value) ? value : null;
  const pick = (value, choices, fallback = null) => choices.includes(value) ? value : fallback;
  const positive = value => number(value) !== null && value >= 0 ? value : null;
  const tabId = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const routes = ["home", "login", "callback", "cas", "logout", "school", "other"];
  function pageRoute(value) {
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/\/$/, "");
      if (url.origin === "https://cas.ust.hk" && path === "/cas/login") return "cas";
      if (url.origin !== "https://w5.ab.ust.hk") return "other";
      for (const [route, suffix] of [["home", "home"], ["login", "login"], ["callback", "callback/cas"], ["logout", "logout"]]) {
        if (path === `/njggt/app/${suffix}`) return route;
      }
      return path.startsWith("/njggt/app/") ? "school" : "other";
    } catch { return "other"; }
  }
  const cleanCode = value => Object.hasOwn(messages, value) ? value : null;
  const steps = ["queued", "begin", "end", "cancel", "beginRequest", "requestPhase", "endRequest", "workerStart", "alarmDelivered", "tabSnapshot", "tabRead", "tokenMessage", "tokenValidate", "protect", "restore", "loading", "navigation", "closed", "initialize", "visibility", "online", "offline", "pagehide", "pageshow", "freeze", "resume", "scriptError", "promiseRejection", "resource", "getRun", "setRun", "clearRun", "getState", "setNotice", "clearNotice", "setKeepAliveNotice", "clearKeepAliveNotice", "get", "save", "finish", "create", "clear"];
  const networkEvents = ["beforeRequest", "beforeSendHeaders", "sendHeaders", "headersReceived", "responseStarted", "redirect", "completed", "error"];
  const networkErrors = new Set(["ERR_ABORTED", "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_NAME_NOT_RESOLVED", "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED", "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_SSL_PROTOCOL_ERROR", "ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_DATE_INVALID", "ERR_CERT_COMMON_NAME_INVALID", "ERR_HTTP2_PROTOCOL_ERROR", "ERR_QUIC_PROTOCOL_ERROR", "ERR_BLOCKED_BY_CLIENT", "ERR_FAILED", "ERR_EMPTY_RESPONSE", "ERR_ADDRESS_UNREACHABLE", "ERR_CONNECTION_REFUSED"]);
  steps.push("observerReady", "pageResponse", "route", "recoveryStarted", "recoverySucceeded", "recoveryExpired", "timingUpdated");
  const observationPaths = new Set([...paths, "/app/prepaid/ac-balance", "/app/prepaid/fcu-settings", "/app/auth/cas/url", "/app/auth/cas/auth"]);
  function observedPath(url) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== "https://w5.ab.ust.hk") return null;
      if (!parsed.pathname.startsWith("/njggt/api/")) return null;
      const path = parsed.pathname.replace(/^\/njggt\/api/, "");
      return observationPaths.has(path) ? path : null;
    } catch { return null; }
  }
  function pageEvidence(value) {
    if (!value || typeof value !== "object") return null;
    return {
      tabId: tabId(value.tabId), documentId: identifier(value.documentId),
      at: positive(value.at), contentObservedAt: positive(value.contentObservedAt), tabObservedAt: positive(value.tabObservedAt), route: pick(value.route, routes),
      responseObserver: bool(value.responseObserver),
      visibility: pick(value.visibility, ["visible", "hidden"]), online: bool(value.online),
      observedOn: bool(value.observedOn),
      wasDiscarded: bool(value.wasDiscarded), frozen: bool(value.frozen), discarded: bool(value.discarded),
      navigationType: pick(value.navigationType, ["navigate", "reload", "back_forward", "prerender"]),
      documentStartedAt: positive(value.documentStartedAt), loginAgeMs: positive(value.loginAgeMs), tokenPresent: bool(value.tokenPresent),
      scripts: (Array.isArray(value.scripts) ? value.scripts : []).filter(name => typeof name === "string" && /^(?:main|\d+)\.[a-f0-9]{8,32}\.chunk\.js$/.test(name)).slice(0, 4)
    };
  }
  function traceEvent(value = {}) {
    return {
      at: positive(value.at), workerId: identifier(value.workerId), operationId: identifier(value.operationId),
      tabId: tabId(value.tabId), documentId: identifier(value.documentId), runId: identifier(value.runId),
      source: sources.has(value.source) ? value.source : null, step: pick(value.step, steps),
      ...(value.timingChange ? { timingChange: timingChange(value.timingChange) } : {}),
      component: pick(value.component, ["operation", "request", "store", "alarm", "recovery", "history", "keepalive", "page", "worker"]),
      outcome: pick(value.outcome, ["begin", "ok", "error", "cancelled"]), code: cleanCode(value.code),
      elapsedMs: positive(value.elapsedMs), scheduledAt: positive(value.scheduledAt), latenessMs: number(value.latenessMs),
      sequence: positive(value.sequence), phase: requestPhases.has(value.phase) ? value.phase : null,
      online: bool(value.online), visibility: pick(value.visibility, ["visible", "hidden"]), route: pick(value.route, routes),
      observer: pick(value.observer, ["tabs", "webNavigation", "content", "page-observer"]),
      navigationEvent: pick(value.navigationEvent, ["onBeforeNavigate", "onCommitted", "onHistoryStateUpdated", "onCompleted", "onErrorOccurred"]),
      navigationError: networkRecord({ error: value.navigationError }).error,
      transitionType: pick(value.transitionType, ["link", "typed", "auto_bookmark", "auto_subframe", "manual_subframe", "generated", "auto_toplevel", "form_submit", "reload", "keyword", "keyword_generated"]),
      qualifiers: (Array.isArray(value.qualifiers) ? value.qualifiers : []).filter(item => ["client_redirect", "server_redirect", "forward_back", "from_address_bar"].includes(item)),
      frozen: bool(value.frozen), discarded: bool(value.discarded), documentStartedAt: positive(value.documentStartedAt),
      script: typeof value.script === "string" && /^(?:main|\d+)\.[a-f0-9]{8,32}\.chunk\.js$/.test(value.script) ? value.script : null,
      line: positive(value.line), column: positive(value.column)
    };
  }
  function resourceTiming(value) {
    if (!value || typeof value !== "object") return null;
    return {
      startedAt: positive(value.startedAt), durationMs: positive(value.durationMs),
      detailsAvailable: bool(value.detailsAvailable),
      dnsMs: positive(value.dnsMs), connectMs: positive(value.connectMs), tlsMs: positive(value.tlsMs),
      waitMs: positive(value.waitMs), downloadMs: positive(value.downloadMs),
      protocol: pick(value.protocol, ["http/1.0", "http/1.1", "h2", "h3", "quic"])
    };
  }
  function networkRecord(value = {}) {
    const error = typeof value.error === "string" ? value.error.replace(/^net::/, "") : null;
    return {
      id: identifier(value.id), operationId: identifier(value.operationId), sequence: positive(value.sequence),
      tabId: tabId(value.tabId), documentId: identifier(value.documentId),
      owner: pick(value.owner, ["extension", "page", "unknown"]),
      method: pick(value.method, ["GET", "POST", "OPTIONS"]), path: observationPaths.has(value.path) ? value.path : null,
      startedAt: positive(value.startedAt), endedAt: positive(value.endedAt),
      httpStatus: Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
      error: error ? networkErrors.has(error) ? error : "UNKNOWN" : null, fromCache: bool(value.fromCache),
      correlation: pick(value.correlation, ["unique", "ambiguous", "unmatched", "time-window"]),
      events: (Array.isArray(value.events) ? value.events : []).slice(-8).map(item => ({ event: pick(item.event, networkEvents), at: positive(item.at) })),
      timing: resourceTiming(value.timing)
    };
  }
  function pageResponse(value = {}) {
    return {
      tabId: tabId(value.tabId), documentId: identifier(value.documentId),
      path: observationPaths.has(value.path) ? value.path : null,
      method: pick(value.method, ["GET", "POST"]), transport: pick(value.transport, ["xhr", "fetch"]),
      startedAt: positive(value.startedAt), endedAt: positive(value.endedAt),
      httpStatus: Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
      schoolCode: Number.isSafeInteger(value.schoolCode) ? value.schoolCode : null,
      result: pick(value.result, ["json", "invalid-json", "too-large", "unavailable", "network-error"]),
      // Page-world observations are evidence only, never authority for control.
      evidenceSource: "page-observer", browserRequestId: identifier(value.browserRequestId),
      correlation: pick(value.correlation, ["unique", "unmatched", "ambiguous"])
    };
  }
  function diagnostics(value) {
    if (!value || typeof value !== "object") return null;
    return {
      version: 2, revision: positive(value.revision) ?? 0, targetTabId: tabId(value.targetTabId),
      worker: { id: identifier(value.worker?.id), startedAt: positive(value.worker?.startedAt) },
      coverage: { webRequest: bool(value.coverage?.webRequest), resourceTiming: bool(value.coverage?.resourceTiming),
        historyLoaded: bool(value.coverage?.historyLoaded), webNavigation: bool(value.coverage?.webNavigation),
        barrierTimedOut: bool(value.coverage?.barrierTimedOut),
        truncated: value.coverage?.truncated === true || ["events", "lifecycleEvents"].some(key => value[key]?.length > 64) || ["network", "pageResponses"].some(key => value[key]?.length > 32) ? true : bool(value.coverage?.truncated),
        missingTerminalEvents: Array.isArray(value.network) && value.network.length ? value.network.some(item => item.endedAt == null) : bool(value.coverage?.missingTerminalEvents),
        journal: pick(value.coverage?.journal, ["ready", "loading", "unavailable", "write-failed"]),
        limitations: ["SERVER_INTERNALS_UNOBSERVABLE", "DNS_TCP_TLS_MAY_BE_UNAVAILABLE", "NETWORK_EVENTS_DO_NOT_PROVE_SERVER_RECEIPT", "PAGE_OBSERVER_IS_PAGE_CONTROLLED", "LEGACY_UNSCOPED_EVENTS_NOT_ATTRIBUTABLE"] },
      site: pageEvidence(value.site),
      lifecycleEvents: (Array.isArray(value.lifecycleEvents) ? value.lifecycleEvents : []).slice(-64).map(traceEvent),
      pageResponses: (Array.isArray(value.pageResponses) ? value.pageResponses : []).slice(-32).map(pageResponse),
      unfinishedOperations: (Array.isArray(value.unfinishedOperations) ? value.unfinishedOperations : []).slice(-8).map(item => ({ operationId: identifier(item.operationId), source: sources.has(item.source) ? item.source : null, at: positive(item.at) })),
      events: (Array.isArray(value.events) ? value.events : []).slice(-64).map(traceEvent),
      network: (Array.isArray(value.network) ? value.network : []).slice(-32).map(networkRecord)
    };
  }
  function mergeDiagnostics(previous, incoming, operationId) {
    const next = diagnostics(incoming), old = diagnostics(previous);
    if (!old || !next) return next ?? old;
    const merge = (key, cap, reserved, identity) => {
      const items = new Map();
      for (const item of [...old[key].filter(item => operationId && item.operationId === operationId), ...next[key]]) {
        const id = identity(item), prior = items.get(id);
        const combined = prior ? { ...prior, ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null)) } : item;
        if (prior && key === "network") combined.events = [...new Map([...prior.events, ...item.events].map(event => [`${event.at}:${event.event}`, event])).values()].sort((a, b) => a.at - b.at).slice(-8);
        items.set(id, combined);
      }
      const all = [...items.values()];
      const critical = all.filter(item => operationId && item.operationId === operationId).slice(-reserved);
      const recent = all.filter(item => !critical.includes(item)).slice(-(cap - critical.length));
      if (all.length > cap) next.coverage.truncated = true;
      return [...recent, ...critical].sort((a, b) => (a.at ?? a.startedAt ?? 0) - (b.at ?? b.startedAt ?? 0));
    };
    if (old.coverage.truncated === true) next.coverage.truncated = true;
    next.events = merge("events", 64, 32, item => [item.workerId, item.operationId, item.at, item.component, item.step, item.sequence, item.outcome].join("|"));
    next.network = merge("network", 32, 10, item => item.id ?? [item.operationId, item.sequence, item.startedAt].join("|"));
    return diagnostics(next);
  }
  function faultBoundary(draft, errorCode) {
    if (!draft.diagnostics) return null;
    const clean = diagnostics(draft.diagnostics);
    const request = (draft.requests ?? []).filter(item => item.errorCode === errorCode).at(-1);
    const operationId = identifier(draft.originalOperationId ?? draft.reportId);
    const matches = request && operationId ? clean.network.filter(item => item.operationId === operationId && item.sequence === request.sequence) : [];
    const network = matches.length === 1 ? matches[0] : null;
    const evidenceNetwork = network?.correlation === "unique" ? network : null;
    const responseHeadersAt = evidenceNetwork?.events?.find(item => item.event === "headersReceived")?.at ?? null;
    const browserCompletedAt = evidenceNetwork?.events?.find(item => item.event === "completed")?.at ?? null;
    const local = operationId ? clean.events.filter(item => item.operationId === operationId && item.code === errorCode && item.outcome === "error").at(-1) : null;
    const phase = requestPhases.has(request?.phase) ? request.phase : null;
    return {
      boundary: phase ?? (draft.lifecycle?.event === "authentication" || draft.run?.recovery?.kind === "authentication" || errorCode === "E_AUTH_RECOVERED" ? "authentication-flow" : ["E_LOCAL_STORAGE", "E_LOCAL_TIMEOUT"].includes(errorCode) ? "local-api" : errorCode.startsWith("E_BACKGROUND_") ? "background-communication" : errorCode.startsWith("E_PAGE_") || errorCode === "E_RECOVERY_TIMEOUT" ? "page-lifecycle" : errorCode.startsWith("E_ALARM_") ? "alarm" : "unknown"),
      requestSequence: positive(request?.sequence), browserRequestId: network?.id ?? null, component: pick(local?.component, ["store", "history", "alarm", "recovery", "keepalive", "page"]),
      step: pick(local?.step, steps), browserStage: network?.events?.filter(item => !["completed", "error"].includes(item.event)).at(-1)?.event ?? null,
      correlation: network?.correlation ?? null,
      browserHttpStatus: evidenceNetwork?.httpStatus ?? null, responseHeadersAt, browserCompletedAt,
      responseHeadersAfterCancellationMs: responseHeadersAt !== null && time(request?.cancelledAt) !== null ? responseHeadersAt - request.cancelledAt : null,
      browserError: networkRecord({ error: network?.error }).error,
      cancellation: request?.cancelledBy ? cleanCode(request.cancelledBy) : errorCode === "E_API_TIMEOUT" ? "E_API_TIMEOUT" : null,
      cancelledAt: time(request?.cancelledAt), cancellationOrigin: pick(request?.cancellationOrigin, ["request-timeout", "parent"]),
      certainty: "observed-boundary", serverInternalCause: "unknown"
    };
  }
  const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const prefix = "airconErrorReport:";
  const fallbackPrefix = "airconErrorFallback:";
  const limit = 20;
  const key = id => prefix + id;
  const fallbackKey = id => fallbackPrefix + id;
  const isKey = value => value.startsWith(prefix) && identifier(value.slice(prefix.length)) !== null;
  const isFallbackKey = value => value.startsWith(fallbackPrefix) && identifier(value.slice(fallbackPrefix.length)) !== null;
  const isCacheKey = value => isKey(value) || isFallbackKey(value);
  function obsoleteKeys(data) {
    const groups = new Map();
    for (const [name, entry] of Object.entries(data)) {
      if (!isCacheKey(name) || !identifier(entry?.report?.reportId)) continue;
      const id = entry.report.reportId;
      if (name !== key(id) && name !== fallbackKey(id)) continue;
      const group = groups.get(id) ?? { at: "", keys: [] };
      const at = String(entry.report.occurredAt);
      if (at > group.at) group.at = at;
      group.keys.push(name);
      groups.set(id, group);
    }
    return [...groups.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(limit).flatMap(group => group.keys);
  }
  function manualCheck(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { trigger: ["click", "stateChange"].includes(value.trigger) ? value.trigger : "unknown", observedOn: bool(value.observedOn) };
  }
  function timingChange(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const durations = item => item ? { onMinutes: number(item.onMinutes), offMinutes: number(item.offMinutes) } : null;
    return { at: time(value.at), runId: identifier(value.runId), phase: pick(value.phase, ["on", "off"]),
      phaseStartedAt: time(value.phaseStartedAt), before: durations(value.before), requested: durations(value.requested),
      expectedRevision: tabId(value.expectedRevision), previousRevision: tabId(value.previousRevision), nextRevision: tabId(value.nextRevision),
      previousNextAt: time(value.previousNextAt), computedNextAt: time(value.computedNextAt), effectiveNextAt: time(value.effectiveNextAt),
      immediate: bool(value.immediate), outcome: pick(value.outcome, ["pending", "applied", "rejected", "unchanged", "cancelled", "failed", "unknown"]) };
  }
  function cycle(value) {
    if (!value) return null;
    return {
      runId: identifier(value.id ?? value.runId), onMinutes: number(value.onMinutes), offMinutes: number(value.offMinutes),
      tabId: tabId(value.tabId), documentId: identifier(value.documentId),
      phase: ["on", "off"].includes(value.phase) ? value.phase : null,
      expectedOn: bool(value.expectedOn), startedAt: number(value.startedAt), nextAt: number(value.nextAt),
      phaseStartedAt: time(value.phaseStartedAt), timingRevision: tabId(value.timingRevision),
      lastTimingChange: timingChange(value.lastTimingChange),
      queryRecovery: queryRecovery(value.queryRecovery),
      recovery: value.recovery ? { kind: pick(value.recovery.kind, ["authentication", "reload", "query"]), at: time(value.recovery.at), deadline: time(value.recovery.deadline), nextAttemptAt: time(value.recovery.nextAttemptAt) } : null
    };
  }
  function requestTrace(item = {}) {
    return {
        method: ["GET", "POST"].includes(item.method) ? item.method : null,
        path: paths.has(item.path) ? item.path : null,
        attempt: [1, 2].includes(item.attempt) ? item.attempt : null,
        sequence: positive(item.sequence), startedAt: positive(item.startedAt), endedAt: positive(item.endedAt),
        timeoutMs: positive(item.timeoutMs), cancelledBy: cleanCode(item.cancelledBy), cancelledAt: time(item.cancelledAt),
        cancellationOrigin: pick(item.cancellationOrigin, ["request-timeout", "parent"]),
        timings: item.timings ? Object.fromEntries(["tokenMs", "headersMs", "bodyMs", "parseMs", "validationMs", "monotonicElapsedMs", "clockDeltaMs", "timeoutOvershootMs"].map(key => [key, number(item.timings[key])])) : null,
        response: item.response ? { contentType: pick(item.response.contentType, ["json", "html", "text", "other", "unknown"]),
          contentLength: positive(item.response.contentLength), redirected: bool(item.response.redirected),
          route: pick(item.response.route, ["expected", "login", "other", "unknown"]), bodyBytes: positive(item.response.bodyBytes) } : null,
        phase: requestPhases.has(item.phase) ? item.phase : null,
        httpStatus: Number.isInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599 ? item.httpStatus : null,
        schoolCode: Number.isSafeInteger(item.schoolCode) ? item.schoolCode : null,
        elapsedMs: number(item.elapsedMs), dispatched: item.dispatched === true,
        errorCode: Object.hasOwn(messages, item.errorCode) ? item.errorCode : null
      };
  }
  function queryRecovery(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { id: identifier(value.id), initialOperationId: identifier(value.initialOperationId),
      initialFailure: value.initialFailure && typeof value.initialFailure === "object" ? {
        errorCode: value.initialFailure.errorCode == null ? null : cleanCode(value.initialFailure.errorCode),
        httpStatus: Number.isInteger(value.initialFailure.httpStatus) && value.initialFailure.httpStatus >= 100 && value.initialFailure.httpStatus <= 599 ? value.initialFailure.httpStatus : null, path: paths.has(value.initialFailure.path) ? value.initialFailure.path : null,
        sequence: positive(value.initialFailure.sequence)
      } : null,
      startedAt: time(value.startedAt), originalNextAt: time(value.originalNextAt), deadline: time(value.deadline),
      nextAttemptAt: time(value.nextAttemptAt), endedAt: time(value.endedAt), outcome: pick(value.outcome, ["waiting", "recovered", "cancelled", "stopped"]),
      rounds: (Array.isArray(value.rounds) ? value.rounds : []).slice(-4).map(item => ({
        operationId: identifier(item.operationId), scheduledAt: time(item.scheduledAt), startedAt: time(item.startedAt), endedAt: time(item.endedAt),
        waitMs: positive(item.waitMs), errorCode: cleanCode(item.errorCode), actualOn: bool(item.actualOn), timerPresent: bool(item.timerPresent),
        sent: bool(item.sent), confirmed: bool(item.confirmed), requests: (Array.isArray(item.requests) ? item.requests : []).slice(-10).map(requestTrace)
      })) };
  }
  function lifecycle(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      event: ["loading", "discarded", "closed", "navigation", "initialize", "authentication"].includes(value.event) ? value.event : "unknown",
      route: pick(value.route, routes), tabId: tabId(value.tabId), documentId: identifier(value.documentId),
      navigationType: ["navigate", "reload", "back_forward"].includes(value.navigationType) ? value.navigationType : "unknown",
      wasDiscarded: bool(value.wasDiscarded), discarded: bool(value.discarded), frozen: bool(value.frozen)
    };
  }
  function postCommandVerification(value) {
    if (!value || typeof value !== "object") return null;
    return {
      reportId: identifier(value.reportId), operationId: identifier(value.operationId), runId: identifier(value.runId),
      tabId: tabId(value.tabId), documentId: identifier(value.documentId), desiredOn: bool(value.desiredOn),
      triggerCode: cleanCode(value.triggerCode), triggerSequence: positive(value.triggerSequence),
      cancelledAt: time(value.cancelledAt), deadlineAt: time(value.deadlineAt), nextAt: time(value.nextAt), endedAt: time(value.endedAt), revision: positive(value.revision),
      state: pick(value.state, ["pending", "running", "waiting", "completed", "cancelled", "interrupted", "not_run", "expired"]),
      reason: pick(value.reason, ["two_rounds", "deadline", "user_action", "page_unavailable", "page_changed", "page_closed", "session_ended", "worker_interrupted", "storage_failure", "page_identity_missing"]),
      conclusion: pick(value.conclusion, ["target_observed", "original_observed", "changed", "unknown"]),
      rounds: (Array.isArray(value.rounds) ? value.rounds : []).slice(0, 2).map(r => ({
        operationId: identifier(r.operationId), scheduledAt: time(r.scheduledAt), startedAt: time(r.startedAt), endedAt: time(r.endedAt),
        actualOn: bool(r.actualOn), timerPresent: bool(r.timerPresent), actualOnError: cleanCode(r.actualOnError), timerPresentError: cleanCode(r.timerPresentError), errorCode: cleanCode(r.errorCode),
        requests: (Array.isArray(r.requests) ? r.requests : []).slice(0, 2).map(requestTrace)
      }))
    };
  }
  function makeReport(draft = {}, environment = {}) {
    const code = Object.hasOwn(messages, draft.error?.code) ? draft.error.code : "E_INTERNAL";
    const at = time(draft.at) ?? Date.now();
    const startedAt = time(draft.startedAt) ?? at;
    const last = draft.lastConfirmedStatus ?? draft.run?.lastConfirmedStatus;
    const agent = String(environment.userAgent ?? "");
    const browserMatch = agent.match(/(Edg)\/([\d.]{1,24})/) || agent.match(/(Chrome|Firefox)\/([\d.]{1,24})/);
    // Never serialize arbitrary error messages, stacks, bodies, or headers.
    const locationPattern = /\b(?:cycle|background|api-client|errors|reports|report-directory|content|report-settings|diagnostics|history)\.js:\d{1,7}:\d{1,7}\b/g;
    const stackLocations = [...String(draft.error?.stack ?? (Array.isArray(draft.error?.stackLocations) ? draft.error.stackLocations.join("\n") : "")).matchAll(locationPattern)].slice(0, 8).map(match => match[0]);
    return {
      schemaVersion: 1, reportId: identifier(draft.reportId) ?? newId(), occurredAt: new Date(at).toISOString(),
      extensionVersion: /^\d{1,5}(\.\d{1,5}){1,3}$/.test(environment.version) ? environment.version : "unknown",
      browserVersion: browserMatch ? `${browserMatch[1]}/${browserMatch[2]}` : "unknown",
      source: sources.has(draft.source) ? draft.source : "getState",
      recovered: bool(draft.recovered),
      snapshotOrigin: draft.snapshotOrigin === "page-cache" ? "page-cache" : "background",
      outcomeUnknown: draft.outcomeUnknown === true,
      error: { code, message: messages[code], stackLocations },
      operation: { startedAt, elapsedMs: Math.max(0, at - startedAt), queuedAt: positive(draft.queuedAt), executionStartedAt: positive(draft.executionStartedAt),
        originalOperationId: identifier(draft.originalOperationId),
        queueWaitMs: positive(draft.queuedAt) !== null && positive(draft.executionStartedAt) !== null ? Math.max(0, draft.executionStartedAt - draft.queuedAt) : null },
      communication: draft.communication ? {
        messageType: messageTypes.has(draft.communication.messageType) ? draft.communication.messageType : null,
        reason: communicationReasons.has(draft.communication.reason) ? draft.communication.reason : "UNKNOWN",
        sourcePage: sourcePages.has(draft.communication.sourcePage) ? draft.communication.sourcePage : null,
        tabIsHome: bool(draft.communication.tabIsHome)
      } : null,
      manualCheck: manualCheck(draft.manualCheck),
      lifecycle: lifecycle(draft.lifecycle ?? draft.run?.lifecycle),
      diagnostics: diagnostics(draft.diagnostics),
      faultBoundary: faultBoundary(draft, code),
      queryRecovery: queryRecovery(draft.queryRecovery ?? draft.run?.queryRecovery),
      postCommandVerification: postCommandVerification(draft.postCommandVerification),
      cycle: cycle(draft.run),
      requestedDurations: draft.durations ? { onMinutes: number(draft.durations.onMinutes), offMinutes: number(draft.durations.offMinutes) } : null,
      timingChange: timingChange(draft.timingChange ?? draft.run?.lastTimingChange),
      lastConfirmedStatus: { value: bool(last?.value), at: number(last?.at) },
      requests: (Array.isArray(draft.requests) ? draft.requests : []).slice(-10).map(requestTrace),
      switchCommand: draft.command ? { desiredOn: bool(draft.command.desiredOn), sent: draft.command.sent === true, confirmed: draft.command.confirmed === true } : null,
      page: {
        path: "/njggt/app/home", cachedAt: number(draft.cachedAt),
        visibility: ["visible", "hidden"].includes(draft.visibility) ? draft.visibility : "unknown"
      }
    };
  }
  function fileName(report) {
    // The operation start time is stable across page/backend observations.
    const stamp = new Date(report.operation.startedAt).toISOString().replace(/[:.]/g, "-");
    return `aircon-error-${stamp}-${report.reportId}.json`;
  }
  globalThis.AirconReportFormat = Object.freeze({ makeReport, postCommandVerification, queryRecovery, requestTrace, mergeDiagnostics, cycle, manualCheck, lifecycle, pageEvidence, pageRoute, pageResponse, traceEvent, resourceTiming, networkRecord, diagnostics, observedPath, newId, identifier, key, isKey, fallbackKey, isFallbackKey, isCacheKey, obsoleteKeys, fileName, limit });
})();
