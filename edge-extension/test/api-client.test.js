import test from "node:test";
import assert from "node:assert/strict";
import { createSchoolApi } from "../api-client.js";
import { bounded, CycleError } from "../errors.js";

const response = data => ({ ok: true, status: 200, json: async () => ({ meta: { code: 200 }, data }) });

for (const method of ["readTimer", "readStatus"]) {
  for (const bodyHangs of [false, true]) {
    test(`${method} recovers from one ${bodyHangs ? "body" : "headers"} timeout with a fresh token`, async () => {
      const controller = new AbortController();
      controller.signal.diagnostic = { requests: [] };
      const calls = [];
      let tokens = 0, finish;
      const api = createSchoolApi({ getToken: async () => `token-${++tokens}`, requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
        fetchImpl: async (_url, opts) => {
          calls.push(opts);
          if (calls.length === 1) {
            const late = new Promise(resolve => { finish = resolve; });
            return bodyHangs ? { ok: true, status: 200, json: () => late } : late;
          }
          return response({ ac_status: { DisconnectRelay: true } });
        }
      });
      assert.equal(await api[method](8, controller.signal), method === "readStatus" ? true : null);
      assert.equal(tokens, 2);
      assert.deepEqual(calls.map(call => call.headers.Authorization), ["Bearer token-1", "Bearer token-2"]);
      assert.equal(calls[0].signal.aborted, true);
      assert.notEqual(calls[0].signal, calls[1].signal);
      const traces = controller.signal.diagnostic.requests;
      assert.deepEqual(traces.map(trace => [trace.attempt, trace.errorCode]), [[1, "E_API_TIMEOUT"], [2, null]]);
      const before = structuredClone(traces);
      finish(bodyHangs ? { meta: { code: 200 }, data: {} } : response({}));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(traces, before);
    });
  }
}

for (const bodyHangs of [false, true]) {
  test(`POST ${bodyHangs ? "body" : "headers"} timeout never retries`, async () => {
    let calls = 0, transport;
    const api = createSchoolApi({ getToken: async () => "token", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
      fetchImpl: async (_url, opts) => {
        calls++; transport = opts.signal;
        return bodyHangs ? { ok: true, status: 200, json: () => new Promise(() => {}) } : new Promise(() => {});
      }
    });
    await assert.rejects(api.setStatus(8, false), { code: "E_API_TIMEOUT" });
    assert.equal(calls, 1);
    assert.equal(transport.aborted, true);
  });
}

test("cancellation while refreshing the retry token cannot dispatch another GET", async () => {
  const controller = new AbortController();
  controller.signal.diagnostic = { requests: [] };
  let tokens = 0, calls = 0, finishToken, entered;
  const retrying = new Promise(resolve => { entered = resolve; });
  const api = createSchoolApi({ requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
    getToken: (_tab, signal) => {
      if (++tokens === 1) return "token-1";
      return bounded(() => new Promise(resolve => { finishToken = resolve; entered(); }), { signal });
    },
    fetchImpl: async () => { calls++; return new Promise(() => {}); }
  });
  const result = assert.rejects(api.readStatus(8, controller.signal), { code: "E_CANCELLED" });
  await retrying;
  controller.abort(new CycleError("E_CANCELLED", "stop"));
  await result;
  finishToken("token-2");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(controller.signal.diagnostic.requests.map(trace => [trace.attempt, trace.errorCode]), [[1, "E_API_TIMEOUT"], [2, "E_CANCELLED"]]);
});

test("a second attempt authentication rejection stops without a third request", async () => {
  let calls = 0;
  const api = createSchoolApi({ getToken: async () => "token", requestTimeoutMs: 10, switchRequestTimeoutMs: 10,
    fetchImpl: async () => ++calls === 1 ? new Promise(() => {}) : { ok: false, status: 401 }
  });
  await assert.rejects(api.readTimer(8), { code: "E_AUTH" });
  assert.equal(calls, 2);
});

test("production contract and omitted school timer remain compatible", async () => {
  const calls = [];
  const api = createSchoolApi({ getToken: async () => "test-token", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("ac-status")) return response({ ac_status: { DisconnectRelay: true } });
    if (url.endsWith("ac-timer")) return response({ ac_timer_action: null });
    return response({ ac_toggle: { Message: "Execution succeeded" } });
  } });
  assert.equal(await api.readStatus(8), true);
  assert.equal(await api.readTimer(8), null);
  await api.setStatus(8, false);
  assert.ok(calls.every(call => call.url.startsWith("https://w5.ab.ust.hk/njggt/api/")));
  assert.equal(calls[2].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].options.body), { toggle: { status: 0 } });
});

