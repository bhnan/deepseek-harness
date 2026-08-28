// 学生成长档案工作台 —— Express API 服务器（03 接口设计文档契约）
// 端口 8797；数据 data/student-portfolio.db（SQLite）；唯一联动：沟通安排 → 教学日历（后续模块）
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openDB, getDB, getById, insertRow, updateRow, deleteRow,
  getSettings, updateSettings, getSetting, withTx, genId, nowISO, todayISO, pushUndo, popUndo, parseAfter,
  schemaVersion,
} from './storage.mjs';
import {
  encryptStudentRow, decryptStudentRow, maskStudentRow,
  maskIdCard, maskPhone, maskAddress, maskName, SENSITIVE_FIELDS, DATA_DIR,
} from './crypto.mjs';
import { seedIfEmpty } from './seed.mjs';
import { analyzeStudentScores, analyzeClass, compareDfClasses, generateComment, catLabel } from './engine.mjs';
import { semesterOf, isoWeek, semesterRange, DB_FILE, closeDB } from './storage.mjs';
import { syncCommunicationToCalendar, deleteCalendarEvent } from './calendar-link.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8797;
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// 启动：建库 + 迁移 + 种子
openDB();
seedIfEmpty();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, status, reason) => res.status(status).json({ ok: false, reason });

// ---------- 校验工具 ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s) => {
  if (!DATE_RE.test(s || '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const STAGES = ['primary', 'middle'];
const ROLES = ['homeroom', 'subject'];
const GENDERS = ['男', '女'];
const PRESSURES = ['低', '中', '高'];
const cleanStr = (v, max) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max || 500));

// ---------- 2. 设置 ----------
app.get('/api/portfolio/settings', (req, res) => ok(res, { settings: getSettings() }));

app.put('/api/portfolio/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.title !== undefined) {
    const t = cleanStr(b.title, 40);
    if (!t) return fail(res, 400, 'title 不能为空');
    patch.title = t;
  }
  if (b.teacher_name !== undefined) patch.teacher_name = cleanStr(b.teacher_name, 40);
  if (b.theme_id !== undefined) {
    if (!['fresh', 'pastel', 'art'].includes(b.theme_id)) return fail(res, 400, 'theme_id 必须是 fresh/pastel/art');
    patch.theme_id = b.theme_id;
  }
  if (b.stage_filter !== undefined) {
    if (!['all', 'primary', 'middle'].includes(b.stage_filter)) return fail(res, 400, 'stage_filter 必须是 all/primary/middle');
    patch.stage_filter = b.stage_filter;
  }
  if (b.calendar_api_base !== undefined) {
    const u = cleanStr(b.calendar_api_base, 200);
    if (u && !/^https?:\/\/[\w.:-]+$/.test(u)) return fail(res, 400, 'calendar_api_base 必须是 http(s)://host[:port]');
    patch.calendar_api_base = u;
  }
  if (b.calendar_semester_id !== undefined) patch.calendar_semester_id = cleanStr(b.calendar_semester_id, 60);
  if (b.calendar_link_enabled !== undefined) patch.calendar_link_enabled = !!b.calendar_link_enabled;
  if (Object.keys(patch).length > 0) {
    pushUndo({ op: 'update', entity: 'settings', entity_id: 'settings', before: getSettings(), after: { ...getSettings(), ...patch } });
    updateSettings(patch);
  }
  ok(res, { settings: getSettings() });
});

app.post('/api/portfolio/calendar/test', async (req, res) => {
  const base = cleanStr((req.body || {}).calendar_api_base, 200) || getSettings().calendar_api_base;
  try {
    const r = await fetch(`${base}/api/calendar/bootstrap`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return ok(res, { reachable: false, reason: `教学日历响应异常（HTTP ${r.status}）` });
    const d = await r.json();
    ok(res, {
      reachable: true,
      semesters: (d.semesters || []).map((s) => ({ id: s.id, name: s.name, start_date: s.start_date, end_date: s.end_date })),
    });
  } catch (e) {
    ok(res, { reachable: false, reason: `无法连接教学日历（${e.message}）` });
  }
});

// ---------- 3. 班级 ----------
const classRow = (c) => ({ ...c });

app.get('/api/portfolio/classes', (req, res) => {
  const { role, stage } = req.query;
  const cond = [];
  const params = [];
  if (role === 'homeroom' || role === 'subject') { cond.push('role = ?'); params.push(role); }
  if (stage === 'primary' || stage === 'middle') { cond.push('stage = ?'); params.push(stage); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const rows = getDB().prepare(`SELECT * FROM classes ${where} ORDER BY role, sort_order, grade, name`).all(...params);
  const counts = getDB().prepare(
    `SELECT class_id, COUNT(*) AS n FROM students WHERE active = 1 GROUP BY class_id`
  ).all();
  const countMap = new Map(counts.map((r) => [r.class_id, r.n]));
  ok(res, {
    classes: rows.map((c) => ({ ...classRow(c), student_count: countMap.get(c.id) || 0 })),
    total: rows.length,
  });
});

app.post('/api/portfolio/classes', (req, res) => {
  const b = req.body || {};
  const name = cleanStr(b.name, 20);
  const grade = cleanStr(b.grade, 20);
  if (!name) return fail(res, 400, 'name 必填');
  if (!grade) return fail(res, 400, 'grade 必填');
  if (!STAGES.includes(b.stage)) return fail(res, 400, 'stage 必须是 primary/middle');
  if (!ROLES.includes(b.role)) return fail(res, 400, 'role 必须是 homeroom/subject');
  const db = getDB();
  if (db.prepare('SELECT id FROM classes WHERE name = ?').get(name)) return fail(res, 409, `班级「${name}」已存在`);
  const cls = {
    id: genId('cls'), name, grade, stage: b.stage, role: b.role,
    sort_order: Number.isInteger(b.sort_order) ? b.sort_order : 0,
    created_at: nowISO(), updated_at: nowISO(),
  };
  withTx(() => {
    pushUndo({ op: 'create', entity: 'class', entity_id: cls.id, before: null, after: cls });
    insertRow('classes', cls);
  });
  ok(res, { class: classRow(cls) });
});

app.put('/api/portfolio/classes/:cid', (req, res) => {
  const before = getById('classes', req.params.cid);
  if (!before) return fail(res, 404, '班级不存在');
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) {
    const name = cleanStr(b.name, 20);
    if (!name) return fail(res, 400, 'name 不能为空');
    if (name !== before.name && getDB().prepare('SELECT id FROM classes WHERE name = ?').get(name)) return fail(res, 409, `班级「${name}」已存在`);
    patch.name = name;
  }
  if (b.grade !== undefined) patch.grade = cleanStr(b.grade, 20);
  if (b.stage !== undefined) {
    if (!STAGES.includes(b.stage)) return fail(res, 400, 'stage 非法');
    patch.stage = b.stage;
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return fail(res, 400, 'role 非法');
    if (b.role !== before.role && before.role === 'homeroom' && b.role === 'subject' && !b.confirm_role_change) {
      return fail(res, 400, '主班改为代课班将隐藏全功能数据，需 confirm_role_change=true 确认');
    }
    patch.role = b.role;
  }
  if (b.sort_order !== undefined) patch.sort_order = Number.isInteger(b.sort_order) ? b.sort_order : before.sort_order;
  if (Object.keys(patch).length === 0) return ok(res, { class: classRow(before) });
  patch.updated_at = nowISO();
  const after = withTx(() => {
    pushUndo({ op: 'update', entity: 'class', entity_id: before.id, before, after: { ...before, ...patch } });
    return updateRow('classes', before.id, patch);
  });
  ok(res, { class: classRow(after) });
});

app.delete('/api/portfolio/classes/:cid', (req, res) => {
  const before = getById('classes', req.params.cid);
  if (!before) return fail(res, 404, '班级不存在');
  const confirm = cleanStr((req.body || {}).confirm_name, 20);
  if (confirm !== before.name) return fail(res, 400, 'confirm_name 必须与班级名一致');
  const db = getDB();
  const cascade = withTx(() => {
    const rows = {
      students: db.prepare('SELECT * FROM students WHERE class_id = ?').all(before.id),
      exams: db.prepare('SELECT * FROM exams WHERE class_id = ?').all(before.id),
      assignments: db.prepare('SELECT * FROM assignments WHERE class_id = ?').all(before.id),
      honors: db.prepare('SELECT * FROM honors WHERE class_id = ?').all(before.id),
      materials: db.prepare('SELECT * FROM materials WHERE class_id = ?').all(before.id),
      communications: db.prepare('SELECT * FROM communications WHERE class_id = ?').all(before.id),
      layers: db.prepare('SELECT * FROM layers_snapshot WHERE class_id = ?').all(before.id),
      student_layers: db.prepare('SELECT * FROM student_layers WHERE class_id = ?').all(before.id),
    };
    // 外键 ON DELETE CASCADE 兜底物理删除；级联快照随 undo entry 记录（before_json 扩展字段）
    pushUndo({ op: 'delete', entity: 'class', entity_id: before.id, before, after: null, cascade: rows });
    db.prepare('DELETE FROM classes WHERE id = ?').run(before.id);
    return rows;
  });
  ok(res, { deleted: before.id, cascade });
});

// ---------- 4. 学生 ----------
const STUDENT_BASE = [
  'name', 'student_no', 'gender', 'birth_date', 'school_id', 'is_boarding', 'pressure_level',
  'puberty_status', 'goal_note', 'subject_note', 'group_name',
];
const STUDENT_ENCRYPTED = SENSITIVE_FIELDS; // 加密字段

function validateStudentInput(b, res, { subjectOnly = false, partial = false } = {}) {
  const errs = [];
  const out = {};
  const name = cleanStr(b.name, 20);
  if (!partial && !name) errs.push('name 必填');
  out.name = name;
  if (b.student_no !== undefined) out.student_no = cleanStr(b.student_no, 20);
  if (b.gender !== undefined && b.gender !== '' && !GENDERS.includes(b.gender)) errs.push('gender 必须是 男/女');
  out.gender = b.gender === undefined ? null : b.gender || null;
  if (b.birth_date !== undefined && b.birth_date !== '' && !isValidDate(b.birth_date)) errs.push('birth_date 格式非法');
  out.birth_date = b.birth_date || null;
  if (b.birth_date && b.birth_date > todayISO()) errs.push('birth_date 不能是未来日期');
  out.school_id = cleanStr(b.school_id, 30);
  out.is_boarding = b.is_boarding ? 1 : 0;
  if (b.pressure_level !== undefined && b.pressure_level !== '' && !PRESSURES.includes(b.pressure_level)) errs.push('pressure_level 必须是 低/中/高');
  out.pressure_level = PRESSURES.includes(b.pressure_level) ? b.pressure_level : '中';
  out.puberty_status = cleanStr(b.puberty_status, 100);
  out.goal_note = cleanStr(b.goal_note, 200);
  out.subject_note = cleanStr(b.subject_note, 500);
  out.group_name = cleanStr(b.group_name, 30);
  if (subjectOnly) {
    // 代课班：仅学科备注有效，敏感字段忽略（warnings）；敏感字段仍以空串补齐（响应契约固定字段）
    for (const f of STUDENT_ENCRYPTED) out[f] = '';
    return { out, errs, warnings: ['代课班仅保留学科备注，敏感字段已忽略'] };
  }
  for (const f of STUDENT_ENCRYPTED) {
    out[f] = cleanStr(b[f], 500);
  }
  return { out, errs, warnings: [] };
}

const findStudent = (id) => getById('students', id);

app.get('/api/portfolio/classes/:cid/students', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const { keyword, gender, boarding, pressure_level, active, page, page_size } = req.query;
  const cond = ['class_id = ?'];
  const params = [cls.id];
  if (keyword) { cond.push('(name LIKE ? OR student_no LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  if (gender === '男' || gender === '女') { cond.push('gender = ?'); params.push(gender); }
  if (boarding === '0' || boarding === '1') { cond.push('is_boarding = ?'); params.push(+boarding); }
  if (PRESSURES.includes(pressure_level)) { cond.push('pressure_level = ?'); params.push(pressure_level); }
  if (active !== '0') cond.push('active = 1');
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(500, Math.max(1, parseInt(page_size, 10) || 100));
  const where = cond.join(' AND ');
  const total = getDB().prepare(`SELECT COUNT(*) AS n FROM students WHERE ${where}`).get(...params).n;
  const rows = getDB().prepare(`SELECT * FROM students WHERE ${where} ORDER BY student_no, name LIMIT ? OFFSET ?`)
    .all(...params, ps, (p - 1) * ps);
  ok(res, { students: rows.map(maskStudentRow), total, page: p, page_size: ps });
});

app.post('/api/portfolio/classes/:cid/students', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const subjectOnly = cls.role === 'subject';
  const { out, errs, warnings } = validateStudentInput(req.body || {}, res, { subjectOnly });
  if (errs.length) return fail(res, 400, errs.join('；'));
  const db = getDB();
  if (out.student_no && db.prepare('SELECT id FROM students WHERE class_id = ? AND student_no = ?').get(cls.id, out.student_no)) {
    return fail(res, 409, `学号「${out.student_no}」在该班已存在`);
  }
  const stu = {
    id: genId('stu'), class_id: cls.id, ...encryptStudentRow(out),
    active: 1, created_at: nowISO(), updated_at: nowISO(),
  };
  withTx(() => {
    pushUndo({ op: 'create', entity: 'student', entity_id: stu.id, before: null, after: decryptStudentRow({ ...stu }) });
    insertRow('students', stu);
  });
  ok(res, { student: decryptStudentRow({ ...stu }), warnings });
});

app.put('/api/portfolio/students/:sid', (req, res) => {
  const before = findStudent(req.params.sid);
  if (!before) return fail(res, 404, '学生不存在');
  const cls = getById('classes', before.class_id);
  const subjectOnly = cls && cls.role === 'subject';
  const { out, errs } = validateStudentInput(req.body || {}, res, { subjectOnly, partial: true });
  if (errs.length) return fail(res, 400, errs.join('；'));
  const db = getDB();
  if (out.student_no && db.prepare('SELECT id FROM students WHERE class_id = ? AND student_no = ? AND id != ?').get(before.class_id, out.student_no, before.id)) {
    return fail(res, 409, `学号「${out.student_no}」在该班已存在`);
  }
  // 部分更新语义：仅更新传入字段
  const patch = {};
  for (const f of STUDENT_BASE) {
    if (req.body[f] !== undefined) patch[f] = out[f];
  }
  for (const f of STUDENT_ENCRYPTED) {
    if (req.body[f] !== undefined) patch[f] = out[f] === '' ? '' : encryptStudentRow({ [f]: out[f] })[f];
  }
  if (req.body.active !== undefined) patch.active = req.body.active ? 1 : 0;
  if (Object.keys(patch).length === 0) return ok(res, { student: decryptStudentRow({ ...before }) });
  patch.updated_at = nowISO();
  const after = withTx(() => {
    pushUndo({ op: 'update', entity: 'student', entity_id: before.id, before: decryptStudentRow({ ...before }), after: { ...decryptStudentRow({ ...before }), ...patch } });
    return updateRow('students', before.id, patch);
  });
  ok(res, { student: decryptStudentRow({ ...after }) });
});

app.get('/api/portfolio/students/:sid', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const cls = getById('classes', stu.class_id);
  ok(res, {
    student: decryptStudentRow({ ...stu }),
    class: cls ? { id: cls.id, name: cls.name, stage: cls.stage, role: cls.role } : null,
  });
});

