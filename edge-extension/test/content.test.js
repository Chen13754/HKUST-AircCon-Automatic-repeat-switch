import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../report-format.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../content.js", import.meta.url), "utf8");
const idle = { run: null, elsewhere: false, notice: null };
const running = { ...idle, run: { phase: "on", nextAt: Date.now() + 60000 } };
const flush = () => new Promise(resolve => setImmediate(resolve));
const timedView = (phase = "on") => ({ ...idle, run: { id: "editable-run", phase, onMinutes: 10, offMinutes: 10,
  phaseStartedAt: Date.now() - 7 * 60000, nextAt: Date.now() + 3 * 60000, timingRevision: 2 } });
function editTimes(h, on, off) {
  const inputs = h.panel.querySelectorAll("input");
  inputs[0].value = String(on); inputs[1].value = String(off); inputs[0].handlers.input();
}

for (const state of ["waiting", "completed", "interrupted"]) test(`post-command ${state} retains uncertainty and stop; cancellation restores normal controls`, async () => {
  const h = harness(msg => ({ ok: true, view: msg.type === "aircon:stop" ? idle : { ...idle,
    notice: { kind: "error", text: "开关超时", outcomeUnknown: true },
    postCommandVerification: { state, deadlineAt: Date.now() + 35000, conclusion: "target_observed", rounds: [{ actualOn: true, timerPresent: false }] }
  } }));
  await flush();
  assert.equal(h.button("start").disabled, true); assert.equal(h.button("stop").disabled, false);
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, state === "waiting" ? /只读核验.*剩.*秒.*结果仍未确认/ : /观察到目标状态.*不能确认原指令成功/);
  h.button("stop").handlers.click(); await flush(); assert.equal(h.button("start").disabled, false);
});

for (const [initialFailure, reason] of [
  [{ errorCode: "E_API_TIMEOUT" }, /查询超时/],
  ...[502, 503, 504].map(httpStatus => [{ errorCode: "E_HTTP", httpStatus }, new RegExp(`HTTP ${httpStatus}`)]),
  [undefined, /查询暂时异常/]
]) test(`query recovery ${initialFailure?.httpStatus ?? initialFailure?.errorCode ?? "legacy"} preserves drafts and permits stopping`, async () => {
  const state = timedView(); let recovering = false;
  const h = harness(msg => ({ ok: true, view: msg.type === "aircon:stop" ? idle : recovering ? { ...state, run: { ...state.run,
    queryRecovery: { id: "incident", initialFailure, deadline: Date.now() + 14000 }, recovery: { kind: "query" } } } : state }));
  await flush(); editTimes(h, 12, 4); recovering = true; h.changed(); await flush();
  assert.equal(h.panel.querySelectorAll("input")[0].value, "12");
  assert.equal(h.panel.querySelectorAll("input")[0].disabled, true);
  assert.equal(h.button("update").disabled, true); assert.equal(h.button("stop").disabled, false);
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, reason);
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /剩 1[34] 秒.*停止/);
  h.button("stop").handlers.click(); await flush(); assert.equal(h.button("start").disabled, false);
});

test("running inputs preserve drafts across countdown/state pushes and submit only on apply", async () => {
  let state = timedView(), finish;
  const calls = [];
  const h = harness(msg => {
    calls.push(msg);
    if (msg.type === "aircon:updateDurations") return new Promise(resolve => { finish = resolve; });
    return { ok: true, view: state };
  });
  await flush();
  assert.equal(h.panel.querySelectorAll("input")[0].disabled, false);
  assert.equal(String(h.panel.querySelectorAll("input")[0].value), "10");
  assert.equal(h.button("update").disabled, true);
  editTimes(h, 12, 4); h.changed(); h.intervals.forEach(fn => fn()); await flush();
  assert.equal(h.panel.querySelectorAll("input")[0].value, "12");
  assert.match(h.panel.querySelector(".ac-cycle-timing-hint").textContent, /尚未应用.*当前仍为开 10.*应用后当前阶段约剩/);
  assert.equal(calls.some(c => c.type === "aircon:updateDurations"), false);
  h.button("update").handlers.click(); h.button("update").handlers.click();
  assert.equal(calls.filter(c => c.type === "aircon:updateDurations").length, 1);
  assert.equal(h.button("update").disabled, true); assert.equal(h.button("stop").disabled, false);
  assert.equal(h.panel.querySelectorAll("input")[0].disabled, true);
  assert.equal(h.button("start").hidden, true);
  const request = calls.find(c => c.type === "aircon:updateDurations");
  assert.equal(request.runId, "editable-run"); assert.equal(request.timingRevision, 2);
  state = { ...state, run: { ...state.run, onMinutes: 12, offMinutes: 4, timingRevision: 3 } };
  finish({ ok: true, view: state }); await flush();
  assert.equal(h.button("update").disabled, true);
  assert.equal(h.panel.querySelector(".ac-cycle-timing-hint").hidden, true);
});

for (const phase of ["on", "off"]) test(`${phase} preview clearly identifies the immediate switch without applying input`, async () => {
  const calls = [], state = timedView(phase);
  const h = harness(msg => { calls.push(msg.type); return { ok: true, view: state }; });
  await flush(); editTimes(h, 5, 5);
  assert.match(h.panel.querySelector(".ac-cycle-timing-hint").textContent, phase === "on" ? /立即核验并关机/ : /立即核验并开机/);
  assert.equal(calls.includes("aircon:updateDurations"), false);
  editTimes(h, 0, 5); assert.equal(h.button("update").disabled, true);
});

test("stale apply adopts latest phase while retaining input for explicit resubmission", async () => {
  const state = timedView();
  const next = { ...state, run: { ...state.run, phase: "off", timingRevision: 3, phaseStartedAt: Date.now(), nextAt: Date.now() + 600000 } };
  const h = harness(msg => msg.type === "aircon:updateDurations"
    ? { ok: false, code: "E_TIMING_STALE", error: "阶段已变化，请核对后再次应用。", view: next }
    : { ok: true, view: state });
  await flush(); editTimes(h, 5, 4); h.button("update").handlers.click(); await flush();
  assert.equal(h.panel.querySelectorAll("input")[0].value, "5");
  assert.equal(h.button("update").disabled, false);
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "关机中");
});

test("stop during apply ignores the late successful reply", async () => {
  let finish;
  const state = timedView();
  const h = harness(msg => msg.type === "aircon:updateDurations" ? new Promise(resolve => { finish = resolve; })
    : { ok: true, view: msg.type === "aircon:stop" ? idle : state });
  await flush(); editTimes(h, 5, 4); h.button("update").handlers.click();
  h.button("stop").handlers.click(); await flush();
  finish({ ok: true, view: state }); await flush();
  assert.equal(h.button("update").hidden, true);
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "未运行");
});

