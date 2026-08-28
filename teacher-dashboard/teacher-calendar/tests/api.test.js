// API 集成测试：spawn 独立端口的 server，验证关键数据安全链路
// 重点：shift 顺延不误删其他班内容（回归保护）、undo 合并回写、临时调课当周生效
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}/api/calendar`;
const SID = '2026-autumn-1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-test-'));

let server;
let started = false;

beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), TC_DATA_DIR: TMP },
    stdio: 'ignore',
  });
  // 等待就绪
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/bootstrap`);
      if (r.ok) { started = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!started) throw new Error('测试服务器启动失败');
}, 20000);

afterAll(() => { server?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

describe('更新内容数据安全（回归保护：shift 不得误删其他班内容）', () => {
  // 用独立临时班级隔离（避免与其它测试共享 undo 栈/内容造成交叉污染）；课时位选第8节（避开 seed 占用的 1-4 节）
  let ta, tb;
  beforeAll(async () => {
    ta = (await api('POST', '/classes', { name: '测试A班', stage: 'middle', color: '#123456' })).class;
    tb = (await api('POST', '/classes', { name: '测试B班', stage: 'middle', color: '#654321' })).class;
    // 给两个班各建一个固定课时位 + 一条内容
    await api('POST', `/${SID}/fixed-courses`, { class_id: ta.id, weekday: 1, period: 8 });
    await api('POST', `/${SID}/fixed-courses`, { class_id: tb.id, weekday: 2, period: 8 });
    await api('POST', `/${SID}/teaching-content`, { class_id: ta.id, week: 1, weekday: 1, period: 8, content: 'A班第一课', source: 'custom' });
    await api('POST', `/${SID}/teaching-content`, { class_id: tb.id, week: 1, weekday: 2, period: 8, content: 'B班第一课', source: 'custom' });
  });
  afterAll(async () => {
    await api('DELETE', `/classes/${tb.id}`);
    await api('DELETE', `/classes/${ta.id}`);
  });
  it('shift 前其他班内容存在', async () => {
    const d = await api('GET', `/${SID}/teaching-content`);
    const b = d.contents.find((c) => c.class_id === tb.id);
    expect(b?.content).toBe('B班第一课');
  });
  it('shift 后其他班内容保留（核心回归）', async () => {
    await api('POST', `/${SID}/shift`, { class_id: ta.id, week: 1, weekday: 1, period: 8, new_content: '复习课' });
    const d = await api('GET', `/${SID}/teaching-content`);
    const a = d.contents.filter((c) => c.class_id === ta.id);
    const b = d.contents.find((c) => c.class_id === tb.id);
    expect(b?.content).toBe('B班第一课'); // 其他班不被误改
    expect(a.find((c) => c.week === 1 && c.weekday === 1 && c.period === 8)?.content).toBe('复习课');
  });
  it('undo 顺延：合并回写，其他班仍保留', async () => {
    await api('POST', '/undo', { current_semester_id: SID });
    const d = await api('GET', `/${SID}/teaching-content`);
    const a = d.contents.filter((c) => c.class_id === ta.id);
    const b = d.contents.find((c) => c.class_id === tb.id);
    expect(a.find((c) => c.week === 1 && c.weekday === 1 && c.period === 8)?.content).toBe('A班第一课'); // 恢复
    expect(b?.content).toBe('B班第一课'); // 其他班不被误改
  });
});

describe('临时调课（R4）', () => {
  it('当周生效、下周恢复固定排课', async () => {
    await api('POST', `/${SID}/temp-changes`, { class_id: 'cls-cy2', week: 1, origin_weekday: 3, origin_period: 2, new_weekday: 5, new_period: 3, note: '测试' });
    const w1 = await api('GET', `/${SID}/week-view?week=1`);
    expect(w1.merged_cells.some((c) => c.key === '5-3' && c.temp)).toBe(true);
    expect(w1.suppressed).toContain('3-2');
    const w2 = await api('GET', `/${SID}/week-view?week=2`);
    expect(w2.merged_cells.some((c) => c.key === '5-3' && c.temp)).toBe(false);
  });
});

describe('学期管理（R2 联动）', () => {
  it('非法学期名被拒', async () => {
    const d = await api('POST', '/semesters', { name: '新学期', start_date: '2026-09-01', end_date: '2027-01-17' });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('标准格式');
  });
  it('重名学期被拒', async () => {
    const d = await api('POST', '/semesters', { name: '2026年秋季第一学期', start_date: '2026-09-01', end_date: '2027-01-17' });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('已存在');
  });
});

describe('素养推送（C2）', () => {
  it('首次取条 + 手动刷新不重复', async () => {
    const today = await api('GET', `/${SID}/push/today`);
    expect(today.ok).toBe(true);
    expect(today.entry?.id).toBeTruthy();
    const first = today.entry.id;
    const refresh = await api('POST', `/${SID}/push/refresh`);
    expect(refresh.entry?.id).not.toBe(first); // 不重复
    // 再次取当天 → 幂等（按日期键控）
    const again = await api('GET', `/${SID}/push/today`);
    expect(again.entry?.id).toBe(refresh.entry?.id);
  });
});

describe('班级内容预填/追加（G4/I1 补充）', () => {
  // 独立临时班级（2 课时位/周 × 20 周 = 40 课时位），避免污染 seed 班级
  let tc;
  beforeAll(async () => {
    tc = (await api('POST', '/classes', { name: '测试C班', stage: 'middle', color: '#11aa22' })).class;
    await api('POST', `/${SID}/fixed-courses`, { class_id: tc.id, weekday: 1, period: 8 });
    await api('POST', `/${SID}/fixed-courses`, { class_id: tc.id, weekday: 3, period: 8 });
  });
  afterAll(async () => {
    await api('DELETE', `/classes/${tc.id}`);
  });
  it('预填：从下一空闲位自动分配', async () => {
    const r = await api('POST', `/${SID}/content-seq/prefill`, { class_id: tc.id, contents: ['预填A', '预填B', '预填C'] });
    expect(r.assigned).toBe(3);
    const seq = await api('GET', `/${SID}/content-seq?class_id=${tc.id}`);
    const filled = seq.seq.filter((s) => s.content);
    expect(filled.length).toBe(3);
    expect(filled[0].content).toBe('预填A');
    expect(filled[1].content).toBe('预填B');
    expect(filled[2].content).toBe('预填C');
  });
  it('追加：接在已有内容之后', async () => {
    const r = await api('POST', `/${SID}/content-seq/prefill`, { class_id: tc.id, contents: ['追加X'] });
    expect(r.assigned).toBe(1);
    const seq = await api('GET', `/${SID}/content-seq?class_id=${tc.id}`);
    const filled = seq.seq.filter((s) => s.content);
    expect(filled.length).toBe(4);
    expect(filled[filled.length - 1].content).toBe('追加X');
  });
  it('撤销预填：恢复原状', async () => {
    const seqBefore = await api('GET', `/${SID}/content-seq?class_id=${tc.id}`);
    const countBefore = seqBefore.seq.filter((s) => s.content).length;
    await api('POST', '/undo', { current_semester_id: SID }); // 撤销追加
    const seq = await api('GET', `/${SID}/content-seq?class_id=${tc.id}`);
    const filled = seq.seq.filter((s) => s.content);
    expect(filled.length).toBe(countBefore - 1); // 追加被撤销，回到追加前
    expect(filled[filled.length - 1].content).toBe('预填C');
  });
  it('课时位耗尽：溢出报告', async () => {
    // tc 共 40 课时位（2 节/周 × 20 周）；已填数动态取，剩余容量 = 总位 - 已填
    const seq = await api('GET', `/${SID}/content-seq?class_id=${tc.id}`);
    const totalSlots = seq.seq.length;
    const filled = seq.seq.filter((s) => s.content).length;
    const capacity = totalSlots - filled;
    const r = await api('POST', `/${SID}/content-seq/prefill`, { class_id: tc.id, contents: Array.from({ length: capacity + 5 }, (_, i) => `内容${i}`) });
    expect(r.assigned).toBe(capacity);
    expect(r.overflow).toBe(5);
    expect(r.full).toBe(true);
  });
});

describe('功能1：一键预填与选择框模式', () => {
  it('统一序列保存 + 一键预填（跳过已占用）', async () => {
    await api('PUT', `/${SID}/sequence?stage=middle`, { items: ['序列一', '序列二', '序列三'] });
    // 限定 seed 8 个班（避免影响其它 describe 创建的临时测试班）
    const seedClasses = ['cls-cy1', 'cls-cy2', 'cls-cy3', 'cls-cy4', 'cls-cy5', 'cls-xs1', 'cls-xs2', 'cls-xs3'];
    const r = await api('POST', `/${SID}/sequence/apply`, { class_ids: seedClasses });
    // 8 个班都有固定排课
    expect(r.report.length).toBe(8);
    expect(r.total_assigned).toBeGreaterThan(0);
    // 覆盖式对齐：第1节课 = 序列[0]（各班一致）
    const seq = await api('GET', `/${SID}/content-seq?class_id=cls-cy1`);
    const first = seq.seq.find((s) => s.content && s.week === 1);
    expect(first.content).toBe('序列一');
  });
  it('选择框模式：指定内容填入指定班', async () => {
    const r = await api('POST', `/${SID}/sequence/apply`, { contents: ['临时加课X'], class_ids: ['cls-cy2'] });
    expect(r.report[0].assigned).toBe(1);
  });
  it('序列保存可撤销', async () => {
    await api('PUT', `/${SID}/sequence?stage=middle`, { items: ['新序列一'] });
    await api('POST', '/undo', { current_semester_id: SID });
    const seq = await api('GET', `/${SID}/sequence?stage=middle`);
    expect(seq.items.length).toBe(3); // 回到上一版
  });
});

describe('功能3：拖动换课（内容互换，归属不变）', () => {
  it('双方有内容 → 内容互换、课时位归属不变', async () => {
    // 构造：batch 精确写入 cy1/cy3 第2周的指定课时位
    await api('POST', `/${SID}/teaching-content/batch`, {
      rows: [
        { class_id: 'cls-cy1', week: 2, weekday: 1, period: 1, content: '甲' },
        { class_id: 'cls-cy3', week: 2, weekday: 1, period: 3, content: '乙' },
      ],
    });
    const before = await api('GET', `/${SID}/teaching-content`);
    const get = (cid) => before.contents.find((c) => c.class_id === cid && c.week === 2);
    const a1 = get('cls-cy1'), b1 = get('cls-cy3');
    await api('POST', `/${SID}/content/swap`, {
      from: { class_id: 'cls-cy1', week: 2, weekday: 1, period: 1 },
      to: { class_id: 'cls-cy3', week: 2, weekday: 1, period: 3 },
    });
    const after = await api('GET', `/${SID}/teaching-content`);
    const a2 = after.contents.find((c) => c.id === a1.id);
    const b2 = after.contents.find((c) => c.id === b1.id);
    expect(a2.content).toBe('乙'); // cy1 的课时位现在显示乙
    expect(b2.content).toBe('甲'); // cy3 的课时位现在显示甲
    expect(a2.class_id).toBe('cls-cy1'); // 归属不变
    expect(b2.class_id).toBe('cls-cy3');
  });
});

describe('功能3扩展：拖到空白格（创建排课并放入）', () => {
  it('空白格（无固定排课）→ 创建来源班排课 + 内容移入', async () => {
    const before = await api('GET', `/${SID}/schedule`);
    const hasSlot = before.fixed_courses.some((f) => f.weekday === 5 && f.period === 8);
    if (hasSlot) {
      // 清理该时段固定课，保证空白
      const f = before.fixed_courses.find((x) => x.weekday === 5 && x.period === 8);
      await api('DELETE', `/${SID}/fixed-courses/${f.id}`);
    }
    const r = await api('POST', `/${SID}/content/swap`, {
      from: { class_id: 'cls-cy1', week: 2, weekday: 1, period: 1 },
      to: { class_id: 'cls-cy1', week: 2, weekday: 5, period: 8 },
    });
    expect(r.fixed_changed).toBe(true);
    const sched = await api('GET', `/${SID}/schedule`);
    expect(sched.fixed_courses.some((f) => f.class_id === 'cls-cy1' && f.weekday === 5 && f.period === 8)).toBe(true);
    // 源位置排课已删除（旧位置完全清空）
    expect(sched.fixed_courses.some((f) => f.class_id === 'cls-cy1' && f.weekday === 1 && f.period === 1)).toBe(false);
    const contents = await api('GET', `/${SID}/teaching-content`);
    const moved = contents.contents.find((c) => c.class_id === 'cls-cy1' && c.week === 2 && c.weekday === 5 && c.period === 8);
    expect(moved).toBeTruthy();
  });
  it('撤销：回滚新建排课与内容移动', async () => {
    await api('POST', '/undo', { current_semester_id: SID });
    const sched = await api('GET', `/${SID}/schedule`);
    expect(sched.fixed_courses.some((f) => f.class_id === 'cls-cy1' && f.weekday === 5 && f.period === 8)).toBe(false);
    // 源排课已恢复
    expect(sched.fixed_courses.some((f) => f.class_id === 'cls-cy1' && f.weekday === 1 && f.period === 1)).toBe(true);
    const contents = await api('GET', `/${SID}/teaching-content`);
    expect(contents.contents.some((c) => c.class_id === 'cls-cy1' && c.week === 2 && c.weekday === 5 && c.period === 8)).toBe(false);
  });
});

describe('法定节假日自动顺延（内容往后顺延，绝不取消）', () => {
  // 2026 国庆 10/1(周四)-10/7(周三)：W5 周四=10/1、W5 周六=10/3 均为假期；W6 周四=10/8 正常上课
  // 独立临时班级（周四第8节 + 周六第8节——避开其他测试占用的 1/2/3/5 星期），内容填在 W5/W6
  let th, th2;
  beforeAll(async () => {
    th = (await api('POST', '/classes', { name: '测试H班', stage: 'middle', color: '#224488' })).class;
    await api('POST', `/${SID}/fixed-courses`, { class_id: th.id, weekday: 4, period: 8 });
    await api('POST', `/${SID}/fixed-courses`, { class_id: th.id, weekday: 6, period: 8 });
    await api('POST', `/${SID}/teaching-content/batch`, {
      rows: [
        { class_id: th.id, week: 5, weekday: 4, period: 8, content: '甲' },
        { class_id: th.id, week: 5, weekday: 6, period: 8, content: '乙' },
        { class_id: th.id, week: 6, weekday: 4, period: 8, content: '丙' },
        { class_id: th.id, week: 6, weekday: 6, period: 8, content: '丁' },
      ],
    });
    // 对照班：同样有周六第8节，但内容只填在第 1 周（非假期）→ 不应被移动
    th2 = (await api('POST', '/classes', { name: '测试H2班', stage: 'primary', color: '#8855cc' })).class;
    await api('POST', `/${SID}/fixed-courses`, { class_id: th2.id, weekday: 6, period: 8 });
    await api('POST', `/${SID}/teaching-content`, { class_id: th2.id, week: 1, weekday: 6, period: 8, content: '对照内容', source: 'custom' });
  });
  afterAll(async () => {
    await api('DELETE', `/classes/${th2.id}`);
    await api('DELETE', `/classes/${th.id}`);
  });
  it('假期课时位内容整体顺延（链式跨周，假期格清空，其他内容保持相对顺序）', async () => {
    // 触发顺延：周视图加载即幂等同步
    const w5 = await api('GET', `/${SID}/week-view?week=5`);
    expect(w5.holiday_off).toContain('4-8'); // 10/1 周四放假
    expect(w5.holiday_off).toContain('6-8'); // 10/3 周六放假
    expect(w5.holiday_off).not.toContain('1-8'); // 9/28 周一正常上课
    const d = await api('GET', `/${SID}/teaching-content`);
    const at = (cid, w, wd, p) => d.contents.find((c) => c.class_id === cid && c.week === w && c.weekday === wd && c.period === p);
    // W5 周四（假期）内容 → 下一个课时位（W5 周六，同为假期）→ 继续越过假期块落 W6 周四
    expect(at(th.id, 6, 4, 8)?.content).toBe('甲');
    // W5 周六（假期）内容 → W6 周六
    expect(at(th.id, 6, 6, 8)?.content).toBe('乙');
    // W6 周四（正常）内容 → W7 周四（越过 W6 周一~周三假期块）
    expect(at(th.id, 7, 4, 8)?.content).toBe('丙');
    // W6 周六（正常）内容 → W7 周六
    expect(at(th.id, 7, 6, 8)?.content).toBe('丁');
    // 假期课时位已清空
    expect(at(th.id, 5, 4, 8)).toBeUndefined();
    expect(at(th.id, 5, 6, 8)).toBeUndefined();
  });
  it('幂等：重复加载周视图不二次顺延', async () => {
    await api('GET', `/${SID}/week-view?week=5`);
    await api('GET', `/${SID}/week-view?week=6`);
    const d = await api('GET', `/${SID}/teaching-content`);
    const at = (cid, w, wd, p) => d.contents.find((c) => c.class_id === cid && c.week === w && c.weekday === wd && c.period === p);
    expect(at(th.id, 6, 4, 8)?.content).toBe('甲'); // 不再移动
    expect(at(th.id, 7, 6, 8)?.content).toBe('丁');
  });
  it('假期课时位无内容 → 不动作（非假期内容不受影响）', async () => {
    await api('GET', `/${SID}/week-view?week=5`);
    const d = await api('GET', `/${SID}/teaching-content`);
    const c = d.contents.find((x) => x.class_id === th2.id);
    expect(c.week).toBe(1); // 对照班内容原地不动
    expect(c.content).toBe('对照内容');
  });
  it('假期当天不在周视图/待办中出现课程', async () => {
    const w5 = await api('GET', `/${SID}/week-view?week=5`);
    // 4-8 为假期隐藏格（不出现 merged_cells）
    expect(w5.merged_cells.some((c) => c.key === '4-8' && c.class_id === th.id)).toBe(false);
    const todos = await api('GET', `/${SID}/todos?date=2026-10-01`);
    expect(todos.todos.some((t) => t.kind === 'course' && t.class_id === th.id)).toBe(false);
  });
});

describe('功能1回归：各班第 N 节课内容一致（用户确认语义）', () => {
  it('一键预填后同班序内容一致（覆盖式对齐）', async () => {
    await api('PUT', `/${SID}/sequence?stage=middle`, { items: ['第一课·中学时代', '少年有梦', '学习伴成长', '享受学习', '认识自己', '和朋友在一起'] });
    await api('POST', `/${SID}/sequence/apply`, {});
    const d = await api('GET', `/${SID}/teaching-content`);
    const byClass = {};
    for (const c of d.contents) {
      if (c.class_id.startsWith('cls-cy')) (byClass[c.class_id] = byClass[c.class_id] || []).push(c);
    }
    const firstCol = new Set();
    const secondCol = new Set();
    for (const cid of Object.keys(byClass)) {
      const items = byClass[cid].sort((a, b) => (a.week - b.week) || ((a.weekday || 1) - (b.weekday || 1)) || ((a.period || 1) - (b.period || 1)));
      firstCol.add(items[0].content);
      if (items[1]) secondCol.add(items[1].content);
    }
    expect(firstCol.size).toBe(1); // 各班第1节课完全一致
    expect([...firstCol][0]).toBe('第一课·中学时代');
    expect(secondCol.size).toBe(1); // 第2节课一致
  });
  it('种子数据：各班第1节课内容一致', async () => {
    const d = await api('GET', `/${SID}/teaching-content`);
    const cy = d.contents.filter((c) => c.class_id.startsWith('cls-cy'));
    const firstOfEach = {};
    for (const c of cy) {
      const key = `${c.class_id}`;
      if (!firstOfEach[key]) firstOfEach[key] = c.content;
    }
    expect(new Set(Object.values(firstOfEach)).size).toBe(1);
  });
});
