(() => {
  const HOME_PATH = "/njggt/app/home";
  const PANEL_ID = "hkust-ac-cycle-panel";
  const OPERATION_REPLY_TIMEOUT_MS = 35_000;
  const communicationMessages = {
    E_BACKGROUND_NO_RECEIVER: "浏览器报告找不到扩展消息接收端。",
    E_BACKGROUND_DISCONNECTED: "扩展通信通道在回复前关闭，操作可能已经执行。",
    E_BACKGROUND_EMPTY_REPLY: "扩展后台返回空回复，未收到有效结果。",
    E_BACKGROUND_INVALID_REPLY: "扩展后台回复格式不完整或无效。",
    E_BACKGROUND_UNAVAILABLE: "扩展后台无法响应，原因未识别。"
  };
  const communicationCodes = new Set([...Object.keys(communicationMessages), "E_BACKGROUND_TIMEOUT"]);
  // Match only known browser messages; never save arbitrary exception text.
  const browserFailures = new Map([
    ["Could not establish connection. Receiving end does not exist", ["E_BACKGROUND_NO_RECEIVER", "NO_RECEIVER"]],
    ["The message port closed before a response was received", ["E_BACKGROUND_DISCONNECTED", "PORT_CLOSED"]],
    ["A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received", ["E_BACKGROUND_DISCONNECTED", "CHANNEL_CLOSED"]],
    ["Extension context invalidated", ["E_BACKGROUND_UNAVAILABLE", "CONTEXT_INVALIDATED"]]
  ]);
  let panel = null;
  let card = null;
  let ui;
  let view = { run: null, elsewhere: false, notice: null };
  let busy = false;
  let busyType = null;
  let draftValues = null;
  let draftEdited = false;
  let draftRunId = null;
  let busySince = 0;
  let actionId = 0;
  let uncertain = false;
  let localError = "";
  let localErrorSource = "";
  let readId = 0;
  let initialization = Promise.resolve({ ok: true });
  let manualCheckTimer = null;
  let pendingManualCheck = null;
  let initialLoad = true;
  let loading = false;
  let returnCheckPending = false;
  let cachedAt = null;
  let reportStatus = { phase: "loading", pending: 0 };
  const pageEvents = [], pageResources = [];

  function pageEvidence() {
    try { return collectPageEvidence(); } catch { return null; }
  }

  function collectPageEvidence() {
    let loginAgeMs = null, tokenPresent = null;
    try {
      const student = JSON.parse(localStorage.getItem("ggt_student") || "null");
      tokenPresent = typeof student?.token === "string" && Boolean(student.token);
      const lastLogin = Date.parse(student?.last_login);
      if (Number.isFinite(lastLogin)) loginAgeMs = Math.max(0, Date.now() - lastLogin);
    } catch { /* Do not serialize the login record. */ }
    const scripts = [];
    for (const script of document.scripts ?? []) {
      try { scripts.push(new URL(script.src).pathname.split("/").at(-1)); } catch { /* Not a URL. */ }
    }
    const nativeSwitch = card?.querySelector?.('button[role="switch"]');
    const displayed = nativeSwitch?.getAttribute?.("aria-checked");
    return globalThis.AirconReportFormat.pageEvidence({ at: Date.now(), contentObservedAt: Date.now(), route: globalThis.AirconReportFormat.pageRoute(location.href), responseObserver: globalThis.AirconObserverReady === true,
      visibility: document.visibilityState, online: globalThis.navigator?.onLine, wasDiscarded: document.wasDiscarded,
      observedOn: displayed === "true" ? true : displayed === "false" ? false : null,
      navigationType: globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.type,
      documentStartedAt: globalThis.performance?.timeOrigin, loginAgeMs, tokenPresent, scripts });
  }

  function telemetry(step, resources = [], detail = {}) {
    pageEvents.push(globalThis.AirconReportFormat.traceEvent({ at: Date.now(), component: "page", step, outcome: "ok", ...detail }));
    if (pageEvents.length > 32) pageEvents.shift();
    try {
      Promise.resolve(chrome.runtime.sendMessage({ type: "aircon:telemetry", step, evidence: pageEvidence(), resources, detail: globalThis.AirconReportFormat.traceEvent(detail) })).catch(() => {});
    } catch { /* Context invalidation must not recursively trigger telemetry. */ }
  }

  if (typeof globalThis.addEventListener === "function") {
    for (const type of ["online", "offline", "pagehide", "pageshow"]) globalThis.addEventListener(type, () => telemetry(type));
    for (const type of ["freeze", "resume"]) document.addEventListener(type, () => telemetry(type));
    document.addEventListener("visibilitychange", () => telemetry("visibility"));
    globalThis.addEventListener("error", event => {
      let script;
      try { script = new URL(event.filename).pathname.split("/").at(-1); } catch { /* No script name. */ }
      telemetry("scriptError", [], { script, line: event.lineno, column: event.colno });
    });
    globalThis.addEventListener("unhandledrejection", () => telemetry("promiseRejection"));
  }
  try {
    const observer = new PerformanceObserver(list => {
      const resources = list.getEntries().filter(entry => globalThis.AirconReportFormat.observedPath(entry.name)).slice(-16).map(entry => {
        const available = entry.requestStart > 0 && entry.responseStart > 0;
        const delta = (end, start) => available && start > 0 && end >= start ? end - start : null;
        return { url: `https://w5.ab.ust.hk/njggt/api${globalThis.AirconReportFormat.observedPath(entry.name)}`, timing: globalThis.AirconReportFormat.resourceTiming({ startedAt: performance.timeOrigin + entry.startTime, durationMs: entry.duration, detailsAvailable: available,
          dnsMs: delta(entry.domainLookupEnd, entry.domainLookupStart), connectMs: delta(entry.connectEnd, entry.connectStart), tlsMs: delta(entry.connectEnd, entry.secureConnectionStart),
          waitMs: delta(entry.responseStart, entry.requestStart), downloadMs: delta(entry.responseEnd, entry.responseStart), protocol: entry.nextHopProtocol }) };
      });
      if (!resources.length) return;
      pageResources.push(...resources.map(entry => globalThis.AirconReportFormat.networkRecord({ owner: "page", path: globalThis.AirconReportFormat.observedPath(entry.url), timing: entry.timing })));
      pageResources.splice(0, Math.max(0, pageResources.length - 16));
      telemetry("resource", resources);
    });
    observer.observe({ type: "resource", buffered: true });
  } catch { /* Resource Timing is best effort. */ }

  function cacheCommunicationError(error, reportId, startedAt, messageType, durations, manualCheck, timingRequest) {
    try {
      const format = globalThis.AirconReportFormat;
      const report = format.makeReport({
        reportId, startedAt, source: "pageCommunication", error,
        run: view.run, snapshotOrigin: "page-cache", outcomeUnknown: true,
        cachedAt, visibility: document.visibilityState, durations, manualCheck,
        timingChange: timingRequest ? { at: startedAt, runId: timingRequest.runId, expectedRevision: timingRequest.timingRevision,
          requested: durations, before: view.run ? { onMinutes: view.run.onMinutes, offMinutes: view.run.offMinutes } : null,
          phase: view.run?.phase, phaseStartedAt: view.run?.phaseStartedAt, previousNextAt: view.run?.nextAt, outcome: "unknown" } : undefined,
        diagnostics: { coverage: { journal: "unavailable" }, site: pageEvidence(), events: pageEvents, network: pageResources },
        communication: { messageType, reason: error.communicationReason, tabIsHome: isHome() }
      }, { version: chrome.runtime.getManifest?.().version ?? "1.1.17", userAgent: globalThis.navigator?.userAgent });
      chrome.storage.local.set({ [format.fallbackKey(report.reportId)]: { report, saved: false } }).then(async () => {
        reportStatus = { phase: "cached", pending: 1 };
        render();
        const old = format.obsoleteKeys(await chrome.storage.local.get(null));
        if (old.length) await chrome.storage.local.remove(old);
      }).catch(() => { reportStatus = { phase: "storage-error", pending: 0 }; render(); });
    } catch { reportStatus = { phase: "storage-error", pending: 0 }; render(); }
  }

  function isHome() { return location.pathname.replace(/\/$/, "") === HOME_PATH; }

  function findCard() {
    if (!isHome()) return null;
    const label = [...document.querySelectorAll("small")]
      .find(element => element.textContent?.trim() === "Air Conditioning Status");
    return label?.closest(".ui.segment") ?? null;
  }

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function inputRow(labelText, name) {
    const label = element("label", "ac-cycle-field");
    const caption = element("span", "", labelText);
    const input = element("input");
    input.type = "number";
    input.name = name;
    input.min = "1";
    input.max = "1440";
    input.step = "1";
    input.required = true;
    input.inputMode = "numeric";
    const control = element("span", "ac-cycle-input");
    const unit = element("span", "ac-cycle-unit", "分钟");
    unit.setAttribute("aria-hidden", "true");
    input.setAttribute("aria-label", `${labelText}时长（分钟）`);
    control.append(input, unit);
    label.append(caption, control);
    return label;
  }

  function communicationFailure(code, communicationReason) {
    return { ok: false, code, communicationReason,
      error: `[${code}] ${communicationMessages[code]}结果未确认，请停止循环或刷新页面。` };
  }

  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  function validReply(result) {
    if (!object(result) || typeof result.ok !== "boolean") return false;
    if (result.blocked !== undefined && typeof result.blocked !== "boolean") return false;
    if (!result.ok) return typeof result.code === "string" && Boolean(result.code) && typeof result.error === "string" && Boolean(result.error);
    const state = result.view;
    return object(state) && typeof state.elsewhere === "boolean"
      && (state.blocked === undefined || typeof state.blocked === "boolean")
      && (state.run === null || (object(state.run) && ["on", "off"].includes(state.run.phase) && Number.isFinite(state.run.nextAt)))
      && (state.notice === null || (object(state.notice) && typeof state.notice.text === "string"))
      && (state.reports === undefined || object(state.reports));
  }

  async function send(type, data = {}, timeoutMs) {
    let timer;
    let result;
    const reportId = globalThis.AirconReportFormat.newId();
    const startedAt = Date.now();
    const currentAction = actionId;
    const ms = timeoutMs ?? (type === "aircon:getState" ? 5000 : OPERATION_REPLY_TIMEOUT_MS);
    try {
      result = await Promise.race([
        chrome.runtime.sendMessage({ type, ...data, reportId, startedAt }),
        new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, code: "E_BACKGROUND_TIMEOUT", communicationReason: "TIMEOUT", error: `[E_BACKGROUND_TIMEOUT] ${type} 等待后台超过 ${ms / 1000} 秒；结果未确认，请停止循环或刷新页面。` }), ms); })
      ]);
      if (result == null) result = communicationFailure("E_BACKGROUND_EMPTY_REPLY", result === null ? "NULL_REPLY" : "UNDEFINED_REPLY");
      else if (!validReply(result)) result = communicationFailure("E_BACKGROUND_INVALID_REPLY", "INVALID_REPLY");
    } catch (error) {
      const message = typeof error?.message === "string" ? error.message : typeof error === "string" ? error : "";
      const [code, reason] = browserFailures.get(message.replace(/\.$/, "")) ?? ["E_BACKGROUND_UNAVAILABLE", "UNKNOWN"];
      result = communicationFailure(code, reason);
    }
    finally { clearTimeout(timer); }
    if (currentAction === actionId && communicationCodes.has(result.code) && !globalThis.AirconReportFormat.identifier(result.reportId)) {
      result.reportId = reportId;
      cacheCommunicationError(result, reportId, startedAt, type, ["aircon:start", "aircon:updateDurations"].includes(type) ? data : undefined,
        type === "aircon:manualCheck" ? data : undefined, type === "aircon:updateDurations" ? data : undefined);
    }
    return result;
  }

  async function readView(type = "aircon:getState", timeoutMs, data = {}) {
    const currentAction = actionId;
    const currentRead = ++readId;
    const result = await send(type, data, timeoutMs);
    if (currentAction === actionId && currentRead === readId) {
      if (result.ok) {
        view = result.view;
        cachedAt = Date.now();
        if (view.reports) reportStatus = view.reports;
        if (localErrorSource === "read") localError = "";
      } else {
        if (result.blocked === true) view = { ...view, blocked: true };
        localError = result.error; localErrorSource = "read";
      }
      render();
    }
    return result;
  }
  const refresh = () => { if (isHome()) return readView(); };

  function initializeView(lifecycle = { event: "initialize" }) {
    if (loading) { returnCheckPending = true; return initialization; }
    loading = true; render();
    initialization = readView("aircon:initialize", undefined, { lifecycle, evidence: pageEvidence() }).then(result => {
      loading = false; render();
      const needsCheck = returnCheckPending && isHome() && (!result.ok || result.view?.run?.recovery);
      returnCheckPending = false;
      return needsCheck ? initializeView(lifecycle) : result;
    }, error => { loading = false; returnCheckPending = false; render(); throw error; });
    return initialization;
  }

  function setText(item, text) {
    if (item.textContent !== text) item.textContent = text;
  }

  function formatRemaining(nextAt) {
    const seconds = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function render() {
    if (!panel?.isConnected) return;
    const run = view.run;
    if (pendingManualCheck && pendingManualCheck.runId !== run?.id) cancelManualCheck();
    const { start, stop, update, inputs, status, message } = ui;
    if (run && (!draftEdited || (draftRunId && draftRunId !== run.id))) {
      draftValues = [run.onMinutes ?? 10, run.offMinutes ?? 10].map(String);
      draftEdited = false;
    }
    if (run) draftRunId = run.id;
    if (draftValues) inputs.forEach((input, index) => { if (String(input.value) !== draftValues[index]) input.value = draftValues[index]; });
    const focused = document.activeElement;
    const needsConfirmation = uncertain || view.notice?.outcomeUnknown === true;
    const inputDisabled = Boolean(view.blocked || loading || busy || needsConfirmation || run?.recovery || view.elsewhere);
    const disabled = inputDisabled || Boolean(run);
    for (const input of inputs) if (input.disabled !== inputDisabled) input.disabled = inputDisabled;
    if (start.disabled !== disabled) start.disabled = disabled;
    const values = inputs.map(input => Number(input.value));
    const valid = values.every(value => Number.isInteger(value) && value >= 1 && value <= 1440);
    const dirty = Boolean(run && (values[0] !== run.onMinutes || values[1] !== run.offMinutes));
    update.hidden = !run;
    update.disabled = !run || inputDisabled || !dirty || !valid;
    setText(update, busy && busyType === "aircon:updateDurations" ? "应用中…" : "应用修改");
    ui.timingHint.hidden = !dirty;
    if (dirty) {
      const origin = run.phaseStartedAt ?? (run.nextAt - (run.phase === "on" ? run.onMinutes : run.offMinutes) * 60_000);
      const nextAt = origin + values[run.phase === "on" ? 0 : 1] * 60_000;
      setText(ui.timingHint, !valid ? "尚未应用：请输入 1–1440 分钟的整数。" : `尚未应用：当前仍为开 ${run.onMinutes}／关 ${run.offMinutes} 分钟。${nextAt <= Date.now() ? `应用后将立即核验并${run.phase === "on" ? "关机" : "开机"}。` : `应用后当前阶段约剩 ${formatRemaining(nextAt)}。`}`);
    }
    const stopDisabled = view.elsewhere || (!view.blocked && !loading && !busy && !run && !needsConfirmation);
    if (stop.disabled !== stopDisabled) stop.disabled = stopDisabled;
    start.hidden = Boolean(run) && (!busy || busyType === "aircon:updateDurations") && !uncertain;
    stop.hidden = stopDisabled;
    // Keep keyboard focus on an available action when its counterpart disappears.
    if (focused === start && start.disabled && !stopDisabled) stop.focus();
    else if (focused === stop && stopDisabled && !disabled) start.focus();
    const state = busy ? "busy" : needsConfirmation ? "unknown" : view.blocked ? "interrupted" : loading || run?.recovery ? "recovering" : view.elsewhere ? "elsewhere" : run ? run.phase : ["error", "warning"].includes(view.notice?.kind) ? "interrupted" : "idle";
    const badges = { busy: "操作中", unknown: "待确认", recovering: "恢复中", interrupted: "已中断", elsewhere: "其他页面", on: "开机中", off: "关机中", idle: "未运行" };
    setText(ui.badge, badges[state]);
    if (ui.badge.dataset.state !== state) ui.badge.dataset.state = state;
    let text;
    if (busy) text = `正在操作（已等待 ${Math.floor((Date.now() - busySince) / 1000)} 秒，最长等待 ${OPERATION_REPLY_TIMEOUT_MS / 1000} 秒）…`;
    else if (view.blocked) text = "已禁止后续开关指令。";
    else if (needsConfirmation) text = "操作结果未确认，请先确认学校页面的空调状态，再点击停止。";
    else if (run?.queryRecovery) text = `查询超时，${run.recovery?.kind === "authentication" ? "等待学校认证恢复" : loading || run.recovery?.kind === "reload" ? "等待页面恢复" : "等待重新核验"}；恢复期限还剩 ${Math.max(0, Math.ceil((run.queryRecovery.deadline - Date.now()) / 1000))} 秒，停止仍可取消。`;
    else if (run?.recovery?.kind === "authentication") text = "学校认证恢复中，暂不切换空调；最多等待 60 秒，返回后核验并接续原计划。";
    else if (loading || run?.recovery) text = "正在核验页面与原循环，请稍候；停止仍可取消循环。";
    else if (run) {
      const phase = run.phase === "on" ? "开机" : "关机";
      const next = new Date(run.nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      text = `${phase}阶段，约 ${formatRemaining(run.nextAt)} 后切换（${next}）`;
    } else if (view.elsewhere) text = "循环正在另一学校页面运行。";
    else text = "循环未运行。";
    setText(status, text);
    status.hidden = !view.blocked && !loading && !busy && !needsConfirmation && !run && !view.elsewhere;
    const notice = view.notice;
    const noticeText = notice?.previous ? `上次循环${Number.isFinite(notice.at) ? `（${new Date(notice.at).toLocaleString()}）` : ""}：${notice.text}` : notice?.text;
    setText(message, localError || noticeText || "");
    const kind = localError ? "error" : notice?.kind || "info";
    if (message.dataset.kind !== kind) message.dataset.kind = kind;
    const reportLabels = {
      loading: "错误报告：正在读取保存状态…", permission: "错误报告：需在报告设置中授权保存目录。",
      ready: "错误报告：自动保存已就绪。", saving: "错误报告：正在保存…",
      cached: "错误报告：已暂存，后台恢复后自动保存。",
      "directory-error": "错误报告：目录不可用，请打开报告设置。",
      "write-error": "错误报告：写文件失败，已暂存，请打开报告设置。",
      "storage-error": "错误报告：缓存不可用，请重新加载扩展。"
    };
    setText(ui.reportStatus, `${reportLabels[reportStatus.phase] || reportLabels.loading}${reportStatus.pending > 0 ? ` 待保存 ${reportStatus.pending} 份。` : ""}`);
    const reportProblems = {
      permission: "报告保存目录尚未授权。",
      cached: "报告已暂存，等待保存。",
      "directory-error": "报告目录不可用，文件尚未保存。",
      "write-error": "报告保存失败，已暂存。",
      "storage-error": "报告缓存不可用，请重新加载扩展。"
    };
    const reportProblem = reportProblems[reportStatus.phase]
      || (reportStatus.pending > 0 && reportStatus.phase !== "saving" ? "仍有报告等待保存。" : "");
    setText(ui.reportHint, reportProblem);
    if (!reportProblem && focused === ui.reportAction) ui.helpToggle.focus();
    ui.reportNotice.hidden = !reportProblem;
    setText(ui.reportAction, reportStatus.phase === "storage-error" ? "查看说明" : "报告设置");
  }

  async function perform(type, data) {
    if (busy && type !== "aircon:stop") return;
    cancelManualCheck();
    const currentAction = ++actionId;
    busy = true;
    busyType = type;
    busySince = Date.now();
    localError = "";
    render();
    // Paint the click immediately; only startup needs to follow initialization.
    let result;
    if (type === "aircon:start") {
      let initialized = await initialization;
      // Retry a failed initialization only on an explicit new start, within
      // the same click deadline. A recovered page must not retain a failed gate.
      const remaining = OPERATION_REPLY_TIMEOUT_MS - (Date.now() - busySince);
      if (!initialized.ok && remaining > 0 && currentAction === actionId) {
        initialization = readView("aircon:initialize", remaining);
        initialized = await initialization;
      }
      if (currentAction !== actionId) return;
      if (!initialized.ok) result = initialized;
    }
    if (!result) {
      const remaining = OPERATION_REPLY_TIMEOUT_MS - (Date.now() - busySince);
      result = remaining > 0 ? await send(type, data, remaining) : {
        ok: false, code: "E_BACKGROUND_TIMEOUT", communicationReason: "TIMEOUT",
        error: "[E_BACKGROUND_TIMEOUT] 页面初始化等待超过操作期限，未发送启动指令；请停止循环或刷新页面。"
      };
    }
    if (currentAction !== actionId) return;
    if (communicationCodes.has(result.code) && !result.reportId) {
      result.reportId = globalThis.AirconReportFormat.newId();
      cacheCommunicationError(result, result.reportId, busySince, type, ["aircon:start", "aircon:updateDurations"].includes(type) ? data : undefined,
        undefined, type === "aircon:updateDurations" ? data : undefined);
    }
    ++readId;
    if (result.ok) {
      view = result.view; cachedAt = Date.now(); if (view.reports) reportStatus = view.reports; uncertain = false;
      if (["aircon:start", "aircon:updateDurations"].includes(type)) draftEdited = false;
    }
    else {
      if (type === "aircon:updateDurations" && result.view && validReply({ ok: true, view: result.view })) { view = result.view; cachedAt = Date.now(); draftRunId = view.run?.id ?? draftRunId; }
      if (result.blocked === true) view = { ...view, blocked: true };
      localError = result.error;
      localErrorSource = "action";
      uncertain = communicationCodes.has(result.code);
    }
    busy = false;
    busyType = null;
    render();
    if (!result.ok && !uncertain && !result.view && result.code !== "E_MESSAGE_SOURCE") refresh();
  }

  function mount() {
    if (panel && panel.isConnected) return;
    panel = null;
    card = findCard();
    if (!card) return;
    if (document.getElementById(PANEL_ID)) return;

    panel = element("section", "ac-cycle-panel");
    panel.id = PANEL_ID;
    const header = element("div", "ac-cycle-header");
    const title = element("h4", "", "自动循环");
    title.id = `${PANEL_ID}-title`;
    panel.setAttribute("aria-labelledby", title.id);
    const badge = element("span", "ac-cycle-badge", "未运行");
    const helpToggle = element("button", "ac-cycle-help-toggle", "说明");
    helpToggle.type = "button";
    helpToggle.setAttribute("aria-expanded", "false");
    helpToggle.setAttribute("aria-controls", `${PANEL_ID}-help`);
    header.append(title, badge, helpToggle);
    const fields = element("div", "ac-cycle-fields");
    fields.append(inputRow("开机", "onMinutes"), inputRow("关机", "offMinutes"));
    const actions = element("div", "ac-cycle-actions");
    const start = element("button", "ac-cycle-start", "开始循环");
    start.type = "button";
    start.dataset.action = "start";
    const update = element("button", "ac-cycle-update", "应用修改");
    update.type = "button";
    update.dataset.action = "update";
    const stop = element("button", "ac-cycle-stop", "停止循环");
    stop.type = "button";
    stop.dataset.action = "stop";
    actions.append(start, update, stop);
    const timingHint = element("p", "ac-cycle-timing-hint");
    const status = element("p", "ac-cycle-status", "正在读取状态…");
    status.setAttribute("role", "status");
    const message = element("p", "ac-cycle-message");
    message.setAttribute("role", "alert");
    const warning = element("p", "ac-cycle-warning", "停止或离开页面会结束循环；刷新会先核验再接续，不额外关机。空调状态请自行确认。电脑休眠或断网会影响定时。");
    const reportSettings = element("button", "ac-cycle-report-settings", "报告设置");
    reportSettings.type = "button";
    const reportState = element("p", "ac-cycle-report-status");
    reportState.setAttribute("role", "status");
    const help = element("div", "ac-cycle-help");
    help.id = `${PANEL_ID}-help`;
    help.hidden = true;
    const diagnosticHelp = element("p", "ac-cycle-warning", "自动诊断记录学校接口分段耗时、页面与后台事件，出错时随报告保存；不记录令牌、Cookie 或响应正文。");
    help.append(warning, diagnosticHelp, reportSettings, reportState);
    const toggleHelp = () => {
      help.hidden = !help.hidden;
      helpToggle.setAttribute("aria-expanded", String(!help.hidden));
    };
    helpToggle.addEventListener("click", toggleHelp);
    const openReportSettings = () => {
      chrome.runtime.sendMessage({ type: "aircon:openReportSettings" }).catch(() => { reportStatus = { phase: "directory-error" }; render(); });
    };
    reportSettings.addEventListener("click", openReportSettings);
    const reportNotice = element("div", "ac-cycle-report-notice");
    reportNotice.hidden = true;
    const reportHint = element("span", "ac-cycle-report-hint");
    reportHint.setAttribute("role", "status");
    const reportAction = element("button", "ac-cycle-report-action", "报告设置");
    reportAction.type = "button";
    reportAction.addEventListener("click", () => {
      if (reportStatus.phase === "storage-error") {
        if (help.hidden) toggleHelp();
        helpToggle.focus();
      } else openReportSettings();
    });
    reportNotice.append(reportHint, reportAction);
    panel.append(header, fields, timingHint, actions, status, message, reportNotice, help);
    card.append(panel);
    ui = { start, update, stop, timingHint, status, message, badge, helpToggle, reportStatus: reportState, reportNotice, reportHint, reportAction,
      inputs: [...fields.querySelectorAll("input")] };
    const mountedPanel = panel;
    for (const input of ui.inputs) {
      input.value = 10;
      input.addEventListener("input", () => { draftEdited = true; draftValues = ui.inputs.map(item => String(item.value)); render(); });
    }
    render();

    start.addEventListener("click", () => {
      const [onMinutes, offMinutes] = ui.inputs.map(input => Number(input.value));
      if (![onMinutes, offMinutes].every(value => Number.isInteger(value) && value >= 1 && value <= 1440)) {
        localError = "开机和关机时间都必须是 1–1440 分钟的整数。";
        localErrorSource = "action";
        render();
        return;
      }
      perform("aircon:start", { onMinutes, offMinutes });
    });
    stop.addEventListener("click", () => perform("aircon:stop"));
    update.addEventListener("click", () => {
      if (update.disabled || !view.run) return;
      const [onMinutes, offMinutes] = ui.inputs.map(input => Number(input.value));
      perform("aircon:updateDurations", { runId: view.run.id, timingRevision: view.run.timingRevision ?? 0, onMinutes, offMinutes });
    });

    chrome.storage.local.get("cycleDurations").then(result => {
      if (panel !== mountedPanel || !panel.isConnected || draftEdited || draftValues || busy || view.run) return;
      ui.inputs[0].value = result.cycleDurations?.onMinutes ?? 10;
      ui.inputs[1].value = result.cycleDurations?.offMinutes ?? 10;
      draftValues = ui.inputs.map(input => String(input.value));
    }).catch(() => {});
    if (initialLoad) {
      initialLoad = false;
      const lifecycle = { event: "initialize", wasDiscarded: document.wasDiscarded === true,
        navigationType: globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.type };
      initializeView(lifecycle);
    } else refresh();
  }

  function cancelManualCheck() {
    clearTimeout(manualCheckTimer);
    manualCheckTimer = null;
    pendingManualCheck = null;
  }

  function displayedOn(button) {
    if (!button?.isConnected) return null;
    const value = button.getAttribute("aria-checked");
    return value === "true" ? true : value === "false" ? false : null;
  }

  function displayMatchesRun(button) {
    return typeof view.run?.expectedOn === "boolean" && displayedOn(button) === view.run.expectedOn;
  }

  function scheduleManualCheck(trigger, button) {
    const runId = view.run?.id;
    if (!runId || !isHome() || !panel?.isConnected) return;
    if (trigger === "stateChange" && displayMatchesRun(button)) return;
    // A display update may debounce a click, but must never downgrade its intent.
    const clickPending = pendingManualCheck?.runId === runId && pendingManualCheck.trigger === "click";
    clearTimeout(manualCheckTimer);
    const check = { runId, panel, button, trigger: clickPending ? "click" : trigger };
    pendingManualCheck = check;
    manualCheckTimer = setTimeout(async () => {
      if (pendingManualCheck !== check) return;
      manualCheckTimer = null;
      pendingManualCheck = null;
      if (!check || view.run?.id !== check.runId || busy || !isHome() || panel !== check.panel || !panel?.isConnected) return;
      if (check.trigger === "stateChange" && displayMatchesRun(check.button)) return;
      await readView("aircon:manualCheck", undefined, { trigger: check.trigger, observedOn: displayedOn(check.button) });
    }, 1500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "aircon:getToken") {
      let token = "";
      try {
        const student = JSON.parse(localStorage.getItem("ggt_student") || "null");
        token = typeof student?.token === "string" ? student.token : "";
      } catch { /* An invalid login record is treated as logged out. */ }
      sendResponse({ token, evidence: pageEvidence() });
      return false;
    }
    if (message?.type === "aircon:stateChanged") {
      if (!busy && !loading && isHome()) refresh();
      return false;
    }
    if (message?.type === "aircon:pageReturned") {
      if (isHome()) initializeView();
      return false;
    }
    if (message?.type === "aircon:reportStatusChanged") {
      reportStatus = message.status;
      render();
      return false;
    }
    return false;
  });

  document.addEventListener("click", event => {
    if (!event.isTrusted || !card?.isConnected) return;
    const switchButton = event.target?.closest?.('button[role="switch"]');
    if (switchButton && card.contains(switchButton)) scheduleManualCheck("click", switchButton);
  }, true);

  const observer = new MutationObserver(mutations => {
    if (!panel?.isConnected) { cancelManualCheck(); mount(); }
    if (!view.run || !card?.isConnected) return;
    const change = mutations.find(item => item.type === "attributes" && item.attributeName === "aria-checked" && item.target.matches?.('button[role="switch"]') && card.contains(item.target));
    if (change) scheduleManualCheck("stateChange", change.target);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-checked"] });
  mount();
  setInterval(() => {
    if (view.run || busy) render();
  }, 1000);
})();
