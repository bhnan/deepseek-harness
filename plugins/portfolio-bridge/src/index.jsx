// 学生成长档案工作台 —— DSH 桥接插件（client 半边）
//
// 展开逻辑与教学日历完全一致（grid 四列重排）：
//   侧栏折叠(窄) | 看板(中) | 对话(右) | 详情 —— 实现「左侧边栏 | 中看板 | 右对话」
//   sidebarCol->1  overlayLayer->2(看板)  centerCol->3(对话)  detailsCol->4
// 收起 → 清理 4 列改动 + 恢复 DSH 3 列 grid + 展开侧栏
//
// 关键约束：
//   - isOpen=false 时 effect 不做任何事（勿动 DSH 自身 grid，否则对话区空白）
//   - 所有 grid 清理只在 isOpen true→false 转换（cleanup）时执行
//   - 侧栏按钮折叠态只显示图标
//
// 热插拔：cordis.patch.yml 增删本条目即热加载/卸载，无需重启 dsh（HMR）。
import React from 'react';

const PORTFOLIO_URL = () => `${window.location.origin}/portfolio/`;

// ---- 跨 slot 共享状态 ----
let open = false;
const listeners = new Set();
function setOpen(v) { open = v; listeners.forEach((f) => f()); }
function subscribe(f) { listeners.add(f); return () => listeners.delete(f); }
function getOpen() { return open; }

// ---- 看板互斥协议（与教学日历等并列看板：同一时间只显示一个看板）----
const OVERLAY_ID = 'teacher-portfolio';
let passiveClose = false;
function openExclusive(v) {
  if (v) window.dispatchEvent(new CustomEvent('dsh:overlay-open', { detail: { id: OVERLAY_ID } }));
  setOpen(v);
}
function toggleOpen() { openExclusive(!open); }
if (typeof window !== 'undefined') {
  window.addEventListener('dsh:overlay-open', (e) => {
    if (e.detail && e.detail.id !== OVERLAY_ID && open) {
      passiveClose = true;
      setOpen(false);
    }
  });
}

// ---- 侧栏折叠状态（供按钮折叠时隐藏文字）----
let sideCollapsed = false;
const sideListeners = new Set();
function getSideCollapsed() { return sideCollapsed; }
function subscribeSide(f) { sideListeners.add(f); return () => sideListeners.delete(f); }
function setSideCollapsed(v) {
  if (sideCollapsed === v) return;
  sideCollapsed = v;
  sideListeners.forEach((f) => f());
}

// ---- 侧栏控制（与教学日历一致）----
let layoutService = null;
let _selfToggle = false;

function getFrame() {
  return document.querySelector('[data-shell-overlay]')?.parentElement || null;
}
function isSidebarCollapsed() {
  return getFrame()?.hasAttribute('data-sidebar-collapsed') ?? false;
}
function collapseSidebar() {
  if (isSidebarCollapsed()) return;
  _selfToggle = true;
  layoutService?.toggleSidebar();
  setTimeout(() => { _selfToggle = false; }, 350);
}
function expandSidebar() {
  if (!isSidebarCollapsed()) return;
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

// ---- 侧栏折叠监听 ----
function watchSidebar() {
  const frameEl = getFrame();
  if (!frameEl) { setTimeout(watchSidebar, 300); return; }
  setSideCollapsed(frameEl.hasAttribute('data-sidebar-collapsed'));
  new MutationObserver(() => {
    setSideCollapsed(frameEl.hasAttribute('data-sidebar-collapsed'));
  }).observe(frameEl, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
}

// ---- 侧栏入口 ----
function PortfolioButton() {
  const isOpen = React.useSyncExternalStore(subscribe, getOpen);
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
      title: isOpen ? '收起成长档案' : '打开学生成长档案工作台',
      style: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '8px 12px', border: 'none', borderRadius: 10,
        background: isOpen ? 'rgba(127,176,105,.18)' : 'transparent',
        color: 'inherit', cursor: 'pointer', fontSize: 14, fontWeight: isOpen ? 600 : 400,
      },
    },
    React.createElement('span', { style: { fontSize: 16 } }, '📁'),
    !collapsed && React.createElement('span', null, '学生成长档案')
  );
}

