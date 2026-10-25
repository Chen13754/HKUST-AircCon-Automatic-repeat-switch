import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL(`../${name}.js`, import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const url = "https://w5.ab.ust.hk/njggt/api/app/prepaid/ac-status";
function harness({ bridgeFirst = true, fetchImpl } = {}) {
  const listeners = new Map(), messages = [], events = [];
  class Event { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  const window = {
    fetch: fetchImpl,
    addEventListener(type, callback) { const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set); },
    dispatchEvent(event) { events.push(event); for (const callback of [...(listeners.get(event.type) ?? [])]) callback(event); }
  };
  class XHR {
    constructor() { this.listeners = new Map(); this.responseType = ""; this.readyState = 0; }
    open(method, uri) { this.method = method; this.uri = uri; this.readyState = 1; return "opened"; }
    send(body) { this.body = body; return "sent"; }
    addEventListener(type, callback) { const set = this.listeners.get(type) ?? new Set(); set.add(callback); this.listeners.set(type, set); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    respond(text, status = 200) { this.status = status; this.responseText = text; this.readyState = 4; for (const type of ["readystatechange", "loadend"]) for (const callback of [...(this.listeners.get(type) ?? [])]) callback(); }
  }
  const globals = { window, CustomEvent: Event, location: { href: "https://w5.ab.ust.hk/njggt/app/home" }, URL, Date, setTimeout, clearTimeout, TextDecoder, Uint8Array, performance: { timeOrigin: 1000 } };
  const bridge = vm.createContext({ ...globals, chrome: { runtime: { sendMessage: message => { messages.push(structuredClone(message)); return Promise.resolve({ ok: true }); } } } });
  const main = vm.createContext({ ...globals, XMLHttpRequest: XHR });
  const connect = () => { vm.runInContext(read("report-format") + "\n" + read("page-bridge"), bridge); };
  if (bridgeFirst) connect();
  vm.runInContext(read("page-observer"), main);
  return { XHR, window, messages, events, bridge, connect };
}

for (const bridgeFirst of [true, false]) {
  test(`XHR business codes cross the bridge with ${bridgeFirst ? "early" : "late"} bridge initialization`, () => {
    const h = harness({ bridgeFirst });
    const xhr = new h.XHR();
    assert.equal(xhr.open("GET", url + "?token=SECRET"), "opened");
    assert.equal(xhr.send(), "sent");
    xhr.respond(JSON.stringify({ meta: { code: 4031, message: "SECRET" }, data: { token: "SECRET", student: "SECRET" } }));
    if (!bridgeFirst) h.connect();
    const replies = h.messages.filter(message => message.kind === "response");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].response.schoolCode, 4031);
    assert.equal(replies[0].response.httpStatus, 200);
    assert.equal(replies[0].response.transport, "xhr");
    assert.equal(replies[0].response.path, "/app/prepaid/ac-status");
    assert.equal(JSON.stringify(h.messages).includes("SECRET"), false);
    assert.equal(h.bridge.AirconObserverReady, true);
    assert.ok(h.messages.every(message => message.type === "aircon:pageDiagnostic"));
  });
}

test("XHR non-whitelist traffic is ignored and malformed or oversized bodies stay metadata only", () => {
  const h = harness();
  for (const [path, body] of [["https://private.example/SECRET", "SECRET"], [url, "<html>SECRET</html>"], [url, "x".repeat(65537)]]) {
    const xhr = new h.XHR(); xhr.open("GET", path); xhr.send(); xhr.respond(body);
  }
  assert.deepEqual(h.messages.filter(m => m.kind === "response").map(m => m.response.result), ["invalid-json", "too-large"]);
  assert.equal(JSON.stringify(h.messages).includes("SECRET"), false);
});

test("fetch keeps its exact promise and readable response while diagnostics reads a bounded clone", async () => {
  const response = new Response(JSON.stringify({ meta: { code: 4032 }, token: "SECRET" }), { status: 200 });
  const promise = Promise.resolve(response);
  const h = harness({ fetchImpl: () => promise });
  assert.equal(h.window.fetch(url), promise);
  assert.equal((await (await promise).json()).token, "SECRET", "original body remains usable by the school");
  for (let i = 0; i < 20 && !h.messages.some(m => m.kind === "response"); i++) await flush();
  assert.equal(h.messages.find(m => m.kind === "response").response.schoolCode, 4032);
  assert.equal(JSON.stringify(h.messages).includes("SECRET"), false);
});

test("fetch failure remains the original rejection and a large clone is cut off", async () => {
  const error = new Error("network SECRET");
  const failed = Promise.reject(error);
  const h = harness({ fetchImpl: () => failed });
  await assert.rejects(h.window.fetch(url), value => value === error);
  await flush();
  assert.equal(h.messages.find(m => m.kind === "response").response.result, "network-error");
  const large = harness({ fetchImpl: () => Promise.resolve(new Response("x".repeat(70000))) });
  await large.window.fetch(url);
  for (let i = 0; i < 20 && !large.messages.some(m => m.kind === "response"); i++) await flush();
  assert.equal(large.messages.find(m => m.kind === "response").response.result, "too-large");
});

test("page-controlled bridge input is filtered and rate bounded without producing controls", () => {
  const h = harness();
  const payload = { kind: "response", response: { path: "/app/auth/cas/auth", method: "POST", schoolCode: 200, headers: "SECRET", token: "SECRET", url: "SECRET" } };
  for (let i = 0; i < 200; i++) h.window.dispatchEvent({ type: "aircon-diagnostic-v2", detail: JSON.stringify(payload) });
  assert.equal(h.messages.filter(m => m.kind === "response").length, 120);
  assert.equal(JSON.stringify(h.messages).includes("SECRET"), false);
  assert.ok(h.messages.every(m => m.type === "aircon:pageDiagnostic"));
});
