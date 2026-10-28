import { CycleController, KEEP_ALIVE_MINUTES, OPERATION_TIMEOUT_MS } from "./cycle.js";
import { SITE_ORIGIN } from "./api-config.js";
import { createSchoolApi } from "./api-client.js";
import { bounded, CycleError, describeError } from "./errors.js";
import { ErrorReporter } from "./reports.js";
import { createHistory } from "./history.js";
import { Diagnostics } from "./diagnostics.js";
import { CommandVerification } from "./command-verification.js";

const HOME_PATH = "/njggt/app/home";
const pageMessageTypes = new Set(["aircon:initialize", "aircon:getState", "aircon:start", "aircon:updateDurations", "aircon:stop", "aircon:manualCheck", "aircon:openReportSettings"]);
const reportTabs = new Set();
const environment = { version: chrome.runtime.getManifest?.().version ?? "1.1.22", userAgent: globalThis.navigator?.userAgent };
const reporter = new ErrorReporter({
  storage: chrome.storage.local,
  environment,
  onStatus: status => {
    for (const tabId of reportTabs) chrome.tabs.sendMessage(tabId, { type: "aircon:reportStatusChanged", status }).catch(() => {});
    chrome.runtime.sendMessage?.({ type: "aircon:reportStatusChanged", status })?.catch(() => {});
  }
});
const diagnostics = new Diagnostics({ storage: chrome.storage.local, sessionStorage: chrome.storage.session, runtimeId: chrome.runtime.id,
  followupAlarm: { create: (id, when) => chrome.alarms.create(`followup:${id}`, { when }), clear: id => chrome.alarms.clear(`followup:${id}`) },
  onFollowup: (id, value) => reporter.updateFollowup(id, value), onOrphanFollowups: ids => reporter.interruptFollowups(ids),
  followupCanStart: async state => {
    const checkpoint = (await chrome.storage.local.get("cycleCheckpoint")).cycleCheckpoint;
    return checkpoint?.active === false && checkpoint.run?.id === state.runId;
  },
  onUpdate: (id, snapshot) => reporter.enrich(id, snapshot), onIncident: draft => capture(draft) });
diagnostics.attach(chrome);
const capture = draft => {
  const tabId = draft.tabId ?? draft.run?.tabId ?? draft.lifecycle?.tabId;
  const id = reporter.capture({ ...draft, recovered: draft.recovered === true, diagnostics: diagnostics.snapshot(tabId) });
  if (id) diagnostics.trackReport(id, draft.originalOperationId ?? id, tabId);
  return id;
};
reporter.flush();

function isHome(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === SITE_ORIGIN && parsed.pathname.replace(/\/$/, "") === HOME_PATH;
  } catch {
    return false;
  }
}
const pageRoute = globalThis.AirconReportFormat.pageRoute;
const isAuthRoute = route => ["login", "callback", "cas"].includes(route);

function sourcePage(url) {
  if (typeof url !== "string" || !url) return "MISSING";
  try {
    const parsed = new URL(url);
    if (parsed.origin !== SITE_ORIGIN) return "OTHER";
    if (isHome(url)) return "HOME";
    return parsed.pathname.startsWith("/njggt/app/") ? "SCHOOL_APP" : "OTHER";
  } catch { return "OTHER"; }
}

const store = {
  async getRun() { return (await chrome.storage.session.get("cycleRun")).cycleRun ?? null; },
  async setRun(run) { await chrome.storage.session.set({ cycleRun: run }); },
  async clearRun() { await chrome.storage.session.remove("cycleRun"); },
  async getState() {
    const state = await chrome.storage.session.get(["cycleRun", "cycleNotice", "keepAliveNotice"]);
    return { run: state.cycleRun ?? null, notice: state.cycleNotice ?? null, keepAliveNotice: state.keepAliveNotice ?? null };
  },
  async setNotice(notice) { await chrome.storage.session.set({ cycleNotice: notice }); },
  async clearNotice() { await chrome.storage.session.remove("cycleNotice"); },
  async setKeepAliveNotice(notice) { await chrome.storage.session.set({ keepAliveNotice: notice }); },
  async clearKeepAliveNotice() { await chrome.storage.session.remove("keepAliveNotice"); }
};

const alarm = {
  async get(id) { return chrome.alarms.get(`cycle:${id}`); },
  async create(id, when) { await chrome.alarms.create(`cycle:${id}`, { when }); },
  async clear(id) { await chrome.alarms.clear(`cycle:${id}`); }
};

