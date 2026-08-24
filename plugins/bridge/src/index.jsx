// 教师教学工作日历 —— DSH 桥接插件（client 半边）
//
// 展开 → 把 DSH frame 从 3 列 grid 改为 4 列，用 grid-column 重排：
//   sidebarCol->1  overlayLayer->2(日历)  centerCol->3(对话)  detailsCol->4
// 收起 → cleanup 清除 4 列改动 + 删除 inline gridTemplateColumns + 展开侧栏
//
// 关键约束：
//   - isOpen=false 时 effect 不做任何事（勿动 DSH 自身的 grid，否则对话区空白）
//   - 所有 grid 清理只在 isOpen 从 true→false 转换（cleanup）时执行
//   - 侧栏按钮折叠态只显示图标（不显示文字）
//
// 热插拔：cordis.patch.yml 增删本条目即热加载/卸载，无需重启 dsh（HMR）。
import React from 'react';

const CALENDAR_URL = () => `${window.location.origin}/calendar/`;
const TITLE_KEY = 'teacher-calendar-title';

// ---- 跨 slot 共享状态 ----
let open = false;
const listeners = new Set();
function setOpen(v) { open = v; listeners.forEach((f) => f()); }
function subscribe(f) { listeners.add(f); return () => listeners.delete(f); }
function getOpen() { return open; }

// ---- 看板互斥协议（与成长档案等并列看板：同一时间只显示一个看板）----
// 打开自己时派发 dsh:overlay-open；收到别人打开的事件时收起自己（若已开）。
// passiveClose：被互斥收起（目标看板即将接管 grid）时不清理 grid，避免与目标竞争。
const OVERLAY_ID = 'teacher-calendar';
let passiveClose = false;
function openExclusive(v) {
  if (v) window.dispatchEvent(new CustomEvent('dsh:overlay-open', { detail: { id: OVERLAY_ID } }));
  setOpen(v);
}
if (typeof window !== 'undefined') {
  window.addEventListener('dsh:overlay-open', (e) => {
    if (e.detail && e.detail.id !== OVERLAY_ID && open) {
      passiveClose = true;
      setOpen(false);
    }
  });
}

// ---- 侧栏折叠状态（供按钮折叠时隐藏文字） ----
let sideCollapsed = false;
const sideListeners = new Set();
function getSideCollapsed() { return sideCollapsed; }
function subscribeSide(f) { sideListeners.add(f); return () => sideListeners.delete(f); }
function setSideCollapsed(v) {
  if (sideCollapsed === v) return;
  sideCollapsed = v;
  sideListeners.forEach((f) => f());
}

// ---- 自定义名称 ----
function loadTitle() {
  try { return localStorage.getItem(TITLE_KEY) || '教学日历'; } catch { return '教学日历'; }
}
let title = loadTitle();
const titleListeners = new Set();
function getTitle() { return title; }
function subscribeTitle(f) { titleListeners.add(f); return () => titleListeners.delete(f); }
function setTitleStore(name) {
  title = name;
  try { localStorage.setItem(TITLE_KEY, name); } catch { /* ignore */ }
  titleListeners.forEach((f) => f());
}

// ---- 侧栏控制 ----
let layoutService = null;
let _selfToggle = false;

function getFrame() {
  return document.querySelector('[data-shell-overlay]')?.parentElement || null;
}
function isSidebarCollapsed() {
  return getFrame()?.hasAttribute('data-sidebar-collapsed') ?? false;
}

function collapseSidebar() {
  if (isSidebarCollapsed()) return; // 已折叠，跳过
  _selfToggle = true;
  layoutService?.toggleSidebar();
  setTimeout(() => { _selfToggle = false; }, 350);
}

function expandSidebar() {
  if (!isSidebarCollapsed()) return; // 已展开，跳过
  _selfToggle = true;
  layoutService?.toggleSidebar();
  setTimeout(() => { _selfToggle = false; }, 350);
}

