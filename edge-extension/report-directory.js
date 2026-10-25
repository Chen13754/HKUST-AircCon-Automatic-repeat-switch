import { bounded } from "./errors.js";

function transaction(mode, work) {
  return bounded(signal => new Promise((resolve, reject) => {
    const opening = indexedDB.open("aircon-report-directory", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("settings");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      if (signal.aborted) { db.close(); return; }
      let tx;
      let result;
      try {
        tx = db.transaction("settings", mode);
        const request = work(tx.objectStore("settings"));
        request.onsuccess = () => { result = request.result; };
      }
      catch (error) { db.close(); reject(error); return; }
      const abort = () => { try { tx.abort(); } catch { /* Already completed. */ } };
      signal.addEventListener("abort", abort, { once: true });
      const close = () => { signal.removeEventListener("abort", abort); db.close(); };
      tx.oncomplete = () => { close(); resolve(result); };
      tx.onabort = tx.onerror = () => { close(); reject(tx.error || new Error("目录记录读取失败")); };
    };
  }), { ms: 2000, code: "REPORT_STORAGE_TIMEOUT", stage: "报告目录存储" });
}

export const getReportDirectory = () => transaction("readonly", store => store.get("directory"));
export const setReportDirectory = handle => transaction("readwrite", store => store.put(handle, "directory"));

export async function writeReportFile(directory, report, filename, timeoutMs = 5000) {
  return bounded(async signal => {
    if (!directory || await directory.queryPermission({ mode: "readwrite" }) !== "granted") {
      throw Object.assign(new Error("请选择报告目录并允许写入。"), { code: "REPORT_PERMISSION" });
    }
    signal.throwIfAborted();
    const file = await directory.getFileHandle(filename, { create: true });
    signal.throwIfAborted();
    const writable = await file.createWritable();
    const abort = () => { writable.abort().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await writable.write(JSON.stringify(report, null, 2) + "\n");
      signal.throwIfAborted();
      await writable.close();
      signal.throwIfAborted();
    } catch (error) { abort(); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }, { ms: timeoutMs, code: "REPORT_FILE_TIMEOUT", stage: "写入错误报告" });
}
