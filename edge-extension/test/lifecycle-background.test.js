import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "./storage-fixture.js";
import { bounded } from "../errors.js";

const home = "https://w5.ab.ust.hk/njggt/app/home";
const flush = () => new Promise(resolve => setImmediate(resolve));
let imports = 0;

async function harness(t) {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  const session = {}, local = {}, alarms = new Map(), posts = [], tokenDocuments = [], updates = [];
  const tab = { id: 8, url: home, autoDiscardable: true, frozen: false, discarded: false };
  let actual = false, documentId = "doc-1", listener, alarm, updated, removed, startup;
  let storageChanged;
  const localArea = memoryStorage(local);
  globalThis.chrome = {
    storage: {
      session: memoryStorage(session),
      local: { ...localArea, set: async values => { await localArea.set(values); storageChanged?.(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), "local"); } },
      onChanged: { addListener(fn) { storageChanged = fn; } }
    },
    tabs: {
      get: async () => ({ ...tab }),
      update: async (_tabId, values) => { updates.push(values); Object.assign(tab, values); return { ...tab }; },
      sendMessage: async (_tabId, message, options) => {
        if (message.type !== "aircon:getToken") return;
        tokenDocuments.push(options?.documentId);
        assert.equal(options?.documentId, documentId, "token is read from the current document");
        return { token: "PRIVATE_TEST_TOKEN" };
      },
      onUpdated: { addListener(fn) { updated = fn; } }, onRemoved: { addListener(fn) { removed = fn; } }
    },
    alarms: {
      get: async name => alarms.get(name), create: async (name, values) => alarms.set(name, { ...values, scheduledTime: values.when }),
      clear: async name => alarms.delete(name), onAlarm: { addListener(fn) { alarm = fn; } }
    },
    runtime: {
      id: "lifecycle-test", getManifest: () => ({ version: "1.1.10" }), sendMessage: async () => undefined,
      onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener(fn) { startup = fn; } }
    }
  };
  globalThis.fetch = async (url, options) => {
    if (options.method === "POST") { actual = JSON.parse(options.body).toggle.status === 1; posts.push(actual); }
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data: url.endsWith("ac-status") ? { ac_status: { DisconnectRelay: actual } } :
      url.endsWith("toggle-status") ? { ac_toggle: { Message: "Execution succeeded" } } : {} }) };
  };
  const load = () => import(`../background.js?lifecycle-${++imports}`);
  await load();
  const send = (type, data = {}, doc = documentId) => new Promise(resolve => listener({ type, onMinutes: 1, offMinutes: 120, ...data }, {
    id: "lifecycle-test", frameId: 0, documentId: doc, url: home, tab: { ...tab }
  }, resolve));
  return { session, local, alarms, posts, tokenDocuments, updates, tab, send, load,
    set document(value) { documentId = value; },
    update: change => updated(8, change, { ...tab }), close: () => removed(8), startup: () => startup(),
    alarm: name => alarm({ name }),
    until: condition => bounded(async () => { while (!condition()) await flush(); await flush(); }, { ms: 1000 }) };
}

test("real background message flow resumes a reloaded document without resetting or re-sending", async t => {
  const h = await harness(t);
  assert.equal((await h.send("aircon:initialize")).ok, true);
  const start = await h.send("aircon:start");
  assert.equal(start.ok, true);
  const before = structuredClone(h.session.cycleRun);
  assert.equal(h.tab.autoDiscardable, false);
  h.update({ status: "loading" });
  await h.until(() => h.session.cycleRun?.recovery);
  assert.ok((await h.send("aircon:getState")).view.run.recovery);
  h.document = "doc-2";
  const resumed = await h.send("aircon:initialize", { lifecycle: { event: "initialize", navigationType: "reload", wasDiscarded: true, arbitrary: "SECRET" } });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.view.run.nextAt, before.nextAt);
  assert.equal(resumed.view.run.id, before.id);
  assert.equal(resumed.view.run.recovery, null);
  assert.deepEqual(h.posts, [true]);
  assert.equal(h.tokenDocuments.at(-1), "doc-2");
  const reads = h.tokenDocuments.length;
  await h.send("aircon:initialize", {}, "doc-1");
  assert.equal(h.tokenDocuments.length, reads);
  assert.equal(JSON.stringify(h.local).includes("PRIVATE_TEST_TOKEN"), false);
  assert.equal(JSON.stringify(h.local).includes("SECRET"), false);
  await h.send("aircon:stop");
  assert.equal(h.tab.autoDiscardable, true);
});

