// ISOLATED world. Revalidate page-controlled messages; the browser sender supplies
// tab/document identity in background.js. This bridge never sends control types.
(() => {
  const format = globalThis.AirconReportFormat;
  let connected = false, windowAt = Date.now(), count = 0;
  function forward(data) {
    try { Promise.resolve(chrome.runtime.sendMessage({ type: "aircon:pageDiagnostic", ...data })).catch(() => {}); } catch { /* Extension was reloaded. */ }
  }
  window.addEventListener("aircon-diagnostic-v2", event => {
    try {
      if (typeof event.detail !== "string" || event.detail.length > 4096) return;
      const value = JSON.parse(event.detail);
      if (value.kind === "ready") {
        if (connected) return;
        connected = true;
        globalThis.AirconObserverReady = true;
        forward({ kind: "ready", evidence: { at: Date.now(), contentObservedAt: Date.now(), route: format.pageRoute(location.href),
          documentStartedAt: performance.timeOrigin, responseObserver: true } });
        window.dispatchEvent(new CustomEvent("aircon-diagnostic-connect-v2"));
      } else if (value.kind === "response") {
        if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); count = 0; }
        if (++count > 120) return;
        const response = format.pageResponse(value.response);
        if (response.path && response.method) forward({ kind: "response", response });
      }
    } catch { /* Untrusted page input must not affect the school UI. */ }
  });
  window.dispatchEvent(new CustomEvent("aircon-diagnostic-connect-v2"));
})();