// 彻底删除学生档案（仅限已停用）：关联数据由外键 ON DELETE CASCADE 级联清理，不可恢复
app.delete('/api/portfolio/students/:sid', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  if (stu.active) return fail(res, 400, '请先「停用」该学生后再彻底删除（档案删除不可恢复）');
  const db = getDB();
  const sid = stu.id;
  const tables = ['exam_scores', 'assignment_records', 'moral_records', 'talents', 'honors', 'materials', 'comments', 'student_layers', 'communications'];
  const cascade = {};
  for (const t of tables) cascade[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE student_id = ?`).get(sid).n;
  // 清理撤销栈中与该生相关的记录（student 本体 + 各子记录快照），避免撤销时重建已删除档案
  const undoCleared = withTx(() => {
    const r = db.prepare(`DELETE FROM undo_log WHERE entity_id = ? OR before_json LIKE ? OR after_json LIKE ?`).run(sid, `%${sid}%`, `%${sid}%`);
    db.prepare('DELETE FROM students WHERE id = ?').run(sid);
    return r.changes;
  });
  ok(res, { deleted: sid, cascade, undo_cleared: undoCleared, note: '关联数据已级联删除，不可恢复' });
});

app.post('/api/portfolio/classes/:cid/students/import', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return fail(res, 400, 'rows 数组必填');
  const subjectOnly = cls.role === 'subject';
  const db = getDB();
  const errors = [];
  const imported = [];
  withTx(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const rowNo = i + 2;
      const { out, errs } = validateStudentInput(r, res, { subjectOnly });
      if (errs.length) { errors.push({ row: rowNo, reason: errs.join('；') }); continue; }
      if (out.student_no && db.prepare('SELECT id FROM students WHERE class_id = ? AND student_no = ?').get(cls.id, out.student_no)) {
        errors.push({ row: rowNo, reason: `学号「${out.student_no}」重复` });
        continue;
      }
      const stu = {
        id: genId('stu'), class_id: cls.id, ...encryptStudentRow(out),
        active: 1, created_at: nowISO(), updated_at: nowISO(),
      };
      insertRow('students', stu);
      imported.push(decryptStudentRow({ ...stu }));
    }
    if (imported.length > 0) {
      pushUndo({ op: 'create', entity: 'student_import', entity_id: cls.id, before: [], after: imported.map((s) => ({ ...s })) });
    }
  });
  ok(res, { imported: imported.length, failed: errors.length, errors });
});

app.get('/api/portfolio/classes/:cid/students/export', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const masked = req.query.masked !== '0';
  if (!masked && req.headers['x-confirm-plain'] !== '1') {
    return fail(res, 400, '明文导出需携带 X-Confirm-Plain: 1 请求头');
  }
  const rows = getDB().prepare('SELECT * FROM students WHERE class_id = ? AND active = 1 ORDER BY student_no').all(cls.id);
  const header = ['姓名', '学号', '性别', '出生年月', '学籍号', '身份证号', '家庭住址', '家长1姓名', '家长1电话', '家长2姓名', '家长2电话', '监护人备注', '家庭特殊情况', '过敏史', '管理注意事项', '住校', '压力等级', '青春期状态', '升学目标', '学科备注'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) => {
    const dec = masked ? maskStudentRow(r) : decryptStudentRow({ ...r });
    return [
      dec.name, dec.student_no, dec.gender || '', dec.birth_date || '', dec.school_id,
      dec.id_card, dec.address, dec.parent1_name, dec.parent1_phone, dec.parent2_name, dec.parent2_phone,
      dec.guardian_note === '🔒' ? '🔒' : dec.guardian_note,
      dec.special_note === '🔒' ? '🔒' : dec.special_note,
      dec.allergy_note === '🔒' ? '🔒' : dec.allergy_note,
      dec.manage_note === '🔒' ? '🔒' : dec.manage_note,
      dec.is_boarding ? '住校' : '走读', dec.pressure_level, dec.puberty_status, dec.goal_note, dec.subject_note,
    ].map(esc).join(',');
  });
  const csv = '\uFEFF' + [header.map(esc).join(','), ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${cls.name}-学生名单.csv`)}`);
  res.send(csv);
});

// 单生档案导出（Markdown；后续轮次扩展成绩/作业/德育章节，先输出基础信息）
app.get('/api/portfolio/students/export/archive/:sid', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const cls = getById('classes', stu.class_id);
  const dec = decryptStudentRow({ ...stu });
  const masked = req.query.masked !== '0';
  const m = (v) => (masked ? (v === '🔒' ? v : maskStudentRow({ ...stu, ...dec })[v] ?? v) : v);
  const lines = [
    `# ${dec.name} · 个人成长档案`,
    '',
    `- 班级：${cls ? cls.name : ''}（${cls ? (cls.stage === 'primary' ? '小学' : '初中') : ''}）`,
    `- 学号：${dec.student_no}`,
    `- 性别：${dec.gender || ''}`,
    `- 出生年月：${dec.birth_date || ''}`,
    `- 学籍号：${dec.school_id}`,
    `- 身份证号：${masked ? maskIdCard(dec.id_card) : dec.id_card}`,
    `- 家庭住址：${masked ? maskAddress(dec.address) : dec.address}`,
    `- 家长1：${masked ? maskName(dec.parent1_name) : dec.parent1_name}（${masked ? maskPhone(dec.parent1_phone) : dec.parent1_phone}）`,
    `- 家长2：${masked ? maskName(dec.parent2_name) : dec.parent2_name}（${masked ? maskPhone(dec.parent2_phone) : dec.parent2_phone}）`,
    `- 监护人备注：${masked ? (dec.guardian_note ? '🔒' : '') : dec.guardian_note}`,
    `- 家庭特殊情况：${masked ? (dec.special_note ? '🔒' : '') : dec.special_note}`,
    `- 过敏史：${masked ? (dec.allergy_note ? '🔒' : '') : dec.allergy_note}`,
    `- 管理注意事项：${masked ? (dec.manage_note ? '🔒' : '') : dec.manage_note}`,
    `- 住校：${dec.is_boarding ? '是' : '否'} ｜ 压力等级：${dec.pressure_level}`,
    `- 青春期状态：${dec.puberty_status || ''} ｜ 升学目标：${dec.goal_note || ''}`,
    `- 道法学科备注：${dec.subject_note || ''}`,
    '',
  ];
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${dec.name}-成长档案.md`)}`);
  res.send(lines.join('\n'));
});

// ---------- 5. 成绩（03 文档 §5：考试 / 成绩批量 / 个人与班级分析 / 道法对比） ----------
const EXAM_TYPES = ['placement', 'weekly', 'monthly', 'midterm', 'final', 'mock', 'subject', 'other'];
const QUESTION_TYPES = ['选择', '简答', '材料分析', '论述'];

function parseQS(v) {
  if (!v) return {};
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return {}; }
}

app.post('/api/portfolio/classes/:cid/exams', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const b = req.body || {};
  const name = cleanStr(b.name, 50);
  if (!name) return fail(res, 400, 'name 必填');
  if (!EXAM_TYPES.includes(b.type)) return fail(res, 400, 'type 非法');
  if (!isValidDate(b.date)) return fail(res, 400, 'date 格式非法');
  const db = getDB();
  if (db.prepare('SELECT id FROM exams WHERE class_id = ? AND name = ? AND date = ?').get(cls.id, name, b.date)) {
    return fail(res, 409, `该班 ${b.date} 已有同名考试「${name}」`);
  }
  const exam = { id: genId('exm'), class_id: cls.id, name, type: b.type, date: b.date, note: cleanStr(b.note, 200), created_at: nowISO() };
  withTx(() => {
    pushUndo({ op: 'create', entity: 'exam', entity_id: exam.id, before: null, after: { ...exam } });
    insertRow('exams', exam);
  });
  ok(res, { exam });
});

app.get('/api/portfolio/classes/:cid/exams', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const type = EXAM_TYPES.includes(req.query.type) ? req.query.type : null;
  const rows = type
    ? getDB().prepare('SELECT * FROM exams WHERE class_id = ? AND type = ? ORDER BY date DESC, created_at DESC').all(cls.id, type)
    : getDB().prepare('SELECT * FROM exams WHERE class_id = ? ORDER BY date DESC, created_at DESC').all(cls.id);
  ok(res, { exams: rows, total: rows.length });
});

app.put('/api/portfolio/exams/:eid', (req, res) => {
  const before = getById('exams', req.params.eid);
  if (!before) return fail(res, 404, '考试不存在');
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) { const n = cleanStr(b.name, 50); if (!n) return fail(res, 400, 'name 不能为空'); patch.name = n; }
  if (b.type !== undefined) { if (!EXAM_TYPES.includes(b.type)) return fail(res, 400, 'type 非法'); patch.type = b.type; }
  if (b.date !== undefined) { if (!isValidDate(b.date)) return fail(res, 400, 'date 非法'); patch.date = b.date; }
  if (b.note !== undefined) patch.note = cleanStr(b.note, 200);
  if (Object.keys(patch).length === 0) return ok(res, { exam: before });
  const after = withTx(() => {
    pushUndo({ op: 'update', entity: 'exam', entity_id: before.id, before: { ...before }, after: { ...before, ...patch } });
    return updateRow('exams', before.id, patch);
  });
  ok(res, { exam: after });
});

app.delete('/api/portfolio/exams/:eid', (req, res) => {
  const before = getById('exams', req.params.eid);
  if (!before) return fail(res, 404, '考试不存在');
  const db = getDB();
  const scores = withTx(() => {
    const rows = db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(before.id);
    pushUndo({ op: 'delete', entity: 'exam', entity_id: before.id, before: { ...before }, after: null, cascade: rows });
    db.prepare('DELETE FROM exams WHERE id = ?').run(before.id); // 级联删成绩
    return rows;
  });
  ok(res, { deleted: before.id, scores_deleted: scores.length });
});

app.post('/api/portfolio/exams/:eid/scores/batch', (req, res) => {
  const exam = getById('exams', req.params.eid);
  if (!exam) return fail(res, 404, '考试不存在');
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return fail(res, 400, 'rows 数组必填');
  const db = getDB();
  const classStudents = new Set(db.prepare('SELECT id FROM students WHERE class_id = ?').all(exam.class_id).map((r) => r.id));
  // 阶段一：全量校验（整批原子：任何一行非法 → 整批不写）
  const errors = [];
  const clean = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const rowNo = i + 2;
    const subject = cleanStr(r.subject, 10);
    const studentId = r.student_id;
    if (!studentId || !classStudents.has(studentId)) { errors.push({ row: rowNo, reason: 'student_id 不属于该考试班级' }); continue; }
    if (!subject) { errors.push({ row: rowNo, reason: 'subject 必填' }); continue; }
    const score = Number(r.score);
    if (!Number.isFinite(score)) { errors.push({ row: rowNo, reason: 'score 非法' }); continue; }
    if (subject !== '总分' && (score < 0 || score > 100)) { errors.push({ row: rowNo, reason: `科目分数须 0-100（${subject}）` }); continue; }
    if (subject === '总分' && score < 0) { errors.push({ row: rowNo, reason: '总分不能为负' }); continue; }
    const rankOk = (v) => v === undefined || v === null || (Number.isInteger(v) && v >= 1);
    if (!rankOk(r.class_rank)) { errors.push({ row: rowNo, reason: 'class_rank 须为正整数' }); continue; }
    if (!rankOk(r.grade_rank)) { errors.push({ row: rowNo, reason: 'grade_rank 须为正整数' }); continue; }
    let qs = null;
    if (r.question_scores) {
      if (typeof r.question_scores !== 'object' || Array.isArray(r.question_scores)) { errors.push({ row: rowNo, reason: 'question_scores 须为对象' }); continue; }
      let qBad = false;
      for (const [k, v] of Object.entries(r.question_scores)) {
        if (!QUESTION_TYPES.includes(k)) { errors.push({ row: rowNo, reason: `题型非法: ${k}` }); qBad = true; break; }
        if (!Number.isFinite(Number(v)) || Number(v) < 0) { errors.push({ row: rowNo, reason: `题型得分非法: ${k}` }); qBad = true; break; }
      }
      if (qBad) continue;
      qs = JSON.stringify(r.question_scores);
    }
    clean.push({ studentId, subject, score, class_rank: r.class_rank ?? null, grade_rank: r.grade_rank ?? null, qs });
  }
  if (errors.length > 0) return ok(res, { upserted: 0, failed: errors.length, errors }); // 整批原子拒绝
  // 阶段二：全部合法 → 批量 upsert
  let upserted = 0;
  const beforeRows = db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(exam.id);
  const before = beforeRows.map((r) => ({ ...r }));
  withTx(() => {
    for (const c of clean) {
      const exist = db.prepare('SELECT id FROM exam_scores WHERE exam_id = ? AND student_id = ? AND subject = ?').get(exam.id, c.studentId, c.subject);
      if (exist) {
        db.prepare('UPDATE exam_scores SET score = ?, class_rank = ?, grade_rank = ?, question_scores = ?, updated_at = ? WHERE id = ?')
          .run(c.score, c.class_rank, c.grade_rank, c.qs, nowISO(), exist.id);
      } else {
        db.prepare('INSERT INTO exam_scores(id, exam_id, student_id, subject, score, class_rank, grade_rank, question_scores, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(genId('scr'), exam.id, c.studentId, c.subject, c.score, c.class_rank, c.grade_rank, c.qs, nowISO(), nowISO());
      }
      upserted++;
    }
    if (upserted > 0) {
      const afterRows = db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(exam.id);
      pushUndo({ op: 'update', entity: 'exam_scores_batch', entity_id: exam.id, before, after: afterRows.map((r) => ({ ...r })) });
    }
  });
  ok(res, { upserted, failed: 0, errors: [] });
});

