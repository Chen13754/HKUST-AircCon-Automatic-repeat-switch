import { API_BASE } from "./api-config.js";
import { timerFromSchoolData, hasNativeTimer } from "./cycle.js";
import { bounded, CycleError } from "./errors.js";

export function createSchoolApi({ getToken, fetchImpl = fetch, requestTimeoutMs = 8000, switchRequestTimeoutMs = 15000, retryGetTimeouts = true, diagnostics, performanceImpl = globalThis.performance, clock = () => Date.now() }) {
  let sequence = 0;
  const monotonic = () => performanceImpl?.now?.() ?? Date.now();
  const event = (context, trace, step) => { try { diagnostics?.requestEvent(context, trace, step); } catch { /* Best effort. */ } };
  async function request(tabId, path, method = "GET", body, signal, validate = value => value) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      try { return await requestOnce(tabId, path, method, body, signal, attempt, validate); }
      catch (error) {
        if (!retryGetTimeouts || method !== "GET" || error.code !== "E_API_TIMEOUT" || attempt === 2) throw error;
        // A fresh attempt reads the current token and gets its own I/O deadline.
        // Parent cancellation and the operation deadline still take precedence.
        signal?.throwIfAborted();
      }
    }
  }

  async function requestOnce(tabId, path, method, body, signal, attempt, validate) {
    const context = signal?.diagnostic;
    const timeoutMs = method === "POST" ? switchRequestTimeoutMs : requestTimeoutMs;
    const startedAt = clock();
    const monoStart = monotonic();
    let phaseStart = monoStart, fetchStart, requestSignal, onAbort;
    const trace = { method, path, attempt, sequence: ++sequence, startedAt, endedAt: null, timeoutMs,
      phase: "token", timings: {}, httpStatus: null, schoolCode: null, elapsedMs: null, dispatched: false, errorCode: null };
    const onParentAbort = () => {
      trace.cancelledAt ??= clock();
      trace.cancelledBy ??= signal.reason?.code;
      trace.cancellationOrigin ??= "parent";
    };
    signal?.addEventListener("abort", onParentAbort, { once: true });
    const closePhase = () => {
      const key = `${trace.phase}Ms`;
      if (["tokenMs", "headersMs", "bodyMs", "parseMs", "validationMs"].includes(key)) trace.timings[key] = (trace.timings[key] ?? 0) + Math.max(0, monotonic() - phaseStart);
      phaseStart = monotonic();
    };
    const phase = value => { closePhase(); trace.phase = value; event(context, trace, "requestPhase"); };
    if (context) { context.requests.push(trace); if (context.requests.length > 10) context.requests.shift(); }
    event(context, trace, "beginRequest");
    try {
      const token = await getToken(tabId, signal);
      signal?.throwIfAborted();
      const stage = `${method} ${path}${attempt === 2 ? "（第 2 次读取）" : ""}`;
      return await bounded(async localSignal => {
        requestSignal = localSignal;
        onAbort = () => {
          trace.cancelledAt ??= clock();
          trace.cancelledBy = requestSignal.reason?.code;
          trace.cancellationOrigin = signal?.aborted ? "parent" : "request-timeout";
        };
        requestSignal.addEventListener("abort", onAbort, { once: true });
        requestSignal.throwIfAborted();
        if (context?.readOnlyVerification && clock() >= context.readDeadlineAt) {
          throw new CycleError("E_OPERATION_TIMEOUT", "只读核验已到期限，不再发送查询。");
        }
        if (method === "POST" && context?.dispatchDeadlineAt !== undefined && clock() >= context.dispatchDeadlineAt) {
          throw new CycleError("E_QUERY_RECOVERY_TIMEOUT", "查询恢复已到期限，不再发送开关指令。");
        }
        let response;
        try {
          fetchStart = monotonic();
          phase("headers");
          trace.dispatched = true;
          if (method === "POST" && context?.command) context.command.sent = true;
          response = await fetchImpl(`${API_BASE}${path}`, {
            method,
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            ...(body ? { body: JSON.stringify(body) } : {}),
            cache: "no-store", signal: requestSignal
          });
        } catch {
          requestSignal.throwIfAborted();
          throw new CycleError("E_NETWORK", `${stage} 连接失败；请检查网络和学校网页是否可用。`);
        }
        requestSignal.throwIfAborted();
        trace.httpStatus = response.status;
        phase("validation");
        const type = response.headers?.get?.("Content-Type") ?? "";
        let route = "unknown";
        try {
          const url = new URL(response.url);
          route = url.origin === new URL(API_BASE).origin && url.pathname === `/njggt/api${path}` ? "expected" : /\/login(?:\/|$)|\/cas(?:\/|$)/.test(url.pathname) ? "login" : "other";
        } catch { /* Mock or opaque response. */ }
        const length = response.headers?.get?.("Content-Length");
        trace.response = { contentType: /json/i.test(type) ? "json" : /html/i.test(type) ? "html" : /text/i.test(type) ? "text" : type ? "other" : "unknown",
          contentLength: length !== null && length !== undefined && /^\d+$/.test(length) ? Number(length) : null, redirected: response.redirected, route };
        if (response.status === 401 || response.status === 403) throw new CycleError("E_AUTH", `${stage} 认证或访问权限异常（HTTP ${response.status}），请在学校页面确认登录与权限。`);
        if (!response.ok) throw new CycleError("E_HTTP", `${stage} 学校服务返回 HTTP ${response.status}。`);
        let result;
        phase("body");
        try {
          if (typeof response.text === "function") {
            const text = await response.text();
            requestSignal.throwIfAborted();
            trace.response.bodyBytes = new TextEncoder().encode(text).byteLength;
            phase("parse");
            result = JSON.parse(text);
          } else result = await response.json();
        }
        catch {
          requestSignal.throwIfAborted();
          throw new CycleError("E_JSON", `${stage} 未返回有效 JSON。`);
        }
        requestSignal.throwIfAborted();
        phase("validation");
        trace.schoolCode = Number.isSafeInteger(result?.meta?.code) ? result.meta.code : null;
        trace.businessError = globalThis.AirconReportFormat.extractBusinessError(result, path, method);
        if (path === "/app/prepaid/toggle-status" && typeof result?.data?.ac_toggle?.Message === "string") trace.switchAccepted = result.meta?.code === 200 && result.data.ac_toggle.Message === "Execution succeeded";
        if ([4031, 4032].includes(result?.meta?.code)) throw new CycleError("E_AUTH", `${stage} 登录失效（学校代码 ${result.meta.code}），请重新登录。`);
        if (result?.meta?.code !== 200) throw new CycleError("E_API_REJECTED", `${stage} 操作被拒绝（学校代码 ${result?.meta?.code ?? "缺失"}）。`);
        const value = validate(result.data);
        if (path === "/app/prepaid/ac-status") trace.actualOn = value;
        if (path === "/app/prepaid/ac-timer") trace.timerPresent = hasNativeTimer(value);
        phase("complete");
        return value;
      }, { signal, ms: timeoutMs, code: "E_API_TIMEOUT", stage: `${stage} 等待学校响应（包括响应正文）` });
    } catch (error) {
      trace.errorCode = error?.code || "E_INTERNAL";
      error.businessError = trace.businessError ?? null;
      if (["E_API_REJECTED", "E_SWITCH_REJECTED"].includes(error.code) && trace.businessError?.text) error.message += ` 学校说明：${trace.businessError.text}`;
      // Bind recovery decisions to this exact failed request, never another trace.
      error.requestSequence = trace.sequence;
      if (signal?.aborted && !trace.cancelledBy) {
        trace.cancelledBy = signal.reason?.code;
        trace.cancelledAt = clock();
        trace.cancellationOrigin = "parent";
      }
      if (error.code === "E_API_TIMEOUT" && fetchStart !== undefined) trace.timings.timeoutOvershootMs = Math.max(0, monotonic() - fetchStart - timeoutMs);
      throw error;
    }
    finally {
      signal?.removeEventListener("abort", onParentAbort);
      if (onAbort) requestSignal.removeEventListener("abort", onAbort);
      closePhase();
      trace.endedAt = clock(); trace.elapsedMs = trace.endedAt - startedAt;
      trace.timings.monotonicElapsedMs = monotonic() - monoStart;
      trace.timings.clockDeltaMs = trace.elapsedMs - trace.timings.monotonicElapsedMs;
      event(context, trace, "endRequest");
    }
  }

  return {
    async readStatus(tabId, signal) {
      return request(tabId, "/app/prepaid/ac-status", "GET", undefined, signal, data => {
        const status = data?.ac_status?.DisconnectRelay;
        if (typeof status !== "boolean") throw new CycleError("E_STATUS_FORMAT", "无法识别学校返回的空调状态。");
        return status;
      });
    },
    async readTimer(tabId, signal) {
      return request(tabId, "/app/prepaid/ac-timer", "GET", undefined, signal, timerFromSchoolData);
    },
    async setStatus(tabId, on, signal) {
      await request(tabId, "/app/prepaid/toggle-status", "POST", { toggle: { status: on ? 1 : 0 } }, signal, data => {
        if (data?.ac_toggle?.Message !== "Execution succeeded") throw new CycleError("E_SWITCH_REJECTED", "学校未确认开关操作成功；请自行确认空调状态。");
      });
    }
  };
}