const keepAliveAlarm = {
  async get(id) { return chrome.alarms.get(`keepalive:${id}`); },
  async create(id, when) { await chrome.alarms.create(`keepalive:${id}`, { when, periodInMinutes: KEEP_ALIVE_MINUTES }); },
  async clear(id) { await chrome.alarms.clear(`keepalive:${id}`); }
};

const recoveryAlarm = {
  async create(id, when) { await chrome.alarms.create(`recovery:${id}`, { when }); },
  async clear(id) { await chrome.alarms.clear(`recovery:${id}`); }
};

const page = {
  async getProtection(tabId) { return (await bounded(() => chrome.tabs.get(tabId), { ms: 2000, code: "E_LOCAL_TIMEOUT", stage: "读取标签页回收设置" })).autoDiscardable; },
  async protect(tabId) { if (chrome.tabs.update) await bounded(() => chrome.tabs.update(tabId, { autoDiscardable: false }), { ms: 2000, code: "E_LOCAL_TIMEOUT", stage: "保护循环标签页" }); },
  async restore(tabId, previous) {
    if (!chrome.tabs.update) return;
    try {
      await bounded(() => chrome.tabs.get(tabId), { ms: 2000, code: "E_LOCAL_TIMEOUT", stage: "检查循环标签页" });
    } catch (error) { if (error.code) throw error; return; }
    await bounded(() => chrome.tabs.update(tabId, { autoDiscardable: previous }), { ms: 2000, code: "E_LOCAL_TIMEOUT", stage: "恢复标签页回收设置" });
  },
  async isOpen(tabId, signal) {
    const at = Date.now();
    diagnostics.event(signal?.diagnostic, { component: "page", step: "tabRead", outcome: "begin" });
    try {
      const tab = await bounded(() => chrome.tabs.get(tabId), { signal, ms: 3000, code: "E_PAGE_TIMEOUT", stage: "检查学校标签页" });
      if (signal?.diagnostic) signal.diagnostic.lifecycle = { ...signal.diagnostic.lifecycle, frozen: tab.frozen, discarded: tab.discarded };
      const route = pageRoute(tab.url);
      diagnostics.page({ at: Date.now(), tabId, route, frozen: tab.frozen, discarded: tab.discarded }, "tabSnapshot", { observer: "tabs" });
      diagnostics.event(signal?.diagnostic, { component: "page", step: "tabRead", outcome: "ok", elapsedMs: Date.now() - at });
      if (isAuthRoute(route)) {
        if (signal?.diagnostic?.readOnlyVerification) throw new CycleError("E_AUTH", "只读核验时页面已进入认证流程。");
        // Do not await the controller queue from inside a control operation.
        controller.suspend(tabId, { event: "authentication", route, tabId }).catch(error => capture({ source: "recovery", tabId, error }));
        throw new CycleError("E_PAGE_RELOADING", "学校正在认证，等待返回主页后核验。");
      }
      if (signal?.diagnostic?.readOnlyVerification && (tab.discarded || tab.frozen || tab.status === "loading")) throw new CycleError("E_PAGE_UNAVAILABLE", "核验页面不可用。");
      return isHome(tab.url);
    }
    catch (error) {
      diagnostics.event(signal?.diagnostic, { component: "page", step: "tabRead", outcome: "error", code: error.code ?? "E_INTERNAL", elapsedMs: Date.now() - at });
      if (error.code) throw error; return false;
    }
  }
};