app.get('/api/portfolio/exams/:eid/scores', (req, res) => {
  const exam = getById('exams', req.params.eid);
  if (!exam) return fail(res, 404, '考试不存在');
  const rows = getDB().prepare('SELECT * FROM exam_scores WHERE exam_id = ? ORDER BY student_id, subject').all(exam.id);
  const names = new Map(getDB().prepare('SELECT id, name FROM students').all().map((r) => [r.id, r.name]));
  ok(res, {
    exam,
    scores: rows.map((r) => ({ ...r, question_scores: parseQS(r.question_scores), student_name: names.get(r.student_id) || '' })),
  });
});

app.get('/api/portfolio/students/:sid/scores', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const rows = getDB().prepare(
    `SELECT s.*, e.name AS exam_name, e.type AS exam_type, e.date AS exam_date
     FROM exam_scores s JOIN exams e ON e.id = s.exam_id
     WHERE s.student_id = ? ORDER BY e.date, e.created_at`
  ).all(stu.id);
  const exams = new Map();
  for (const r of rows) {
    if (!exams.has(r.exam_id)) exams.set(r.exam_id, { exam_id: r.exam_id, exam_name: r.exam_name, exam_type: r.exam_type, exam_date: r.exam_date, rows: [] });
    exams.get(r.exam_id).rows.push(r);
  }
  const out = [];
  for (const e of exams.values()) {
    const totalRow = e.rows.find((r) => r.subject === '总分');
    for (const r of e.rows) {
      out.push({
        exam_id: r.exam_id, exam_name: r.exam_name, exam_type: r.exam_type, exam_date: r.exam_date,
        subject: r.subject, score: r.score, class_rank: r.class_rank, grade_rank: r.grade_rank,
        total: totalRow ? totalRow.score : null, total_rank: totalRow ? totalRow.class_rank : null,
        question_scores: parseQS(r.question_scores),
      });
    }
  }
  ok(res, { scores: out });
});

app.get('/api/portfolio/students/:sid/analysis', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const db = getDB();
  const rows = db.prepare(
    `SELECT s.*, e.name AS exam_name, e.date AS exam_date
     FROM exam_scores s JOIN exams e ON e.id = s.exam_id
     WHERE s.student_id = ? ORDER BY e.date, e.created_at`
  ).all(stu.id);
  // 班级均分（该生所在班全部成绩，按科目）
  const classScores = db.prepare(
    `SELECT s.subject, s.score FROM exam_scores s JOIN exams e ON e.id = s.exam_id WHERE e.class_id = ?`
  ).all(stu.class_id);
  const classAvgs = {};
  for (const r of classScores) {
    if (r.subject === '总分') continue;
    classAvgs[r.subject] = classAvgs[r.subject] || { sum: 0, n: 0 };
    classAvgs[r.subject].sum += r.score;
    classAvgs[r.subject].n++;
  }
  const avgMap = {};
  for (const [k, v] of Object.entries(classAvgs)) avgMap[k] = v.n ? v.sum / v.n : null;
  const input = rows.map((r) => ({ exam_id: r.exam_id, exam_name: r.exam_name, exam_date: r.exam_date, subject: r.subject, score: r.score, class_rank: r.class_rank, grade_rank: r.grade_rank, question_scores: parseQS(r.question_scores) }));
  ok(res, { analysis: analyzeStudentScores(input, avgMap) });
});

app.get('/api/portfolio/classes/:cid/analysis', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const db = getDB();
  const exam = req.query.exam_id ? getById('exams', req.query.exam_id) : null;
  if (req.query.exam_id && !exam) return fail(res, 404, '考试不存在');
  const examRow = exam || db.prepare('SELECT * FROM exams WHERE class_id = ? ORDER BY date DESC, created_at DESC LIMIT 1').get(cls.id);
  if (!examRow) return ok(res, { analysis: null, exam: null, prev_exam: null, reason: '该班暂无考试数据' });
  const loadScores = (eid) => db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(eid).map((r) => ({ ...r, question_scores: parseQS(r.question_scores) }));
  const scores = loadScores(examRow.id);
  // 对比基准：compare_exam_id 显式指定时用任意考试（不限类型）；缺省回退为上一次同类型考试（date 更早）
  let prevRow = null;
  if (req.query.compare_exam_id) {
    prevRow = getById('exams', req.query.compare_exam_id);
    if (!prevRow) return fail(res, 404, '对比考试不存在');
    if (prevRow.class_id !== cls.id) return fail(res, 400, '对比考试不属于该班级');
    if (prevRow.id === examRow.id) return fail(res, 400, '对比考试不能与当前考试相同');
  } else {
    prevRow = db.prepare('SELECT * FROM exams WHERE class_id = ? AND type = ? AND date < ? ORDER BY date DESC LIMIT 1').get(cls.id, examRow.type, examRow.date);
  }
  const prevScores = prevRow ? loadScores(prevRow.id) : [];
  const ranking = scores
    .filter((s) => s.subject === '总分' && s.score != null)
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ student_id: s.student_id, total: s.score, total_rank: s.class_rank }));
  ok(res, {
    analysis: analyzeClass(scores, prevScores),
    exam: examRow, prev_exam: prevRow || null,
    ranking,
  });
});

app.get('/api/portfolio/df/compare', (req, res) => {
  const db = getDB();
  const stage = req.query.stage;
  const examType = EXAM_TYPES.includes(req.query.exam_type) ? req.query.exam_type : null;
  const classes = db.prepare('SELECT * FROM classes ORDER BY stage, sort_order, name').all()
    .filter((c) => !stage || stage === 'all' || c.stage === stage);
  const rows = [];
  for (const cls of classes) {
    const exam = examType
      ? db.prepare('SELECT * FROM exams WHERE class_id = ? AND type = ? ORDER BY date DESC, created_at DESC LIMIT 1').get(cls.id, examType)
      : db.prepare('SELECT * FROM exams WHERE class_id = ? ORDER BY date DESC, created_at DESC LIMIT 1').get(cls.id);
    if (!exam) continue;
    const scores = db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(exam.id);
    const prev = db.prepare('SELECT * FROM exams WHERE class_id = ? AND type = ? AND date < ? ORDER BY date DESC LIMIT 1').get(cls.id, exam.type, exam.date);
    const prevScores = prev ? db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(prev.id) : [];
    const prevDf = prevScores.filter((s) => s.subject === '道德与法治' && s.score != null);
    const prevAvg = prevDf.length ? prevDf.reduce((a, b) => a + b.score, 0) / prevDf.length : null;
    rows.push({
      class_id: cls.id, class_name: cls.name, role: cls.role, stage: cls.stage,
      exam_id: exam.id, exam_name: exam.name, exam_date: exam.date,
      scores, prev_avg: prevAvg,
    });
  }
  ok(res, { compare: compareDfClasses(rows), rule_note: '各班最近一次同类型考试对齐对比' });
});

// ---------- 6. 作业台账（03 文档 §6） ----------
const HW_STATUS = ['excellent', 'normal', 'late', 'missing', 'slack', 'copy'];

app.post('/api/portfolio/classes/:cid/assignments', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const b = req.body || {};
  const subject = cleanStr(b.subject, 10);
  if (!subject) return fail(res, 400, 'subject 必填');
  if (!isValidDate(b.date)) return fail(res, 400, 'date 格式非法');
  const title = cleanStr(b.title, 200);
  if (!title) return fail(res, 400, 'title 必填');
  const aw = { id: genId('aw'), class_id: cls.id, subject, date: b.date, title, requirement: cleanStr(b.requirement, 300), deadline: cleanStr(b.deadline, 50), status: 'pending', created_at: nowISO() };
  withTx(() => { pushUndo({ op: 'create', entity: 'assignment', entity_id: aw.id, before: null, after: { ...aw } }); insertRow('assignments', aw); });
  ok(res, { assignment: aw });
});

app.get('/api/portfolio/classes/:cid/assignments', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const cond = ['class_id = ?'];
  const params = [cls.id];
  if (req.query.subject) { cond.push('subject = ?'); params.push(req.query.subject); }
  if (req.query.status === 'pending' || req.query.status === 'closed') { cond.push('status = ?'); params.push(req.query.status); }
  if (isValidDate(req.query.date_from)) { cond.push('date >= ?'); params.push(req.query.date_from); }
  if (isValidDate(req.query.date_to)) { cond.push('date <= ?'); params.push(req.query.date_to); }
  const rows = getDB().prepare(`SELECT * FROM assignments WHERE ${cond.join(' AND ')} ORDER BY date DESC, created_at DESC`).all(...params);
  ok(res, { assignments: rows, total: rows.length });
});

app.put('/api/portfolio/assignments/:aid', (req, res) => {
  const before = getById('assignments', req.params.aid);
  if (!before) return fail(res, 404, '作业不存在');
  const b = req.body || {};
  const patch = {};
  if (b.subject !== undefined) { const v = cleanStr(b.subject, 10); if (!v) return fail(res, 400, 'subject 不能为空'); patch.subject = v; }
  if (b.title !== undefined) { const v = cleanStr(b.title, 200); if (!v) return fail(res, 400, 'title 不能为空'); patch.title = v; }
  if (b.date !== undefined) { if (!isValidDate(b.date)) return fail(res, 400, 'date 非法'); patch.date = b.date; }
  if (b.requirement !== undefined) patch.requirement = cleanStr(b.requirement, 300);
  if (b.deadline !== undefined) patch.deadline = cleanStr(b.deadline, 50);
  if (b.status !== undefined) { if (!['pending', 'closed'].includes(b.status)) return fail(res, 400, 'status 非法'); patch.status = b.status; }
  if (Object.keys(patch).length === 0) return ok(res, { assignment: before });
  const after = withTx(() => { pushUndo({ op: 'update', entity: 'assignment', entity_id: before.id, before: { ...before }, after: { ...before, ...patch } }); return updateRow('assignments', before.id, patch); });
  ok(res, { assignment: after });
});

app.delete('/api/portfolio/assignments/:aid', (req, res) => {
  const before = getById('assignments', req.params.aid);
  if (!before) return fail(res, 404, '作业不存在');
  const db = getDB();
  const records = withTx(() => {
    const rows = db.prepare('SELECT * FROM assignment_records WHERE assignment_id = ?').all(before.id);
    pushUndo({ op: 'delete', entity: 'assignment', entity_id: before.id, before: { ...before }, after: null, cascade: rows });
    db.prepare('DELETE FROM assignments WHERE id = ?').run(before.id);
    return rows;
  });
  ok(res, { deleted: before.id, records_deleted: records.length });
});

app.post('/api/portfolio/assignments/:aid/records/batch', (req, res) => {
  const aw = getById('assignments', req.params.aid);
  if (!aw) return fail(res, 404, '作业不存在');
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return fail(res, 400, 'rows 数组必填');
  const db = getDB();
  const classStudents = new Set(db.prepare('SELECT id FROM students WHERE class_id = ?').all(aw.class_id).map((r) => r.id));
  const errors = [];
  const clean = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const rowNo = i + 2;
    if (!r.student_id || !classStudents.has(r.student_id)) { errors.push({ row: rowNo, reason: 'student_id 不属于该班' }); continue; }
    if (!HW_STATUS.includes(r.status)) { errors.push({ row: rowNo, reason: `status 非法: ${r.status}` }); continue; }
    clean.push({ student_id: r.student_id, status: r.status, issue_note: cleanStr(r.issue_note, 300), rectify_note: cleanStr(r.rectify_note, 300) });
  }
  if (errors.length > 0) return ok(res, { upserted: 0, failed: errors.length, errors }); // 整批原子
  let upserted = 0;
  const beforeRows = db.prepare('SELECT * FROM assignment_records WHERE assignment_id = ?').all(aw.id);
  withTx(() => {
    for (const c of clean) {
      const exist = db.prepare('SELECT id FROM assignment_records WHERE assignment_id = ? AND student_id = ?').get(aw.id, c.student_id);
      if (exist) {
        db.prepare('UPDATE assignment_records SET status = ?, issue_note = ?, rectify_note = ?, recorded_at = ? WHERE id = ?').run(c.status, c.issue_note, c.rectify_note, nowISO(), exist.id);
      } else {
        db.prepare('INSERT INTO assignment_records(id, assignment_id, student_id, status, issue_note, rectify_note, recorded_at) VALUES (?,?,?,?,?,?,?)')
          .run(genId('arec'), aw.id, c.student_id, c.status, c.issue_note, c.rectify_note, nowISO());
      }
      upserted++;
    }
    if (upserted > 0) {
      const afterRows = db.prepare('SELECT * FROM assignment_records WHERE assignment_id = ?').all(aw.id);
      pushUndo({ op: 'update', entity: 'assignment_records_batch', entity_id: aw.id, before: beforeRows.map((r) => ({ ...r })), after: afterRows.map((r) => ({ ...r })) });
    }
  });
  ok(res, { upserted, failed: 0, errors: [] });
});

