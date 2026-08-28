// CDP 真实浏览器交互测试：连接本机 Chrome 调试端口，模拟点击/输入/读取
// 用法：node scripts/cdp-interact.mjs <动作> [参数]
// 动作：
//   add-course <班级名> <内容>   —— 在周一第5节新增课程（自动选班+填内容+保存）
//   shift-course <新内容> [周几] [节次] —— 指定格子"替换并顺延"（R3 核心，默认周一第1节）
//   temp-change <目标周几> <目标节> <备注> —— 周三第2节发起临时调课（R4）
//   undo / redo                  —— 点击撤销/恢复
//   theme <id>                   —— 切换主题
//   view <week|month|semester>   —— 切换视图
//   read-grid                    —— 读取当前周视图网格全部格子内容
//   check-overlay                —— 检查 shell.overlay 面板（DSH 集成验证用）
import { setTimeout as sleep } from 'node:timers/promises';

const CDP_PORT = 9222;
const PAGE_URL_FILTER = process.argv[2] === 'check-overlay' ? '127.0.0.1:3080' : 'localhost:5173';

async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(PAGE_URL_FILTER));
  if (!page) throw new Error(`未找到页面: ${PAGE_URL_FILTER}（可用 target: ${targets.map((t) => t.url).join(', ')}）`);
  return page;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) { c.pending.get(msg.id)(msg); c.pending.delete(msg.id); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result?.result?.value;
  }
  close() { this.ws.close(); }
}

const JS = {
  // 点击周一第5节格子并打开编辑器
  openSlot5: `(() => {
    const rows = document.querySelectorAll('.week-grid-row');
    const cell = rows[4]?.querySelector('.week-cell'); // 第5行第1列 = 周一
    if (!cell) return '未找到周一第5节格子';
    cell.click();
    return '已点击';
  })()`,
  // 等待弹窗并检查
  modalState: `(() => {
    const modal = document.querySelector('.modal');
    return modal ? { title: modal.querySelector('.modal-head span')?.textContent, hasClassSel: !!modal.querySelector('.stage-tabs'), hasInput: !!modal.querySelector('input[placeholder*="词库"]') } : null;
  })()`,
  // 设置授课内容（React 受控组件）
  setContent: (text) => `(() => {
    const input = document.querySelector('input[placeholder*="词库"]');
    if (!input) return '未找到内容输入框';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return '内容已输入: ' + input.value;
  })()`,
  save: `(() => {
    const btn = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.includes('保存'));
    if (!btn) return '未找到保存按钮';
    btn.click();
    return '已点击保存';
  })()`,
  readCell: `(() => {
    const rows = document.querySelectorAll('.week-grid-row');
    const cell = rows[4]?.querySelector('.week-cell');
    return cell ? { text: cell.textContent.trim().replace(/\\s+/g, ' '), hasCourse: !!cell.querySelector('.cell-inner') } : null;
  })()`,
  readCellAt: (wd, p) => `(() => {
    const rows = document.querySelectorAll('.week-grid-row');
    const cell = rows[${p - 1}]?.querySelectorAll('.week-cell')[${wd - 1}];
    return cell ? { text: cell.textContent.trim().replace(/\\s+/g, ' '), hasCourse: !!cell.querySelector('.cell-inner') } : null;
  })()`,
  readGrid: `(() => {
    const out = [];
    document.querySelectorAll('.week-grid-row').forEach((row, ri) => {
      const cells = row.querySelectorAll('.week-cell');
      cells.forEach((c, ci) => {
        const t = c.textContent.trim().replace(/\\s+/g, ' ');
        if (t) out.push({ slot: ci + 1, period: ri + 1, text: t });
      });
    });
    return out;
  })()`,
  overlay: `(() => {
    const ov = document.querySelector('[data-shell-overlay]');
    return ov ? { exists: true, text: ov.textContent.trim().replace(/\\s+/g, ' ').slice(0, 120) } : { exists: false };
  })()`,
  // 点击指定 周几(1-7)/节次 的格子
  openCell: (wd, p) => `(() => {
    const rows = document.querySelectorAll('.week-grid-row');
    const cell = rows[${p - 1}]?.querySelectorAll('.week-cell')[${wd - 1}];
    if (!cell) return '未找到格子 周${wd} 第${p}节';
    cell.click();
    return '已点击 周${wd} 第${p}节';
  })()`,
  checkShift: `(() => {
    const cb = [...document.querySelectorAll('.modal .check input')].find((i) => i.closest('label')?.textContent.includes('替换并顺延'));
    if (!cb) return '未找到顺延勾选框';
    cb.click();
    return '已勾选替换并顺延';
  })()`,
  checkTemp: `(() => {
    const cb = [...document.querySelectorAll('.modal .check input')].find((i) => i.closest('label')?.textContent.includes('临时调课'));
    if (!cb) return '未找到临时调课勾选框';
    cb.click();
    return '已勾选临时调课';
  })()`,
  setTempTarget: (wd, p, note) => `(() => {
    const selects = [...document.querySelectorAll('.modal select')];
    const wdSel = selects.find((s) => [...s.options].some((o) => ['周一','周二','周三','周四','周五','周六','周日'].includes(o.textContent)));
    const pSel = selects.find((s) => [...s.options].some((o) => o.textContent.startsWith('第')));
    const noteInput = document.querySelector('.modal input[placeholder*="备注"]');
    if (!wdSel || !pSel) return '未找到目标时段选择器';
    wdSel.value = ${JSON.stringify(String(wd))};
    wdSel.dispatchEvent(new Event('change', { bubbles: true }));
    pSel.value = ${JSON.stringify(String(p))};
    pSel.dispatchEvent(new Event('change', { bubbles: true }));
    if (noteInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(noteInput, ${JSON.stringify(note || '')});
      noteInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return '目标已设: 周${wd} 第${p}节 ' + (${JSON.stringify(note || '')} || '');
  })()`,
  clickBtn: (label) => `(() => {
    const btn = [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes(${JSON.stringify(label)}));
    if (!btn) return '未找到按钮: ' + ${JSON.stringify(label)};
    btn.click();
    return '已点击: ' + ${JSON.stringify(label)};
  })()`,
  toast: `document.querySelector('.toast')?.textContent || null`,
  themeValue: `document.querySelector('.theme-select')?.value || null`,
  activeView: `document.querySelector('.tab.active')?.textContent || null`,
};

