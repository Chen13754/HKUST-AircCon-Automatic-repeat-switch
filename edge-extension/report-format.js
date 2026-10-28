// Shared by the isolated content script and the extension's ES modules.
(() => {
  const messages = {
    E_HTTP: "学校接口返回错误 HTTP 状态。", E_NETWORK: "网络请求失败。",
    E_AUTH: "认证或访问权限异常。", E_API_TIMEOUT: "学校接口请求超时。",
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
    E_OTHER_TAB: "循环在另一标签页运行。", E_NATIVE_TIMER: "学校原有定时器仍生效。", E_PAGE_CONTROL: "网页原生操作已取消自动恢复。",
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
  const requestSequence = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const businessCategories = ["authentication", "access-restricted", "balance", "rate-limit", "device-unavailable", "reported-timeout", "service-error", "unknown"];
  function businessCategory(text, code) {
    if ([4031, 4032].includes(code) || /(?:login|session|token).{0,24}(?:expired|invalid)|登录.{0,10}(?:失效|过期)/i.test(text)) return "authentication";
    for (const [category, pattern] of [
      ["balance", /insufficient.{0,15}(?:balance|credit)|余额不足|欠费/i],
      ["rate-limit", /too (?:many|frequent)|rate.?limit|频繁|限流/i],
      ["device-unavailable", /device.{0,20}(?:offline|unavailable|busy)|设备.{0,12}(?:离线|不可用|忙)/i],
      ["reported-timeout", /tim(?:e[ -]?out|ed out)|超时/i],
      ["access-restricted", /permission|access denied|forbidden|权限|无权/i],
      ["service-error", /internal.{0,12}(?:error|exception)|server error|服务.{0,10}(?:异常|错误)/i]
    ]) if (pattern.test(text)) return category;
    return "unknown";
  }
  function businessError(value) {
    if (!value || typeof value !== "object") return null;
    const code = Number.isSafeInteger(value.code) ? value.code : null;
    const source = pick(value.source, ["meta.message", "data.ac_toggle.Message"]);
    let text = typeof value.text === "string" ? value.text : null;
    let omissionReason = pick(value.omissionReason, ["missing", "too-long", "sensitive", "unsafe-format"]);
    let category = businessCategories.includes(value.category) && text === null ? value.category : businessCategory(text !== null && text.length <= 512 ? text : "", code);
    if (text === null || !text.trim()) { text = null; omissionReason ??= "missing"; }
    else if (text.length > 512) { text = null; omissionReason = "too-long"; category = businessCategory("", code); }
    else if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/u.test(text)) { text = null; omissionReason = "unsafe-format"; }
    else if (/(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\beyJ[A-Za-z0-9_-]+\.|\b\d{1,3}(?:\.\d{1,3}){3}\b|\+?\d[\d ()-]{6,}\d|bearer\s+\S+|\bSECRET\b|(?:token|cookie|session|password|secret|ticket|authorization|密钥|密码)\s*[:=]|(?:user(?:name)?|student(?:[ _-]?id)?|account|学号|姓名|账号)\s*[:=#\w\u4e00-\u9fff])/iu.test(text)) { text = null; omissionReason = "sensitive"; }
    else { text = [...text.trim().replace(/\s+/gu, " ")].slice(0, 160).join(""); omissionReason = null; category = businessCategory(text, code); }
    return { code, source, category, text, omissionReason };
  }
  function extractBusinessError(value, path, method) {
    const rejected = value?.meta?.code !== 200;
    const switchRejected = method === "POST" && path === "/app/prepaid/toggle-status" && value?.data?.ac_toggle?.Message !== "Execution succeeded";
    if (!rejected && !switchRejected) return null;
    const source = rejected && typeof value?.meta?.message === "string" && value.meta.message.trim() ? "meta.message"
      : typeof value?.data?.ac_toggle?.Message === "string" ? "data.ac_toggle.Message" : "meta.message";
    return businessError({ code: value?.meta?.code, source, text: source === "meta.message" ? value?.meta?.message : value?.data?.ac_toggle?.Message });
  }
  function causalRequest(draft, code) {
    const candidates = (draft.requests ?? []).filter(r => r.errorCode === code);
    const exact = requestSequence(draft.error?.requestSequence);
    const matches = exact !== null ? candidates.filter(r => r.sequence === exact) : candidates;
    return matches.length === 1 ? matches[0] : null;
  }
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
      cancellationRequested: bool(value.cancellationRequested), queueInvalidated: bool(value.queueInvalidated), abortApplied: bool(value.abortApplied),
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
      switchAccepted: bool(value.switchAccepted), actualOn: bool(value.actualOn),
      timerPresent: bool(value.timerPresent), businessError: businessError(value.businessError),
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
    const request = causalRequest(draft, errorCode);
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
        actualOn: bool(item.actualOn), timerPresent: bool(item.timerPresent), switchAccepted: bool(item.switchAccepted), businessError: businessError(item.businessError),
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
      policyVersion: value.policyVersion === 2 ? 2 : null,
      attemptTimes: (Array.isArray(value.attemptTimes) ? value.attemptTimes : []).slice(0, 5).map(time),
      nextSlot: Number.isInteger(value.nextSlot) && value.nextSlot >= 0 && value.nextSlot <= 5 ? value.nextSlot : null,
      skippedAttempts: (Array.isArray(value.skippedAttempts) ? [...new Set(value.skippedAttempts)] : []).filter(i => Number.isInteger(i) && i >= 0 && i < 5).slice(0, 5),
      stopReason: pick(value.stopReason, ["page-control"]),
      nextAttemptAt: time(value.nextAttemptAt), endedAt: time(value.endedAt), outcome: pick(value.outcome, ["waiting", "recovered", "cancelled", "stopped"]),
      rounds: (Array.isArray(value.rounds) ? value.rounds : []).slice(-6).map(item => ({
        operationId: identifier(item.operationId), scheduledAt: time(item.scheduledAt), startedAt: time(item.startedAt), endedAt: time(item.endedAt),
        outcome: pick(item.outcome, ["completed", "interrupted"]),
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
      failureRequestSequence: requestSequence(value.failureRequestSequence), triggeredAt: time(value.triggeredAt),
      cancelledAt: time(value.cancelledAt), deadlineAt: time(value.deadlineAt), nextAt: time(value.nextAt), endedAt: time(value.endedAt), revision: positive(value.revision),
      state: pick(value.state, ["pending", "running", "waiting", "completed", "cancelled", "interrupted", "not_run", "expired"]),
      reason: pick(value.reason, ["two_rounds", "deadline", "user_action", "page_control", "authentication", "insufficient_evidence", "page_unavailable", "page_changed", "page_closed", "session_ended", "worker_interrupted", "storage_failure", "page_identity_missing"]),
      conclusion: pick(value.conclusion, ["target_observed", "original_observed", "changed", "unknown"]),
      rounds: (Array.isArray(value.rounds) ? value.rounds : []).slice(0, 2).map(r => ({
        operationId: identifier(r.operationId), scheduledAt: time(r.scheduledAt), startedAt: time(r.startedAt), endedAt: time(r.endedAt),
        actualOn: bool(r.actualOn), timerPresent: bool(r.timerPresent), actualOnError: cleanCode(r.actualOnError), timerPresentError: cleanCode(r.timerPresentError), errorCode: cleanCode(r.errorCode),
        requests: (Array.isArray(r.requests) ? r.requests : []).slice(0, 2).map(requestTrace)
      }))
    };
  }
  function incidentFollowup(value) {
    if (!value || typeof value !== "object") return null;
    const observation = item => item ? { ...pageResponse(item), id: identifier(item.id), error: networkRecord(item).error, pageEndedAt: time(item.pageEndedAt),
      evidenceSource: pick(item.evidenceSource, ["browser", "page-observer"]),
      sinceFailureMs: number(item.startedAt) !== null && number(value.failureStartedAt) !== null ? item.startedAt - value.failureStartedAt : null,
      sameDocument: item.documentId && value.documentId ? item.documentId === value.documentId : null } : null;
    return { reportId: identifier(value.reportId), runId: identifier(value.runId), tabId: tabId(value.tabId), documentId: identifier(value.documentId),
      revision: positive(value.revision), startedAt: time(value.startedAt), deadlineAt: time(value.deadlineAt), endedAt: time(value.endedAt),
      failurePath: paths.has(value.failurePath) ? value.failurePath : null, failureStartedAt: time(value.failureStartedAt),
      state: pick(value.state, ["observing", "ended"]), reason: pick(value.reason, ["expired", "new-cycle", "closed", "session-ended", "superseded", "storage-failure"]),
      conclusion: pick(value.conclusion, ["same-endpoint-discrepancy", "endpoint-later-recovered", "switch-only-success", "unknown"]), serverInternalCause: "unknown",
      coverage: { observerReady: bool(value.coverage?.observerReady), receivedCount: positive(value.coverage?.receivedCount),
        lastResponseAt: time(value.coverage?.lastResponseAt), browserCompletions: positive(value.coverage?.browserCompletions),
        businessEvidenceMissing: bool(value.coverage?.businessEvidenceMissing) },
      switches: (Array.isArray(value.switches) ? value.switches : []).slice(-4).map(s => ({ ...observation(s), statusAfter: observation(s.statusAfter) })),
      queries: (Array.isArray(value.queries) ? value.queries : []).slice(-4).map(q => ({ ...observation(q), role: pick(q.role, ["first-success", "latest"]) })) };
  }
  function diagnosis(report) {
    const code = report.error.code, request = causalRequest(report, code);
    const ref = { operationId: request ? report.operation.originalOperationId ?? report.reportId : report.reportId, requestSequence: requestSequence(request?.sequence), browserRequestId: report.faultBoundary?.browserRequestId ?? null };
    const facts = [], hypotheses = [], missingEvidence = [];
    const fact = (text, evidence = ref) => { if (facts.length < 6) facts.push({ confidence: "confirmed", text, evidence: { ...evidence } }); };
    let category = "unknown", actions = ["在学校页面确认实际状态，再决定是否手动开始。"];
    if (/^E_BACKGROUND_|E_MESSAGE_SOURCE/.test(code)) {
      category = "communication"; actions = ["检查扩展是否仍启用，并重新读取状态。", "控制消息没有回执时，先确认实际状态，不要重复提交。"];
      if (["aircon:getState", "aircon:manualCheck", "aircon:openReportSettings"].includes(report.communication?.messageType)) actions = ["本次是只读消息失败，请重新读取状态；不要清除先前已存在的未知开关警告。"];
    } else if (["E_API_REJECTED", "E_SWITCH_REJECTED"].includes(code)) {
      category = "business-rejection"; actions = ["查看学校业务说明，并在学校页面核对实际状态。", "没有确认开关结果时不要重发指令。"];
    } else if (["E_AUTH", "E_AUTH_RECOVERED"].includes(code)) {
      category = "authentication-or-access"; actions = ["在学校页面核对登录和访问权限；确认状态后再手动开始。"];
    } else if (code === "E_HTTP") {
      category = "http-response"; actions = ["等待接口恢复，或检查学校网页同一接口是否也失败。", "HTTP 状态不能单独确定学校后台或代理链路的根因。"];
    } else if (code === "E_NETWORK") {
      category = "connection"; actions = ["检查同一时段学校网页请求和浏览器网络错误。", "开关结果未知时不要重复发送。"];
    } else if (["E_API_TIMEOUT", "E_OPERATION_TIMEOUT", "E_TIMEOUT", "E_QUERY_RECOVERY_TIMEOUT"].includes(code)) {
      category = "timeout"; actions = ["按响应头、正文、排队和操作期限区分超时阶段。", "参考后续只读核验；未确认的开关指令不可重发。"];
    } else if (["E_JSON", "E_STATUS_FORMAT", "E_TIMER_FORMAT"].includes(code)) {
      category = "response-format"; actions = ["检查响应类型、重定向线索及学校页面是否更新。", "不要以 HTTP 200 代替业务成功。"];
    } else if (["E_STATUS_CHANGED", "E_STATUS_UNCONFIRMED", "E_NATIVE_TIMER", "E_PAGE_CONTROL"].includes(code)) {
      category = "state-or-timer"; actions = ["核对学校定时器及手机、其他页面是否操作过空调。", "后续观察不能证明原指令执行成功。"];
    } else if (/^E_ALARM_/.test(code)) {
      category = "scheduling"; actions = ["核对闹钟送达、排队时间及电脑是否保持唤醒。", "确认状态后手动开始，不补跳错过的阶段。"];
    } else if (["E_LOCAL_STORAGE", "E_LOCAL_TIMEOUT", "E_SCHEDULE"].includes(code) || report.source === "cleanup") {
      category = "control-storage"; actions = ["关键控制记录保存失败时，确认实际状态并重新加载扩展。", "仅报告目录保存失败时，重新授权报告目录；不要据此重复开关。"];
      if (["keepAlive", "keepAliveSchedule"].includes(report.source)) { category = "auxiliary-storage"; actions = ["核对保活保存或闹钟状态；保活警告本身不表示主循环已经停止。"];
      }
    } else if (/^E_PAGE_|^E_SESSION_|^E_COMMAND_UNKNOWN$|^E_CYCLE_INTERRUPTED$|^E_START_INTERRUPTED$|^E_RECOVERY_TIMEOUT$/.test(code)) {
      category = "page-or-session"; actions = ["核对本标签页的导航、文档和后台事件。", "会话结束后确认实际状态，再手动启用。"];
    } else if (["E_TIMING_STALE", "E_TIMING_UNAVAILABLE", "E_DURATION", "E_ALREADY_RUNNING", "E_OTHER_TAB"].includes(code)) {
      category = "request-validation"; actions = ["核对当前循环及输入，本次请求未获应用时不要认为参数已经生效。"];
    } else if (code === "E_CANCELLED") category = "cancellation";
    fact(`记录的错误为 ${code}。`);
    if (request) {
      fact(`失败关联请求：${request.method ?? "未知方法"} ${request.path ?? "未知接口"}，阶段 ${request.phase ?? "未知"}。`);
      if (request.httpStatus != null) fact(`收到 HTTP ${request.httpStatus}。`);
      if (request.schoolCode != null) fact(`学校 JSON 业务码为 ${request.schoolCode}；它与 HTTP 状态分别记录。`);
      if (request.cancelledBy) fact(`请求取消原因 ${request.cancelledBy}，来源 ${request.cancellationOrigin ?? "未知"}。`);
    } else if (["E_HTTP", "E_NETWORK", "E_API_TIMEOUT", "E_API_REJECTED", "E_SWITCH_REJECTED", "E_AUTH", "E_JSON", "E_STATUS_FORMAT", "E_TIMER_FORMAT"].includes(code)) missingEvidence.push("未能唯一关联失败请求；不借用其他请求的错误。");
    if (["E_STATUS_UNCONFIRMED", "E_STATUS_CHANGED"].includes(code)) {
      const observed = report.requests.filter(r => r.path === "/app/prepaid/ac-status" && typeof r.actualOn === "boolean").at(-1);
      if (observed) fact(`最后状态读取为 ${observed.actualOn}，目标为 ${typeof report.switchCommand?.desiredOn === "boolean" ? report.switchCommand.desiredOn : report.cycle?.expectedOn ?? "未知"}。`, { ...ref, requestSequence: observed.sequence });
      else missingEvidence.push("未保存可定位到单次读取的实际状态摘要。");
    }
    if (report.switchCommand) fact(`开关指令：已发送=${report.switchCommand.sent}，已确认=${report.switchCommand.confirmed}。`);
    if (report.businessError) {
      const b = report.businessError;
      if (b.text) hypotheses.push({ confidence: "clue", text: `学校返回说明：${b.text}`, evidence: { ...ref } });
      else missingEvidence.push(`业务说明未保留：${b.omissionReason ?? "未知"}。`);
      if (b.category === "balance") actions.unshift("在学校页面检查余额及欠费状态。");
      if (b.category === "rate-limit") actions.unshift("避免连续手动开关，待学校限制解除后再确认状态。");
      if (b.category === "device-unavailable") actions.unshift("在学校页面检查设备状态，必要时向学校报修。");
    } else if (category === "business-rejection") missingEvidence.push("该报告没有可用的业务说明。");
    if (request?.timings?.clockDeltaMs != null && Math.abs(request.timings.clockDeltaMs) > 1000) hypotheses.push({ confidence: "clue", text: "墙上时间与单调时钟差异超过一秒，需核对时钟变化。", evidence: { ...ref } });
    if (report.postCommandVerification) fact(`后续只读核验：${report.postCommandVerification.state ?? "未知"}，观察结论 ${report.postCommandVerification.conclusion ?? "未知"}。`);
    else if (report.outcomeUnknown) missingEvidence.push("没有后续主动核验记录；不能据此推断开关结果。");
    if (report.incidentFollowup) hypotheses.push({ confidence: "clue", text: `被动网页旁证：${report.incidentFollowup.conclusion ?? "unknown"}；仅表示观察线索。`, evidence: { ...ref } });
    if (!report.diagnostics?.coverage.webRequest) missingEvidence.push("浏览器网络观察不可用或未知。");
    hypotheses.push({ confidence: "unknown", text: "学校服务器或设备内部原因未被独立验证。", evidence: { ...ref } });
    return { rulesVersion: 1, category, facts, hypotheses: hypotheses.slice(0, 4), missingEvidence: missingEvidence.slice(0, 6), actions: actions.slice(0, 3), serverInternalCause: "unknown" };
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
    const report = {
      schemaVersion: 1, reportId: identifier(draft.reportId) ?? newId(), occurredAt: new Date(at).toISOString(),
      extensionVersion: /^\d{1,5}(\.\d{1,5}){1,3}$/.test(environment.version) ? environment.version : "unknown",
      browserVersion: browserMatch ? `${browserMatch[1]}/${browserMatch[2]}` : "unknown",
      source: sources.has(draft.source) ? draft.source : "getState",
      recovered: bool(draft.recovered),
      snapshotOrigin: draft.snapshotOrigin === "page-cache" ? "page-cache" : "background",
      outcomeUnknown: draft.outcomeUnknown === true,
      error: { code, message: messages[code], requestSequence: requestSequence(draft.error?.requestSequence), stackLocations },
      businessError: businessError(causalRequest(draft, code)?.businessError),
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
      incidentFollowup: incidentFollowup(draft.incidentFollowup),
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
    report.diagnosis = diagnosis(report);
    return report;
  }
  function fileName(report) {
    // The operation start time is stable across page/backend observations.
    const stamp = new Date(report.operation.startedAt).toISOString().replace(/[:.]/g, "-");
    return `aircon-error-${stamp}-${report.reportId}.json`;
  }
  globalThis.AirconReportFormat = Object.freeze({ makeReport, businessError, extractBusinessError, incidentFollowup, postCommandVerification, queryRecovery, requestTrace, mergeDiagnostics, cycle, manualCheck, lifecycle, pageEvidence, pageRoute, pageResponse, traceEvent, resourceTiming, networkRecord, diagnostics, observedPath, newId, identifier, key, isKey, fallbackKey, isFallbackKey, isCacheKey, obsoleteKeys, fileName, limit });
})();