/** 作业统计（周/月/学期聚合；03 文档 §6.5 口径） */
function assignmentStats(classId, period, dateFrom, dateTo) {
  const db = getDB();
  const today = todayISO();
  let from = dateFrom, to = dateTo;
  if (!from || !to) {
    if (period === 'week') { from = isoWeekStart(today); to = today; }
    else if (period === 'month') { from = today.slice(0, 8) + '01'; to = today; }
    else {
      // 学期范围 = 学期起止（semesterRange 口径，与 semesterOf 一致）
      const r = semesterRange(today);
      from = r.from; to = r.to;
    }
  }
  const rows = db.prepare(
    `SELECT ar.*, a.subject, a.date FROM assignment_records ar JOIN assignments a ON a.id = ar.assignment_id
     WHERE a.class_id = ? AND a.date >= ? AND a.date <= ?`
  ).all(classId, from, to);
  const total = rows.length;
  const count = (st) => rows.filter((r) => r.status === st).length;
  const good = count('excellent') + count('normal') + count('late');
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, { total: 0, missing: 0, slack: 0, excellent: 0, weeks: new Map() });
    const s = byStudent.get(r.student_id);
    s.total++;
    if (r.status === 'missing') s.missing++;
    if (r.status === 'slack') s.slack++;
    if (r.status === 'excellent') s.excellent++;
    const wk = isoWeek(r.date);
    s.weeks.set(wk, (s.weeks.get(wk) || 0) + 1);
  }
  const studentStats = [...byStudent.entries()].map(([sid, s]) => ({
    student_id: sid,
    completion_rate: s.total ? Math.round(((s.total - s.missing - s.slack - count('copy') * 0) / s.total) * 1000) / 1000 : 0,
    missing: s.missing, slack: s.slack, excellent: s.excellent,
    trend: [...s.weeks.entries()].map(([week, n]) => ({ week, rate: 1 })),
  }));
  const problemStudents = studentStats.filter((s) => s.missing + s.slack >= 3);
  // 高频问题标签
  const issueCount = {};
  for (const r of rows) if (r.issue_note) issueCount[r.issue_note] = (issueCount[r.issue_note] || 0) + 1;
  const topIssues = Object.entries(issueCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([issue, n]) => ({ issue, count: n }));
  return {
    period, range: { from, to },
    class_summary: {
      total_records: total, completion_rate: total ? Math.round((good / total) * 1000) / 1000 : 0,
      excellent_count: count('excellent'), missing_count: count('missing'), slack_count: count('slack'), copy_count: count('copy'),
      top_issues: topIssues,
    },
    student_stats: studentStats,
    problem_students: problemStudents,
  };
}

const isoWeekStart = (dateStr) => {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  const wd = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - (wd - 1));
  return dt.toISOString().slice(0, 10);
};

app.get('/api/portfolio/classes/:cid/assignment-stats', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const period = ['week', 'month', 'semester'].includes(req.query.period) ? req.query.period : 'semester';
  ok(res, { stats: assignmentStats(cls.id, period, req.query.date_from, req.query.date_to) });
});

app.get('/api/portfolio/students/:sid/assignment-stats', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const db = getDB();
  const rows = db.prepare(
    `SELECT ar.*, a.date FROM assignment_records ar JOIN assignments a ON a.id = ar.assignment_id
     WHERE ar.student_id = ? ORDER BY a.date`
  ).all(stu.id);
  const total = rows.length;
  const count = (st) => rows.filter((r) => r.status === st).length;
  const good = count('excellent') + count('normal') + count('late');
  // 学情联动：最近两次考试总分 delta
  const examRows = db.prepare(
    `SELECT s.score, e.date FROM exam_scores s JOIN exams e ON e.id = s.exam_id
     WHERE s.student_id = ? AND s.subject = '总分' ORDER BY e.date DESC LIMIT 2`
  ).all(stu.id);
  const academicLink = examRows.length >= 2
    ? { total_delta: Math.round((examRows[0].score - examRows[1].score) * 100) / 100, completion_rate: total ? Math.round((good / total) * 1000) / 1000 : 0 }
    : null;
  ok(res, {
    stats: {
      student_id: stu.id,
      student_stats: [{
        student_id: stu.id, completion_rate: total ? Math.round((good / total) * 1000) / 1000 : 0,
        missing: count('missing'), slack: count('slack'), excellent: count('excellent'),
      }],
      problem_students: count('missing') + count('slack') >= 3 ? [{ student_id: stu.id, missing: count('missing'), slack: count('slack') }] : [],
      academic_link: academicLink,
    },
  });
});

// ---------- 作业台账（台账模式：日期+科目+填报人 + 表扬/未交/问题三份名单，永久留存无删除） ----------
const parseNameList = (rawList, roster) => {
  const items = (Array.isArray(rawList) ? rawList : String(rawList || '').split(/[,，]/))
    .map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  const warnings = [];
  const byNo = new Map(roster.map((s) => [s.student_no, s]));
  const byName = new Map(roster.map((s) => [s.name, s]));
  for (const it of items) {
    const hit = byNo.get(it) || byName.get(it);
    if (hit) { out.push({ id: hit.id, name: hit.name }); continue; }
    out.push({ id: '', name: it });
    warnings.push(`「${it}」不在本班花名册中（将按姓名归档）`);
  }
  return { out, warnings };
};
const ledgerJson = (list) => JSON.stringify(list || []);
const ledgerDecode = (r) => ({ ...r, subjects: JSON.parse(r.subjects || '[]'), praise: JSON.parse(r.praise_names || '[]'), missing: JSON.parse(r.missing_names || '[]'), problem: JSON.parse(r.problem_names || '[]') });

app.post('/api/portfolio/classes/:cid/hw-ledger', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const records = req.body?.records;
  if (!Array.isArray(records) || records.length === 0) return fail(res, 400, 'records 数组必填');
  const db = getDB();
  const roster = db.prepare('SELECT id, name, student_no FROM students WHERE class_id = ?').all(cls.id);
  const warnings = [];
  const created = [];
  withTx(() => {
    for (let i = 0; i < records.length; i++) {
      const r = records[i] || {};
      if (!isValidDate(r.record_date)) { warnings.push(`第 ${i + 1} 行：record_date 非法`); continue; }
      const subjects = (Array.isArray(r.subjects) ? r.subjects : String(r.subjects || '').split(/[,，]/)).map((x) => String(x).trim()).filter(Boolean);
      if (!subjects.length) { warnings.push(`第 ${i + 1} 行：涉及科目为空`); continue; }
      const reporter = cleanStr(r.reporter, 30);
      const praise = parseNameList(r.praise, roster);
      const missing = parseNameList(r.missing, roster);
      const problem = parseNameList(r.problem, roster);
      if (praise.warnings.length) warnings.push(...praise.warnings.map((w) => `第 ${i + 1} 行表扬：${w}`));
      if (missing.warnings.length) warnings.push(...missing.warnings.map((w) => `第 ${i + 1} 行未交：${w}`));
      if (problem.warnings.length) warnings.push(...problem.warnings.map((w) => `第 ${i + 1} 行问题：${w}`));
      const rec = {
        id: genId('hl'), class_id: cls.id, record_date: r.record_date,
        subjects: JSON.stringify(subjects), reporter,
        praise_names: ledgerJson(praise.out), missing_names: ledgerJson(missing.out), problem_names: ledgerJson(problem.out),
        note: cleanStr(r.note, 500),
        created_at: nowISO(), updated_at: nowISO(),
      };
      insertRow('hw_ledger', rec);
      created.push(ledgerDecode({ ...rec }));
    }
  });
  ok(res, { created: created.length, warnings, records: created });
});

app.get('/api/portfolio/classes/:cid/hw-ledger', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const db = getDB();
  const cond = ['class_id = ?'];
  const params = [cls.id];
  if (isValidDate(req.query.date_from)) { cond.push('record_date >= ?'); params.push(req.query.date_from); }
  if (isValidDate(req.query.date_to)) { cond.push('record_date <= ?'); params.push(req.query.date_to); }
  if (req.query.reporter) { cond.push('reporter = ?'); params.push(req.query.reporter); }
  let rows = db.prepare(`SELECT * FROM hw_ledger WHERE ${cond.join(' AND ')} ORDER BY record_date DESC, created_at DESC`).all(...params).map(ledgerDecode);
  // 科目多选（任一项命中）
  if (req.query.subjects) {
    const subs = String(req.query.subjects).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (subs.length) rows = rows.filter((r) => r.subjects.some((s) => subs.includes(s)));
  }
  // 小组多选（名单中任一学生属于所选小组）
  if (req.query.groups) {
    const groups = String(req.query.groups).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (groups.length) {
      const gids = new Set(db.prepare(`SELECT id FROM students WHERE class_id = ? AND group_name IN (${groups.map(() => '?').join(',')})`).all(cls.id, ...groups).map((s) => s.id));
      rows = rows.filter((r) => [...r.praise, ...r.missing, ...r.problem].some((x) => x.id && gids.has(x.id)));
    }
  }
  // 学生过滤（姓名/学号出现在任一名单）
  if (req.query.student) {
    const kw = String(req.query.student).trim();
    rows = rows.filter((r) => [...r.praise, ...r.missing, ...r.problem].some((x) => x.name.includes(kw) || x.id.includes(kw)));
  }
  // 状态过滤
  if (['praise', 'missing', 'problem'].includes(req.query.status)) {
    const st = req.query.status;
    rows = rows.filter((r) => r[st].length > 0);
  }
  ok(res, { records: rows, total: rows.length });
});

app.put('/api/portfolio/hw-ledger/:id', (req, res) => {
  const before = getById('hw_ledger', req.params.id);
  if (!before) return fail(res, 404, '台账记录不存在');
  const cls = getById('classes', before.class_id);
  const b = req.body || {};
  const patch = {};
  if (b.record_date !== undefined) { if (!isValidDate(b.record_date)) return fail(res, 400, 'record_date 非法'); patch.record_date = b.record_date; }
  if (b.subjects !== undefined) patch.subjects = JSON.stringify((Array.isArray(b.subjects) ? b.subjects : String(b.subjects).split(/[,，]/)).map((x) => String(x).trim()).filter(Boolean));
  if (b.reporter !== undefined) patch.reporter = cleanStr(b.reporter, 30);
  const roster = getDB().prepare('SELECT id, name, student_no FROM students WHERE class_id = ?').all(cls.id);
  for (const [field, src] of [['praise_names', b.praise], ['missing_names', b.missing], ['problem_names', b.problem]]) {
    if (src !== undefined) { const { out } = parseNameList(src, roster); patch[field] = ledgerJson(out); }
  }
  if (b.note !== undefined) patch.note = cleanStr(b.note, 500);
  if (Object.keys(patch).length === 0) return ok(res, { record: before });
  patch.updated_at = nowISO();
  const after = withTx(() => { pushUndo({ op: 'update', entity: 'hw_ledger', entity_id: before.id, before: { ...before }, after: { ...before, ...patch } }); return updateRow('hw_ledger', before.id, patch); });
  ok(res, { record: ledgerDecode({ ...after }) });
});

app.delete('/api/portfolio/hw-ledger/:id', (req, res) => {
  const before = getById('hw_ledger', req.params.id);
  if (!before) return fail(res, 404, '台账记录不存在');
  withTx(() => {
    getDB().prepare('DELETE FROM hw_ledger WHERE id = ?').run(before.id);
  });
  ok(res, { deleted: before.id });
});

// 个人作业事件（台账自动回流：按 student_id 聚合，未匹配 id 回退姓名）
app.get('/api/portfolio/students/:sid/hw-events', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const db = getDB();
  const rows = db.prepare('SELECT * FROM hw_ledger WHERE class_id = ? ORDER BY record_date DESC, created_at DESC').all(stu.class_id);
  const events = [];
  const summary = { praise: 0, missing: 0, problem: 0 };
  const hit = (list) => list.some((x) => (x.id && x.id === stu.id) || (!x.id && x.name === stu.name));
  for (const r of rows) {
    const rec = ledgerDecode(r);
    const push = (kind) => { events.push({ date: r.record_date, subjects: rec.subjects, kind, note: r.note, reporter: r.reporter }); summary[kind]++; };
    if (hit(rec.praise)) push('praise');
    if (hit(rec.missing)) push('missing');
    if (hit(rec.problem)) push('problem');
  }
  ok(res, { events, summary: { praise: summary.praise, missing: summary.missing, problem: summary.problem, total: events.length } });
});

// ---------- 7. 德育心理（03 文档 §7） ----------
const MORAL_CATS = ['emotion', 'family', 'relationship', 'conduct', 'reward', 'punish', 'volunteer', 'other'];

app.post('/api/portfolio/students/:sid/moral-records', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const b = req.body || {};
  if (!isValidDate(b.date)) return fail(res, 400, 'date 格式非法');
  if (!MORAL_CATS.includes(b.category)) return fail(res, 400, 'category 非法');
  const content = cleanStr(b.content, 2000);
  if (!content) return fail(res, 400, 'content 必填');
  const cls = getById('classes', stu.class_id);
  const rec = {
    id: genId('mr'), student_id: stu.id, date: b.date, category: b.category,
    stage: STAGES.includes(b.stage) ? b.stage : (cls ? cls.stage : 'middle'),
    content, follow_up: cleanStr(b.follow_up, 500), result: cleanStr(b.result, 500), created_at: nowISO(),
  };
  withTx(() => { pushUndo({ op: 'create', entity: 'moral_record', entity_id: rec.id, before: null, after: { ...rec } }); insertRow('moral_records', rec); });
  ok(res, { record: rec });
});

app.get('/api/portfolio/students/:sid/moral-records', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const cond = ['student_id = ?'];
  const params = [stu.id];
  if (MORAL_CATS.includes(req.query.category)) { cond.push('category = ?'); params.push(req.query.category); }
  if (isValidDate(req.query.date_from)) { cond.push('date >= ?'); params.push(req.query.date_from); }
  if (isValidDate(req.query.date_to)) { cond.push('date <= ?'); params.push(req.query.date_to); }
  const rows = getDB().prepare(`SELECT * FROM moral_records WHERE ${cond.join(' AND ')} ORDER BY date DESC`).all(...params);
  ok(res, { records: rows, total: rows.length });
});

app.put('/api/portfolio/moral-records/:rid', (req, res) => {
  const before = getById('moral_records', req.params.rid);
  if (!before) return fail(res, 404, '记录不存在');
  const b = req.body || {};
  const patch = {};
  if (b.date !== undefined) { if (!isValidDate(b.date)) return fail(res, 400, 'date 非法'); patch.date = b.date; }
  if (b.category !== undefined) { if (!MORAL_CATS.includes(b.category)) return fail(res, 400, 'category 非法'); patch.category = b.category; }
  if (b.content !== undefined) { const v = cleanStr(b.content, 2000); if (!v) return fail(res, 400, 'content 不能为空'); patch.content = v; }
  if (b.follow_up !== undefined) patch.follow_up = cleanStr(b.follow_up, 500);
  if (b.result !== undefined) patch.result = cleanStr(b.result, 500);
  const after = withTx(() => { pushUndo({ op: 'update', entity: 'moral_record', entity_id: before.id, before: { ...before }, after: { ...before, ...patch } }); return updateRow('moral_records', before.id, patch); });
  ok(res, { record: after });
});