const action = process.argv[2];

const target = await getTarget();
const cdp = await CDP.connect(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${target.id}`);
await cdp.send('Runtime.enable');

if (action === 'read-grid') {
  const grid = await cdp.eval(JS.readGrid);
  console.log(JSON.stringify(grid, null, 1));
} else if (action === 'add-course') {
  const className = process.argv[3];
  const content = process.argv[4];
  console.log('1)', await cdp.eval(JS.openSlot5));
  await sleep(400);
  const modal = await cdp.eval(JS.modalState);
  console.log('2) 弹窗:', JSON.stringify(modal));
  if (!modal) throw new Error('弹窗未出现');
  if (className) {
    // 选班级（下拉）
    const sel = await cdp.eval(`(() => {
      const select = document.querySelector('.form select:not(.stage-tabs)');
      if (!select) return '未找到班级下拉';
      const opt = [...select.options].find((o) => o.textContent.includes(${JSON.stringify(className)}));
      if (!opt) return '班级不存在: ' + className;
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return '已选班级: ' + opt.textContent;
    })()`);
    console.log('3)', sel);
  }
  console.log('4)', await cdp.eval(JS.setContent(content)));
  await sleep(200);
  console.log('5)', await cdp.eval(JS.save));
  await sleep(800);
  console.log('6) 格子状态:', JSON.stringify(await cdp.eval(JS.readCell)));
} else if (action === 'shift-course') {
  const content = process.argv[3];
  const wd = parseInt(process.argv[4] || '1', 10), p = parseInt(process.argv[5] || '1', 10);
  console.log('1)', await cdp.eval(JS.openCell(wd, p))); // 默认周一第1节（初一(1)班 有内容）
  await sleep(400);
  console.log('2)', await cdp.eval(JS.checkShift));
  await sleep(100);
  console.log('3)', await cdp.eval(JS.setContent(content)));
  await sleep(200);
  console.log('4)', await cdp.eval(JS.clickBtn('替换并顺延')));
  await sleep(800);
  console.log('5) 提示:', await cdp.eval(JS.toast));
  console.log('6) 周${wd}第${p}节:', JSON.stringify(await cdp.eval(JS.readCellAt(wd, p))));
  console.log('7) 网格:', JSON.stringify(await cdp.eval(JS.readGrid)));
} else if (action === 'temp-change') {
  const targetWd = process.argv[3], targetP = process.argv[4], note = process.argv[5] || '';
  console.log('1)', await cdp.eval(JS.openCell(3, 2))); // 周三第2节（初一(2)班）
  await sleep(400);
  console.log('2)', await cdp.eval(JS.checkTemp));
  await sleep(100);
  console.log('3)', await cdp.eval(JS.setTempTarget(targetWd, targetP, note)));
  await sleep(200);
  console.log('4)', await cdp.eval(JS.clickBtn('保存')));
  await sleep(800);
  console.log('5) 提示:', await cdp.eval(JS.toast));
  console.log('6) 周五列:', JSON.stringify(await cdp.eval(JS.readGrid)));
} else if (action === 'undo' || action === 'redo') {
  console.log(await cdp.eval(JS.clickBtn(action === 'undo' ? '撤销' : '恢复')));
  await sleep(800);
  console.log('提示:', await cdp.eval(JS.toast));
  console.log('网格:', JSON.stringify(await cdp.eval(JS.readGrid)));
} else if (action === 'theme') {
  const id = process.argv[3];
  console.log('切换前:', await cdp.eval(JS.themeValue));
  console.log(await cdp.eval(`(() => {
    const sel = document.querySelector('.theme-select');
    sel.value = ${JSON.stringify(id)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return '已切换: ' + sel.value;
  })()`));
  await sleep(600);
  console.log('切换后:', await cdp.eval(JS.themeValue), '| data-theme:', await cdp.eval(`document.documentElement.dataset.theme`));
} else if (action === 'view') {
  const v = process.argv[3];
  const label = v === 'week' ? '周视图' : v === 'month' ? '月视图' : '学期视图';
  console.log(await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.tab')].find((b) => b.textContent.includes(${JSON.stringify(label)}));
    if (!btn) return '未找到页签: ' + ${JSON.stringify(label)};
    btn.click();
    return '已点击: ' + ${JSON.stringify(label)};
  })()`));
  await sleep(900);
  console.log('当前视图:', await cdp.eval(JS.activeView));
  if (v === 'month') console.log('月视图网格行数:', await cdp.eval(`document.querySelectorAll('.month-grid-row').length`));
  if (v === 'semester') console.log('事件卡片数:', await cdp.eval(`document.querySelectorAll('.event-card').length`));
} else if (action === 'check-overlay') {
  console.log('overlay:', JSON.stringify(await cdp.eval(JS.overlay)));
} else {
  console.log('未知动作:', action);
}

cdp.close();
