/** 客户端错误上报 + 全局错误钩子（错误进 host 文件日志，测试点 X1/调试闭环）。 */
const API = "/api/trading";

export function report(level, message, context) {
  try {
    fetch(`${API}/log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, message: String(message), context }),
    }).catch(() => {});
  } catch { /* 上报失败不影响主流程 */ }
}

export function initGlobalErrorHook() {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) =>
    report("error", e.message, { file: e.filename, line: e.lineno, col: e.colno }));
  window.addEventListener("unhandledrejection", (e) =>
    report("error", "unhandledrejection", String(e.reason)));
}