app.delete('/api/portfolio/moral-records/:rid', (req, res) => {
  const before = getById('moral_records', req.params.rid);
  if (!before) return fail(res, 404, '记录不存在');
  withTx(() => { pushUndo({ op: 'delete', entity: 'moral_record', entity_id: before.id, before: { ...before }, after: null }); deleteRow('moral_records', before.id); });
  ok(res, { deleted: before.id });
});

app.get('/api/portfolio/students/:sid/moral-report', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const db = getDB();
  const semester = req.query.semester;
  let rows;
  if (semester) {
    const [y, s] = [semester.slice(0, 4), semester.slice(4)];
    const from = s === '秋' ? `${y}-09-01` : `${y}-02-01`;
    const to = s === '秋' ? `${Number(y) + 1}-01-31` : `${y}-07-31`;
    rows = db.prepare('SELECT * FROM moral_records WHERE student_id = ? AND date >= ? AND date <= ? ORDER BY date').all(stu.id, from, to);
  } else {
    rows = db.prepare('SELECT * FROM moral_records WHERE student_id = ? ORDER BY date').all(stu.id);
  }
  const byCategory = {};
  const highlights = [];
  const concerns = [];
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    if (r.category === 'reward' || r.category === 'volunteer') highlights.push(r.result || r.content.slice(0, 20));
    if ((r.category === 'emotion' || r.category === 'family') && (byCategory[r.category] || 0) >= 2) concerns.push(`${catLabel(r.category)}记录 ${byCategory[r.category]} 次`);
  }
  const total = rows.length;
  ok(res, {
    report: {
      semester: semester || '全部', student_id: stu.id, student_name: stu.name,
      summary: `本学期共 ${total} 条记录${highlights.length ? `，亮点：${highlights.slice(0, 3).join('；')}` : ''}${concerns.length ? `；需关注：${concerns.slice(0, 3).join('；')}` : ''}`,
      by_category: Object.entries(byCategory).map(([k, count]) => ({ category: k, label: catLabel(k), count, latest_result: [...rows].reverse().find((r) => r.category === k)?.result || '' })),
      highlights: highlights.slice(0, 5), concerns: concerns.slice(0, 5),
    },
  });
});

// ---------- 8. 特长荣誉（03 文档 §8） ----------
app.post('/api/portfolio/students/:sid/talents', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const b = req.body || {};
  const category = cleanStr(b.category, 20);
  const name = cleanStr(b.name, 50);
  if (!category || !name) return fail(res, 400, 'category/name 必填');
  const t = { id: genId('tl'), student_id: stu.id, category, name, level: cleanStr(b.level, 20), potential: cleanStr(b.potential, 200), created_at: nowISO() };
  withTx(() => { pushUndo({ op: 'create', entity: 'talent', entity_id: t.id, before: null, after: { ...t } }); insertRow('talents', t); });
  ok(res, { talent: t });
});

app.get('/api/portfolio/students/:sid/talents', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const rows = getDB().prepare('SELECT * FROM talents WHERE student_id = ? ORDER BY created_at').all(stu.id);
  ok(res, { talents: rows, total: rows.length });
});

app.delete('/api/portfolio/talents/:tid', (req, res) => {
  const before = getById('talents', req.params.tid);
  if (!before) return fail(res, 404, '特长不存在');
  withTx(() => { pushUndo({ op: 'delete', entity: 'talent', entity_id: before.id, before: { ...before }, after: null }); deleteRow('talents', before.id); });
  ok(res, { deleted: before.id });
});

const HONOR_LEVELS = ['school', 'district', 'city', 'province', 'national'];

app.post('/api/portfolio/students/:sid/honors', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const b = req.body || {};
  const title = cleanStr(b.title, 100);
  if (!title) return fail(res, 400, 'title 必填');
  if (!HONOR_LEVELS.includes(b.level)) return fail(res, 400, 'level 非法');
  if (!isValidDate(b.date)) return fail(res, 400, 'date 格式非法');
  const h = { id: genId('hn'), student_id: stu.id, class_id: null, title, level: b.level, event: cleanStr(b.event, 100), date: b.date, material_id: b.material_id || null, created_at: nowISO() };
  withTx(() => { pushUndo({ op: 'create', entity: 'honor', entity_id: h.id, before: null, after: { ...h } }); insertRow('honors', h); });
  ok(res, { honor: h });
});

app.post('/api/portfolio/classes/:cid/honors', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const b = req.body || {};
  const title = cleanStr(b.title, 100);
  if (!title) return fail(res, 400, 'title 必填');
  if (!HONOR_LEVELS.includes(b.level)) return fail(res, 400, 'level 非法');
  if (!isValidDate(b.date)) return fail(res, 400, 'date 格式非法');
  const h = { id: genId('hn'), student_id: null, class_id: cls.id, title, level: b.level, event: cleanStr(b.event, 100), date: b.date, material_id: b.material_id || null, created_at: nowISO() };
  withTx(() => { pushUndo({ op: 'create', entity: 'honor', entity_id: h.id, before: null, after: { ...h } }); insertRow('honors', h); });
  ok(res, { honor: h });
});

app.get('/api/portfolio/classes/:cid/honors', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const scope = req.query.scope === 'class' ? 'class' : 'student';
  let rows;
  if (scope === 'class') {
    rows = getDB().prepare('SELECT * FROM honors WHERE class_id = ? ORDER BY date DESC').all(cls.id);
  } else if (req.query.student_id) {
    rows = getDB().prepare('SELECT * FROM honors WHERE student_id = ? ORDER BY date DESC').all(req.query.student_id);
  } else {
    rows = getDB().prepare(
      `SELECT h.* FROM honors h JOIN students s ON s.id = h.student_id WHERE s.class_id = ? ORDER BY h.date DESC`
    ).all(cls.id);
  }
  if (HONOR_LEVELS.includes(req.query.level)) rows = rows.filter((r) => r.level === req.query.level);
  ok(res, { honors: rows, total: rows.length });
});

app.delete('/api/portfolio/honors/:hid', (req, res) => {
  const before = getById('honors', req.params.hid);
  if (!before) return fail(res, 404, '荣誉不存在');
  withTx(() => { pushUndo({ op: 'delete', entity: 'honor', entity_id: before.id, before: { ...before }, after: null }); deleteRow('honors', before.id); });
  ok(res, { deleted: before.id });
});

// ---------- 9. 成长素材（03 文档 §9；零依赖 multipart + 文件存储） ----------
import { parseMultipart, ALLOWED_MIME, extOf } from './multipart.mjs';
const UPLOAD_ROOT = () => path.join(DATA_DIR(), 'uploads');
const MATERIAL_CATS = ['class_performance', 'sports', 'activity', 'daily', 'award_cert', 'class_honor', 'photo', 'df_activity', 'df_honor', 'other'];
const MAX_MB = 50;

app.use('/api/portfolio/materials', (req, res, next) => {
  if (req.method === 'POST') return express.raw({ type: 'multipart/form-data', limit: '60mb' })(req, res, next);
  next();
});

app.post('/api/portfolio/materials', (req, res) => {
  const ct = req.headers['content-type'] || '';
  const m = /boundary=(.+)$/.exec(ct);
  if (!m) return fail(res, 400, '需要 multipart/form-data');
  const { fields, files } = parseMultipart(req.body, m[1].replace(/^"|"$/g, ''));
  const file = files.find((f) => f.fieldname === 'file');
  if (!file) return fail(res, 400, '缺少 file 字段');
  if (!ALLOWED_MIME.has(file.mimetype)) return fail(res, 400, `不支持的文件类型: ${file.mimetype}`);
  if (file.data.length > MAX_MB * 1024 * 1024) return fail(res, 400, `文件超过 ${MAX_MB}MB 限制`);
  const ownerType = fields.owner_type === 'class' ? 'class' : 'student';
  const ownerId = fields.owner_id;
  if (!ownerId) return fail(res, 400, 'owner_id 必填');
  if (ownerType === 'student' && !findStudent(ownerId)) return fail(res, 404, '学生不存在');
  if (ownerType === 'class' && !getById('classes', ownerId)) return fail(res, 404, '班级不存在');
  const category = MATERIAL_CATS.includes(fields.category) ? fields.category : 'other';
  const eventDate = isValidDate(fields.event_date) ? fields.event_date : todayISO();
  const id = genId('mat');
  const month = eventDate.slice(0, 7).replace('-', '');
  const dir = path.join(UPLOAD_ROOT(), month);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${id}.${extOf(file.mimetype)}`;
  fs.writeFileSync(path.join(dir, fileName), file.data);
  const mat = {
    id, owner_type: ownerType, student_id: ownerType === 'student' ? ownerId : null, class_id: ownerType === 'class' ? ownerId : null,
    category, file_name: file.filename, file_path: `${month}/${fileName}`, mime: file.mimetype, size: file.data.length,
    event_date: eventDate, note: cleanStr(fields.note, 500), semester: semesterOf(eventDate), created_at: nowISO(),
  };
  withTx(() => { pushUndo({ op: 'create', entity: 'material', entity_id: id, before: null, after: { ...mat } }); insertRow('materials', mat); });
  ok(res, { material: mat });
});

app.get('/api/portfolio/materials', (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.owner_type === 'student' || req.query.owner_type === 'class') { cond.push('owner_type = ?'); params.push(req.query.owner_type); }
  if (req.query.owner_id) { cond.push('(student_id = ? OR class_id = ?)'); params.push(req.query.owner_id, req.query.owner_id); }
  if (req.query.class_id && req.query.include_students === '1') { cond.push('class_id = ?'); params.push(req.query.class_id); }
  if (MATERIAL_CATS.includes(req.query.category)) { cond.push('category = ?'); params.push(req.query.category); }
  if (req.query.semester) { cond.push('semester = ?'); params.push(req.query.semester); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const rows = getDB().prepare(`SELECT * FROM materials ${where} ORDER BY event_date DESC, created_at DESC`).all(...params);
  ok(res, { materials: rows, total: rows.length });
});

app.get('/api/portfolio/materials/:mid/file', (req, res) => {
  const mat = getById('materials', req.params.mid);
  if (!mat) return fail(res, 404, '素材不存在');
  const file = path.join(UPLOAD_ROOT(), mat.file_path);
  if (!fs.existsSync(file)) return fail(res, 404, '素材文件缺失');
  res.setHeader('Content-Type', mat.mime);
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(mat.file_name)}`);
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }
  res.sendFile(file);
});

app.get('/api/portfolio/materials/export.zip', (req, res) => {
  const cls = getById('classes', req.query.class_id || '');
  const cond = [];
  const params = [];
  if (cls) { cond.push('class_id = ?'); params.push(cls.id); }
  if (req.query.semester) { cond.push('semester = ?'); params.push(req.query.semester); }
  const rows = getDB().prepare(`SELECT * FROM materials ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}`).all(...params);
  if (rows.length === 0) return fail(res, 404, '没有可打包的素材');
  const tmp = fs.mkdtempSync(path.join(UPLOAD_ROOT(), '.tmp-zip-'));
  let n = 0;
  for (const r of rows) {
    const src = path.join(UPLOAD_ROOT(), r.file_path);
    if (!fs.existsSync(src)) continue;
    const safe = `${String(++n).padStart(3, '0')}-${r.file_name.replace(/[\/:*?"<>|]/g, '_')}`;
    fs.copyFileSync(src, path.join(tmp, safe));
  }
  const zipName = `materials-${Date.now()}.zip`;
  const zipPath = path.join(UPLOAD_ROOT(), zipName);
  execFileSync('/usr/bin/zip', ['-jq', zipPath, ...fs.readdirSync(tmp).map((f) => path.join(tmp, f))]);
  fs.rmSync(tmp, { recursive: true, force: true });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.sendFile(zipPath, () => { try { fs.unlinkSync(zipPath); } catch { /* ignore */ } });
});

app.delete('/api/portfolio/materials/:mid', (req, res) => {
  const before = getById('materials', req.params.mid);
  if (!before) return fail(res, 404, '素材不存在');
  withTx(() => {
    pushUndo({ op: 'delete', entity: 'material', entity_id: before.id, before: { ...before }, after: null });
    deleteRow('materials', before.id);
  });
  try { fs.unlinkSync(path.join(UPLOAD_ROOT(), before.file_path)); } catch { /* 文件可能已缺 */ }
  ok(res, { deleted: before.id });
});

// ---------- 10. 评语（03 文档 §10：确定性引擎） ----------
const COMMENT_TYPES = ['talk', 'home_school', 'periodic'];

app.post('/api/portfolio/students/:sid/comments/generate', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const b = req.body || {};
  if (!COMMENT_TYPES.includes(b.type)) return fail(res, 400, 'type 非法');
  if (b.type === 'periodic' && !b.period) return fail(res, 400, 'periodic 评语必填 period');
  const cls = getById('classes', stu.class_id);
  const db = getDB();
  const period = b.period || (semesterOf(todayISO()) + '');
  // 数据装配
  const scoreRows = db.prepare(
    `SELECT s.*, e.name AS exam_name, e.date AS exam_date FROM exam_scores s JOIN exams e ON e.id = s.exam_id WHERE s.student_id = ? ORDER BY e.date`
  ).all(stu.id);
  const trends = [];
  let prev = null;
  for (const r of scoreRows) {
    if (r.subject !== '总分') continue;
    trends.push({ exam_id: r.exam_id, exam_name: r.exam_name, exam_date: r.exam_date, total: r.score, total_rank: r.class_rank, delta_total: prev === null ? null : Math.round((r.score - prev) * 100) / 100 });
    prev = r.score;
  }
  const hwRows = db.prepare('SELECT * FROM assignment_records WHERE student_id = ?').all(stu.id);
  const hw = {
    completion_rate: hwRows.length ? (hwRows.filter((r) => ['excellent', 'normal', 'late'].includes(r.status)).length / hwRows.length) : 1,
    missing: hwRows.filter((r) => r.status === 'missing').length,
    slack: hwRows.filter((r) => r.status === 'slack').length,
    excellent: hwRows.filter((r) => r.status === 'excellent').length,
  };
  const moralRows = db.prepare('SELECT * FROM moral_records WHERE student_id = ?').all(stu.id);
  const moralByCat = {};
  for (const r of moralRows) moralByCat[r.category] = (moralByCat[r.category] || 0) + 1;
  const honors = db.prepare('SELECT * FROM honors WHERE student_id = ? ORDER BY date DESC LIMIT 3').all(stu.id);
  const weak = db.prepare(
    `SELECT subject FROM exam_scores WHERE student_id = ? AND subject != '总分' GROUP BY subject
     HAVING AVG(score) < (SELECT AVG(score) FROM exam_scores e2 WHERE e2.subject = exam_scores.subject) - 5 AND COUNT(*) >= 2`
  ).all(stu.id);
  const content = generateComment({
    name: stu.name, trends, hw, moralByCat, honors,
    weak: weak.map((w) => ({ subject: w.subject })), stage: cls ? cls.stage : 'middle',
  }, b.type);
  const cmt = {
    id: genId('cmt'), student_id: stu.id, class_id: stu.class_id, type: b.type,
    stage: cls ? cls.stage : 'middle', content, period, saved: 0, created_at: nowISO(), updated_at: nowISO(),
  };
  withTx(() => { pushUndo({ op: 'create', entity: 'comment', entity_id: cmt.id, before: null, after: { ...cmt } }); insertRow('comments', cmt); });
  ok(res, { comment: cmt });
});