async function getToken(tabId, signal) {
  if (!await page.isOpen(tabId, signal)) throw new CycleError("E_PAGE_CLOSED", "学校页面已关闭。");
  let reply;
  const at = Date.now();
  diagnostics.event(signal?.diagnostic, { component: "page", step: "tokenMessage", outcome: "begin" });
  try {
    reply = await bounded(() => chrome.tabs.sendMessage(tabId, { type: "aircon:getToken" }, signal?.diagnostic?.run?.documentId ? { documentId: signal.diagnostic.run.documentId } : { frameId: 0 }), { signal, ms: 3000, code: "E_PAGE_TIMEOUT", stage: "向学校页面读取登录状态" });
    diagnostics.event(signal?.diagnostic, { component: "page", step: "tokenMessage", outcome: "ok", elapsedMs: Date.now() - at });
  }
  catch (error) {
    diagnostics.event(signal?.diagnostic, { component: "page", step: "tokenMessage", outcome: "error", code: error.code ?? "E_PAGE_UNAVAILABLE", elapsedMs: Date.now() - at });
    if (error.code) throw error;
    throw new CycleError("E_PAGE_UNAVAILABLE", "无法从学校页面读取登录状态，请刷新页面后重试。");
  }
  if (reply?.evidence) diagnostics.page({ ...reply.evidence, tabId, documentId: signal?.diagnostic?.run?.documentId });
  if (typeof reply?.token !== "string" || !reply.token || reply.token.length > 4096) {
    diagnostics.event(signal?.diagnostic, { component: "page", step: "tokenValidate", outcome: "error", code: "E_AUTH" });
    throw new CycleError("E_AUTH", "学校登录已失效，请重新登录。");
  }
  diagnostics.event(signal?.diagnostic, { component: "page", step: "tokenValidate", outcome: "ok" });
  return reply.token;
}

const api = createSchoolApi({ getToken, diagnostics });

const controller = new CycleController({
  store, alarm, keepAliveAlarm, recoveryAlarm, diagnostics,
  history: createHistory(chrome.storage.local, environment, (report, values) => reporter.persist(report ? { ...report, recovered: report.recovered ?? false, diagnostics: diagnostics.snapshot(report.cycle?.tabId) } : null, values)), api, page, report: capture,
  notify: tabId => {
    // UI notification must not hold the serialized control queue open.
    chrome.tabs.sendMessage(tabId, { type: "aircon:stateChanged" }).catch(() => {});
  }
});

const verificationApi = createSchoolApi({ getToken, diagnostics, retryGetTimeouts: false });
const verification = new CommandVerification({
  storage: chrome.storage.session,
  alarm: {
    create: (id, when) => chrome.alarms.create(`verification:${id}`, { when }),
    clear: id => chrome.alarms.clear(`verification:${id}`)
  },
  readStatus: verificationApi.readStatus, readTimer: verificationApi.readTimer,
  canVerify: async job => {
    const [session, local] = await Promise.all([chrome.storage.session.get("cycleRun"), chrome.storage.local.get("cycleCheckpoint")]);
    const checkpoint = local.cycleCheckpoint;
    return !session.cycleRun && checkpoint?.active === false && checkpoint.run?.id === job.runId
      && checkpoint.run?.documentId === job.documentId && checkpoint.notice?.outcomeUnknown === true
      && checkpoint.command?.sent === true && checkpoint.command?.confirmed !== true;
  },
  updateReport: (id, value) => reporter.updateVerification(id, value),
  interruptOrphans: id => reporter.interruptVerifications(id),
  notify: tabId => { chrome.tabs.sendMessage(tabId, { type: "aircon:stateChanged" }).catch(() => {}); }
});
controller.verificationGeneration = tabId => verification.generationFor(tabId);
controller.onStopped = (draft, failure) => {
  if (!draft) return;
  if (!failure) void diagnostics.startFollowup(draft).catch(() => {});
  void verification.start({ ...draft, error: { code: draft.error.code, requestSequence: draft.error.requestSequence },
    run: { ...draft.run }, command: { ...draft.command }, requests: structuredClone(draft.requests) }, failure);
};

