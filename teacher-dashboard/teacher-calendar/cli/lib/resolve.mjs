// tc CLI · 名称→ID 解析器（intent R4 / spec §3）
// 原则：精确 ID → 名称精确 → 名称包含；多义抛 RESOLVE_AMBIGUOUS 附候选清单，绝不猜测。
// 所有解析结果通过 _resolved 字段回显，方便 Agent 后续复用 ID。

import { TcError } from './api.mjs';

const notFound = (entity, input, candidates) =>
  new TcError('RESOLVE_NOT_FOUND', `找不到${entity}「${input}」`, { candidates });
const ambiguous = (entity, input, candidates) =>
  new TcError('RESOLVE_AMBIGUOUS', `${entity}「${input}」命中 ${candidates.length} 个候选，请用更精确的名称或改用 id 指定`, { candidates });

/** id 精确 → 名称精确 → 名称包含（唯一） */
function pick(list, input, { idKey, nameKey, label }) {
  const byId = list.find((x) => x[idKey] === input);
  if (byId) return { hit: byId, how: 'id' };
  const exact = list.filter((x) => x[nameKey] === input);
  if (exact.length === 1) return { hit: exact[0], how: 'name-exact' };
  if (exact.length > 1) throw ambiguous(label, input, exact);
  const fuzzy = list.filter((x) => x[nameKey]?.includes(input));
  if (fuzzy.length === 1) return { hit: fuzzy[0], how: 'name-contains' };
  if (fuzzy.length > 1) throw ambiguous(label, input, fuzzy);
  throw notFound(label, input, list.map((x) => ({ id: x[idKey], name: x[nameKey] })));
}

/** 学期：undefined/'current' → 当前学期；否则 id / 名称子串（spec §3） */
export async function resolveSemester(api, input) {
  const boot = await api.call('calendar', '/bootstrap');
  const sems = boot.semesters || [];
  if (!input || input === 'current') {
    const cur = sems.find((s) => s.id === boot.settings?.current_semester_id) || sems[0];
    if (!cur) throw new TcError('RESOLVE_NOT_FOUND', '实例中尚无任何学期', { candidates: [] });
    cur._resolved = { entity: 'semester', how: input ? 'current' : 'current-fallback' };
    return cur;
  }
  const { hit, how } = pick(sems, input, { idKey: 'id', nameKey: 'name', label: '学期' });
  hit._resolved = { entity: 'semester', how };
  return hit;
}

/** 日历侧班级（全局班级库） */
export async function resolveCalendarClass(api, input) {
  const { classes } = await api.call('calendar', '/classes');
  const { hit, how } = pick(classes || [], input, { idKey: 'id', nameKey: 'name', label: '班级' });
  hit._resolved = { entity: 'class', how };
  return hit;
}

/** 档案侧班级（可带 role/stage 过滤） */
export async function resolvePortfolioClass(api, input, { role, stage } = {}) {
  const q = new URLSearchParams();
  if (role) q.set('role', role);
  if (stage) q.set('stage', stage);
  const qs = q.toString() ? `?${q}` : '';
  const { classes } = await api.call('portfolio', `/classes${qs}`);
  const { hit, how } = pick(classes || [], input, { idKey: 'id', nameKey: 'name', label: '班级' });
  hit._resolved = { entity: 'class', how };
  return hit;
}

/** 学生：限某班名单内，姓名精确 / 学号 / id；同名多名 → AMBIGUOUS（intent E3） */
export async function resolveStudent(api, classObj, input) {
  const { students } = await api.call('portfolio', `/classes/${classObj.id}/students?page_size=500`);
  const list = students || [];
  const byId = list.find((s) => s.id === input);
  if (byId) return { ...byId, _resolved: { entity: 'student', how: 'id' } };
  const byNo = list.filter((s) => s.student_no && s.student_no === input);
  if (byNo.length === 1) return { ...byNo[0], _resolved: { entity: 'student', how: 'student_no' } };
  const byName = list.filter((s) => s.name === input);
  if (byName.length === 1) return { ...byName[0], _resolved: { entity: 'student', how: 'name-exact' } };
  if (byName.length > 1) throw ambiguous('学生', input, byName.map((s) => ({ id: s.id, name: s.name, student_no: s.student_no })));
  const fuzzy = list.filter((s) => s.name?.includes(input));
  if (fuzzy.length === 1) return { ...fuzzy[0], _resolved: { entity: 'student', how: 'name-contains' } };
  if (fuzzy.length > 1) throw ambiguous('学生', input, fuzzy.map((s) => ({ id: s.id, name: s.name, student_no: s.student_no })));
  throw notFound('学生', input, list.slice(0, 50).map((s) => ({ id: s.id, name: s.name, student_no: s.student_no })));
}

/** 考试：限某班考试列表内，id 精确 → 名称精确 → 名称包含 */
export async function resolveExam(api, classObj, input, { type } = {}) {
  const q = type ? `?type=${encodeURIComponent(type)}` : '';
  const { exams } = await api.call('portfolio', `/classes/${classObj.id}/exams${q}`);
  const { hit, how } = pick(exams || [], input, { idKey: 'id', nameKey: 'name', label: '考试' });
  hit._resolved = { entity: 'exam', how };
  return hit;
}