// ---- grid 辅助 ----
function getGridCols(frameEl) {
  return {
    sidebarCol: frameEl.querySelector('[class*="sidebarCol"]'),
    centerCol: frameEl.querySelector('[class*="centerCol"]'),
    detailsCol: frameEl.querySelector('[class*="detailsCol"]'),
    overlayLayer: frameEl.querySelector('[data-shell-overlay]'),
  };
}

function setGridColumn(cols, s, o, c, d) {
  if (cols.sidebarCol) cols.sidebarCol.style.gridColumn = s;
  if (cols.overlayLayer) cols.overlayLayer.style.gridColumn = o;
  if (cols.centerCol) cols.centerCol.style.gridColumn = c;
  if (cols.detailsCol) cols.detailsCol.style.gridColumn = d;
}

// ---- 侧栏折叠监听（apply 时启动一次） ----
function watchSidebar() {
  const frameEl = getFrame();
  if (!frameEl) { setTimeout(watchSidebar, 300); return; }
  setSideCollapsed(frameEl.hasAttribute('data-sidebar-collapsed'));
  new MutationObserver(() => {
    setSideCollapsed(frameEl.hasAttribute('data-sidebar-collapsed'));
  }).observe(frameEl, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
}

// ---- 侧栏入口 ----
function CalendarButton() {
  const isOpen = React.useSyncExternalStore(subscribe, getOpen);
  const t = React.useSyncExternalStore(subscribeTitle, getTitle);
  const collapsed = React.useSyncExternalStore(subscribeSide, getSideCollapsed);

  const handleClick = React.useCallback(() => {
    if (!isOpen) {
      collapseSidebar();
      openExclusive(true);
    } else {
      setOpen(false);
    }
  }, [isOpen]);

  return React.createElement(
    'button',
    {
      onClick: handleClick,
      title: isOpen ? '收起教学日历' : '打开教学日历',
      style: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '8px 12px', border: 'none', borderRadius: 10,
        background: isOpen ? 'rgba(74,144,217,.15)' : 'transparent',
        color: 'inherit', cursor: 'pointer', fontSize: 14, fontWeight: isOpen ? 600 : 400,
      },
    },
    React.createElement('span', { style: { fontSize: 16 } }, '📅'),
    // 折叠态只显示图标，不打文字（DSH 自家按钮同样行为）
    !collapsed && React.createElement('span', null, t)
  );
}

