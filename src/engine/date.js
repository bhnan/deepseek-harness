// 日期工具（纯函数，UTC 语义，避免时区偏移）
// ISO 日期字符串 YYYY-MM-DD 为全系统唯一日期形态

/** 解析 "YYYY-MM-DD" → Date（UTC 午夜）。非法输入返回 null */
export function parseISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** Date → "YYYY-MM-DD" */
export function toISO(dt) {
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** 日期字符串差（b - a，单位：天） */
export function diffDays(a, b) {
  const da = parseISO(a), db = parseISO(b);
  if (!da || !db) return NaN;
  return Math.round((db - da) / 86400000);
}

/** 日期字符串加 N 天 */
export function addDays(s, n) {
  const dt = parseISO(s);
  if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() + n);
  return toISO(dt);
}

/** 星期几：周一=1 … 周日=7 */
export function weekday(s) {
  const dt = parseISO(s);
  if (!dt) return null;
  const wd = dt.getUTCDay(); // 0=周日
  return wd === 0 ? 7 : wd;
}

/** 所在周的周一（周一起始） */
export function weekStart(s) {
  const dt = parseISO(s);
  if (!dt) return null;
  const wd = weekday(s);
  dt.setUTCDate(dt.getUTCDate() - (wd - 1));
  return toISO(dt);
}

/** 所在周的周日 */
export function weekEnd(s) {
  const ws = weekStart(s);
  return ws ? addDays(ws, 6) : null;
}

/** 两个 ISO 日期比较：a < b → -1, a === b → 0, a > b → 1 */
export function cmpISO(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export const todayISO = () => toISO(new Date());

/** 标准月日格式（F8.2）："2026-09-01" → "9.1"；无前导零 */
export function formatMD(s) {
  const dt = parseISO(s);
  if (!dt) return s || '';
  return `${dt.getUTCMonth() + 1}.${dt.getUTCDate()}`;
}
