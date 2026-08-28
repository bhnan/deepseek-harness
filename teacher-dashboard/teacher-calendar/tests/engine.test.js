import { describe, it, expect } from 'vitest';
import {
  weekOf, semesterTotalWeeks, weekRange, progress, weekIndexOf,
  shiftContent, deferContent, undeferContent, buildSlots, bindItems,
  mergeWeekView, dailyTodos,
  parseISO, diffDays, weekday, weekStart,
} from '../src/engine/index.js';

const SEM_FALL = { id: 's1', name: '2026年秋季第一学期', start_date: '2026-09-01', end_date: '2027-01-17' };
const SEM_SPRING = { id: 's2', name: '2027年春季第二学期', start_date: '2027-02-22', end_date: '2027-07-06' };

describe('R1 周数计算', () => {
  it('开学前不计数（验收 1）', () => {
    expect(weekOf(SEM_FALL, '2026-08-25').status).toBe('未开学');
    expect(weekOf(SEM_FALL, '2026-08-31').status).toBe('未开学'); // 开学前一日
  });
  it('开学日 = 第1周（验收 1）', () => {
    expect(weekOf(SEM_FALL, '2026-09-01')).toMatchObject({ status: '第N周', week: 1 });
  });
  it('跨年周连续累加不归零（验收 2）', () => {
    expect(weekOf(SEM_FALL, '2026-12-28').week).toBe(18);
    expect(weekOf(SEM_FALL, '2027-01-04').week).toBe(19);
    expect(weekOf(SEM_FALL, '2027-01-17').week).toBe(20);
  });
  it('两学期均 20 周，口径唯一（验收 3）', () => {
    expect(semesterTotalWeeks(SEM_FALL)).toBe(20);
    expect(semesterTotalWeeks(SEM_SPRING)).toBe(20);
  });
  it('放假结束后封顶学期总周数', () => {
    expect(weekOf(SEM_FALL, '2027-01-20').week).toBe(20);
  });
  it('周数-日期双向映射：weekRange 与 weekOf 互逆', () => {
    const r = weekRange(SEM_FALL, 7);
    expect(weekOf(SEM_FALL, r.start).week).toBe(7);
    expect(weekOf(SEM_FALL, r.end).week).toBe(7);
    expect(weekOf(SEM_FALL, '2026-10-12').week).toBe(7); // 用户故事 10.12 第 7 周
  });
  it('日期边界：2026-09-01 为周二', () => {
    expect(weekday('2026-09-01')).toBe(2);
    expect(weekStart('2026-09-01')).toBe('2026-08-31');
  });
});

describe('R6 进度计算（自然日口径，含当天）', () => {
  it('端点：开学当天、放假当天（验收 11）', () => {
    expect(progress(SEM_FALL, '2026-09-01')).toBe(0.7); // 1/139 ≈ 0.72%，保留 1 位小数 → 0.7
    expect(progress(SEM_FALL, '2027-01-17')).toBe(100);
  });
  it('开学前 0%、结束后 100%', () => {
    expect(progress(SEM_FALL, '2026-08-01')).toBe(0);
    expect(progress(SEM_FALL, '2027-02-01')).toBe(100);
  });
  it('中间值单调递增', () => {
    const p1 = progress(SEM_FALL, '2026-10-13');
    const p2 = progress(SEM_FALL, '2026-10-14');
    expect(p2).toBeGreaterThan(p1);
  });
});

