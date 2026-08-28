// R4 临时调课合并（纯函数）
// 语义（规则护栏文档 §2.4 TM1–TM5）：
// - 临时调课绑定生效周，仅当周生效，下周自动失效（记录保留，历史可查）
// - 当周合并：临时调课优先覆盖固定排课同班级同时段；被覆盖的固定课当周不显示但数据不动
// - 当周视图 = 固定排课(当周) ⊕ 临时调课(当周)，由引擎纯函数输出，UI 只消费合并结果

/**
 * 固定排课生效周判定（单双周/指定周支持，D3 扩展）
 * @param fc 固定排课 { week?, ... }：week 缺省=每周；'odd'=单周；'even'=双周；数字=仅该周；数组=仅这些周
 */
export function fixedInWeek(fc, week) {
  const w = fc && fc.week;
  if (w === undefined || w === null || w === '') return true;
  if (w === 'odd') return week % 2 === 1;
  if (w === 'even') return week % 2 === 0;
  if (Array.isArray(w)) return w.includes(week);
  return Number(w) === week;
}

/**
 * merge_week_view(fixedCourses, tempChanges, week)
 * @param fixedCourses 固定排课：[{ id, class_id, weekday, period, week? }]（每周复用模板；week 可选：'odd'/'even'/指定周）
 * @param tempChanges 临时调课：[{ id, class_id, week, origin_weekday, origin_period, new_weekday, new_period, note? }]
 * @param week 目标周
 * @returns {
 *   cells: Map<"weekday-period", { class_id, temp?: true, temp_id?, note? }>  // 当周合并后的课时占用
 *   moved:  [{ class_id, origin: "wd-p", target: "wd-p", note? }]            // 本周被调动的记录
 *   suppressed: ["wd-p", ...]                                               // 被覆盖隐藏的固定课时位
 * }
 * 同班同时段固定+临时冲突：临时优先（TM2）
 */
export function mergeWeekView(fixedCourses, tempChanges, week) {
  const cells = new Map();
  const key = (wd, p) => `${wd}-${p}`;
  // 1. 固定排课铺底（仅当周生效的固定课：单双周/指定周过滤）
  for (const fc of fixedCourses) {
    if (!fixedInWeek(fc, week)) continue;
    const k = key(fc.weekday, fc.period);
    cells.set(k, { class_id: fc.class_id, fixed_id: fc.id, week: fc.week });
  }
  // 2. 当周临时调课覆盖
  const moved = [];
  const suppressed = new Set();
  const weekChanges = (tempChanges || []).filter((t) => t.week === week);
  for (const t of weekChanges) {
    const originK = key(t.origin_weekday, t.origin_period);
    const targetK = key(t.new_weekday, t.new_period);
    // 原位置有固定课 → 当周隐藏（数据不动）
    if (cells.has(originK) && !cells.get(originK).temp) {
      suppressed.add(originK);
    }
    // 目标位置：临时调课优先覆盖
    cells.set(targetK, { class_id: t.class_id, temp: true, temp_id: t.id, note: t.note });
    moved.push({ class_id: t.class_id, origin: originK, target: targetK, note: t.note });
    // 原位置若只是被本调课移走（无其他固定课）→ 移除
    if (!suppressed.has(originK) && cells.get(originK) && cells.get(originK).temp) {
      cells.delete(originK);
    }
  }
  return { cells, moved, suppressed: [...suppressed] };
}

/**
 * 计算某日的今日待办（F2）：当日固定课程 + 当周临时调课覆盖结果 + 个人事务
 * @returns [{ kind: 'course'|'temp'|'task', class_id?, title, weekday, period, date, done, event_id? }]
 */
export function dailyTodos(fixedCourses, tempChanges, week, weekday, tasks) {
  const view = mergeWeekView(fixedCourses, tempChanges, week);
  const todos = [];
  for (const [k, cell] of view.cells.entries()) {
    const [wd, period] = k.split('-').map(Number);
    if (wd !== weekday) continue;
    if (cell.temp) {
      todos.push({ kind: 'temp', class_id: cell.class_id, title: `临时调课·${cell.note || ''}`.trim(), weekday: wd, period, done: false });
    } else {
      todos.push({ kind: 'course', class_id: cell.class_id, title: `固定课程·${cell.class_id}`, weekday: wd, period, done: false });
    }
  }
  for (const t of (tasks || [])) {
    if (t.weekday === weekday) {
      todos.push({ kind: 'task', title: t.title, weekday, period: t.period || 99, done: !!t.done, event_id: t.id });
    }
  }
  todos.sort((a, b) => (a.period - b.period) || (a.kind === 'task' ? 1 : -1));
  return todos;
}
