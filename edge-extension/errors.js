export class CycleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function describeError(error) {
  return `[${error?.code || "E_INTERNAL"}] ${error?.message || "扩展内部异常"}`;
}

// Race non-cancellable page messages too. A late reply must never continue an
// expired operation; fetch additionally receives the signal to abort its I/O.
export async function bounded(work, { signal, ms = 5000, code = "E_TIMEOUT", stage = "操作" } = {}) {
  if (signal?.aborted) throw signal.reason;
  const local = new AbortController();
  const abort = () => local.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => local.abort(new CycleError(code, `${stage}超过 ${ms / 1000} 秒未完成。`)), ms);
  let rejectAbort;
  const interrupted = new Promise((_, reject) => {
    rejectAbort = () => reject(local.signal.reason);
    local.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      local.signal.throwIfAborted();
      return work(local.signal);
    }), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    local.signal.removeEventListener("abort", rejectAbort);
  }
}
