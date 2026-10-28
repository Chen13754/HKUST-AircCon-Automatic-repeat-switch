// MAIN world, document_start. Observe only numeric business codes; never send
// tokens, account data, headers, response text or URL query strings to the bridge.
// Nothing from this observer is used to authorize a control operation.
(() => {
  const EVENT = "aircon-diagnostic-v2", CONNECT = "aircon-diagnostic-connect-v2";
  const LIMIT = 65536;
  const allowed = new Set(["/app/prepaid/ac-status", "/app/prepaid/ac-timer", "/app/prepaid/ac-balance", "/app/prepaid/toggle-status", "/app/prepaid/fcu-settings", "/app/auth/cas/url", "/app/auth/cas/auth"]);
  let connected = false;
  const pending = [];
  const dispatch = value => { try { window.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(value) })); } catch { /* Diagnostic only. */ } };
  const emit = value => {
    if (connected) dispatch(value);
    else { pending.push(value); if (pending.length > 32) pending.shift(); }
  };
  window.addEventListener(CONNECT, () => {
    if (connected) return;
    connected = true; dispatch({ kind: "ready" });
    for (const item of pending.splice(0)) dispatch(item);
  });
  function pathOf(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== "https://w5.ab.ust.hk" || !url.pathname.startsWith("/njggt/api/")) return null;
      const path = url.pathname.slice("/njggt/api".length);
      return allowed.has(path) ? path : null;
    } catch { return null; }
  }
  function summarize(record, status, value, result = "json") {
    emit({ kind: "response", response: { ...record, endedAt: Date.now(), httpStatus: status,
      schoolCode: Number.isSafeInteger(value?.meta?.code) ? value.meta.code : null, result,
      switchAccepted: record.method === "POST" && record.path === "/app/prepaid/toggle-status" && typeof value?.data?.ac_toggle?.Message === "string"
        ? value.meta?.code === 200 && value.data.ac_toggle.Message === "Execution succeeded" : null,
      actualOn: record.method === "GET" && record.path === "/app/prepaid/ac-status" && typeof value?.data?.ac_status?.DisconnectRelay === "boolean" ? value.data.ac_status.DisconnectRelay : null } });
  }
  function parse(record, status, text) {
    if (text.length > LIMIT) return summarize(record, status, null, "too-large");
    try { summarize(record, status, JSON.parse(text)); }
    catch { summarize(record, status, null, "invalid-json"); }
  }
  if (typeof XMLHttpRequest === "function") {
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    const requests = new WeakMap();
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      const result = Reflect.apply(open, this, [method, url, ...args]);
      requests.set(this, { path: pathOf(url), method: String(method).toUpperCase() });
      return result;
    };
    XMLHttpRequest.prototype.send = function(...args) {
      const meta = requests.get(this);
      if (!meta?.path || !["GET", "POST"].includes(meta.method)) return Reflect.apply(send, this, args);
      const record = { ...meta, transport: "xhr", startedAt: Date.now() };
      let done = false;
      const finish = () => {
        if (done || this.readyState !== 4) return;
        done = true; this.removeEventListener("readystatechange", finish);
        this.removeEventListener("loadend", finish);
        try {
          if (!this.status) summarize(record, null, null, "network-error");
          else if (this.responseType === "json") summarize(record, this.status, this.response);
          else if (!this.responseType || this.responseType === "text") parse(record, this.status, this.responseText);
          else summarize(record, this.status, null, "unavailable");
        } catch { summarize(record, null, null, "unavailable"); }
      };
      this.addEventListener("readystatechange", finish);
      this.addEventListener("loadend", finish);
      try { return Reflect.apply(send, this, args); }
      catch (error) {
        this.removeEventListener("readystatechange", finish); this.removeEventListener("loadend", finish);
        summarize(record, null, null, "network-error"); throw error;
      }
    };
  }
  if (typeof window.fetch === "function") {
    const fetch = window.fetch;
    async function inspect(record, response) {
      let reader, timer;
      try {
        if (Number(response.headers.get("content-length")) > LIMIT) return summarize(record, response.status, null, "too-large");
        reader = response.clone().body?.getReader();
        if (!reader) return summarize(record, response.status, null, "unavailable");
        let size = 0; const chunks = [];
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("observer timeout")), 8000); });
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), timeout]);
          if (done) break;
          size += value.byteLength;
          if (size > LIMIT) return summarize(record, response.status, null, "too-large");
          chunks.push(value);
        }
        const body = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        parse(record, response.status, new TextDecoder().decode(body));
      } catch { summarize(record, response.status, null, "unavailable"); }
      finally { clearTimeout(timer); try { reader?.cancel()?.catch(() => {}); } catch { /* Best effort. */ } }
    }
    window.fetch = function(input, init) {
      const promise = Reflect.apply(fetch, this, arguments);
      try {
        const path = pathOf(typeof input === "string" || input instanceof URL ? input : input?.url);
        const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
        if (path && ["GET", "POST"].includes(method)) {
          const record = { path, method, transport: "fetch", startedAt: Date.now() };
          promise.then(response => inspect(record, response), () => summarize(record, null, null, "network-error")).catch(() => {});
        }
      } catch { /* Preserve the exact original promise and outcome. */ }
      return promise;
    };
  }
  dispatch({ kind: "ready" });
})();