for (const kind of ["recovery", "blocked", "unknown", "elsewhere"]) test(`${kind} disables running-time edits`, async () => {
  const state = timedView();
  if (kind === "recovery") state.run.recovery = { kind: "authentication" };
  if (kind === "blocked") state.blocked = true;
  if (kind === "unknown") state.notice = { text: "unknown", outcomeUnknown: true };
  if (kind === "elsewhere") state.elsewhere = true;
  const h = harness(() => ({ ok: true, view: state }));
  await flush(); editTimes(h, 5, 4);
  assert.equal(h.panel.querySelectorAll("input")[0].disabled, true);
  assert.equal(h.button("update").disabled, true);
});

test("apply communication failure retains submitted durations in the fallback report", async () => {
  const h = harness(msg => msg.type === "aircon:updateDurations" ? null : { ok: true, view: timedView() });
  await flush(); editTimes(h, 5, 4); h.button("update").handlers.click(); await flush();
  const saved = Object.values(h.reports).find(item => item.report?.communication?.messageType === "aircon:updateDurations").report;
  assert.deepEqual(JSON.parse(JSON.stringify(saved.requestedDurations)), { onMinutes: 5, offMinutes: 4 });
  assert.equal(saved.timingChange.outcome, "unknown");
  assert.equal(saved.timingChange.expectedRevision, 2);
  assert.equal(h.button("update").disabled, true);
});
const communicationCases = [
  { name: "missing receiver", reply: () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")), code: "E_BACKGROUND_NO_RECEIVER", reason: "NO_RECEIVER" },
  { name: "closed port", reply: () => { throw new Error("The message port closed before a response was received."); }, code: "E_BACKGROUND_DISCONNECTED", reason: "PORT_CLOSED" },
  { name: "closed asynchronous channel", reply: () => Promise.reject(new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received")), code: "E_BACKGROUND_DISCONNECTED", reason: "CHANNEL_CLOSED" },
  { name: "null reply", reply: () => null, code: "E_BACKGROUND_EMPTY_REPLY", reason: "NULL_REPLY" },
  { name: "undefined reply", reply: () => undefined, code: "E_BACKGROUND_EMPTY_REPLY", reason: "UNDEFINED_REPLY" },
  { name: "unknown rejection", reply: () => Promise.reject(new Error("SECRET Could not establish connection. Receiving end does not exist.")), code: "E_BACKGROUND_UNAVAILABLE", reason: "UNKNOWN" },
  { name: "invalidated context", reply: () => { throw new Error("Extension context invalidated."); }, code: "E_BACKGROUND_UNAVAILABLE", reason: "CONTEXT_INVALIDATED" },
  { name: "false reply is not an empty reply", reply: () => false, code: "E_BACKGROUND_INVALID_REPLY", reason: "INVALID_REPLY" },
  ...[
    ["missing view", { ok: true }], ["null view", { ok: true, view: null }], ["array view", { ok: true, view: [] }],
    ["incomplete view", { ok: true, view: {} }], ["invalid run", { ok: true, view: { ...idle, run: {} } }],
    ["missing ok", {}], ["nonboolean ok", { ok: "true", view: idle }], ["array reply", []],
    ["incomplete failure", { ok: false }]
  ].map(([name, value]) => ({ name, reply: () => value, code: "E_BACKGROUND_INVALID_REPLY", reason: "INVALID_REPLY" }))
];

function harness(onSend, DateImpl = Date, getDurations = async () => ({}), storageOverrides = {}, browserGlobals = {}) {
  const stats = { queries: 0, textWrites: 0 };
  const reports = {};
  const documentHandlers = {};
  const document = { activeElement: null, visibilityState: "visible", wasDiscarded: false, scripts: [] };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.handlers = {}; this.attributes = {}; this.isConnected = true; }
    append(...items) { this.children.push(...items); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    contains(item) { return this === item || this.children.some(child => child.contains(item)); }
    matches(selector) { return selector === 'button[role="switch"]' && this.tag === "button" && this.getAttribute("role") === "switch"; }
    closest(selector) { return this.matches(selector) ? this : null; }
    focus() { document.activeElement = this; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    get textContent() { return this.text || ""; }
    set textContent(value) { this.text = value; stats.textWrites++; }
    querySelectorAll(selector) {
      stats.queries++;
      return this.children.flatMap(item => [item, ...item.querySelectorAll("*")]).filter(item => {
        if (selector === "*") return true;
        if (selector === "input") return item.tag === "input";
        if (selector.startsWith(".")) return item.className === selector.slice(1);
        if (selector.startsWith("[data-action=")) return item.dataset.action === selector.slice(13, -1);
        if (selector.startsWith('[name="')) return item.name === selector.slice(7, -2);
        return false;
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  }
  const card = new Element("div");
  const nativeSwitch = new Element("button");
  nativeSwitch.setAttribute("role", "switch");
  nativeSwitch.setAttribute("aria-checked", "true");
  const contains = card.contains.bind(card);
  card.contains = item => item === nativeSwitch || contains(item);
  const location = { pathname: "/njggt/app/home" };
  const timers = new Map();
  const intervals = [];
  let onMessage;
  let onMutation;
  let onClick;
  let timerId = 0;
  vm.runInNewContext(source, {
    location,
    document: Object.assign(document, {
      createElement: tag => new Element(tag), getElementById: () => null,
      querySelectorAll: () => [{ textContent: "Air Conditioning Status", closest: () => card }],
      documentElement: {}, addEventListener(type, fn) { if (type === "click") onClick = fn; else documentHandlers[type] = fn; }
    }),
    MutationObserver: class { constructor(fn) { onMutation = fn; } observe() {} },
    chrome: {
      runtime: { sendMessage: message => Promise.resolve(onSend(message)), onMessage: { addListener(fn) { onMessage = fn; } } },
      storage: { local: {
        get: key => key === null ? Promise.resolve({ ...reports }) : getDurations(),
        set: async value => Object.assign(reports, value),
        remove: async keys => { for (const key of keys) delete reports[key]; }, ...storageOverrides
      } }
    },
    setInterval: fn => intervals.push(fn),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), Date: DateImpl, ...browserGlobals
  });
  return { card, timers, intervals, stats, reports, document, documentHandlers, location, nativeSwitch,
    mutate: (mutations = []) => onMutation(mutations), clickSwitch: (trusted = true) => onClick({ isTrusted: trusted, target: nativeSwitch }),
    get panel() { return card.children.at(-1); },
    reportChanged: status => onMessage({ type: "aircon:reportStatusChanged", status }),
    tokenReply: () => { let reply; onMessage({ type: "aircon:getToken" }, {}, value => { reply = value; }); return reply; },
    returned: () => onMessage({ type: "aircon:pageReturned" }),
    changed: () => onMessage({ type: "aircon:stateChanged" }), button: action => card.children.at(-1).querySelector(`[data-action=${action}]`) };
}

test("leaving home suppresses follow-up reads and same-document return initializes once", async () => {
  const calls = [];
  const h = harness(message => { calls.push(message.type); return { ok: true, view: idle }; });
  await flush(); calls.length = 0;
  h.location.pathname = "/njggt/app/login";
  h.changed(); h.returned(); await flush();
  assert.deepEqual(calls, []);
  h.location.pathname = "/njggt/app/home";
  h.returned(); h.returned(); await flush();
  assert.deepEqual(calls, ["aircon:initialize"]);
});

test("return while an older initialization is pending retries the cancelled check once", async () => {
  let release; const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    if (calls.length === 1) return new Promise(resolve => { release = resolve; });
    return { ok: true, view: idle };
  });
  await flush(); h.returned();
  release({ ok: false, code: "E_CANCELLED", error: "cancelled" });
  await flush(); await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:initialize"]);
});

test("page lifecycle and script errors emit sanitized evidence without extra control messages", async () => {
  const handlers = {}, calls = [];
  const h = harness(message => { calls.push(message); return { ok: true, view: idle }; }, Date, async () => ({}), {}, {
    URL, navigator: { onLine: false }, performance: { timeOrigin: 1000, getEntriesByType: () => [{ type: "reload" }] },
    localStorage: { getItem: () => JSON.stringify({ token: "SECRET", last_login: "2026-10-20T12:00:00Z", student: { email: "SECRET" } }) },
    addEventListener: (type, fn) => { handlers[type] = fn; }
  });
  await flush();
  h.document.scripts = [{ src: "https://w5.ab.ust.hk/njggt/app/static/js/main.c005f61e.chunk.js?SECRET" }];
  handlers.offline(); h.document.visibilityState = "hidden"; h.documentHandlers.visibilitychange();
  handlers.error({ filename: "https://w5.ab.ust.hk/njggt/app/static/js/main.c005f61e.chunk.js?SECRET", lineno: 42, colno: 7, message: "SECRET" });
  await flush();
  const telemetry = calls.filter(call => call.type === "aircon:telemetry");
  assert.deepEqual(telemetry.map(call => call.step), ["offline", "visibility", "scriptError"]);
  assert.equal(telemetry[0].evidence.online, false);
  assert.equal(telemetry[1].evidence.visibility, "hidden");
  assert.equal(telemetry[2].detail.script, "main.c005f61e.chunk.js");
  assert.equal(telemetry[2].detail.line, 42);
  assert.equal(JSON.stringify(calls).includes("SECRET"), false);
  assert.deepEqual(calls.filter(call => call.type !== "aircon:telemetry").map(call => call.type), ["aircon:initialize"]);
  const reply = h.tokenReply();
  assert.equal(reply.token, "SECRET", "token is returned only through the existing control RPC");
  assert.equal(reply.evidence.tokenPresent, true);
  assert.equal(JSON.stringify(reply.evidence).includes("SECRET"), false);
  h.documentHandlers.freeze(); h.documentHandlers.resume(); await flush();
  assert.deepEqual(calls.filter(call => call.type === "aircon:telemetry").slice(-2).map(call => call.step), ["freeze", "resume"]);
});

test("page resource timing ignores unrelated traffic and strips query parameters", async () => {
  let observe;
  const calls = [];
  const h = harness(message => { calls.push(message); return { ok: true, view: idle }; }, Date, async () => ({}), {}, {
    URL, performance: { timeOrigin: 1000 }, PerformanceObserver: class { constructor(callback) { observe = callback; } observe() {} }
  });
  await flush();
  observe({ getEntries: () => [
    { name: "https://private.example/SECRET", duration: 999 },
    { name: "https://w5.ab.ust.hk/njggt/api/app/prepaid/ac-status?SECRET", startTime: 2, duration: 10, requestStart: 4, responseStart: 8, responseEnd: 12 }
  ] });
  await flush();
  const message = calls.find(call => call.type === "aircon:telemetry");
  assert.equal(message.resources.length, 1);
  assert.equal(message.resources[0].url, "https://w5.ab.ust.hk/njggt/api/app/prepaid/ac-status");
  assert.equal(JSON.stringify(calls).includes("SECRET"), false);
  assert.equal(h.button("start").disabled, false);
});

test("invalidated extension context cannot recursively throw from telemetry", async () => {
  const handlers = {};
  harness(message => { if (message.type === "aircon:telemetry") throw new Error("Extension context invalidated"); return { ok: true, view: idle }; }, Date, async () => ({}), {}, {
    addEventListener: (type, callback) => { handlers[type] = callback; }
  });
  await flush();
  assert.doesNotThrow(() => handlers.offline());
  assert.doesNotThrow(() => handlers.unhandledrejection({ reason: "SECRET" }));
});

test("new page initializes once; panel remount only reads state", async () => {
  const calls = [];
  const h = harness(message => { calls.push(message.type); return { ok: true, view: idle }; });
  await flush();
  assert.deepEqual(calls, ["aircon:initialize"]);
  h.card.children[0].isConnected = false;
  h.mutate();
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:getState"]);
});

test("cleanup failure overrides an old running view and keeps stop available", async () => {
  const error = "[E_LOCAL_STORAGE] 循环清理失败，已禁止后续空调指令。";
  const h = harness(message => message.type === "aircon:stop"
    ? { ok: false, blocked: true, code: "E_LOCAL_STORAGE", error }
    : { ok: true, view: message.type === "aircon:initialize" ? running : { ...running, blocked: true, notice: { kind: "error", text: error } } });
  await flush(); h.button("stop").handlers.click(); await flush();
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "已中断");
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /已禁止后续开关指令/);
});

test("blocked initialization failure cannot offer a new start with an empty view", async () => {
  const h = harness(() => ({ ok: false, blocked: true, code: "E_LOCAL_STORAGE", error: "[E_LOCAL_STORAGE] 循环清理失败。" }));
  await flush();
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "已中断");
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
});