app.put('/api/portfolio/comments/:cid', (req, res) => {
  const before = getById('comments', req.params.cid);
  if (!before) return fail(res, 404, '评语不存在');
  const b = req.body || {};
  const patch = {};
  if (b.content !== undefined) { const v = cleanStr(b.content, 2000); if (!v) return fail(res, 400, 'content 不能为空'); patch.content = v; }
  if (b.saved !== undefined) patch.saved = b.saved ? 1 : 0;
  if (b.period !== undefined) patch.period = cleanStr(b.period, 20);
  patch.updated_at = nowISO();
  const after = withTx(() => { pushUndo({ op: 'update', entity: 'comment', entity_id: before.id, before: { ...before }, after: { ...before, ...patch } }); return updateRow('comments', before.id, patch); });
  ok(res, { comment: after });
});

app.get('/api/portfolio/students/:sid/comments', (req, res) => {
  const stu = findStudent(req.params.sid);
  if (!stu) return fail(res, 404, '学生不存在');
  const cond = ['student_id = ?'];
  const params = [stu.id];
  if (COMMENT_TYPES.includes(req.query.type)) { cond.push('type = ?'); params.push(req.query.type); }
  if (req.query.saved === '1') { cond.push('saved = 1'); params.push(); }
  const rows = getDB().prepare(`SELECT * FROM comments WHERE ${cond.join(' AND ')} ORDER BY created_at DESC`).all(...params);
  ok(res, { comments: rows, total: rows.length });
});

app.get('/api/portfolio/classes/:cid/comments/export', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const type = COMMENT_TYPES.includes(req.query.type) ? req.query.type : null;
  const period = req.query.period || null;
  let rows;
  if (type && period) rows = getDB().prepare('SELECT * FROM comments WHERE class_id = ? AND type = ? AND period = ? ORDER BY student_id').all(cls.id, type, period);
  else if (type) rows = getDB().prepare('SELECT * FROM comments WHERE class_id = ? AND type = ? ORDER BY student_id').all(cls.id, type);
  else rows = getDB().prepare('SELECT * FROM comments WHERE class_id = ? ORDER BY student_id').all(cls.id);
  const names = new Map(getDB().prepare('SELECT id, name FROM students').all().map((r) => [r.id, r.name]));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\uFEFF' + ['姓名,类型,学期,内容', ...rows.map((r) => [names.get(r.student_id) || '', r.type, r.period, r.content].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${cls.name}-评语.csv`)}`);
  res.send(csv);
});

app.delete('/api/portfolio/comments/:cid', (req, res) => {
  const before = getById('comments', req.params.cid);
  if (!before) return fail(res, 404, '评语不存在');
  withTx(() => { pushUndo({ op: 'delete', entity: 'comment', entity_id: before.id, before: { ...before }, after: null }); deleteRow('comments', before.id); });
  ok(res, { deleted: before.id });
});

// ---------- 11. 家校话术（03 文档 §11） ----------
const PHRASE_CATS = ['homework', 'supervise', 'safety', 'material', 'custom'];
const TONES = ['strict', 'gentle'];