// Reconcile before control/state events. A delivered one-shot cycle alarm is
// already consumed, so recognize its ID and scheduled time during reconciliation.
// Read-only heartbeats use a separate path.
let ready;
let reconciling = false;
const deliveredCycles = new Map();
function ensureReady(delivered) {
  if (!ready) {
    reconciling = true;
    ready = controller.reconcile(deliveredCycles).then(() => {
      reconciling = false;
      deliveredCycles.clear();
    }).catch(error => {
      ready = null;
      reconciling = false;
      deliveredCycles.clear();
      throw error;
    });
  }
  if (reconciling && delivered && Number.isFinite(delivered.scheduledTime)) {
    deliveredCycles.set(delivered.name.slice("cycle:".length), delivered.scheduledTime);
  }
  return ready;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (["aircon:telemetry", "aircon:pageDiagnostic"].includes(message?.type)) {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)
      || !["HOME", "SCHOOL_APP"].includes(sourcePage(sender.url)) || !["HOME", "SCHOOL_APP"].includes(sourcePage(sender.tab?.url))) return false;
    const identity = { tabId: sender.tab.id, documentId: sender.documentId };
    if (message.type === "aircon:pageDiagnostic") {
      if (message.kind === "ready") diagnostics.page({ ...message.evidence, ...identity }, "observerReady", { observer: "page-observer" });
      else if (message.kind === "response") diagnostics.response({ ...message.response, ...identity });
    } else {
      if (message.evidence) diagnostics.page({ ...message.evidence, ...identity }, message.step, message.detail ?? {});
      for (const entry of (Array.isArray(message.resources) ? message.resources : []).slice(-16)) diagnostics.resource({ ...entry, ...identity });
    }
    sendResponse({ ok: true });
    return false;
  }
  const isSettings = typeof chrome.runtime.getURL === "function" && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("report-settings.html");
  if (isSettings && ["aircon:reportsStatus", "aircon:reportsFlush"].includes(message?.type)) {
    if (message.type === "aircon:reportsFlush") reporter.flush();
    sendResponse({ ok: true, status: { ...reporter.state } });
    return false;
  }
  if (!pageMessageTypes.has(message?.type)) return false;
  const tabId = sender.tab?.id;
  const communication = {
    messageType: message.type, reason: "ACCEPTED", sourcePage: sourcePage(sender.url),
    tabIsHome: typeof sender.tab?.url === "string" && sender.tab.url ? isHome(sender.tab.url) : null
  };
  // A script's source URL can predate an SPA navigation. Use the browser's
  // current tab snapshot for the route, while retaining origin/frame checks.
  if (sender.id !== chrome.runtime.id) communication.reason = "EXTENSION_MISMATCH";
  else if (!Number.isInteger(tabId)) communication.reason = "TAB_ID_MISSING";
  else if (sender.frameId !== 0) communication.reason = "FRAME_REJECTED";
  else if (!["HOME", "SCHOOL_APP"].includes(communication.sourcePage)) communication.reason = "SOURCE_REJECTED";
  else if (communication.tabIsHome === null) communication.reason = "TAB_URL_MISSING";
  else if (!communication.tabIsHome) communication.reason = "TAB_NOT_HOME";
  const options = {
    tabId,
    ...(message.type === "aircon:updateDurations" ? { deadlineAt: Date.now() + OPERATION_TIMEOUT_MS,
      durations: { onMinutes: message.onMinutes, offMinutes: message.offMinutes } } : {}),
    reportId: globalThis.AirconReportFormat.identifier(message.reportId) ?? globalThis.AirconReportFormat.newId(),
    startedAt: Number.isFinite(message.startedAt) ? message.startedAt : Date.now(), communication,
    documentId: globalThis.AirconReportFormat.identifier(sender.documentId),
    lifecycle: globalThis.AirconReportFormat.lifecycle(message.lifecycle)
  };
  if (message.type === "aircon:manualCheck") {
    options.manualCheck = globalThis.AirconReportFormat.manualCheck({ trigger: message.trigger, observedOn: message.observedOn });
  }
  if (communication.reason !== "ACCEPTED") {
    const error = new CycleError("E_MESSAGE_SOURCE", `页面消息来源未通过校验（${communication.reason}），本次指令未执行；请返回学校主页并刷新页面。`);
    // A read already in flight when the page leaves home is a consequence of
    // that navigation, not a second control failure. Keep the strict rejection.
    const reportId = message.type === "aircon:getState" && communication.reason === "TAB_NOT_HOME" ? null
      : capture({ ...options, source: message.type.replace("aircon:", ""), error });
    sendResponse({ ok: false, code: error.code, error: describeError(error), reportId });
    return false;
  }
  reportTabs.add(tabId);
  if (message.evidence) diagnostics.page({ ...message.evidence, tabId, documentId: sender.documentId }, "initialize");
  if (message?.type === "aircon:openReportSettings") {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  (async () => {
    if (["aircon:stop", "aircon:start", "aircon:manualCheck", "aircon:updateDurations"].includes(message.type)) await verification.cancel(tabId);
    else await verification.ready();
    if (message.type === "aircon:initialize" && verification.job?.tabId === tabId && verification.job.documentId !== options.documentId) await verification.cancel(tabId, "page_changed");
    if (message?.type !== "aircon:stop") await ensureReady();
    switch (message?.type) {
      case "aircon:initialize":
        await controller.initialize(tabId, options);
        break;
      case "aircon:getState":
        break;
      case "aircon:start": {
        await diagnostics.endFollowup(tabId, "new-cycle");
        const onMinutes = message.onMinutes;
        const offMinutes = message.offMinutes;
        await controller.start(tabId, onMinutes, offMinutes, options);
        // Saving defaults must not turn a successful start into a reported failure.
        chrome.storage.local.set({ cycleDurations: { onMinutes, offMinutes } }).catch(() => {});
        break;
      }
      case "aircon:stop":
        await controller.stop(tabId);
        break;
      case "aircon:updateDurations": {
        const updated = await controller.updateDurations(tabId, message, options);
        if (updated.changed) chrome.storage.local.set({ cycleDurations: { onMinutes: updated.run.onMinutes, offMinutes: updated.run.offMinutes } }).catch(() => {});
        break;
      }
      case "aircon:manualCheck":
        await controller.manualCheck(tabId, options);
        break;
      default:
        throw new Error("未知扩展操作。");
    }
    return { ...await controller.getView(tabId), postCommandVerification: verification.view(tabId), incidentFollowup: globalThis.AirconReportFormat.incidentFollowup(diagnostics.followups.get(tabId)), reports: { ...reporter.state } };
  })().then(view => sendResponse({ ok: true, view }))
    .catch(async error => {
      if (!error?.reportId) capture({ ...options, source: message?.type?.replace("aircon:", ""), error });
      const view = message.type === "aircon:updateDurations" ? await controller.getView(tabId).catch(() => undefined) : undefined;
      sendResponse({ ok: false, blocked: Boolean(controller.writeFault), code: error?.code || "E_INTERNAL", error: describeError(error), reportId: error?.reportId ?? options.reportId, ...(view ? { view } : {}) });
    });
  return true;
});