test("page timeout stages its fallback without overwriting a detailed backend report", async () => {
  let h, reportId, original;
  h = harness(message => {
    if (message.type === "aircon:start") {
      reportId = message.reportId;
      original = { report: { reportId, occurredAt: new Date().toISOString(), snapshotOrigin: "background", error: { code: "E_HTTP" }, requests: [{ httpStatus: 502 }] }, saved: true };
      h.reports[`airconErrorReport:${reportId}`] = original;
      return new Promise(() => {});
    }
    return { ok: true, view: idle };
  });
  await flush(); h.button("start").handlers.click(); await flush();
  [...h.timers.values()].find(timer => timer.ms > 34000 && timer.ms <= 35000).fn(); await flush();
  assert.deepEqual(h.reports[`airconErrorReport:${reportId}`], original);
  const fallback = h.reports[`airconErrorFallback:${reportId}`].report;
  assert.equal(fallback.snapshotOrigin, "page-cache");
  assert.equal(fallback.error.code, "E_BACKGROUND_TIMEOUT");
});

test("initial recovery is visible and can be cancelled before initialization returns", async () => {
  let finish;
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    if (message.type === "aircon:initialize") return new Promise(resolve => { finish = resolve; });
    return { ok: true, view: idle };
  });
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "恢复中");
  assert.equal(h.panel.querySelector(".ac-cycle-status").hidden, false);
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
  h.button("stop").handlers.click(); await flush();
  finish({ ok: true, view: running }); await flush();
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "未运行");
  assert.deepEqual(calls, ["aircon:initialize", "aircon:stop"]);
});

