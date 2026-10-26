// Isolated mock: content.js is unmodified; no background or school API is loaded.
const listeners = [];
const calls = [];
const cache = {};
let view = { run: null, elsewhere: false, notice: null, reports: { phase: "ready", pending: 0 } };
let scenario = "idle";
const reply = () => ({ ok: true, view: structuredClone(view) });
const notify = message => listeners.forEach(listener => listener(message, {}, () => {}));
let runNumber = 0;
const run = phase => ({ id: `preview-${++runNumber}`, phase, expectedOn: phase === "on", onMinutes: 10, offMinutes: 10,
  startedAt: Date.now() - 420000, phaseStartedAt: Date.now() - 420000, timingRevision: 0, nextAt: Date.now() + 180000 });
window.chrome = {
  runtime: {
    getManifest: () => ({ version: "1.1.19" }),
    onMessage: { addListener: listener => listeners.push(listener) },
    async sendMessage(message) {
      calls.push(message.type);
      document.getElementById("calls").textContent = calls.join("\n");
      if (message.type === "aircon:openReportSettings") {
        document.getElementById("settings-result").textContent = "已收到打开报告设置的模拟请求（不打开真实设置、不授权目录）。";
      }
      if (message.type === "aircon:start") {
        if (scenario === "busy") return new Promise(() => {});
        if (scenario === "unknown") return {
          ok: false, code: "E_BACKGROUND_DISCONNECTED", reportId: "preview-report",
          error: "[E_BACKGROUND_DISCONNECTED] 扩展通信通道在回复前关闭，操作可能已经执行。结果未确认，请停止循环或刷新页面。"
        };
        view.run = { ...run("on"), onMinutes: message.onMinutes, offMinutes: message.offMinutes,
          phaseStartedAt: Date.now(), startedAt: Date.now(), nextAt: Date.now() + message.onMinutes * 60000 };
      }
      if (message.type === "aircon:updateDurations") {
        await new Promise(resolve => setTimeout(resolve, Number(document.getElementById("apply-delay").value)));
        if (!view.run || message.runId !== view.run.id || message.timingRevision !== view.run.timingRevision) return {
          ok: false, code: "E_TIMING_STALE", error: "循环或阶段已变化，本次修改未执行；请核对后再次应用。", view: structuredClone(view)
        };
        const current = view.run;
        const nextAt = current.phaseStartedAt + (current.phase === "on" ? message.onMinutes : message.offMinutes) * 60000;
        view.run = { ...current, onMinutes: message.onMinutes, offMinutes: message.offMinutes, nextAt, timingRevision: current.timingRevision + 1 };
        if (nextAt <= Date.now()) {
          view.run.phase = current.phase === "on" ? "off" : "on";
          view.run.expectedOn = view.run.phase === "on";
          view.run.phaseStartedAt = Date.now();
          view.run.nextAt = Date.now() + (view.run.expectedOn ? message.onMinutes : message.offMinutes) * 60000;
          view.run.timingRevision++;
        }
        view.notice = { kind: "info", text: "时长已更新，当前及后续循环使用新设置。（本地模拟）" };
      }
      if (message.type === "aircon:stop") { view.run = null; if (!view.blocked) view.notice = null; view.elsewhere = false; }
      return reply();
    }
  },
  storage: { local: {
    async get(key) { return key === null ? structuredClone(cache) : { cycleDurations: cache.cycleDurations ?? { onMinutes: 2, offMinutes: 4 } }; },
    async set(value) { Object.assign(cache, value); },
    async remove(keys) { keys.forEach(key => delete cache[key]); }
  } }
};
document.getElementById("scenario").addEventListener("change", async event => {
  // Use the actual stop handler to clear any prior local busy/uncertain outcome.
  const stop = document.querySelector(".ac-cycle-stop");
  if (!stop.hidden && !stop.disabled) {
    stop.click();
    // Drain the mock promise chain; no additional timeout/timer.
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  scenario = event.target.value;
  view.run = ["on", "off", "warning", "recovering", "query-recovering", "http-recovering", "blocked"].includes(scenario) ? run(scenario === "off" ? "off" : "on") : null;
  view.blocked = scenario === "blocked";
  if (scenario === "recovering") view.run.recovery = { deadline: Date.now() + 60000 };
  if (["query-recovering", "http-recovering"].includes(scenario)) {
    view.run.queryRecovery = { id: "preview-incident", deadline: Date.now() + 44000,
      initialFailure: scenario === "http-recovering" ? { errorCode: "E_HTTP", httpStatus: 502 } : { errorCode: "E_API_TIMEOUT" } };
    view.run.recovery = { kind: "query", deadline: view.run.queryRecovery.deadline, nextAttemptAt: Date.now() + 30000 };
  }
  view.elsewhere = scenario === "elsewhere";
  view.notice = scenario === "error"
    ? { kind: "error", text: "无法确认空调状态，循环已停止：[E_HTTP] GET /app/prepaid/ac-status 学校服务返回 HTTP 502。" }
    : scenario === "warning" ? { kind: "warning", text: "14:20 [E_API_TIMEOUT] GET /app/prepaid/ac-status 保活查询超时，循环仍在运行。" } : null;
  if (["interrupted", "command-unknown"].includes(scenario)) view.notice = { previous: true, at: Date.now() - 600000, kind: "error",
    outcomeUnknown: scenario === "command-unknown", text: scenario === "command-unknown"
      ? "[E_COMMAND_UNKNOWN] 中断时存在尚未确认的开关指令，禁止自动重发；请自行确认空调状态。"
      : "[E_SESSION_ENDED] 浏览器或扩展会话已结束，具体原因未知；上次循环未恢复。" };
  if (scenario === "blocked") view.notice = { kind: "error", text: "[E_LOCAL_STORAGE] 循环清理失败，已禁止后续空调指令；请重新加载扩展并确认空调状态。" };
  notify({ type: "aircon:stateChanged" });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  if (["busy", "unknown"].includes(scenario)) document.querySelector(".ac-cycle-start").click();
});
document.getElementById("width").addEventListener("change", event => {
  document.querySelector(".school-card").style.width = `${Number(event.target.value)}px`;
});
document.getElementById("zoom").addEventListener("change", event => {
  document.getElementById("stage").style.zoom = event.target.value;
});
document.getElementById("reports").addEventListener("change", event => {
  view.reports = { phase: event.target.value, pending: ["cached", "write-error", "directory-error"].includes(event.target.value) ? 2 : 0 };
  notify({ type: "aircon:reportStatusChanged", status: view.reports });
});