describe('R3 授课内容序列顺延（单班）', () => {
  // 该班每周 2 节（周一第1节、周三第2节），学期 20 周 → 40 个课时位
  const slots = buildSlots([{ weekday: 1, period: 1 }, { weekday: 3, period: 2 }], 20);
  const contents = [
    { id: 'a', week: 1, weekday: 1, period: 1, content: '一.1', seq_index: 0 },
    { id: 'b', week: 1, weekday: 3, period: 2, content: '一.2', seq_index: 1 },
    { id: 'c', week: 2, weekday: 1, period: 1, content: '一.3', seq_index: 2 },
    { id: 'd', week: 2, weekday: 3, period: 2, content: '一.4', seq_index: 3 },
  ];
  // 构造按 seq_index 排序的 items（shiftContent 的新接口）
  const seqItems = contents.map((c) => ({ seq_index: c.seq_index, content: c.content, id: c.id })).sort((a, b) => a.seq_index - b.seq_index);
  it('链式后移（用户原例：第2课时改为复习）', () => {
    const r = shiftContent(seqItems, '复习', 1);
    expect(r.ok).toBe(true);
    const seq = r.items;
    // 内容条目数 +1：新内容占位，原内容依次后移，一.4 追加到末尾
    expect(seq.map((i) => i.content)).toEqual(['一.1', '复习', '一.2', '一.3', '一.4']);
    expect(seq.map((i) => i.seq_index)).toEqual([0, 1, 2, 3, 4]);
    expect(seq[seq.length - 1].id).toBe(null); // 追加条目 id 待分配
  });
  it('仅该班序列变动：其他内容不受影响（函数外由调用方保证）', () => {
    const r = shiftContent(seqItems, '复习', 0);
    expect(r.ok).toBe(true);
    expect(r.items[0].content).toBe('复习');
    expect(r.items[1].content).toBe('一.1');
    expect(r.items.length).toBe(5);
  });
  it('边界校验：越界 pos / 空内容 / seq_index 乱序', () => {
    expect(shiftContent(seqItems, 'X', 99).ok).toBe(false);
    expect(shiftContent(seqItems, '  ', 0).ok).toBe(false);
    const bad = [{ seq_index: 2, content: 'x' }, { seq_index: 1, content: 'y' }];
    expect(shiftContent(bad, 'X', 0).ok).toBe(false);
  });
  it('停课顺延：第 2 课时停课 → 内容整体后移一位，该课时位置空（R3 扩展）', () => {
    const { items } = bindItems(contents, slots);
    const r = deferContent(slots, items, 1);
    expect(r.ok).toBe(true);
    const seq = r.items;
    // 内容数不变；一.2/一.3/一.4 各后移一位，slotIndex=1 空出（当天停课）
    expect(seq.map((i) => i.content)).toEqual(['一.1', '一.2', '一.3', '一.4']);
    expect(seq.map((i) => i.slotIndex)).toEqual([0, 2, 3, 4]);
    // 被挤出的最后一条（一.4）落入 slotIndex=4（原空课时位），id 保留
    expect(seq[3].id).toBe('d');
  });
  it('停课顺延第 1 课时：整条链后移，第一课时位空出', () => {
    const { items } = bindItems(contents, slots);
    const r = deferContent(slots, items, 0);
    expect(r.ok).toBe(true);
    expect(r.items.map((i) => i.slotIndex)).toEqual([1, 2, 3, 4]);
  });
  it('停课顺延课时位不足 → 原子拒绝（与 SH7 一致）', () => {
    const tightSlots = buildSlots([{ weekday: 1, period: 1 }, { weekday: 3, period: 2 }], 2); // 4 个课时位
    const tight = [
      { id: 'a', week: 1, weekday: 1, period: 1, content: '一.1' },
      { id: 'b', week: 1, weekday: 3, period: 2, content: '一.2' },
      { id: 'c', week: 2, weekday: 1, period: 1, content: '一.3' },
      { id: 'd', week: 2, weekday: 3, period: 2, content: '一.4' },
    ];
    const { items } = bindItems(tight, tightSlots);
    const r = deferContent(tightSlots, items, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('超出');
  });
  it('取消停课顺延：内容整体前移，恢复到原位置（defer 逆操作）', () => {
    const { items } = bindItems(contents, slots); // [{0,一.1},{1,一.2},{2,一.3},{3,一.4}]
    const d = deferContent(slots, items, 1); // → [{0,一.1},{2,一.2},{3,一.3},{4,一.4}]
    expect(d.ok).toBe(true);
    const u = undeferContent(slots, d.items, 1); // → 恢复 [{0,一.1},{1,一.2},{2,一.3},{3,一.4}]
    expect(u.ok).toBe(true);
    expect(u.items.map((i) => i.content)).toEqual(['一.1', '一.2', '一.3', '一.4']);
    expect(u.items.map((i) => i.slotIndex)).toEqual([0, 1, 2, 3]);
    expect(u.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']); // id 全部还原
  });
  it('取消停课顺延首课时位：整条链前移恢复', () => {
    const { items } = bindItems(contents, slots);
    const d = deferContent(slots, items, 0); // → [{1,一.1},{2,一.2},{3,一.3},{4,一.4}]
    const u = undeferContent(slots, d.items, 0);
    expect(u.ok).toBe(true);
    expect(u.items.map((i) => i.slotIndex)).toEqual([0, 1, 2, 3]);
  });
  it('取消顺延边界：该课时位未被顺延（已有内容）→ 拒绝', () => {
    const { items } = bindItems(contents, slots);
    // items 中 slotIndex=1 有内容（未顺延）→ undefer 应拒绝
    const r = undeferContent(slots, items, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('已有内容');
  });
  it('取消顺延边界：该课时位之后无内容 → 拒绝', () => {
    const { items } = bindItems(contents, slots);
    const d = deferContent(slots, items, 3); // 最后一条后移 → [{0},{1},{2},{4,一.4}]
    expect(d.ok).toBe(true);
    // 顺延后再取消第 4 课时位（slotIndex=4 无内容，后续无内容）→ 拒绝
    const r = undeferContent(slots, d.items, 4);
    expect(r.ok).toBe(false);
  });
});

describe('R4 临时调课合并', () => {
  const fixed = [
    { id: 'f1', class_id: 'c1', weekday: 1, period: 1 },
    { id: 'f2', class_id: 'c1', weekday: 3, period: 2 },
    { id: 'f3', class_id: 'c2', weekday: 1, period: 2 },
  ];
  const temps = [
    { id: 't1', class_id: 'c1', week: 5, origin_weekday: 3, origin_period: 2, new_weekday: 4, new_period: 3, note: '国庆调休' },
  ];
  it('当周生效：第5周合并正确（验收 7）', () => {
    const v = mergeWeekView(fixed, temps, 5);
    expect(v.cells.get('4-3')).toMatchObject({ class_id: 'c1', temp: true, note: '国庆调休' });
    expect(v.suppressed).toContain('3-2'); // 原周三第2节当周隐藏
    expect(v.moved.length).toBe(1);
  });
  it('下周自动失效：第6周恢复固定排课（验收 7）', () => {
    const v = mergeWeekView(fixed, temps, 6);
    expect(v.cells.get('3-2')).toMatchObject({ class_id: 'c1', fixed_id: 'f2' });
    expect(v.cells.has('4-3')).toBe(false);
    expect(v.suppressed.length).toBe(0);
  });
  it('临时优先覆盖同班同时段（TM2）', () => {
    const t = [{ id: 't9', class_id: 'c2', week: 3, origin_weekday: 5, origin_period: 5, new_weekday: 1, new_period: 2, note: '加课' }];
    const v = mergeWeekView(fixed, t, 3);
    expect(v.cells.get('1-2')).toMatchObject({ class_id: 'c2', temp: true });
  });
  it('今日待办：固定+临时+事务汇总（F2）', () => {
    const todos = dailyTodos(fixed, temps, 5, 4, [{ id: 'e1', title: '提交教研计划', weekday: 4, period: 0, done: true }]);
    const kinds = todos.map((t) => t.kind);
    expect(kinds).toContain('temp');   // 临时调课（周四）
    expect(kinds).toContain('task');   // 个人事务
    const doneTask = todos.find((t) => t.kind === 'task');
    expect(doneTask.done).toBe(true);
  });
});

describe('D3 固定排课生效周（week 字段：单双周/指定周/周数组）', () => {
  const fixed = [
    { id: 'f1', class_id: 'c1', weekday: 1, period: 5 },        // 每周
    { id: 'f2', class_id: 'c2', weekday: 2, period: 8, week: 'odd' },   // 仅单周
    { id: 'f3', class_id: 'c3', weekday: 2, period: 9, week: 'even' },  // 仅双周
    { id: 'f4', class_id: 'c4', weekday: 7, period: 5, week: 11 },      // 仅第11周
    { id: 'f5', class_id: 'c5', weekday: 7, period: 7, week: [13, 17] },// 仅第13/17周
  ];
  it('单周：odd 生效、even 隐藏、指定周不生效', () => {
    const v = mergeWeekView(fixed, [], 11); // 第11周（单）
    expect(v.cells.get('2-8')).toMatchObject({ class_id: 'c2', fixed_id: 'f2' }); // 单周课服 ✓
    expect(v.cells.has('2-9')).toBe(false);                                      // 双周课服隐藏
    expect(v.cells.get('7-5')).toMatchObject({ class_id: 'c4' });                // 第11周周日课 ✓
    expect(v.cells.has('7-7')).toBe(false);                                      // 13/17 周数组不含 11
    expect(v.cells.get('1-5')).toMatchObject({ class_id: 'c1' });                // 每周正课 ✓
  });
  it('双周：even 生效、odd 隐藏', () => {
    const v = mergeWeekView(fixed, [], 12); // 第12周（双）
    expect(v.cells.get('2-9')).toMatchObject({ class_id: 'c3' });
    expect(v.cells.has('2-8')).toBe(false);
    expect(v.cells.has('7-5')).toBe(false); // 指定周 11 不生效
  });
  it('周数组：仅列出的周生效（第13周有、第14周无）', () => {
    expect(mergeWeekView(fixed, [], 13).cells.has('7-7')).toBe(true);
    expect(mergeWeekView(fixed, [], 14).cells.has('7-7')).toBe(false);
  });
  it('buildSlots 按生效周展开课时位（内容序列/预填口径一致）', () => {
    const slots = buildSlots(fixed, 22);
    const keys = slots.map((s) => `${s.week}-${s.weekday}-${s.period}`);
    // f2：'odd' 单周（周二第8节）→ 学期 22 周内单周共 11 个（1,3,5,…,21）
    expect(keys.filter((k) => /^\d+-2-8$/.test(k))).toHaveLength(11);
    expect(keys.filter((k) => k === '11-7-5')).toHaveLength(1);   // 仅第11周
    expect(keys.filter((k) => k === '13-7-7')).toHaveLength(1);   // 第13周数组
    expect(keys.filter((k) => k === '14-7-7')).toHaveLength(0);   // 第14周不在数组
  });
});

describe('日期工具', () => {
  it('parseISO 拒绝非法输入', () => {
    expect(parseISO('2026-13-01')).toBe(null);
    expect(parseISO('2026-02-30')).toBe(null);
    expect(parseISO('abc')).toBe(null);
  });
  it('diffDays / addDays 正确', () => {
    expect(diffDays('2026-09-01', '2026-09-08')).toBe(7);
    expect(diffDays('2026-09-01', '2027-01-17')).toBe(138); // 含首尾 139 天
  });
});