// ---- 日历面板（shell.overlay） ----
function CalendarOverlay() {
  const isOpen = React.useSyncExternalStore(subscribe, getOpen);
  const t = React.useSyncExternalStore(subscribeTitle, getTitle);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [rect, setRect] = React.useState({ left: 56, width: 600 });

  React.useEffect(() => {
    // 关键：未展开时不做任何事，避免初始挂载破坏 DSH 自身 grid
    if (!isOpen) return;
    const frameEl = getFrame();
    if (!frameEl) return;

    // ---------- 展开 ----------
    collapseSidebar();

    const cols = getGridCols(frameEl);
    // centerCol 推至列 3（对话区压缩）；overlayLayer 是 absolute 定位，grid-column 无效，不设
    setGridColumn(cols, '1', '', '3', '4');

    const updateGrid = () => {
      const vw = window.innerWidth;
      // 折叠态固定 56px（DSH 轨道宽度），不依赖异步 DOM 测量的时机
      const collapsed = frameEl.hasAttribute('data-sidebar-collapsed');
      const sidebarW = collapsed ? 56 : (cols.sidebarCol ? cols.sidebarCol.getBoundingClientRect().width : 280);
      const detailsW = (!frameEl.hasAttribute('data-details-collapsed') && cols.detailsCol)
        ? cols.detailsCol.getBoundingClientRect().width : 0;
      const avail = vw - sidebarW - detailsW;
      const calW = Math.max(480, Math.min(Math.round(avail * 0.62), avail - 340));
      frameEl.style.gridTemplateColumns = `${sidebarW}px ${calW}px 1fr ${detailsW}px`;
      setRect({ left: sidebarW, width: calW });
    };
    updateGrid();
    window.addEventListener('resize', updateGrid);

    // 监听外部侧栏展开 → 自动关日历；顺带在侧栏属性变化时重算 grid
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'data-sidebar-collapsed') {
          if (!frameEl.hasAttribute('data-sidebar-collapsed') && !_selfToggle) {
            setOpen(false);
          } else {
            updateGrid(); // 折叠动画完成后重算占位
          }
        }
      }
    });
    observer.observe(frameEl, { attributes: true });

    // ---------- 收起（isOpen true→false 转换时执行） ----------
    return () => {
      if (passiveClose) { passiveClose = false; return; } // 被互斥收起：交还给即将打开的目标看板
      window.removeEventListener('resize', updateGrid);
      observer.disconnect();
      setGridColumn(cols, '', '', '', '');
      // 恢复 DSH 自身的 3 列 grid（依据属性判断，而不是清空：
      // 原生展开路径中 DSH 已重设 grid，若清空则对话区失去布局）
      const collapsed = frameEl.hasAttribute('data-sidebar-collapsed');
      const sidebarW = collapsed ? 56 : 280;
      const detailsW = (!frameEl.hasAttribute('data-details-collapsed') && cols.detailsCol)
        ? cols.detailsCol.getBoundingClientRect().width : 0;
      frameEl.style.gridTemplateColumns = `${sidebarW}px minmax(0px, 1fr) ${detailsW}px`;
      expandSidebar();
    };
  }, [isOpen]);

  // ---- 标题编辑 ----
  const startRename = () => { setDraft(t); setEditing(true); };
  const commitRename = () => {
    const n = draft.trim();
    if (n) setTitleStore(n);
    setEditing(false);
  };

  if (!isOpen) return React.createElement('div', { style: { display: 'none' } });

  return React.createElement(
    'div',
    {
      style: {
        position: 'absolute', top: 0, bottom: 0,
        left: rect.left, width: rect.width,
        display: 'flex', flexDirection: 'column',
        background: 'var(--dsw-alias-bg-surface, #fff)',
        boxShadow: '2px 0 12px rgba(0,0,0,.08)',
        zIndex: 50,
      },
    },
    React.createElement(
      'div',
      {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
          font: '600 14px system-ui, sans-serif', flex: 'none',
          background: 'var(--dsw-alias-bg-surface, #f7fafc)',
        },
      },
      React.createElement(
        'span',
        { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        React.createElement('span', { style: { fontSize: 16 } }, '📅'),
        editing
          ? React.createElement('input', {
              value: draft, autoFocus: true,
              onChange: (e) => setDraft(e.target.value),
              onBlur: commitRename,
              onKeyDown: (e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); },
              style: { fontSize: 14, fontWeight: 600, border: '1px solid #4a90d9', borderRadius: 6, padding: '2px 8px', width: 180 },
            })
          : React.createElement(
              'span',
              { title: '点击重命名', onClick: startRename, style: { cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              t
            ),
        !editing && React.createElement(
          'span',
          { title: '重命名', onClick: startRename, style: { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #8a8a8a)' } },
          '✏️'
        )
      ),
      React.createElement(
        'button',
        {
          onClick: () => { setOpen(false); },
          title: '收起看板并展开侧栏',
          style: {
            padding: '4px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)',
            background: 'var(--dsw-alias-bg-surface, #fff)', cursor: 'pointer', fontSize: 13,
          },
        },
        '✕ 收起'
      )
    ),
    React.createElement('iframe', {
      src: CALENDAR_URL(),
      style: { flex: 1, border: 'none', width: '100%', background: '#f4f9f7' },
      title: t,
    })
  );
}

// ---- 插件定义 ----
const plugin = {
  inject: ['slots', 'layout'],
  apply(ctx) {
    layoutService = ctx.layout;
    watchSidebar();
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'teacher-calendar', position: 'end' }, CalendarButton);
    ctx.slots.register({ name: 'shell.overlay', id: 'teacher-calendar', position: 'end' }, CalendarOverlay);
  },
};

export const apply = plugin.apply;
export const inject = plugin.inject;