// ---- 看板面板（shell.overlay，与教学日历同布局：左=侧栏 中=看板 右=对话）----
function PortfolioOverlay() {
  const isOpen = React.useSyncExternalStore(subscribe, getOpen);
  const [rect, setRect] = React.useState({ left: 56, width: 600 });

  React.useEffect(() => {
    // 未展开时不做任何事
    if (!isOpen) return;
    const frameEl = getFrame();
    if (!frameEl) return;

    // ---------- 展开 ----------
    collapseSidebar();
    const cols = getGridCols(frameEl);
    setGridColumn(cols, '1', '', '3', '4');

    const updateGrid = () => {
      const vw = window.innerWidth;
      const collapsed = frameEl.hasAttribute('data-sidebar-collapsed');
      const sidebarW = collapsed ? 56 : (cols.sidebarCol ? cols.sidebarCol.getBoundingClientRect().width : 280);
      const detailsW = (!frameEl.hasAttribute('data-details-collapsed') && cols.detailsCol)
        ? cols.detailsCol.getBoundingClientRect().width : 0;
      const avail = vw - sidebarW - detailsW;
      const boardW = Math.max(480, Math.min(Math.round(avail * 0.62), avail - 340));
      frameEl.style.gridTemplateColumns = `${sidebarW}px ${boardW}px 1fr ${detailsW}px`;
      setRect({ left: sidebarW, width: boardW });
    };
    updateGrid();
    window.addEventListener('resize', updateGrid);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'data-sidebar-collapsed') {
          if (!frameEl.hasAttribute('data-sidebar-collapsed') && !_selfToggle) {
            setOpen(false);
          } else {
            updateGrid();
          }
        }
      }
    });
    observer.observe(frameEl, { attributes: true });

    // ---------- 收起 ----------
    return () => {
      if (passiveClose) { passiveClose = false; return; } // 被互斥收起：交还给即将打开的目标看板
      window.removeEventListener('resize', updateGrid);
      observer.disconnect();
      setGridColumn(cols, '', '', '', '');
      const collapsed = frameEl.hasAttribute('data-sidebar-collapsed');
      const sidebarW = collapsed ? 56 : 280;
      const detailsW = (!frameEl.hasAttribute('data-details-collapsed') && cols.detailsCol)
        ? cols.detailsCol.getBoundingClientRect().width : 0;
      frameEl.style.gridTemplateColumns = `${sidebarW}px minmax(0px, 1fr) ${detailsW}px`;
      expandSidebar();
    };
  }, [isOpen]);

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
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { fontSize: 16 } }, '📁'),
        React.createElement('span', null, '学生成长档案')
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
      src: PORTFOLIO_URL(),
      style: { flex: 1, border: 'none', width: '100%', background: '#f5f7fa' },
      title: '学生成长档案',
    })
  );
}

// ---- 插件定义 ----
const plugin = {
  inject: ['slots', 'layout'],
  apply(ctx) {
    layoutService = ctx.layout;
    watchSidebar();
    // sidebar.footer.action 槽原为 flex row（DSH 源码），两个看板按钮会并排；
    // 注入一次 CSS 覆盖为纵向排列（教学日历在上、成长档案在下），只影响该插件容器。
    if (typeof document !== 'undefined' && !document.getElementById('pf-sidebar-stack')) {
      const st = document.createElement('style');
      st.id = 'pf-sidebar-stack';
      st.textContent = '.hHd-Xa_footerActions{flex-direction:column !important;} .hHd-Xa_footerActions>div{width:100% !important;}';
      document.head.appendChild(st);
    }
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'teacher-portfolio', position: 'end' }, PortfolioButton);
    ctx.slots.register({ name: 'shell.overlay', id: 'teacher-portfolio', position: 'end' }, PortfolioOverlay);
  },
};

export const apply = plugin.apply;
export const inject = plugin.inject;
