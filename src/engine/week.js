// R1 周数计算 + R6 学期进度（纯函数）
// 口径（规则护栏文档 §2.1/§2.2）：
// - 第 1 周 = 开学日所在周（周一起始）
// - 未到开学日 → "未开学"，不显示周数、不提前计数
// - 周数自开学日连续累加，跨年不重置；放假结束后封顶于学期总周数
// - 进度 = 自然日口径：已过自然日（含当天）/ 学期总自然日（含首尾）× 100%

import { parseISO, diffDays, weekStart, addDays } from './date.js';

function assertSemester(semester) {
  if (!semester || !semester.start_date || !semester.end_date) {
    throw new Error('semester 必须包含 start_date / end_date');
  }
  if (!parseISO(semester.start_date) || !parseISO(semester.end_date)) {
    throw new Error(`非法学期日期: ${semester.start_date} ~ ${semester.end_date}`);
  }
  if (diffDays(semester.start_date, semester.end_date) < 0) {
    throw new Error('学期结束日期不得早于开始日期');
  }
}

/** 学期总周数（全站唯一口径入口） */
export function semesterTotalWeeks(semester) {
  assertSemester(semester);
  const w1 = weekStart(semester.start_date);
  const end = semester.end_date;
  return Math.floor(diffDays(w1, end) / 7) + 1;
}

/**
 * week_of(semester, date)
 * 返回 { status: "未开学" } 或 { status: "第N周", week, total, week_start, week_end }
 */
export function weekOf(semester, date) {
  assertSemester(semester);
  if (!parseISO(date)) throw new Error(`非法日期: ${date}`);
  if (date < semester.start_date) return { status: '未开学' };
  const w1 = weekStart(semester.start_date);
  const total = semesterTotalWeeks(semester);
  const week = Math.min(Math.floor(diffDays(w1, date) / 7) + 1, total);
  const ws = addDays(w1, (week - 1) * 7);
  return { status: '第N周', week, total, week_start: ws, week_end: addDays(ws, 6) };
}

/** 指定周 → 该周日期范围 [start, end] */
export function weekRange(semester, week) {
  const total = semesterTotalWeeks(semester);
  if (week < 1 || week > total) throw new Error(`周数越界: ${week}（学期共 ${total} 周）`);
  const w1 = weekStart(semester.start_date);
  const ws = addDays(w1, (week - 1) * 7);
  return { week, start: ws, end: addDays(ws, 6) };
}

/**
 * progress(semester, today) → 0..100（自然日口径，含当天）
 * 开学前 = 0%，结束后 = 100%
 */
export function progress(semester, today) {
  assertSemester(semester);
  if (!parseISO(today)) throw new Error(`非法日期: ${today}`);
  if (today < semester.start_date) return 0;
  if (today > semester.end_date) return 100;
  const total = diffDays(semester.start_date, semester.end_date) + 1; // 含首尾
  const elapsed = diffDays(semester.start_date, today) + 1; // 含当天
  return Math.round((elapsed / total) * 1000) / 10; // 保留 1 位小数
}

/** 学期内某日期属于第几周（未开学返回 0） */
export function weekIndexOf(semester, date) {
  const r = weekOf(semester, date);
  return r.status === '未开学' ? 0 : r.week;
}
