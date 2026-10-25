import { setReportDirectory } from "./report-directory.js";
import { bounded } from "./errors.js";

const choose = document.getElementById("choose");
const retry = document.getElementById("retry");
const status = document.getElementById("status");
const error = document.getElementById("error");
const labels = {
  loading: "正在读取保存状态…", permission: "请选择报告目录并允许写入。",
  saving: "正在保存错误报告…", ready: "自动保存已就绪。",
  "directory-error": "无法读取报告目录，请重新选择。",
  "write-error": "文件写入失败，报告仍在插件缓存中，可重试保存。",
  "storage-error": "无法访问插件报告缓存，请重新加载扩展后检查。"
};

function render(value) {
  status.textContent = [labels[value?.phase] || labels.loading,
    value?.directoryName ? `目录：${value.directoryName}` : "",
    `待保存：${value?.pending ?? 0} 份`, value?.lastFile ? `最近文件：${value.lastFile}` : ""
  ].filter(Boolean).join("\n");
}

async function send(type) {
  try {
    const reply = await bounded(() => chrome.runtime.sendMessage({ type }), { ms: 5000, stage: "读取报告保存状态" });
    if (!reply?.ok) throw new Error();
    render(reply.status);
  } catch { error.textContent = "无法连接扩展后台，请重新加载扩展后再打开此设置页。"; }
}

choose.addEventListener("click", async () => {
  error.textContent = "";
  if (typeof window.showDirectoryPicker !== "function") { error.textContent = "当前浏览器不支持目录写入，请使用新版 Edge。"; return; }
  choose.disabled = true;
  try {
    // Invoke the picker directly from this trusted click, before other awaits.
    const directory = await window.showDirectoryPicker({ id: "aircon-error-reports", mode: "readwrite" });
    await setReportDirectory(directory);
    await send("aircon:reportsFlush");
  } catch (failure) {
    if (failure.name !== "AbortError") error.textContent = "目录授权或保存失败，请重新选择并允许写入。";
  } finally { choose.disabled = false; }
});
retry.addEventListener("click", () => { error.textContent = ""; send("aircon:reportsFlush"); });
chrome.runtime.onMessage.addListener(message => { if (message?.type === "aircon:reportStatusChanged") render(message.status); });
send("aircon:reportsStatus");