app.get('/api/portfolio/phrases', (req, res) => {
  const cond = [];
  const params = [];
  if (PHRASE_CATS.includes(req.query.category)) { cond.push('category = ?'); params.push(req.query.category); }
  if (req.query.stage === 'primary' || req.query.stage === 'middle') { cond.push('stage = ?'); params.push(req.query.stage); }
  if (TONES.includes(req.query.tone)) { cond.push('tone = ?'); params.push(req.query.tone); }
  if (req.query.favorite === '1') { cond.push('favorite = 1'); }
  if (req.query.keyword) { cond.push('(title LIKE ? OR content LIKE ?)'); params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`); }
  const rows = getDB().prepare(`SELECT * FROM phrases ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY category, favorite DESC, created_at`).all(...params);
  ok(res, { phrases: rows, total: rows.length });
});

app.post('/api/portfolio/phrases', (req, res) => {
  const b = req.body || {};
  if (!PHRASE_CATS.includes(b.category)) return fail(res, 400, 'category 非法');
  if (b.stage !== 'primary' && b.stage !== 'middle') return fail(res, 400, 'stage 非法');
  if (!TONES.includes(b.tone)) return fail(res, 400, 'tone 非法');
  const title = cleanStr(b.title, 100);
  const content = cleanStr(b.content, 2000);
  if (!title || !content) return fail(res, 400, 'title/content 必填');
  const ph = { id: genId('ph'), category: b.category, stage: b.stage, tone: b.tone, title, content, favorite: 0, created_at: nowISO(), updated_at: nowISO() };
  withTx(() => { pushUndo({ op: 'create', entity: 'phrase', entity_id: ph.id, before: null, after: { ...ph } }); insertRow('phrases', ph); });
  ok(res, { phrase: ph });
});

app.put('/api/portfolio/phrases/:pid', (req, res) => {
  const before = getById('phrases', req.params.pid);
  if (!before) return fail(res, 404, '话术不存在');
  const b = req.body || {};
  const patch = {};
  if (b.title !== undefined) { const v = cleanStr(b.title, 100); if (!v) return fail(res, 400, 'title 不能为空'); patch.title = v; }
  if (b.content !== undefined) { const v = cleanStr(b.content, 2000); if (!v) return fail(res, 400, 'content 不能为空'); patch.content = v; }
  if (b.category !== undefined) { if (!PHRASE_CATS.includes(b.category)) return fail(res, 400, 'category 非法'); patch.category = b.category; }
  if (b.tone !== undefined) { if (!TONES.includes(b.tone)) return fail(res, 400, 'tone 非法'); patch.tone = b.tone; }
  if (b.stage !== undefined) { if (b.stage !== 'primary' && b.stage !== 'middle') return fail(res, 400, 'stage 非法'); patch.stage = b.stage; }
  patch.updated_at = nowISO();
  const after = withTx(() => { pushUndo({ op: 'update', entity: 'phrase', entity_id: before.id, before: { ...before }, after: { ...before, ...patch } }); return updateRow('phrases', before.id, patch); });
  ok(res, { phrase: after });
});

app.delete('/api/portfolio/phrases/:pid', (req, res) => {
  const before = getById('phrases', req.params.pid);
  if (!before) return fail(res, 404, '话术不存在');
  withTx(() => { pushUndo({ op: 'delete', entity: 'phrase', entity_id: before.id, before: { ...before }, after: null }); deleteRow('phrases', before.id); });
  ok(res, { deleted: before.id });
});

app.put('/api/portfolio/phrases/:pid/favorite', (req, res) => {
  const before = getById('phrases', req.params.pid);
  if (!before) return fail(res, 404, '话术不存在');
  const fav = (req.body || {}).favorite ? 1 : 0;
  const after = withTx(() => { pushUndo({ op: 'update', entity: 'phrase', entity_id: before.id, before: { ...before }, after: { ...before, favorite: fav } }); return updateRow('phrases', before.id, { favorite: fav }); });
  ok(res, { favorite: after.favorite });
});

app.post('/api/portfolio/phrases/:pid/generate', (req, res) => {
  const before = getById('phrases', req.params.pid);
  if (!before) return fail(res, 404, '话术不存在');
  const params = (req.body || {}).params || {};
  let content = before.content;
  const unresolved = [];
  for (const m of content.matchAll(/\{([^}]+)\}/g)) {
    const key = m[1];
    if (params[key] !== undefined && params[key] !== '') content = content.split(m[0]).join(String(params[key]));
    else if (!unresolved.includes(key)) unresolved.push(key);
  }
  ok(res, { content, unresolved });
});

// ---------- 12. 道法智能分层（03 文档 §12） ----------
// 权重（04 文档 §13）：初中 score0.6/question0.25/classroom0.15，阈值 80/60；小学 0.5/0.35/0.15，阈值 85/65
function layerScoreOf(db, classId, stage) {
  const cls = getById('classes', classId);
  const exam = db.prepare(
    `SELECT id FROM exams WHERE class_id = ? AND type IN ('midterm','final','monthly') ORDER BY date DESC LIMIT 1`
  ).get(classId) || db.prepare('SELECT id FROM exams WHERE class_id = ? ORDER BY date DESC LIMIT 1').get(classId);
  const byStudent = new Map();
  if (exam) {
    const dfRows = db.prepare(`SELECT student_id, score FROM exam_scores WHERE exam_id = ? AND subject = '道德与法治'`).all(exam.id);
    for (const r of dfRows) {
      const s = byStudent.get(r.student_id) || { score: [], question: [], classroom: [] };
      s.score.push(r.score);
      byStudent.set(r.student_id, s);
    }
    // 题型失分 → question 维度（0-100 分制：失分率越低越好）
    const qRows = db.prepare(`SELECT student_id, question_scores FROM exam_scores WHERE exam_id = ? AND subject = '道德与法治' AND question_scores IS NOT NULL`).all(exam.id);
    for (const r of qRows) {
      const qs = parseQS(r.question_scores);
      if (Object.keys(qs).length === 0) continue;
      const s = byStudent.get(r.student_id);
      if (!s) continue;
      let lossSum = 0, n = 0;
      for (const [k, v] of Object.entries(qs)) {
        const full = { 选择: 20, 简答: 10, 材料分析: 8, 论述: 6 }[k];
        if (full) { lossSum += (full - v) / full; n++; }
      }
      s.question.push(n ? 100 * (1 - lossSum / n) : 60);
    }
  }
  // classroom：最近 30 天作业记录折算（excellent100/normal80/late60/slack30/missing0/copy0）
  const W = { excellent: 100, normal: 80, late: 60, slack: 30, missing: 0, copy: 0 };
  const from = todayISO().slice(0, 8) + '01';
  const awRows = db.prepare(
    `SELECT ar.student_id, ar.status FROM assignment_records ar JOIN assignments a ON a.id = ar.assignment_id
     WHERE a.class_id = ? AND a.date >= ?`
  ).all(classId, from);
  for (const r of awRows) {
    const s = byStudent.get(r.student_id);
    if (s && W[r.status] !== undefined) s.classroom.push(W[r.status]);
  }
  const weights = stage === 'primary'
    ? { score: 0.5, question: 0.15, classroom: 0.35 }
    : { score: 0.6, question: 0.25, classroom: 0.15 };
  const out = new Map();
  for (const [sid, s] of byStudent) {
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const sc = avg(s.score);
    const q = avg(s.question);
    const cr = avg(s.classroom);
    // 可用维度归一化加权：缺失维度不参与（避免 60 兜底拉低高分生）
    let total = 0, wsum = 0;
    if (sc != null) { total += sc * weights.score; wsum += weights.score; }
    if (q != null) { total += q * weights.question; wsum += weights.question; }
    if (cr != null) { total += cr * weights.classroom; wsum += weights.classroom; }
    const final = wsum > 0 ? total / wsum : 60;
    out.set(sid, { score: Math.round(final * 100) / 100, sc, q, cr });
  }
  return { weights, scores: out };
}

function layerOf(total, stage) {
  if (stage === 'primary') return total >= 85 ? 'advanced' : total >= 65 ? 'middle' : 'basic';
  return total >= 80 ? 'advanced' : total >= 60 ? 'middle' : 'basic';
}

app.post('/api/portfolio/classes/:cid/layers/auto', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const db = getDB();
  const stage = req.body?.stage === 'primary' || req.body?.stage === 'middle' ? req.body.stage : cls.stage;
  const { weights, scores } = layerScoreOf(db, cls.id, stage);
  const students = db.prepare('SELECT id, name FROM students WHERE class_id = ? AND active = 1').all(cls.id);
  const result = { advanced: [], middle: [], basic: [] };
  const layerAssign = [];
  for (const stu of students) {
    const sc = scores.get(stu.id);
    const layer = layerOf(sc ? sc.score : 60, stage);
    result[layer].push({ student_id: stu.id, student_name: stu.name, score: sc ? sc.score : 60 });
    layerAssign.push({ student_id: stu.id, layer, score: sc ? sc.score : 60 });
  }
  const beforeSl = db.prepare('SELECT * FROM student_layers WHERE class_id = ?').all(cls.id);
  const beforeSnap = db.prepare('SELECT * FROM layers_snapshot WHERE class_id = ?').all(cls.id);
  // 保留人工微调层（source=manual 不被 auto 覆盖；04 文档 §13）
  const manual = new Map(beforeSl.filter((r) => r.source === 'manual').map((r) => [r.student_id, r.layer]));
  const snap = {
    id: genId('lay'), class_id: cls.id, stage, rule_json: JSON.stringify({ weight: weights }),
    created_at: nowISO(), updated_at: nowISO(),
  };
  withTx(() => {
    pushUndo({
      op: 'update', entity: 'layers_auto', entity_id: cls.id,
      before: { snapshot: beforeSnap, layers: beforeSl },
      after: { snapshot: [snap], layers: layerAssign.map((l) => ({ student_id: l.student_id, layer: manual.has(l.student_id) ? manual.get(l.student_id) : l.layer, source: manual.has(l.student_id) ? 'manual' : 'auto' })) },
    });
    db.prepare('DELETE FROM student_layers WHERE class_id = ? AND source = \'auto\'').run(cls.id);
    for (const l of layerAssign) {
      if (manual.has(l.student_id)) continue; // manual 保留
      db.prepare('INSERT INTO student_layers(id, class_id, student_id, layer, source, updated_at) VALUES (?,?,?,?,?,?)')
        .run(genId('sl'), cls.id, l.student_id, l.layer, 'auto', nowISO());
    }
    db.prepare('DELETE FROM layers_snapshot WHERE class_id = ?').run(cls.id);
    insertRow('layers_snapshot', snap);
  });
  ok(res, { result, rule: { weight: weights, stage } });
});

app.put('/api/portfolio/student-layers', (req, res) => {
  const b = req.body || {};
  if (!b.student_id || !findStudent(b.student_id)) return fail(res, 404, '学生不存在');
  if (!['advanced', 'middle', 'basic'].includes(b.layer)) return fail(res, 400, 'layer 非法');
  const stu = findStudent(b.student_id);
  const before = getDB().prepare('SELECT * FROM student_layers WHERE class_id = ? AND student_id = ?').get(stu.class_id, stu.id);
  const after = { id: before ? before.id : genId('sl'), class_id: stu.class_id, student_id: stu.id, layer: b.layer, source: 'manual', updated_at: nowISO() };
  withTx(() => {
    pushUndo({ op: 'update', entity: 'student_layer', entity_id: stu.id, before: before ? { ...before } : null, after: { ...after } });
    if (before) {
      getDB().prepare('UPDATE student_layers SET layer = ?, source = ?, updated_at = ? WHERE id = ?').run(b.layer, 'manual', nowISO(), before.id);
    } else {
      insertRow('student_layers', after);
    }
  });
  ok(res, { student_layer: after });
});

app.get('/api/portfolio/classes/:cid/layers', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const db = getDB();
  const rows = db.prepare(
    `SELECT sl.*, s.name AS student_name FROM student_layers sl JOIN students s ON s.id = sl.student_id WHERE sl.class_id = ? ORDER BY s.name`
  ).all(cls.id);
  const layers = { advanced: [], middle: [], basic: [] };
  for (const r of rows) layers[r.layer].push({ student_id: r.student_id, student_name: r.student_name, source: r.source, updated_at: r.updated_at });
  const snap = db.prepare('SELECT * FROM layers_snapshot WHERE class_id = ? ORDER BY updated_at DESC LIMIT 1').get(cls.id);
  ok(res, { layers, updated_at: snap ? snap.updated_at : null, rule: snap ? JSON.parse(snap.rule_json) : null });
});

app.get('/api/portfolio/classes/:cid/layers/plans', (req, res) => {
  const cls = getById('classes', req.params.cid);
  if (!cls) return fail(res, 404, '班级不存在');
  const stage = cls.stage;
  const plans = stage === 'primary'
    ? {
        advanced: { focus: '兴趣拓展、表达展示', homework: '主题手抄报 + 1 道开放题', question: '课堂提问：创意分享类' },
        middle: { focus: '习惯巩固、基础识记', homework: '识记清单 + 2 道基础题', question: '课堂提问：情景判断类' },
        basic: { focus: '兴趣保护、参与感建立', homework: '亲子共读 1 页 + 口头复述', question: '课堂提问：直接复述类' },
      }
    : {
        advanced: { focus: '主观题逻辑深化、时政分析', homework: '材料分析题 2 道 + 时政短评 1 篇', question: '课堂提问：开放性问题为主' },
        middle: { focus: '考点梳理、答题规范', homework: '基础题 + 1 道材料题', question: '课堂提问：半开放问题' },
        basic: { focus: '基础识记、课堂参与', homework: '识记清单 + 2 道基础题', question: '课堂提问：直接复述类问题' },
      };
  ok(res, { plans, stage });
});

// ---------- 14. 知识卡片与推送（03 文档 §14：轻量辅助模块） ----------
const PUSH_KINDS = ['manager', 'df_teaching', 'psychology', 'quote'];
const KIND_LIBRARY = { manager: 'master', df_teaching: 'master', psychology: 'psychology', quote: 'quote' };

/** 当日推送：每类取未推送条目（push_logs 去重，全推完 round+1）；df_teaching 按学段偏好 */
function pushOfDay(db, kind) {
  const date = todayISO();
  const log = db.prepare('SELECT * FROM push_logs WHERE date = ? AND kind = ?').get(date, kind);
  if (log) {
    const it = getById('knowledge_items', log.item_id);
    return it ? { item: it, round: log.round } : null;
  }
  // 取未推送条目
  const pushed = new Set(db.prepare('SELECT item_id FROM push_logs WHERE kind = ?').all(kind).map((r) => r.item_id));
  const library = KIND_LIBRARY[kind];
  let cond = 'library = ?';
  const params = [library];
  if (kind === 'df_teaching') {
    const pref = getSetting('stage_filter', 'all');
    if (pref === 'primary' || pref === 'middle') { cond += ' AND (stage = ? OR stage = \'all\')'; params.push(pref); }
  }
  const pool = db.prepare(`SELECT * FROM knowledge_items WHERE ${cond}`).all(...params)
    .filter((i) => !pushed.has(i.id));
  let round = 1;
  let item = null;
  if (pool.length === 0) {
    // 全推完：round+1 重置（该轮已推条目不再排除）
    const maxRound = db.prepare('SELECT MAX(round) AS r FROM push_logs WHERE kind = ?').get(kind).r || 0;
    round = maxRound + 1;
    const all = db.prepare(`SELECT * FROM knowledge_items WHERE ${cond}`).all(...params);
    item = all.length ? all[Math.floor(Math.random() * all.length)] : null;
  } else {
    item = pool[Math.floor(Math.random() * pool.length)];
  }
  if (!item) return null;
  db.prepare('INSERT INTO push_logs(date, kind, item_id, round) VALUES (?,?,?,?)').run(date, kind, item.id, round);
  return { item, round };
}

app.get('/api/portfolio/push/today', (req, res) => {
  const db = getDB();
  const kind = PUSH_KINDS.includes(req.query.kind) ? req.query.kind : null;
  if (kind) {
    const r = pushOfDay(db, kind);
    ok(res, { date: todayISO(), kind, item: r ? r.item : null });
  } else {
    const items = PUSH_KINDS.map((k) => ({ kind: k, item: pushOfDay(db, k)?.item || null }));
    ok(res, { date: todayISO(), items });
  }
});

app.post('/api/portfolio/push/refresh', (req, res) => {
  const kind = (req.body || {}).kind;
  if (!PUSH_KINDS.includes(kind)) return fail(res, 400, 'kind 非法');
  const db = getDB();
  // 换一条：删除当日记录后重取
  db.prepare('DELETE FROM push_logs WHERE date = ? AND kind = ?').run(todayISO(), kind);
  const r = pushOfDay(db, kind);
  ok(res, { kind, item: r ? r.item : null });
});

app.get('/api/portfolio/knowledge', (req, res) => {
  const db = getDB();
  const cond = [];
  const params = [];
  const LIBRARIES = ['classic', 'psychology', 'master', 'quote'];
  if (LIBRARIES.includes(req.query.library)) { cond.push('library = ?'); params.push(req.query.library); }
  if (req.query.category) { cond.push('category = ?'); params.push(req.query.category); }
  if (req.query.stage === 'primary' || req.query.stage === 'middle' || req.query.stage === 'all') { cond.push('stage = ?'); params.push(req.query.stage); }
  if (req.query.keyword) { cond.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)'); params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`, `%${req.query.keyword}%`); }
  if (req.query.favorite === '1') cond.push('favorite = 1');
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = getDB().prepare(`SELECT * FROM knowledge_items ${where} ORDER BY favorite DESC, created_at`).all(...params);
  ok(res, { items: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') })), total: rows.length });
});

app.put('/api/portfolio/knowledge/:kid/favorite', (req, res) => {
  const before = getById('knowledge_items', req.params.kid);
  if (!before) return fail(res, 404, '条目不存在');
  const fav = (req.body || {}).favorite ? 1 : 0;
  updateRow('knowledge_items', before.id, { favorite: fav });
  ok(res, { favorite: fav });
});

app.put('/api/portfolio/knowledge/:kid/note', (req, res) => {
  const before = getById('knowledge_items', req.params.kid);
  if (!before) return fail(res, 404, '条目不存在');
  const note = cleanStr((req.body || {}).note, 1000);
  updateRow('knowledge_items', before.id, { note });
  ok(res, { note });
});

app.get('/api/portfolio/push/review', (req, res) => {
  const db = getDB();
  const period = ['week', 'month', 'semester'].includes(req.query.period) ? req.query.period : 'month';
  const today = todayISO();
  let from;
  if (period === 'week') from = isoWeekStart(today);
  else if (period === 'month') from = today.slice(0, 8) + '01';
  else { const r = semesterRange(today); from = r.from; }
  const logs = db.prepare('SELECT * FROM push_logs WHERE date >= ? ORDER BY date').all(from);
  const pushed = [];
  for (const l of logs) {
    const it = getById('knowledge_items', l.item_id);
    if (!it) continue;
    pushed.push({ date: l.date, kind: l.kind, title: it.title, content_excerpt: it.content.slice(0, 60), favorite: it.favorite });
  }
  // 收藏沉淀：取全部已收藏条目（含笔记），不限推送周期
  const favs = db.prepare("SELECT id, title, note FROM knowledge_items WHERE favorite = 1 ORDER BY created_at").all()
    .map((r) => ({ item_id: r.id, title: r.title, note: r.note }));
  const favCount = favs.length;
  const reflection = `${period === 'week' ? '本周' : period === 'month' ? '本月' : '本学期'}推送 ${pushed.length} 条，收藏 ${favCount} 条，笔记 ${favs.filter((f) => f.note).length} 条${favCount ? `；重点资源：${pushed.filter((p) => p.favorite).slice(0, 3).map((p) => p.title).join('、')}` : ''}。`;
  ok(res, {
    review: {
      period, range: { from, to: today },
      pushed, favorites: favs, reflection,
      work_summary: `${reflection} 建议回顾收藏条目并转化为家长群通知/谈心话术落地应用。`,
    },
  });
});

app.get('/api/portfolio/push/review/export', (req, res) => {
  const period = ['week', 'month', 'semester'].includes(req.query.period) ? req.query.period : 'month';
  const db = getDB();
  const today = todayISO();
  let from;
  if (period === 'week') from = isoWeekStart(today);
  else if (period === 'month') from = today.slice(0, 8) + '01';
  else { const r = semesterRange(today); from = r.from; }
  const logs = db.prepare('SELECT * FROM push_logs WHERE date >= ? ORDER BY date').all(from);
  const lines = [`# 知识卡片复盘汇总（${period}）`, '', `范围：${from} ~ ${today}`, ''];
  for (const l of logs) {
    const it = getById('knowledge_items', l.item_id);
    if (!it) continue;
    lines.push(`## ${l.date} [${l.kind}] ${it.title}${it.favorite ? ' ⭐' : ''}`);
    lines.push(it.content);
    if (it.note) lines.push(`> 笔记：${it.note}`);
    lines.push('');
  }
  lines.push(`共 ${logs.length} 条推送。`);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`知识复盘-${period}.md`)}`);
  res.send(lines.join('\n'));
});

// ---------- 13. 沟通安排与日历联动（03 文档 §13：唯一联动） ----------
const COM_TYPES = ['talk', 'home_visit', 'parent_meet', 'chat'];

app.post('/api/portfolio/communications', async (req, res) => {
  const b = req.body || {};
  if (!b.student_id || !findStudent(b.student_id)) return fail(res, 404, '学生不存在');
  if (!COM_TYPES.includes(b.type)) return fail(res, 400, 'type 非法');
  if (!isValidDate(b.date)) return fail(res, 400, 'date 格式非法');
  const stu = findStudent(b.student_id);
  const cls = getById('classes', stu.class_id);
  const rec = {
    id: genId('com'), student_id: stu.id, class_id: stu.class_id, type: b.type,
    date: b.date, time: cleanStr(b.time, 50), location: cleanStr(b.location, 100), note: cleanStr(b.note, 500),
    sync_status: 'pending', calendar_event_id: '', calendar_semester_id: '', sync_error: '',
    created_at: nowISO(), updated_at: nowISO(),
  };
  insertRow('communications', rec);
  // 自动同步（唯一联动）
  const label = { talk: '谈心', home_visit: '家访', parent_meet: '家长约谈', chat: '私聊安排' }[b.type];
  const r = await syncCommunicationToCalendar({
    type: b.type,
    title: `💬 ${label} · ${stu.name}（${cls ? cls.name : ''}）`,
    date: b.date, time: rec.time, location: rec.location, note: rec.note,
    participants: `${stu.name}（${cls ? cls.name : ''}）`,
  });
  if (r.ok) {
    updateRow('communications', rec.id, { sync_status: 'synced', calendar_event_id: r.calendar_event_id, calendar_semester_id: r.calendar_semester_id, sync_error: '' });
  } else if (!r.skipped) {
    updateRow('communications', rec.id, { sync_status: 'failed', sync_error: r.error || '' });
  }
  const after = getById('communications', rec.id);
  ok(res, { communication: after });
});

app.get('/api/portfolio/communications', (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.student_id) { cond.push('student_id = ?'); params.push(req.query.student_id); }
  if (req.query.class_id) { cond.push('class_id = ?'); params.push(req.query.class_id); }
  if (COM_TYPES.includes(req.query.type)) { cond.push('type = ?'); params.push(req.query.type); }
  if (['pending', 'synced', 'failed'].includes(req.query.sync_status)) { cond.push('sync_status = ?'); params.push(req.query.sync_status); }
  if (isValidDate(req.query.date_from)) { cond.push('date >= ?'); params.push(req.query.date_from); }
  if (isValidDate(req.query.date_to)) { cond.push('date <= ?'); params.push(req.query.date_to); }
  const rows = getDB().prepare(`SELECT * FROM communications ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY date DESC, created_at DESC`).all(...params);
  ok(res, { communications: rows, total: rows.length });
});

app.post('/api/portfolio/communications/:cid/sync', async (req, res) => {
  const before = getById('communications', req.params.cid);
  if (!before) return fail(res, 404, '沟通安排不存在');
  const stu = findStudent(before.student_id);
  const cls = getById('classes', before.class_id);
  const label = { talk: '谈心', home_visit: '家访', parent_meet: '家长约谈', chat: '私聊安排' }[before.type];
  const r = await syncCommunicationToCalendar({
    type: before.type,
    title: `💬 ${label} · ${stu ? stu.name : ''}（${cls ? cls.name : ''}）`,
    date: before.date, time: before.time, location: before.location, note: before.note,
    participants: `${stu ? stu.name : ''}（${cls ? cls.name : ''}）`,
  });
  let patch;
  if (r.ok) {
    patch = { sync_status: 'synced', calendar_event_id: r.calendar_event_id, calendar_semester_id: r.calendar_semester_id, sync_error: '', updated_at: nowISO() };
  } else if (r.skipped) {
    patch = { sync_status: 'pending', sync_error: '', updated_at: nowISO() };
  } else {
    patch = { sync_status: 'failed', sync_error: r.error || '', updated_at: nowISO() };
  }
  const after = withTx(() => { pushUndo({ op: 'update', entity: 'communication', entity_id: before.id, before: { ...before }, after: { ...before, ...patch } }); return updateRow('communications', before.id, patch); });
  ok(res, { communication: after });
});

app.put('/api/portfolio/communications/:cid', async (req, res) => {
  const before = getById('communications', req.params.cid);
  if (!before) return fail(res, 404, '沟通安排不存在');
  const b = req.body || {};
  const patch = {};
  if (b.date !== undefined) { if (!isValidDate(b.date)) return fail(res, 400, 'date 非法'); patch.date = b.date; }
  if (b.time !== undefined) patch.time = cleanStr(b.time, 50);
  if (b.location !== undefined) patch.location = cleanStr(b.location, 100);
  if (b.note !== undefined) patch.note = cleanStr(b.note, 500);
  if (b.type !== undefined) { if (!COM_TYPES.includes(b.type)) return fail(res, 400, 'type 非法'); patch.type = b.type; }
  if (Object.keys(patch).length === 0) return ok(res, { communication: before });
  // 更新后重同步：先删旧日历事件再按新信息创建（状态机：03 文档 §3.4）
  let syncPatch = { sync_status: 'pending', sync_error: '', updated_at: nowISO() };
  if (before.calendar_event_id && before.calendar_semester_id) {
    const err = await deleteCalendarEvent(before.calendar_event_id, before.calendar_semester_id);
    if (err) syncPatch = { sync_status: 'failed', sync_error: err, updated_at: nowISO() };
  }
  const merged = { ...before, ...patch };
  const stu = findStudent(merged.student_id);
  const cls = getById('classes', merged.class_id);
  if (syncPatch.sync_status !== 'failed') {
    const label = { talk: '谈心', home_visit: '家访', parent_meet: '家长约谈', chat: '私聊安排' }[merged.type];
    const r = await syncCommunicationToCalendar({
      type: merged.type,
      title: `💬 ${label} · ${stu ? stu.name : ''}（${cls ? cls.name : ''}）`,
      date: merged.date, time: merged.time, location: merged.location, note: merged.note,
      participants: `${stu ? stu.name : ''}（${cls ? cls.name : ''}）`,
    });
    if (r.ok) syncPatch = { sync_status: 'synced', calendar_event_id: r.calendar_event_id, calendar_semester_id: r.calendar_semester_id, sync_error: '', updated_at: nowISO() };
    else if (!r.skipped) syncPatch = { sync_status: 'failed', sync_error: r.error || '', updated_at: nowISO() };
  }
  const after = withTx(() => {
    pushUndo({ op: 'update', entity: 'communication', entity_id: before.id, before: { ...before }, after: { ...before, ...patch, ...syncPatch } });
    return updateRow('communications', before.id, { ...patch, ...syncPatch });
  });
  ok(res, { communication: after });
});

app.delete('/api/portfolio/communications/:cid', async (req, res) => {
  const before = getById('communications', req.params.cid);
  if (!before) return fail(res, 404, '沟通安排不存在');
  let syncNote = '';
  if (before.calendar_event_id && before.calendar_semester_id) {
    const err = await deleteCalendarEvent(before.calendar_event_id, before.calendar_semester_id);
    if (err) syncNote = err;
  }
  withTx(() => { pushUndo({ op: 'delete', entity: 'communication', entity_id: before.id, before: { ...before }, after: null }); deleteRow('communications', before.id); });
  ok(res, { deleted: before.id, sync_note: syncNote });
});

// ---------- 15.2-15.6 备份 / 恢复 / 全量导出（03 文档 §15） ----------
const BACKUP_DIR = () => path.join(DATA_DIR(), 'backups');

app.post('/api/portfolio/backup', (req, res) => {
  try {
    // WAL 模式：先 checkpoint 合并 -wal 到主库，否则备份丢失未合并的最近提交
    getDB().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.mkdirSync(BACKUP_DIR(), { recursive: true });
    const ts = nowISO().replace(/[-:T]/g, '').slice(0, 14);
    const name = `portfolio-backup-${ts}.zip`;
    const zipPath = path.join(BACKUP_DIR(), name);
    const tmp = fs.mkdtempSync(path.join(DATA_DIR(), '.tmp-bak-'));
    fs.copyFileSync(DB_FILE(), path.join(tmp, 'student-portfolio.db'));
    if (fs.existsSync(path.join(DATA_DIR(), 'uploads'))) {
      fs.cpSync(path.join(DATA_DIR(), 'uploads'), path.join(tmp, 'uploads'), { recursive: true });
    }
    const manifest = { app: 'student-portfolio', schema_version: schemaVersion(), created_at: nowISO(), file_count: 0, db_size: fs.statSync(DB_FILE()).size };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // 排除 tmp/backups 自身
    execFileSync('/usr/bin/zip', ['-jq', zipPath, path.join(tmp, 'student-portfolio.db'), path.join(tmp, 'manifest.json')]);
    const upDir = path.join(tmp, 'uploads');
    if (fs.existsSync(upDir)) {
      execFileSync('/usr/bin/zip', ['-rq', zipPath, 'uploads'], { cwd: tmp });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    manifest.file_count = 2 + (fs.existsSync(path.join(DATA_DIR(), 'uploads')) ? 1 : 0);
    ok(res, { backup: { file: name, size: fs.statSync(zipPath).size, created_at: manifest.created_at } });
  } catch (e) {
    fail(res, 500, `备份失败（${e.message}）`);
  }
});

app.get('/api/portfolio/backups', (req, res) => {
  if (!fs.existsSync(BACKUP_DIR())) return ok(res, { backups: [] });
  const list = fs.readdirSync(BACKUP_DIR()).filter((f) => f.startsWith('portfolio-backup-') && f.endsWith('.zip'))
    .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR(), f)); return { file: f, size: st.size, created_at: st.mtime.toISOString() }; })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  ok(res, { backups: list });
});

app.get('/api/portfolio/backups/:file/download', (req, res) => {
  const file = req.params.file;
  if (!/^portfolio-backup-[\w-]+\.zip$/.test(file)) return fail(res, 400, '非法文件名');
  const p = path.join(BACKUP_DIR(), file);
  if (!fs.existsSync(p)) return fail(res, 404, '备份不存在');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.sendFile(p);
});

app.use('/api/portfolio/backup/restore', (req, res, next) => {
  if (req.method === 'POST') return express.raw({ type: 'multipart/form-data', limit: '200mb' })(req, res, next);
  next();
});

app.post('/api/portfolio/backup/restore', (req, res) => {
  const ct = req.headers['content-type'] || '';
  const m = /boundary=(.+)$/.exec(ct);
  if (!m) return fail(res, 400, '需要 multipart/form-data');
  const { files } = parseMultipart(req.body, m[1].replace(/^"|"$/g, ''));
  const file = files.find((f) => f.fieldname === 'file');
  if (!file) return fail(res, 400, '缺少 file 字段');
  const tmp = fs.mkdtempSync(path.join(DATA_DIR(), '.tmp-rest-'));
  const zipPath = path.join(tmp, 'restore.zip');
  fs.writeFileSync(zipPath, file.data);
  try {
    execFileSync('/usr/bin/unzip', ['-oq', zipPath, '-d', path.join(tmp, 'out')]);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(res, 400, `备份包解压失败（${e.message}）`);
  }
  const outDir = path.join(tmp, 'out');
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { fs.rmSync(tmp, { recursive: true, force: true }); return fail(res, 400, '备份包缺少 manifest.json'); }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { fs.rmSync(tmp, { recursive: true, force: true }); return fail(res, 400, 'manifest.json 损坏'); }
  if (manifest.app !== 'student-portfolio') { fs.rmSync(tmp, { recursive: true, force: true }); return fail(res, 400, '不是学生成长档案备份包'); }
  if (manifest.schema_version > schemaVersion()) { fs.rmSync(tmp, { recursive: true, force: true }); return fail(res, 400, `备份版本 ${manifest.schema_version} 高于当前 ${schemaVersion()}，请先升级应用`); }
  const dbPath = path.join(outDir, 'student-portfolio.db');
  if (!fs.existsSync(dbPath)) { fs.rmSync(tmp, { recursive: true, force: true }); return fail(res, 400, '备份包缺少数据库文件'); }
  // 停库 → 替换 → 重启
  const rollbackDir = path.join(DATA_DIR(), 'tmp', `restore-rollback-${Date.now()}`);
  fs.mkdirSync(rollbackDir, { recursive: true });
  try {
    closeDB();
    fs.copyFileSync(DB_FILE(), path.join(rollbackDir, 'student-portfolio.db'));
    fs.copyFileSync(dbPath, DB_FILE());
    if (fs.existsSync(path.join(outDir, 'uploads'))) {
      const up = path.join(DATA_DIR(), 'uploads');
      if (fs.existsSync(up)) fs.cpSync(up, path.join(rollbackDir, 'uploads'), { recursive: true });
      fs.rmSync(up, { recursive: true, force: true });
      fs.cpSync(path.join(outDir, 'uploads'), up, { recursive: true });
    }
    const db = openDB();
    const okFlag = db.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok';
    if (!okFlag) throw new Error('integrity_check 失败');
  } catch (e) {
    closeDB();
    fs.copyFileSync(path.join(rollbackDir, 'student-portfolio.db'), DB_FILE());
    openDB();
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(res, 500, `恢复失败已回滚（${e.message}）`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  ok(res, { restored: true, schema_version: schemaVersion() });
});

app.get('/api/portfolio/export', (req, res) => {
  const db = getDB();
  const tables = ['classes', 'students', 'exams', 'exam_scores', 'assignments', 'assignment_records', 'moral_records', 'talents', 'honors', 'materials', 'comments', 'phrases', 'layers_snapshot', 'student_layers', 'communications', 'knowledge_items'];
  const tmp = fs.mkdtempSync(path.join(DATA_DIR(), '.tmp-exp-'));
  const json = {};
  for (const t of tables) json[t] = db.prepare(`SELECT * FROM ${t}`).all();
  json.settings = getSettings();
  fs.writeFileSync(path.join(tmp, 'portfolio.json'), JSON.stringify(json, null, 2));
  for (const t of ['students', 'exam_scores', 'moral_records', 'honors', 'comments']) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all();
    const cols = rows.length ? Object.keys(rows[0]) : ['id'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync(path.join(tmp, `${t}.csv`), '\uFEFF' + [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
  }
  const name = `portfolio-export-${Date.now()}.zip`;
  execFileSync('/usr/bin/zip', ['-rjq', path.join(tmp, name), ...fs.readdirSync(tmp).filter((f) => f !== name).map((f) => path.join(tmp, f))]);
  const zipPath = path.join(tmp, name);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(zipPath, () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
});

// ---------- 15. 撤销 / 恢复（基础版；重做栈在后续轮次补充实体回放） ----------
app.post('/api/portfolio/undo', (req, res) => {
  const entry = popUndo();
  if (!entry) return fail(res, 409, '没有可撤销的操作');
  // 快照回放（通用）：before_json 为单行或数组快照
  const db = getDB();
  const before = entry.before_json ? JSON.parse(entry.before_json) : null;
  const entity = entry.entity;
  withTx(() => {
    if (entity === 'settings') {
      if (before) for (const [k, v] of Object.entries(before)) {
        db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
      }
    } else if (entity === 'class') {
      if (before === null) {
        db.prepare('DELETE FROM classes WHERE id = ?').run(entry.entity_id);
      } else {
        insertRow('classes', before);
        // 级联数据恢复（删除班级时快照的 students/exams/assignments/honors/materials/communications/layers）
        const { cascade } = parseAfter(entry);
        if (cascade) {
          const T = { students: 'students', exams: 'exams', assignments: 'assignments', honors: 'honors', materials: 'materials', communications: 'communications', layers: 'layers_snapshot', student_layers: 'student_layers' };
          for (const [k, table] of Object.entries(T)) {
            const rows = cascade[k] || [];
            for (const r of rows) {
              try { insertRow(table, r); } catch { /* 已存在则跳过 */ }
            }
          }
        }
      }
    } else if (entity === 'exam') {
      if (before === null) {
        db.prepare('DELETE FROM exams WHERE id = ?').run(entry.entity_id);
      } else {
        insertRow('exams', before);
        const { cascade } = parseAfter(entry);
        if (cascade) for (const r of cascade) { try { insertRow('exam_scores', r); } catch { /* skip */ } }
      }
    } else if (entity === 'student_import') {
      // undo 导入 = 移除 after 快照中的行（before 为空数组，无意义）
      const after = entry.after_json ? JSON.parse(entry.after_json) : [];
      for (const s of after) db.prepare('DELETE FROM students WHERE id = ?').run(s.id);
    } else if (entity === 'student') {
      if (before === null) {
        db.prepare('DELETE FROM students WHERE id = ?').run(entry.entity_id);
      } else {
        const row = getById('students', entry.entity_id);
        if (row) {
          const patch = {};
          for (const k of Object.keys(before)) if (k !== 'id') patch[k] = before[k];
          updateRow('students', entry.entity_id, patch);
        } else {
          insertRow('students', before);
        }
      }
    }
  });
  ok(res, { entry: { op: entry.op, entity, entity_id: entry.entity_id, ts: entry.ts } });
});

app.post('/api/portfolio/redo', (req, res) => {
  fail(res, 409, '重做暂未实现（后续里程碑补齐）');
});

// ---------- 状态 ----------
app.get('/api/portfolio/health', (req, res) => ok(res, { schema_version: schemaVersion(), db: 'student-portfolio.db' }));

// ---------- 静态服务（生产模式） ----------
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  // 带内容 hash 的构建产物可永久缓存：文件名变了，浏览器自然拉到新版本。
  app.use('/assets', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  });
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`[student-portfolio] API server: http://127.0.0.1:${PORT}（schema v${schemaVersion()}）`);
});