test("persisted interruption is labelled as the previous cycle instead of plain idle", async () => {
  const h = harness(() => ({ ok: true, view: { ...idle, notice: { previous: true, at: 1000, kind: "error", text: "[E_SESSION_ENDED] 会话已结束。" } } }));
  await flush();
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "已中断");
  assert.match(h.panel.querySelector(".ac-cycle-message").textContent, /上次循环.*E_SESSION_ENDED/);
});

test("a durable unknown-command notice disables start until the explicit stop reply", async () => {
  const h = harness(message => ({ ok: true, view: message.type === "aircon:stop" ? idle : {
    ...idle, notice: { kind: "error", outcomeUnknown: true, text: "[E_COMMAND_UNKNOWN] 开关结果未确认。" }
  } }));
  await flush();
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "待确认");
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
  h.button("stop").handlers.click(); await flush();
  assert.equal(h.button("start").disabled, false);
});

for (const scenario of communicationCases) {
  test(`startup classifies ${scenario.name} without another message or timer`, async () => {
    const calls = [];
    const h = harness(message => { calls.push(message.type); return scenario.reply(); });
    await flush();
    assert.match(h.panel.querySelector(".ac-cycle-message").textContent, new RegExp(scenario.code));
    const records = Object.values(h.reports);
    assert.equal(records.length, 1);
    const report = records[0].report;
    assert.equal(report.error.code, scenario.code);
    assert.equal(report.communication.messageType, "aircon:initialize");
    assert.equal(report.communication.reason, scenario.reason);
    assert.equal(report.outcomeUnknown, true);
    assert.equal(JSON.stringify(records).includes("SECRET"), false);
    assert.equal(h.timers.size, 0);
    h.intervals[0]();
    await flush();
    assert.deepEqual(calls, ["aircon:initialize"]);
  });

  test(`control ${scenario.name} retains unknown outcome until an explicit stop`, async () => {
    const calls = [];
    const h = harness(message => {
      calls.push(message.type);
      return message.type === "aircon:start" ? scenario.reply() : { ok: true, view: idle };
    });
    await flush();
    h.button("start").handlers.click();
    await flush();
    assert.match(h.panel.querySelector(".ac-cycle-message").textContent, new RegExp(scenario.code));
    assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /操作结果未确认/);
    assert.equal(h.button("start").disabled, true);
    assert.equal(h.button("stop").disabled, false);
    assert.deepEqual(calls, ["aircon:initialize", "aircon:start"], "no follow-up read or repeated command");
    const records = Object.values(h.reports);
    assert.equal(records.length, 1);
    assert.equal(records[0].report.error.code, scenario.code);
    assert.equal(records[0].report.communication.messageType, "aircon:start");
    assert.equal(records[0].report.communication.reason, scenario.reason);
    assert.equal(records[0].report.requestedDurations.onMinutes, 10);
    h.button("stop").handlers.click();
    await flush();
    assert.equal(h.button("start").disabled, false);
    assert.equal(h.button("stop").disabled, true);
    assert.equal(h.panel.querySelector(".ac-cycle-message").textContent, "");
    assert.deepEqual(calls, ["aircon:initialize", "aircon:start", "aircon:stop"]);
  });
}

test("UI bounds busy state, reports unknown outcome and keeps stop available", async () => {
  const h = harness(message => message.type === "aircon:start" ? new Promise(() => {}) : { ok: true, view: idle });
  await flush();
  h.button("start").handlers.click();
  await flush();
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
  const timeout = [...h.timers.values()].find(item => item.ms > 5000 && item.ms <= 35000);
  timeout.fn();
  await flush();
  assert.match(h.card.querySelector(".ac-cycle-message").textContent, /E_BACKGROUND_TIMEOUT/);
  assert.doesNotMatch(h.card.querySelector(".ac-cycle-status").textContent, /正在操作/);
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
  const report = Object.values(h.reports)[0].report;
  assert.equal(report.error.code, "E_BACKGROUND_TIMEOUT");
  assert.equal(report.communication.messageType, "aircon:start");
  assert.equal(report.communication.reason, "TIMEOUT");
  h.button("stop").handlers.click();
  await flush();
  assert.equal(h.button("start").disabled, false);
});

for (const scenario of [communicationCases[0], communicationCases[2], communicationCases[3], communicationCases.find(item => item.name === "missing view")]) {
  test(`late ${scenario.name} cannot overwrite a newer stop or cache an obsolete fault`, async () => {
    let finishStart;
    const h = harness(message => message.type === "aircon:start"
      ? new Promise(resolve => { finishStart = () => resolve(scenario.reply()); }) : { ok: true, view: idle });
    await flush();
    h.button("start").handlers.click();
    await flush();
    h.button("stop").handlers.click();
    await flush();
    finishStart();
    await flush();
    assert.equal(h.panel.querySelector(".ac-cycle-status").textContent, "循环未运行。");
    assert.equal(h.panel.querySelector(".ac-cycle-message").textContent, "");
    assert.equal(h.button("start").disabled, false);
    assert.equal(Object.keys(h.reports).length, 0);
  });
}