chrome.alarms.onAlarm.addListener(item => {
  if (item.name.startsWith("followup:")) {
    void diagnostics.ready.then(() => {
      const state = [...diagnostics.followups.values()].find(s => s.reportId === item.name.slice(9) && s.deadlineAt === item.scheduledTime);
      if (state && Date.now() >= state.deadlineAt) diagnostics.closeFollowup(state.tabId, "expired");
    });
    return;
  }
  if (item.name.startsWith("verification:")) { void verification.onAlarm(item.name.slice("verification:".length), item.scheduledTime); return; }
  if (/^(cycle|keepalive|recovery):/.test(item.name)) diagnostics.event(null, { component: "alarm", step: "alarmDelivered", scheduledAt: item.scheduledTime, latenessMs: Date.now() - item.scheduledTime, outcome: "ok" });
  if (item.name.startsWith("recovery:")) {
    const id = item.name.slice("recovery:".length);
    controller.recoveryExpired(id, item.scheduledTime).catch(error => { if (!error?.reportId) capture({ source: "recovery", error }); console.error("AC recovery failed", error); });
  } else if (item.name.startsWith("keepalive:")) {
    // Do not reconcile a possibly consumed simultaneous cycle alarm here.
    const id = item.name.slice("keepalive:".length);
    controller.keepAlive(id).catch(error => { if (!error?.reportId) capture({ source: "keepAlive", error }); console.error("AC keepalive failed", error); });
  } else if (item.name.startsWith("cycle:")) {
    const id = item.name.slice("cycle:".length);
    ensureReady(item).then(() => controller.tick(id, item.scheduledTime)).catch(error => { if (!error?.reportId) capture({ source: "tick", error }); console.error("AC cycle alarm failed", error); });
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  void diagnostics.endFollowup(tabId, "closed");
  void verification.cancel(tabId, "page_closed");
  if (reportTabs.has(tabId)) { diagnostics.event(null, { tabId, component: "page", step: "closed", outcome: "ok" }); diagnostics.flush(); }
  reportTabs.delete(tabId);
  // Cancel immediately even while startup reconciliation is pending.
  controller.abandon(tabId).catch(error => { if (!error?.reportId) capture({ source: "lifecycle", error }); console.error("AC cycle tab close failed", error); });
});

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && Object.entries(changes).some(([key, change]) => globalThis.AirconReportFormat.isCacheKey(key) && change.newValue?.saved === false)) reporter.flush();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const route = pageRoute(changeInfo.url ?? tab?.url);
  if (changeInfo.status === "loading" || changeInfo.discarded === true || changeInfo.url && !isHome(changeInfo.url)) void verification.cancel(tabId, "page_changed");
  if ((reportTabs.has(tabId) || route !== "other") && (changeInfo.status || changeInfo.url || typeof changeInfo.discarded === "boolean" || typeof changeInfo.frozen === "boolean")) {
    diagnostics.page({ at: Date.now(), tabId, route, frozen: tab?.frozen, discarded: tab?.discarded }, changeInfo.status === "loading" ? "loading" : changeInfo.url ? "navigation" : "tabSnapshot", { observer: "tabs" });
  }
  if (changeInfo.url && isAuthRoute(route)) {
    controller.suspend(tabId, { event: "authentication", route, tabId }).catch(error => capture({ source: "recovery", tabId, error }));
  } else if (changeInfo.url && route !== "home") {
    controller.abandon(tabId, "navigation", { route, tabId }).catch(error => { capture({ source: "lifecycle", tabId, error }); console.error("AC cycle navigation failed", error); });
  } else if (changeInfo.status === "loading" || changeInfo.discarded === true) {
    controller.suspend(tabId, { event: changeInfo.discarded === true ? "discarded" : "loading", discarded: tab?.discarded, frozen: tab?.frozen })
      .catch(error => { capture({ source: "lifecycle", error }); console.error("AC page suspension failed", error); });
  }
  if (route === "home" && (changeInfo.status === "complete" || changeInfo.url && changeInfo.status !== "loading" && tab?.status !== "loading")) {
    chrome.tabs.sendMessage(tabId, { type: "aircon:pageReturned" }).catch(() => {});
  }
});

