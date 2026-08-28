/** client 入口：模块级单例看板 + sidebar 底部按钮。
 *
 * 设计要点（修复"堆看板"）：
 * - 看板 open 状态是模块级单例（不是每个按钮实例一份 useState）：
 *   无论 sidebar footer 槽有多少个 TradingButton 实例（重复注册 /
 *   宽窄模式重挂载 / hot reload 重入），所有按钮共享同一个开关。
 * - DashboardApp 通过 react-dom 的 createRoot 渲染在 document.body 顶层的
 *   唯一容器里（全局只有一个看板 root），任何时刻至多渲染一个看板：
 *   打开新看板前旧的会被同一 root 替换，天然"先关旧再开新"。
 * - hot reload 版本轮询、autoreopen、关闭事件全部模块级单例初始化，
 *   杜绝多实例各自轮询/各自刷新。
 */
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp } from "./app.jsx";
import { initGlobalErrorHook } from "./report.js";
initGlobalErrorHook();

// ── 模块级单例：看板开合状态 ────────────────────────────────────────

const listeners = new Set();
let isOpen = false;

function getOpen() {
  return isOpen;
}

function setOpen(value) {
  const next = !!value;
  if (next === isOpen) return;
  isOpen = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── 看板互斥协议（与教师看板 teacher-calendar / teacher-portfolio 共用） ──
// 教师插件用 dsh:overlay-open 全局面板事件做互斥：面板打开时广播自己的 id，
// 监听者发现"别人打开且自己开着"→ 被动关闭，且不恢复 grid（把布局留给新面板）。
// 交易看板同样广播/监听，从而实现 教师↔交易 互切互关。
const OVERLAY_ID = "trading-dashboard";
let passiveClose = false;   // 本次关闭是否因别的面板抢占（跳过布局恢复）

/** 打开：先广播互斥事件让其他面板关掉自己；关闭：安静关闭。 */
function openExclusive(value) {
  if (value) {
    window.dispatchEvent(new CustomEvent("dsh:overlay-open", { detail: { id: OVERLAY_ID } }));
  }
  setOpen(value);
}

if (typeof window !== "undefined") {
  window.addEventListener("dsh:overlay-open", (e) => {
    if (e.detail && e.detail.id !== OVERLAY_ID && getOpen()) {
      window.__tdPassiveClose = true;   // app.jsx 卸载时据此跳过 restore
      setOpen(false);
    }
  });
}

// 挂载时若有"热插拔自动恢复"标记 → 自动打开（一次性）
function maybeRestoreOpen() {
  if (localStorage.getItem("td:autoreopen") === "1") {
    localStorage.removeItem("td:autoreopen");
    openExclusive(true);
  }
}

// ── 模块级单例：看板渲染 root（document.body 顶层，全应用唯一） ────────

let overlayHost = null;   // body 下的容器 div
let overlayRoot = null;   // createRoot(overlayHost)

function ensureOverlayRoot() {
  if (overlayRoot && overlayHost && overlayHost.isConnected) return overlayRoot;
  overlayHost = document.createElement("div");
  overlayHost.id = "td-dashboard-root";
  overlayHost.style.cssText = "position:fixed;inset:0;z-index:9000;pointer-events:none;";
  document.body.appendChild(overlayHost);
  overlayRoot = createRoot(overlayHost);
  return overlayRoot;
}

/** 把"当前 open 状态"渲染进唯一看板 root：打开渲染看板，关闭清空。 */
function renderDashboard() {
  const root = ensureOverlayRoot();
  root.render(isOpen
    ? h(DashboardApp, { onClose: () => setOpen(false) })
    : null);
}

// 状态变更即同步到唯一 root（模块级一次性订阅，与按钮实例数无关）
subscribe(renderDashboard);

// ── 模块级单例：hot reload 版本轮询（全应用只跑一份） ──────────────────

let pollStarted = false;
function startVersionPoll() {
  if (pollStarted) return;
  pollStarted = true;
  let seen = null;
  const poll = async () => {
    try {
      const r = await fetch("/api/trading/hot/version").then((x) => x.json());
      if (seen === null) {
        seen = r.version;
      } else if (r.version > seen) {
        // 刷新前记录看板开关状态，刷新后自动恢复
        localStorage.setItem("td:autoreopen", isOpen ? "1" : "0");
        location.reload();
        return;
      }
    } catch {
      /* 端点不可用则跳过 */
    }
    setTimeout(poll, 3000);
  };
  poll();
}

// ── 侧边栏按钮：只负责开关单例状态，不渲染看板本体 ─────────────────────

function TradingButton({ wide = true }) {
  const open = useSyncExternalStore(subscribe, getOpen);
  return h("span", null,
    h("button", {
      type: "button",
      onClick: () => (open ? setOpen(false) : openExclusive(true)),
      title: open ? "收起交易看板" : "交易看板",
      style: {
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        padding: "8px 12px", border: "none", borderRadius: 10,
        background: open ? "rgba(244,89,86,.16)" : "transparent",
        color: "inherit", cursor: "pointer", fontSize: 14, fontWeight: open ? 600 : 400,
      },
    },
    h("span", { style: { fontSize: 16 } }, "📈"),
    wide ? h("span", null, "交易看板") : null));
}

// ── 插件入口：幂等注册（重复 apply 只注册一次） ────────────────────────

let applied = false;

export function apply(ctx) {
  if (applied) return;
  applied = true;

  maybeRestoreOpen();
  startVersionPoll();
  // 双向绑定：shell 侧边栏收起（用户点 shell 收起按钮）→ 关闭看板
  window.addEventListener("td:close-dashboard", () => setOpen(false));

  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register({ name: "sidebar.footer.action", id: "trading-dashboard", order: 30 }, TradingButton));
}

export const inject = ["slots"];