test("late channel rejection after timeout cannot change its code or create a second report", async () => {
  let rejectStart;
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    return message.type === "aircon:start" ? new Promise((_resolve, reject) => { rejectStart = reject; }) : { ok: true, view: idle };
  });
  await flush();
  h.button("start").handlers.click();
  await flush();
  [...h.timers.values()].find(item => item.ms > 5000 && item.ms <= 35000).fn();
  await flush();
  rejectStart(new Error("The message port closed before a response was received."));
  await flush();
  const records = Object.values(h.reports);
  assert.equal(records.length, 1);
  assert.equal(records[0].report.error.code, "E_BACKGROUND_TIMEOUT");
  assert.match(h.panel.querySelector(".ac-cycle-message").textContent, /E_BACKGROUND_TIMEOUT/);
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
  assert.deepEqual(calls, ["aircon:initialize", "aircon:start"]);
});

test("late startup response cannot replace a newer stop result", async () => {
  let finishStart;
  const h = harness(message => message.type === "aircon:start" ? new Promise(resolve => { finishStart = resolve; }) : { ok: true, view: idle });
  await flush();
  h.button("start").handlers.click();
  await flush();
  h.button("stop").handlers.click();
  await flush();
  finishStart({ ok: true, view: running });
  await flush();
  assert.equal(h.button("start").disabled, false);
  assert.equal(h.button("stop").disabled, true);
  assert.equal(h.card.querySelector(".ac-cycle-status").textContent, "循环未运行。");
});

test("click paints immediately and start waits for initialization", async () => {
  let finish;
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    if (message.type === "aircon:initialize") return new Promise(resolve => { finish = resolve; });
    return { ok: true, view: running };
  });
  await flush();
  h.button("start").handlers.click();
  assert.match(h.card.querySelector(".ac-cycle-status").textContent, /正在操作/);
  assert.match(h.card.querySelector(".ac-cycle-status").textContent, /最长等待 35 秒/);
  assert.equal(h.button("stop").disabled, false);
  assert.deepEqual(calls, ["aircon:initialize"]);
  finish({ ok: true, view: idle });
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:start"]);
  assert.match(h.card.querySelector(".ac-cycle-status").textContent, /开机阶段/);
});

test("initialization consumes the same 35-second click budget while state reads remain five seconds", async () => {
  let now = Date.now(), finish, finishStart;
  class TestDate extends Date { static now() { return now; } }
  const h = harness(message => {
    if (message.type === "aircon:initialize") return new Promise(resolve => { finish = resolve; });
    if (message.type === "aircon:start") return new Promise(resolve => { finishStart = resolve; });
    return new Promise(() => {});
  }, TestDate);
  await flush();
  assert.ok([...h.timers.values()].some(timer => timer.ms === 35000));
  h.button("start").handlers.click();
  now += 12000;
  finish({ ok: true, view: idle }); await flush();
  assert.ok([...h.timers.values()].some(timer => timer.ms === 23000));
  finishStart({ ok: true, view: idle }); await flush();
  h.changed(); await flush();
  assert.ok([...h.timers.values()].some(timer => timer.ms === 5000));
});

test("late initialization cannot override stop or release a cancelled start", async () => {
  let finish;
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    if (message.type === "aircon:initialize") return new Promise(resolve => { finish = resolve; });
    return { ok: true, view: idle };
  });
  await flush();
  h.button("start").handlers.click();
  h.button("stop").handlers.click();
  await flush();
  finish({ ok: true, view: running });
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:stop"]);
  assert.equal(h.card.querySelector(".ac-cycle-status").textContent, "循环未运行。");
});

test("successful refresh removes transient communication error", async () => {
  let fail = true;
  const h = harness(message => message.type === "aircon:getState" && fail
    ? { ok: false, code: "E_BACKGROUND_UNAVAILABLE", error: "[E_BACKGROUND_UNAVAILABLE] temporary" }
    : { ok: true, view: idle });
  await flush();
  h.changed();
  await flush();
  assert.match(h.card.querySelector(".ac-cycle-message").textContent, /temporary/);
  fail = false;
  h.changed();
  await flush();
  assert.equal(h.card.querySelector(".ac-cycle-message").textContent, "");
});

test("successful state refresh preserves a failed control's actionable error", async () => {
  const h = harness(message => message.type === "aircon:start"
    ? { ok: false, code: "E_AUTH", error: "[E_AUTH] please login" }
    : { ok: true, view: idle });
  await flush();
  h.button("start").handlers.click();
  await flush();
  await flush();
  assert.match(h.card.querySelector(".ac-cycle-message").textContent, /please login/);
});

test("state reply started during an action cannot overwrite its completed result", async () => {
  let finishRead;
  let finishStart;
  const h = harness(message => {
    if (message.type === "aircon:start") return new Promise(resolve => { finishStart = resolve; });
    if (message.type === "aircon:getState") return new Promise(resolve => { finishRead = resolve; });
    return { ok: true, view: idle };
  });
  await flush();
  h.button("start").handlers.click();
  await flush();
  h.panel.isConnected = false;
  h.mutate();
  await flush();
  finishStart({ ok: true, view: running });
  await flush();
  finishRead({ ok: true, view: idle });
  await flush();
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /开机阶段/);
});

test("long initialization cannot extend the click deadline or dispatch a late start", async () => {
  let now = Date.now();
  class TestDate extends Date { static now() { return now; } }
  let finish;
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    if (message.type === "aircon:initialize") return new Promise(resolve => { finish = resolve; });
    return { ok: true, view: idle };
  }, TestDate);
  await flush();
  h.button("start").handlers.click();
  now += 36000;
  finish({ ok: true, view: idle });
  await flush();
  assert.deepEqual(calls, ["aircon:initialize"]);
  assert.match(h.card.querySelector(".ac-cycle-message").textContent, /E_BACKGROUND_TIMEOUT/);
  assert.equal(h.button("stop").disabled, false);
});

test("late saved defaults cannot overwrite user input", async () => {
  let finish;
  const h = harness(() => ({ ok: true, view: idle }), Date, () => new Promise(resolve => { finish = resolve; }));
  const input = h.panel.querySelector('[name="onMinutes"]');
  assert.equal(Number(input.value), 10, "defaults are usable immediately");
  input.value = "6";
  input.handlers.input();
  finish({ cycleDurations: { onMinutes: 20, offMinutes: 30 } });
  await flush();
  assert.equal(input.value, "6");
});

test("new start can retry a previously failed initialization", async () => {
  let initializations = 0;
  const h = harness(message => {
    if (message.type === "aircon:initialize" && ++initializations === 1) {
      return { ok: false, code: "E_LOCAL_TIMEOUT", error: "temporary initialization error" };
    }
    return { ok: true, view: message.type === "aircon:start" ? running : idle };
  });
  await flush();
  h.button("start").handlers.click();
  await flush();
  assert.equal(initializations, 2);
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /开机阶段/);
  assert.equal(h.panel.querySelector(".ac-cycle-message").textContent, "");
});