for (const bodyHangs of [false, true]) {
  test(`GET ${bodyHangs ? "body" : "headers"} timeout retries once and aborts both transports`, async () => {
    const signals = [], finishes = [];
    let calls = 0;
    let bodyReads = 0;
    const controller = new AbortController();
    controller.signal.diagnostic = { requests: [] };
    const api = createSchoolApi({ getToken: async () => "test-token", requestTimeoutMs: 10, switchRequestTimeoutMs: 10, fetchImpl: async (_url, opts) => {
      calls++;
      signals.push(opts.signal);
      const late = new Promise(resolve => { finishes.push(resolve); });
      return bodyHangs ? { ok: true, status: 200, json: () => { bodyReads++; return late; } } : late;
    } });
    await assert.rejects(api.readStatus(8, controller.signal), error => error.code === "E_API_TIMEOUT" && error.message.includes("第 2 次读取"));
    assert.ok(signals.every(signal => signal.aborted));
    const traces = controller.signal.diagnostic.requests;
    assert.deepEqual(traces.map(trace => trace.attempt), [1, 2]);
    for (const trace of traces) {
      assert.equal(trace.phase, bodyHangs ? "body" : "headers");
      assert.equal(trace.httpStatus, bodyHangs ? 200 : null);
      assert.equal(trace.errorCode, "E_API_TIMEOUT");
      assert.equal(typeof trace.elapsedMs, "number");
    }
    const before = structuredClone(traces);
    for (const finish of finishes) finish(bodyHangs ? { meta: { code: 200 }, data: {} } : { ok: true, status: 200, json: async () => { bodyReads++; return {}; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(traces, before, "late completion cannot rewrite the timeout evidence");
    assert.equal(bodyReads, bodyHangs ? 2 : 0);
    assert.equal(calls, 2, "only one retry");
  });
}

for (const [name, reply, code] of [
  ["HTML 401", { ok: false, status: 401 }, "E_AUTH"],
  ["HTTP 503", { ok: false, status: 503 }, "E_HTTP"],
  ["malformed JSON", { ok: true, status: 200, json: async () => { throw new Error("bad JSON"); } }, "E_JSON"],
  ["school login code", { ok: true, status: 200, json: async () => ({ meta: { code: 4031 } }) }, "E_AUTH"],
  ["school rejection", { ok: true, status: 200, json: async () => ({ meta: { code: 40399 } }) }, "E_API_REJECTED"],
  ["invalid status", response({ ac_status: { DisconnectRelay: "true" } }), "E_STATUS_FORMAT"]
]) {
  test(`${name} returns a diagnostic code`, async () => {
    let calls = 0;
    const api = createSchoolApi({ getToken: async () => "test-token", fetchImpl: async () => { calls++; return reply; } });
    await assert.rejects(api.readStatus(8), { code });
    assert.equal(calls, 1, "non-timeout failures do not retry");
  });
}

test("cancelled token read cannot issue a late POST", async () => {
  let resolveToken;
  let calls = 0;
  const controller = new AbortController();
  const api = createSchoolApi({ getToken: (_tab, signal) => bounded(() => new Promise(resolve => { resolveToken = resolve; }), { signal }), fetchImpl: async () => { calls++; return response({}); } });
  const pending = assert.rejects(api.setStatus(8, true, controller.signal), { code: "E_CANCELLED" });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new CycleError("E_CANCELLED", "cancelled"));
  await pending;
  resolveToken("test-token");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("page timeout and network failure have different codes", async () => {
  const pageApi = createSchoolApi({ getToken: () => bounded(() => new Promise(() => {}), { ms: 10, code: "E_PAGE_TIMEOUT", stage: "读取登录" }) });
  await assert.rejects(pageApi.readStatus(8), { code: "E_PAGE_TIMEOUT" });
  let calls = 0;
  const networkApi = createSchoolApi({ getToken: async () => "test-token", fetchImpl: async () => { calls++; throw new Error("network"); } });
  await assert.rejects(networkApi.readStatus(8), { code: "E_NETWORK" });
  assert.equal(calls, 1);
});

for (const code of ["E_CANCELLED", "E_PAGE_RELOADING", "E_OPERATION_TIMEOUT", "E_QUERY_RECOVERY_TIMEOUT"]) test(`${code} records parent cancellation rather than a request timeout`, async () => {
  const controller = new AbortController(); controller.signal.diagnostic = { requests: [] };
  const api = createSchoolApi({ getToken: async () => "token", fetchImpl: () => new Promise(() => {}), requestTimeoutMs: 1000, switchRequestTimeoutMs: 1000 });
  const pending = assert.rejects(api.readStatus(8, controller.signal), { code });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(new CycleError(code, "cancel")); await pending;
  const trace = controller.signal.diagnostic.requests[0];
  assert.equal(trace.cancellationOrigin, "parent"); assert.equal(trace.cancelledBy, code);
  assert.ok(trace.cancelledAt >= trace.startedAt && trace.cancelledAt <= trace.endedAt);
  assert.equal(controller.signal.diagnostic.requests.length, 1);
});

test("invalid timer data is not retried", async () => {
  let calls = 0;
  const api = createSchoolApi({ getToken: async () => "test-token", fetchImpl: async () => { calls++; return response(null); } });
  await assert.rejects(api.readTimer(8), { code: "E_TIMER_FORMAT" });
  assert.equal(calls, 1);
});

for (const [name, token, fetchReply, phase, code] of [
  ["token failure", () => { throw new CycleError("E_AUTH", "expired"); }, response({}), "token", "E_AUTH"],
  ["HTTP rejection", () => "token", { ok: false, status: 502 }, "validation", "E_HTTP"],
  ["invalid JSON", () => "token", { ok: true, status: 200, json: async () => { throw new Error("invalid"); } }, "body", "E_JSON"],
  ["school rejection", () => "token", { ok: true, status: 200, json: async () => ({ meta: { code: 40399 } }) }, "validation", "E_API_REJECTED"],
  ["success", () => "token", response({ ac_status: { DisconnectRelay: true } }), "complete", null]
]) {
  test(`request phase identifies ${name}`, async () => {
    const controller = new AbortController();
    controller.signal.diagnostic = { requests: [] };
    let calls = 0;
    const api = createSchoolApi({ getToken: async () => token(), fetchImpl: async () => { calls++; return fetchReply; } });
    if (code) await assert.rejects(api.readStatus(8, controller.signal), { code });
    else assert.equal(await api.readStatus(8, controller.signal), true);
    const trace = controller.signal.diagnostic.requests[0];
    assert.equal(trace.phase, phase);
    assert.equal(trace.errorCode, code);
    assert.equal(trace.dispatched, phase !== "token");
    assert.equal(calls, phase === "token" ? 0 : 1);
  });
}

for (const bodyHangs of [false, true]) test(`default POST accepts a 9s ${bodyHangs ? "body" : "header"} response with a 15s budget`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  let finish, calls = 0;
  const parent = new AbortController(); parent.signal.diagnostic = { requests: [], command: {} };
  const api = createSchoolApi({ getToken: async () => "mock", performanceImpl: { now: () => Date.now() }, fetchImpl: async () => {
    calls++;
    const pending = new Promise(resolve => { finish = resolve; });
    return bodyHangs ? { ok: true, status: 200, json: () => pending } : pending;
  } });
  const task = api.setStatus(8, false, parent.signal);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(9000);
  finish(bodyHangs ? { meta: { code: 200 }, data: { ac_toggle: { Message: "Execution succeeded" } } } : response({ ac_toggle: { Message: "Execution succeeded" } }));
  await task;
  assert.equal(calls, 1);
  assert.equal(parent.signal.diagnostic.requests[0].timeoutMs, 15000);
  assert.equal(parent.signal.diagnostic.requests[0].elapsedMs, 9000);
});

for (const method of ["readStatus", "setStatus"]) test(`${method} retains its independent default deadline and ignores late completion`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const parent = new AbortController(); parent.signal.diagnostic = { requests: [], command: {} };
  const finishes = [], signals = [];
  const api = createSchoolApi({ getToken: async () => "mock", performanceImpl: { now: () => Date.now() }, fetchImpl: async (_url, options) => {
    signals.push(options.signal); return new Promise(resolve => finishes.push(resolve));
  } });
  const task = method === "setStatus" ? api.setStatus(8, false, parent.signal) : api.readStatus(8, parent.signal);
  const rejected = assert.rejects(task, { code: "E_API_TIMEOUT" });
  await new Promise(resolve => setImmediate(resolve));
  const budget = method === "setStatus" ? 15000 : 8000;
  t.mock.timers.tick(budget); await new Promise(resolve => setImmediate(resolve));
  if (method === "readStatus") { t.mock.timers.tick(budget); await new Promise(resolve => setImmediate(resolve)); }
  await rejected;
  assert.equal(signals.length, method === "setStatus" ? 1 : 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(parent.signal.diagnostic.requests.every(trace => trace.timeoutMs === budget));
  const before = structuredClone(parent.signal.diagnostic.requests);
  finishes.forEach(finish => finish(response({ ac_toggle: { Message: "Execution succeeded" }, ac_status: { DisconnectRelay: false } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(parent.signal.diagnostic.requests, before);
});

for (const code of ["E_CANCELLED", "E_OPERATION_TIMEOUT"]) test(`15s POST respects earlier ${code} without retransmission`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const parent = new AbortController(); parent.signal.diagnostic = { requests: [], command: {} };
  let calls = 0;
  const api = createSchoolApi({ getToken: async () => "mock", fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  const rejected = assert.rejects(api.setStatus(8, false, parent.signal), { code });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000); parent.abort(new CycleError(code, "simulated")); await rejected;
  assert.equal(calls, 1); assert.equal(parent.signal.diagnostic.requests[0].cancellationOrigin, "parent");
  assert.equal(parent.signal.diagnostic.requests[0].cancelledBy, code);
});