// Browser-provided navigation identity is independent of the page-world probe.
// Only categorical routes are retained, never CAS tickets or service queries.
try {
  for (const name of ["onBeforeNavigate", "onCommitted", "onHistoryStateUpdated", "onCompleted", "onErrorOccurred"]) {
    chrome.webNavigation[name].addListener(details => {
      if (details.frameId !== 0) return;
      if (name === "onBeforeNavigate" || name === "onHistoryStateUpdated" && !isHome(details.url)) void verification.cancel(details.tabId, "page_changed");
      diagnostics.page({ at: details.timeStamp, tabId: details.tabId, documentId: details.documentId, route: pageRoute(details.url) },
        name === "onBeforeNavigate" ? "loading" : "navigation", { observer: "webNavigation", navigationEvent: name, navigationError: details.error, transitionType: details.transitionType, qualifiers: details.transitionQualifiers });
      if (name === "onHistoryStateUpdated" && isHome(details.url)) chrome.tabs.sendMessage(details.tabId, { type: "aircon:pageReturned" }, details.documentId ? { documentId: details.documentId } : { frameId: 0 }).catch(() => {});
    }, { url: [{ hostEquals: "w5.ab.ust.hk" }, { hostEquals: "cas.ust.hk" }] });
  }
  diagnostics.coverage.webNavigation = true;
} catch { diagnostics.coverage.webNavigation = false; }

chrome.runtime.onStartup?.addListener(() => {
  void diagnostics.endFollowup(null, "session-ended");
  void verification.cancel(null, "session_ended");
  ensureReady().catch(error => { capture({ source: "reconcile", error }); console.error("AC startup reconciliation failed", error); });
});
chrome.runtime.onInstalled?.addListener(() => { void verification.cancel(null, "session_ended"); void diagnostics.endFollowup(null, "session-ended"); });

// Only browser-provided request identity can cancel recovery. Page diagnostics
// may enrich reports, but cannot authorize or cancel a control operation.
try {
  chrome.webRequest.onBeforeRequest.addListener(details => {
    if (details.method !== "POST" || details.frameId !== 0 || details.initiator !== SITE_ORIGIN || !Number.isInteger(details.tabId) || details.tabId < 0) return;
    const path = globalThis.AirconReportFormat.observedPath(details.url);
    if (["/app/prepaid/toggle-status", "/app/prepaid/ac-timer"].includes(path)) {
      if (!details.documentId || !verification.job?.documentId || verification.job.documentId === details.documentId) void verification.cancel(details.tabId, "page_control");
      void controller.externalControl(details.tabId, details.documentId).catch(error => capture({ source: "queryRecovery", error }));
    }
  }, { urls: ["https://w5.ab.ust.hk/njggt/api/app/prepaid/*"] });
} catch { /* The existing webRequest coverage flag reports availability. */ }

for (const type of ["error", "unhandledrejection"]) globalThis.addEventListener?.(type, event => {
  const error = event.error ?? event.reason;
  capture({ source: "background", error: { code: "E_INTERNAL", stack: error?.stack } });
});