test("action notifications reuse the final reply rather than request duplicate state", async () => {
  let finish;
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    if (message.type === "aircon:start") return new Promise(resolve => { finish = resolve; });
    return { ok: true, view: idle };
  });
  await flush();
  h.button("start").handlers.click();
  await flush();
  h.changed();
  h.changed();
  finish({ ok: true, view: running });
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:start"]);
});

test("unchanged countdown tick performs no DOM queries or text writes", async () => {
  class FixedDate extends Date { static now() { return 1000000; } }
  const h = harness(() => ({ ok: true, view: { ...idle, run: { phase: "on", nextAt: 1060000 } } }), FixedDate);
  await flush();
  const before = { ...h.stats };
  h.intervals[0]();
  assert.deepEqual(h.stats, before);
});

test("idle timer does no DOM work; mutation observer handles mounting", async () => {
  const h = harness(() => ({ ok: true, view: idle }));
  await flush();
  h.panel.isConnected = false;
  const before = { ...h.stats };
  h.intervals[0]();
  assert.deepEqual(h.stats, before);
  h.mutate();
  await flush();
  assert.equal(h.panel.isConnected, true);
});

test("lost background response is cached locally with stale state explicitly marked unknown", async () => {
  let fail = false;
  const h = harness(() => {
    if (fail) throw new Error("SECRET must not be stored");
    return { ok: true, view: running };
  });
  await flush();
  fail = true;
  h.changed();
  await flush();
  const records = Object.values(h.reports);
  assert.equal(records.length, 1);
  assert.equal(records[0].report.snapshotOrigin, "page-cache");
  assert.equal(records[0].report.outcomeUnknown, true);
  assert.equal(records[0].report.error.code, "E_BACKGROUND_UNAVAILABLE");
  assert.equal(records[0].report.cycle.phase, "on");
  assert.equal(JSON.stringify(records).includes("SECRET"), false);
});

test("backend-reported fault does not create a duplicate page report", async () => {
  const h = harness(message => message.type === "aircon:start"
    ? { ok: false, code: "E_HTTP", error: "HTTP 502", reportId: "server-report" } : { ok: true, view: idle });
  await flush();
  h.button("start").handlers.click();
  await flush();
  assert.equal(Object.keys(h.reports).length, 0);
});

test("invalid state reply preserves the last valid cycle view and records unknown outcome", async () => {
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    return message.type === "aircon:getState" ? { ok: true } : { ok: true, view: running };
  });
  await flush();
  h.changed();
  await flush();
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /开机阶段/);
  assert.match(h.panel.querySelector(".ac-cycle-message").textContent, /E_BACKGROUND_INVALID_REPLY/);
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").disabled, false);
  const records = Object.values(h.reports);
  assert.equal(records.length, 1);
  assert.equal(records[0].report.cycle.phase, "on");
  assert.equal(records[0].report.outcomeUnknown, true);
  assert.equal(records[0].report.communication.tabIsHome, true);
  assert.deepEqual(calls, ["aircon:initialize", "aircon:getState"]);
});

test("backend communication report ID is retained without a duplicate page report or follow-up read", async () => {
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    return message.type === "aircon:start"
      ? { ok: false, code: "E_BACKGROUND_INVALID_REPLY", error: "[E_BACKGROUND_INVALID_REPLY] failed", reportId: "backend-report" }
      : { ok: true, view: idle };
  });
  await flush();
  h.button("start").handlers.click();
  await flush();
  assert.equal(Object.keys(h.reports).length, 0);
  assert.match(h.panel.querySelector(".ac-cycle-message").textContent, /E_BACKGROUND_INVALID_REPLY/);
  assert.equal(h.button("stop").disabled, false);
  assert.deepEqual(calls, ["aircon:initialize", "aircon:start"]);
});

test("source rejection ends waiting without retry, follow-up read or duplicate report", async () => {
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    return message.type === "aircon:start"
      ? { ok: false, code: "E_MESSAGE_SOURCE", error: "[E_MESSAGE_SOURCE] request not executed", reportId: "source-report" }
      : { ok: true, view: idle };
  });
  await flush();
  h.button("start").handlers.click();
  await flush();
  assert.match(h.panel.querySelector(".ac-cycle-message").textContent, /E_MESSAGE_SOURCE/);
  assert.doesNotMatch(h.panel.querySelector(".ac-cycle-status").textContent, /正在操作|操作结果未确认/);
  assert.equal(h.button("start").disabled, false, "an explicitly rejected command was not executed");
  assert.equal(Object.keys(h.reports).length, 0);
  assert.deepEqual(calls, ["aircon:initialize", "aircon:start"]);
});

test("invalidated extension storage cannot mask the original communication error", async () => {
  const h = harness(() => { throw new Error("Extension context invalidated"); }, Date, async () => ({}), {
    set() { throw new Error("Extension context invalidated"); }
  });
  await flush();
  assert.match(h.card.querySelector(".ac-cycle-message").textContent, /E_BACKGROUND_UNAVAILABLE/);
  assert.match(h.card.querySelector(".ac-cycle-report-status").textContent, /缓存不可用/);
});

test("help is initially collapsed and disclosure sends no messages or resets on countdown", async () => {
  let now = Date.now();
  class TestDate extends Date { static now() { return now; } }
  const calls = [];
  const h = harness(message => { calls.push(message.type); return { ok: true, view: running }; }, TestDate);
  await flush();
  const toggle = h.panel.querySelector(".ac-cycle-help-toggle");
  const help = h.panel.querySelector(".ac-cycle-help");
  assert.equal(help.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.handlers.click();
  assert.equal(help.hidden, false);
  assert.equal(toggle.getAttribute("aria-controls"), help.id);
  toggle.focus();
  now += 1000;
  h.intervals[0]();
  assert.equal(help.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(h.document.activeElement, toggle);
  toggle.handlers.click();
  assert.equal(help.hidden, true);
  assert.deepEqual(calls, ["aircon:initialize"]);
});

test("idle, busy, running and stopped actions have the intended visibility and focus", async () => {
  let now = Date.now();
  class TestDate extends Date { static now() { return now; } }
  let finish;
  const h = harness(message => message.type === "aircon:start" ? new Promise(resolve => { finish = resolve; }) : { ok: true, view: idle }, TestDate);
  await flush();
  assert.equal(h.button("start").hidden, false);
  assert.equal(h.button("stop").hidden, true);
  assert.equal(h.panel.querySelector(".ac-cycle-status").hidden, true);
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "未运行");
  h.button("start").focus();
  h.button("start").handlers.click();
  await flush();
  assert.equal(h.button("start").hidden, false);
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").hidden, false);
  assert.equal(h.button("stop").disabled, false);
  assert.equal(h.document.activeElement, h.button("stop"));
  now += 4000;
  h.intervals[0]();
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /已等待 4 秒/);
  finish({ ok: true, view: running });
  await flush();
  assert.equal(h.button("start").hidden, true);
  assert.equal(h.button("stop").hidden, false);
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "开机中");
  h.button("stop").handlers.click();
  await flush();
  assert.equal(h.button("stop").hidden, true);
  assert.equal(h.document.activeElement, h.button("start"));
});