for (const event of ["navigation", "closed"]) {
  test(`${event} persists its reason and report across a new document`, async t => {
    const h = await harness(t); await h.send("aircon:start");
    if (event === "navigation") h.update({ url: "https://w5.ab.ust.hk/njggt/app/top-up" });
    else h.close();
    await h.until(() => !h.session.cycleRun && h.local.cycleCheckpoint?.active === false);
    h.document = "doc-2";
    const view = (await h.send("aircon:initialize")).view;
    assert.match(view.notice.text, /页面已关闭或离开/);
    assert.equal(h.local.cycleCheckpoint.notice.kind, "warning");
    const reports = Object.values(h.local).filter(value => value?.report);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].report.lifecycle.event, event);
    assert.equal(reports[0].report.error.code, "E_PAGE_CLOSED");
    assert.equal(h.tab.autoDiscardable, true);
    assert.deepEqual(h.posts, [true]);
  });
}

for (const sameDocument of [true, false]) {
  test(`school authentication returns ${sameDocument ? "in the same document" : "through CAS and a new document"} without a new toggle`, async t => {
    const h = await harness(t); await h.send("aircon:start");
    const before = structuredClone(h.session.cycleRun);
    const navigate = url => { h.tab.url = url; h.update({ url }); };
    navigate("https://w5.ab.ust.hk/njggt/app/login?path=/home");
    await h.until(() => h.session.cycleRun?.recovery?.kind === "authentication");
    const deadline = h.session.cycleRun.recovery.deadline;
    if (!sameDocument) {
      navigate("https://cas.ust.hk/cas/login?service=SECRET");
      await h.load();
      navigate("https://w5.ab.ust.hk/njggt/app/callback/cas?ticket=SECRET");
      h.document = "doc-2";
    }
    navigate(home);
    const result = await h.send("aircon:initialize");
    assert.equal(result.ok, true);
    assert.equal(h.session.cycleRun.id, before.id);
    assert.equal(h.session.cycleRun.nextAt, before.nextAt);
    assert.equal(h.session.cycleRun.startedAt, before.startedAt);
    assert.equal(h.session.cycleRun.recovery, null);
    assert.deepEqual(h.posts, [true]);
    await h.until(() => Object.values(h.local).some(value => value?.report?.source === "authRecovery"));
    const report = Object.values(h.local).find(value => value?.report?.source === "authRecovery").report;
    assert.equal(report.recovered, true);
    assert.equal(report.cycle.recovery.deadline, deadline);
    assert.equal(report.diagnostics.targetTabId, 8);
    assert.equal(report.faultBoundary.boundary, "authentication-flow");
    assert.equal(JSON.stringify(h.local).includes("SECRET"), false);
    await h.send("aircon:stop");
  });
}

test("page diagnostics use browser identity and never suspend the running tab", async t => {
  const h = await harness(t); await h.send("aircon:start");
  const before = structuredClone(h.session.cycleRun);
  // Direct controller behavior is also covered by the recovery unit tests;
  // the diagnostic bridge must use the browser sender, not page-supplied IDs.
  await h.send("aircon:pageDiagnostic", { kind: "response", response: { path: "/app/prepaid/ac-status", method: "GET", tabId: 99, documentId: "spoof", schoolCode: 4031 } });
  await h.until(() => h.local.airconDiagnosticJournal?.pageResponses?.length);
  assert.equal(h.local.airconDiagnosticJournal.pageResponses[0].tabId, 8);
  assert.equal(h.local.airconDiagnosticJournal.pageResponses[0].documentId, "doc-1");
  assert.deepEqual(h.session.cycleRun, before);
  await h.send("aircon:stop");
});

test("onStartup detects browser-session loss and never recreates the persisted cycle", async t => {
  const h = await harness(t); await h.send("aircon:start");
  for (const key of Object.keys(h.session)) delete h.session[key];
  await h.load(); h.startup();
  await h.until(() => h.local.cycleCheckpoint?.active === false);
  assert.match((await h.send("aircon:initialize")).view.notice.text, /E_SESSION_ENDED/);
  assert.equal(h.tab.autoDiscardable, true);
  assert.equal(h.alarms.size, 0);
  assert.deepEqual(h.posts, [true]);
});

test("a discarded tab records recovery without trusting an unload callback", async t => {
  const h = await harness(t); await h.send("aircon:start");
  h.tab.discarded = true; h.update({ discarded: true });
  await h.until(() => h.session.cycleRun?.recovery);
  assert.equal(h.local.cycleCheckpoint.run.lifecycle.event, "discarded");
  assert.equal(h.local.cycleCheckpoint.run.lifecycle.discarded, true);
  assert.equal([...h.alarms.keys()].some(key => key.startsWith("recovery:")), true);
  await h.send("aircon:stop");
});