test("unknown outcome keeps full selectable error outside help and explicit stop available", async () => {
  const error = "[E_BACKGROUND_DISCONNECTED] 扩展通信通道在回复前关闭，操作可能已经执行。结果未确认，请停止循环或刷新页面。";
  const h = harness(message => message.type === "aircon:start"
    ? { ok: false, code: "E_BACKGROUND_DISCONNECTED", error, reportId: "existing-report" }
    : { ok: true, view: idle });
  await flush();
  h.button("start").handlers.click();
  await flush();
  assert.equal(h.panel.querySelector(".ac-cycle-help").hidden, true);
  const message = h.panel.querySelector(".ac-cycle-message");
  assert.ok(h.panel.children.includes(message));
  assert.equal(message.textContent, error);
  assert.equal(message.dataset.kind, "error");
  assert.equal(h.button("start").hidden, false);
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").hidden, false);
  assert.equal(h.button("stop").disabled, false);
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "待确认");
});

test("elsewhere state remains explicit and cannot start or stop that page's cycle", async () => {
  const h = harness(() => ({ ok: true, view: { ...idle, elsewhere: true } }));
  await flush();
  assert.equal(h.button("start").hidden, false);
  assert.equal(h.button("start").disabled, true);
  assert.equal(h.button("stop").hidden, true);
  assert.equal(h.button("stop").disabled, true);
  assert.equal(h.panel.querySelector(".ac-cycle-status").hidden, false);
  assert.match(h.panel.querySelector(".ac-cycle-status").textContent, /另一学校页面/);
  assert.equal(h.panel.querySelector(".ac-cycle-badge").textContent, "其他页面");
  assert.ok(h.panel.querySelectorAll("input").every(input => input.disabled));
});

for (const phase of ["loading", "ready", "saving", "permission", "cached", "directory-error", "write-error", "storage-error"]) {
  test(`report ${phase} shows only actionable issues outside help without masking cycle warnings`, async () => {
    const warning = "14:20 [E_API_TIMEOUT] 保活查询超时，循环仍在运行。";
    const h = harness(() => ({ ok: true, view: { ...running, notice: { kind: "warning", text: warning } } }));
    await flush();
    h.reportChanged({ phase, pending: phase === "cached" ? 2 : 0 });
    const problem = !["loading", "ready", "saving"].includes(phase);
    assert.equal(h.panel.querySelector(".ac-cycle-report-notice").hidden, !problem);
    assert.equal(h.panel.querySelector(".ac-cycle-help").hidden, true);
    assert.equal(h.panel.querySelector(".ac-cycle-message").textContent, warning);
    assert.equal(h.panel.querySelector(".ac-cycle-message").dataset.kind, "warning");
    if (phase === "cached") assert.match(h.panel.querySelector(".ac-cycle-report-status").textContent, /待保存 2 份/);
    if (phase === "storage-error") {
      h.panel.querySelector(".ac-cycle-report-action").handlers.click();
      assert.equal(h.panel.querySelector(".ac-cycle-help").hidden, false);
      assert.match(h.panel.querySelector(".ac-cycle-report-status").textContent, /重新加载扩展/);
    }
  });
}

test("both report settings entrances retain their explicit independent message", async () => {
  const calls = [];
  const h = harness(message => { calls.push(message.type); return { ok: true, view: idle }; });
  await flush();
  h.reportChanged({ phase: "permission", pending: 0 });
  h.panel.querySelector(".ac-cycle-report-action").handlers.click();
  h.panel.querySelector(".ac-cycle-help-toggle").handlers.click();
  h.panel.querySelector(".ac-cycle-report-settings").handlers.click();
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:openReportSettings", "aircon:openReportSettings"]);
});

test("resolved report notice returns focus to help when its action disappears", async () => {
  const h = harness(() => ({ ok: true, view: idle }));
  await flush();
  h.reportChanged({ phase: "cached", pending: 2 });
  h.panel.querySelector(".ac-cycle-report-action").focus();
  h.reportChanged({ phase: "ready", pending: 0 });
  assert.equal(h.panel.querySelector(".ac-cycle-report-notice").hidden, true);
  assert.equal(h.document.activeElement, h.panel.querySelector(".ac-cycle-help-toggle"));
});

test("saved durations and edited four-digit inputs survive disclosure, report and state renders", async () => {
  const h = harness(() => ({ ok: true, view: idle }), Date, async () => ({ cycleDurations: { onMinutes: 2, offMinutes: 4 } }));
  await flush();
  const inputs = h.panel.querySelectorAll("input");
  assert.deepEqual(inputs.map(input => Number(input.value)), [2, 4]);
  inputs[0].value = "1440";
  inputs[0].handlers.input();
  inputs[0].focus();
  h.panel.querySelector(".ac-cycle-help-toggle").handlers.click();
  h.reportChanged({ phase: "ready", pending: 0 });
  h.changed();
  await flush();
  assert.equal(inputs[0].value, "1440");
  assert.equal(h.document.activeElement, inputs[0]);
  assert.deepEqual(inputs.map(input => [input.type, input.min, input.max, input.step]), [["number", "1", "1440", "1"], ["number", "1", "1440", "1"]]);
});

for (const value of ["0", "1441", "1.5", ""]) {
  test(`invalid duration ${JSON.stringify(value)} remains visible without a control request`, async () => {
    const calls = [];
    const h = harness(message => { calls.push(message.type); return { ok: true, view: idle }; });
    await flush();
    h.panel.querySelectorAll("input")[0].value = value;
    h.button("start").handlers.click();
    await flush();
    assert.match(h.panel.querySelector(".ac-cycle-message").textContent, /1–1440/);
    assert.equal(h.panel.querySelector(".ac-cycle-help").hidden, true);
    assert.deepEqual(calls, ["aircon:initialize"]);
  });
}

const activeView = (id = "run-1", expectedOn = true) => ({ ...idle,
  run: { id, expectedOn, phase: expectedOn ? "on" : "off", nextAt: Date.now() + 120000 } });
const mutateSwitch = h => h.mutate([{ type: "attributes", attributeName: "aria-checked", target: h.nativeSwitch }]);
const manualTimer = h => [...h.timers.values()].find(item => item.ms === 1500);

for (const expectedOn of [true, false]) {
  test(`automatic display synchronization to ${expectedOn} issues no manual check or timer`, async () => {
    const calls = [];
    const h = harness(message => { calls.push(message.type); return { ok: true, view: activeView("run-1", expectedOn) }; });
    await flush();
    h.nativeSwitch.setAttribute("aria-checked", String(expectedOn));
    mutateSwitch(h);
    assert.equal(manualTimer(h), undefined);
    assert.deepEqual(calls, ["aircon:initialize"]);
  });
}

for (const displayed of ["false", undefined, "invalid"]) {
  test(`display ${String(displayed)} keeps one state check with sanitized observation`, async () => {
    const calls = [];
    const h = harness(message => { calls.push(message); return { ok: true, view: activeView() }; });
    await flush();
    h.nativeSwitch.setAttribute("aria-checked", displayed);
    mutateSwitch(h);
    await manualTimer(h).fn();
    await flush();
    const checks = calls.filter(message => message.type === "aircon:manualCheck");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].trigger, "stateChange");
    assert.equal(checks[0].observedOn, displayed === "false" ? false : null);
  });
}

test("a missing cycle expectation cannot suppress a display check", async () => {
  const calls = [];
  const state = activeView();
  delete state.run.expectedOn;
  const h = harness(message => { calls.push(message.type); return { ok: true, view: state }; });
  await flush();
  mutateSwitch(h);
  await manualTimer(h).fn();
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:manualCheck"]);
});

test("trusted click is checked even when subsequent display synchronization matches", async () => {
  const calls = [];
  const h = harness(message => { calls.push(message); return { ok: true, view: activeView() }; });
  await flush();
  h.clickSwitch(false);
  assert.equal(manualTimer(h), undefined);
  h.clickSwitch();
  const scheduled = manualTimer(h);
  mutateSwitch(h);
  assert.equal(manualTimer(h), scheduled, "matching sync does not postpone or discard the click");
  await scheduled.fn();
  await flush();
  const checks = calls.filter(message => message.type === "aircon:manualCheck");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].trigger, "click");
  assert.equal(checks[0].observedOn, true);
});

for (const clickFirst of [true, false]) {
  test(`click ${clickFirst ? "before" : "after"} mismatching DOM events wins one debounce`, async () => {
    const calls = [];
    const h = harness(message => { calls.push(message); return { ok: true, view: activeView() }; });
    await flush();
    h.nativeSwitch.setAttribute("aria-checked", "false");
    if (clickFirst) h.clickSwitch();
    mutateSwitch(h);
    if (!clickFirst) h.clickSwitch();
    const replaced = manualTimer(h);
    mutateSwitch(h);
    const current = manualTimer(h);
    assert.notEqual(current, replaced);
    await replaced.fn();
    assert.equal(calls.length, 1, "a superseded callback cannot consume the current check");
    await current.fn();
    await flush();
    const checks = calls.filter(message => message.type === "aircon:manualCheck");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].trigger, "click");
    assert.equal(checks[0].observedOn, false);
  });
}

test("a display-only debounce rechecks the final DOM value before contacting background", async () => {
  const calls = [];
  const h = harness(message => { calls.push(message.type); return { ok: true, view: activeView() }; });
  await flush();
  h.nativeSwitch.setAttribute("aria-checked", "false");
  mutateSwitch(h);
  const pending = manualTimer(h);
  h.nativeSwitch.setAttribute("aria-checked", "true");
  mutateSwitch(h);
  await pending.fn();
  await flush();
  assert.deepEqual(calls, ["aircon:initialize"]);
});

test("old cycle callback cannot check a new cycle or consume its new pending click", async () => {
  let state = activeView();
  const calls = [];
  const h = harness(message => { calls.push(message.type); return { ok: true, view: state }; });
  await flush();
  h.clickSwitch();
  const old = manualTimer(h);
  state = activeView("run-2");
  h.changed();
  await flush();
  assert.equal(manualTimer(h), undefined);
  h.clickSwitch();
  const current = manualTimer(h);
  await old.fn();
  assert.equal(manualTimer(h), current);
  assert.deepEqual(calls, ["aircon:initialize", "aircon:getState"]);
  await current.fn();
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:getState", "aircon:manualCheck"]);
});

test("stop and restart cancel the prior pending check even if the view is not cleared yet", async () => {
  let state = activeView();
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    if (message.type === "aircon:stop") state = idle;
    if (message.type === "aircon:start") state = activeView("run-2");
    return { ok: true, view: state };
  });
  await flush();
  h.clickSwitch();
  const old = manualTimer(h);
  h.button("stop").handlers.click();
  assert.equal(manualTimer(h), undefined);
  await flush();
  h.button("start").handlers.click();
  await flush();
  await old.fn();
  await flush();
  assert.deepEqual(calls, ["aircon:initialize", "aircon:stop", "aircon:start"]);
});

for (const reason of ["leave", "disconnect", "remount"]) {
  test(`${reason} invalidates an existing delayed manual check`, async () => {
    const calls = [];
    const h = harness(message => { calls.push(message.type); return { ok: true, view: activeView() }; });
    await flush();
    h.clickSwitch();
    const old = manualTimer(h);
    if (reason === "leave") h.location.pathname = "/njggt/app/login";
    else h.panel.isConnected = false;
    if (reason === "remount") { h.mutate(); await flush(); }
    await old.fn();
    await flush();
    assert.equal(calls.includes("aircon:manualCheck"), false);
  });
}

test("manual-check communication fallback caches its trigger without retrying", async () => {
  const calls = [];
  const h = harness(message => {
    calls.push(message.type);
    return message.type === "aircon:manualCheck" ? undefined : { ok: true, view: activeView() };
  });
  await flush();
  h.clickSwitch();
  await manualTimer(h).fn();
  await flush();
  const report = Object.values(h.reports)[0].report;
  assert.equal(report.error.code, "E_BACKGROUND_EMPTY_REPLY");
  assert.equal(report.extensionVersion, "1.1.21");
  assert.deepEqual(JSON.parse(JSON.stringify(report.manualCheck)), { trigger: "click", observedOn: true });
  assert.deepEqual(calls, ["aircon:initialize", "aircon:manualCheck"]);
});
