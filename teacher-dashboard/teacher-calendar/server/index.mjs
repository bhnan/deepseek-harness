// 教师教学工作日历 —— Express API 服务器
// 定位：独立运行版的 host 半边（未来迁移为 DSH host 插件时路由原样保留）
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import {
  readJSON, writeJSON, exists, listSemesters, saveSemesters, getSemester,
  loadCollection, saveCollection, genId, loadSettings, saveSettings, pushUndo, undo, redo,
  P,
} from './storage.mjs';
import { seedIfEmpty } from './seed.mjs';
import {
  weekOf, semesterTotalWeeks, progress, weekRange,
  mergeWeekView, buildSlots, bindItems, shiftContent, deferContent, undeferContent, fixedInWeek,
  weekday, todayISO, parseISO, weekIndexOf, addDays, weekStart,
} from '../src/engine/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 = 本机所有网络接口（支持局域网访问）
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

seedIfEmpty();

// ---------- 基础 ----------
const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, status, reason) => res.status(status).json({ ok: false, reason });

// 班级分色系（避免跨学段撞色）：初中=莫兰迪色系，小学=马卡龙色系
const STAGE_PALETTES = {
  middle: [
    { color: '#A3B8C4', label: '雾霾蓝' }, { color: '#9CAF88', label: '灰豆绿' },
    { color: '#C4A6A0', label: '灰豆沙' }, { color: '#B5A8CC', label: '灰紫' },
    { color: '#C9B896', label: '燕麦黄' }, { color: '#A0A6A8', label: '暖灰' },
    { color: '#B89A8C', label: '陶土棕' }, { color: '#8FA9B0', label: '青灰' },
  ],
  primary: [
    { color: '#F5A9B8', label: '樱花粉' }, { color: '#A8D8EA', label: '天空蓝' },
    { color: '#F9D976', label: '柠檬黄' }, { color: '#A8DCA8', label: '薄荷绿' },
    { color: '#F4B183', label: '蜜桃橙' }, { color: '#C9A8E8', label: '香芋紫' },
    { color: '#F7C8D0', label: '浅玫红' }, { color: '#B8E0D0', label: '马卡龙青' },
  ],
};
/** 同色系防重复：班级创建/改名/改色时，同一学段内颜色不可重复（跨学段色系天然不同） */
const classColorConflict = (list, stage, color, excludeId) => {
  const c = list.find((x) => x.id !== excludeId && x.stage === stage && x.color.toLowerCase() === String(color).toLowerCase());
  return c ? c.name : null;
};

// ---------- 汇总数据 ----------
app.get('/api/calendar/bootstrap', (req, res) => {
  const semesters = listSemesters();
  const settings = loadSettings();
  // 当前学期缺失 → 自动回退最近学期（缺失行为表）
  if (!getSemester(settings.current_semester_id) && semesters.length) {
    settings.current_semester_id = semesters[0].id;
    saveSettings(settings);
  }
  ok(res, {
    semesters, settings,
    classes: readJSON(P.classes, []),
    class_palettes: STAGE_PALETTES,
    themes: (readJSON(P.theme, {}) || {}).themes || {},
    culture: (readJSON(P.culture, {}) || {}).data?.items || [],
    presets: (readJSON(P.presets, {}) || {}).data?.items || [],
    holidays: (readJSON(P.holidays, {}) || {}).data?.items || [],
  });
});

// ---------- 学期 CRUD（D1/R2，完全开放） ----------
app.get('/api/calendar/semesters', (req, res) => ok(res, { semesters: listSemesters() }));

app.post('/api/calendar/semesters', (req, res) => {
  const { name, start_date, end_date } = req.body || {};
  // 支持寒暑假：`2026年暑假` / `2027年寒假`（同样可排课、事件、计划）
  const m = /^(\d{4})年(春季|秋季)第[一二]学期$/.exec(name || '') || /^(\d{4})年(寒|暑)假$/.exec(name || '');
  if (!m) {
    return fail(res, 400, '学期名称必须为「年份+春季/秋季+第X学期」或「年份+寒/暑假」标准格式');
  }
  const list = listSemesters();
  if (list.some((s) => s.name === name)) return fail(res, 409, `学期「${name}」已存在`);
  if (!start_date || !end_date || end_date < start_date) return fail(res, 400, '起止日期非法或结束早于开始');
  const year = parseInt(m[1], 10);
  const season = m[2] === '春季' ? 'spring' : m[2] === '秋季' ? 'autumn' : m[2] === '寒' ? 'winter' : 'summer';
  const semester = {
    id: genId('sem'), name, start_date, end_date,
    year, season,
    semester_index: m[2] === '春季' || m[2] === '秋季' ? (name.includes('第一') ? 1 : 2) : 1,
  };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'semester', entity_id: semester.id, semester_id: null,
    snapshot_before: null, snapshot_after: semester, ts: new Date().toISOString(),
  });
  list.push(semester);
  saveSemesters(list);
  // 新建学期目录（空学期，含空集合）
  for (const f of ['fixed_courses.json', 'temporary_changes.json', 'suspensions.json', 'teaching_content.json', 'events.json', 'birthdays.json', 'push_state.json']) {
    if (!exists(P.sid(semester.id, f))) writeJSON(P.sid(semester.id, f), []);
  }
  ok(res, { semester });
});

app.put('/api/calendar/semesters/:id', (req, res) => {
  const list = listSemesters();
  const idx = list.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return fail(res, 404, '学期不存在');
  const before = list[idx];
  const { start_date, end_date } = req.body || {};
  if (start_date && end_date && end_date < start_date) return fail(res, 400, '结束日期不得早于开始日期');
  const after = { ...before, start_date: start_date || before.start_date, end_date: end_date || before.end_date };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'semester', entity_id: before.id, semester_id: null,
    snapshot_before: before, snapshot_after: after, ts: new Date().toISOString(),
  });
  list[idx] = after;
  saveSemesters(list);
  ok(res, { semester: after });
});

app.delete('/api/calendar/semesters/:id', (req, res) => {
  const list = listSemesters();
  const idx = list.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return fail(res, 404, '学期不存在');
  const before = list[idx];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'semester', entity_id: before.id, semester_id: null,
    snapshot_before: before, snapshot_after: null, ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  saveSemesters(list);
  ok(res, { deleted: before.id });
});

// ---------- 班级 CRUD（D2，双学段库） ----------
app.get('/api/calendar/classes', (req, res) => ok(res, { classes: readJSON(P.classes, []) }));

app.post('/api/calendar/classes', (req, res) => {
  const { name, stage, color } = req.body || {};
  if (!name || !['primary', 'middle'].includes(stage)) return fail(res, 400, '班级名称与学段必填');
  if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) return fail(res, 400, '配色必须为 hex 色值');
  const list = readJSON(P.classes, []);
  if (list.some((c) => c.name === name)) return fail(res, 409, `班级「${name}」已存在`);
  const conflict = classColorConflict(list, stage, color);
  if (conflict) return fail(res, 409, `该颜色已被同色系班级「${conflict}」使用，请换一个（跨学段自动分色系）`);
  const cls = { id: genId('cls'), name, stage, color };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'class', entity_id: cls.id, semester_id: null,
    snapshot_before: null, snapshot_after: cls, ts: new Date().toISOString(),
  });
  list.push(cls);
  writeJSON(P.classes, list);
  ok(res, { class: cls });
});

app.put('/api/calendar/classes/:id', (req, res) => {
  const list = readJSON(P.classes, []);
  const idx = list.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return fail(res, 404, '班级不存在');
  const before = list[idx];
  const after = { ...before, ...req.body };
  if (req.body.name !== undefined && !String(req.body.name || '').trim()) return fail(res, 400, '班级名称不能为空');
  if (req.body.name !== undefined && req.body.name !== before.name && list.some((c) => c.id !== before.id && c.name === req.body.name)) {
    return fail(res, 409, `班级「${req.body.name}」已存在`);
  }
  if (req.body.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(req.body.color || '')) return fail(res, 400, '配色必须为 hex 色值');
  if (req.body.color !== undefined && req.body.color.toLowerCase() !== before.color.toLowerCase()) {
    const conflict = classColorConflict(list, before.stage, req.body.color, before.id);
    if (conflict) return fail(res, 409, `该颜色已被同色系班级「${conflict}」使用，请换一个（跨学段自动分色系）`);
  }
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'class', entity_id: before.id, semester_id: null,
    snapshot_before: before, snapshot_after: after, ts: new Date().toISOString(),
  });
  list[idx] = after;
  writeJSON(P.classes, list);
  ok(res, { class: after });
});

app.delete('/api/calendar/classes/:id', (req, res) => {
  const list = readJSON(P.classes, []);
  const idx = list.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return fail(res, 404, '班级不存在');
  const before = list[idx];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'class', entity_id: before.id, semester_id: null,
    snapshot_before: before, snapshot_after: null, ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  writeJSON(P.classes, list);
  ok(res, { deleted: before.id });
});

// ---------- 班级与学生档案联动（X 扩展） ----------
// 学生档案（portfolio，默认 127.0.0.1:8797）为班级名册来源：
// - 拉取：档案内班级 → 日历按名称（含「初一(5)班·班主任」这类后缀归一）匹配，未匹配的自动建班
// - 班主任班：role=homeroom 的班级在日历侧标记 homeroom=true，各界面不显示（档案保留）
// - 推送：日历里新建的普通班级 → 档案侧自动创建为 subject 班级
const PORTFOLIO_BASE = process.env.TC_PORTFOLIO_BASE || 'http://127.0.0.1:8797';

function normalizeClassName(name) {
  return String(name || '').replace(/·班主任$/, '').replace(/班主任$/, '').trim();
}

function gradeFromClassName(name) {
  const m = /^(初一|初二|初三|高一|高二|高三)/.exec(name || '');
  if (m) return m[1];
  const m2 = /^(一|二|三|四|五|六)年级/.exec(name || '');
  if (m2) return `${m2[1]}年级`;
  if (/^四\(/.test(name || '')) return '四年级';
  if (/^[一二三五六]\(/.test(name || '')) return '其他';
  return '其他';
}

function fetchJSON(url, options, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(url, { ...(options || {}), signal: ctrl.signal })
      .then((r) => r.json().catch(() => ({ ok: false, reason: `学生档案响应异常 HTTP ${r.status}` })))
      .then((d) => { clearTimeout(timer); resolve(d); })
      .catch((e) => { clearTimeout(timer); resolve({ ok: false, reason: `学生档案不可用（${e.message}）` }); });
  });
}

/** 同色系取色：优先未用过的颜色 */
function pickClassColor(list, stage) {
  const palette = (STAGE_PALETTES[stage] || STAGE_PALETTES.middle).map((p) => p.color);
  const used = new Set(list.filter((c) => c.stage === stage).map((c) => c.color.toLowerCase()));
  return palette.find((c) => !used.has(c.toLowerCase())) || palette[list.length % palette.length];
}

app.post('/api/calendar/classes/sync-portfolio', async (req, res) => {
  const pf = await fetchJSON(`${PORTFOLIO_BASE}/api/portfolio/classes`);
  if (!Array.isArray(pf.classes)) return fail(res, 502, pf.reason || '学生档案服务不可用');
  const pfClasses = Array.isArray(pf.classes) ? pf.classes : [];
  const classes = readJSON(P.classes, []);
  const report = { created: [], linked: [], pushed: [], skipped: [] };

  for (const p of pfClasses) {
    const norm = normalizeClassName(p.name);
    let cls = classes.find((c) => c.linked_portfolio_id === p.id)
      || classes.find((c) => c.name === p.name)
      || classes.find((c) => !c.linked_portfolio_id && normalizeClassName(c.name) === norm);
    if (cls) {
      const wasHidden = !!cls.homeroom;
      cls.linked_portfolio_id = p.id;
      cls.homeroom = p.role === 'homeroom' ? true : !!cls.homeroom;
      if (p.role === 'homeroom' && !wasHidden) report.linked.push(`${cls.name} → 班主任班（工作日历隐藏）`);
      else if (!report.linked.includes(`${cls.name}（已联动）`)) report.linked.push(`${cls.name}（已联动）`);
    } else {
      const ncls = {
        id: genId('cls'), name: p.name, stage: p.stage === 'primary' ? 'primary' : 'middle',
        color: pickClassColor(classes, p.stage === 'primary' ? 'primary' : 'middle'),
        homeroom: p.role === 'homeroom', linked_portfolio_id: p.id,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      classes.push(ncls);
      report.created.push(`${p.name}${ncls.homeroom ? '（班主任班·日历隐藏）' : ''}`);
    }
  }

  // 推送：日历内未联动且非班主任班的班级 → 档案建班（subject）
  for (const c of classes) {
    if (c.linked_portfolio_id || c.homeroom) continue;
    const body = { name: c.name, grade: gradeFromClassName(c.name), stage: c.stage === 'primary' ? 'primary' : 'middle', role: 'subject' };
    const r = await fetchJSON(`${PORTFOLIO_BASE}/api/portfolio/classes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.ok && r.class && r.class.id) { c.linked_portfolio_id = r.class.id; report.pushed.push(c.name); }
    else if (r.ok === false && String(r.reason || '').includes('已存在')) { report.skipped.push(`${c.name}（档案已存在同名班级）`); }
    else if (r.ok === false) { report.skipped.push(`${c.name}（${r.reason}）`); }
    else { report.skipped.push(`${c.name}（档案无 200 响应）`); }
  }

  writeJSON(P.classes, classes);
  ok(res, {
    report,
    classes: classes.map((c) => ({ id: c.id, name: c.name, color: c.color, stage: c.stage, homeroom: !!c.homeroom, linked_portfolio_id: c.linked_portfolio_id || null })),
  });
});

// ---------- 学期内集合通用读取 ----------
const sidGuard = (res, id) => {
  if (!getSemester(id)) { fail(res, 404, '学期不存在'); return null; }
  return id;
};

app.get('/api/calendar/:sid/schedule', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  ok(res, {
    fixed_courses: loadCollection(sid, 'fixed_courses.json'),
    temporary_changes: loadCollection(sid, 'temporary_changes.json'),
  });
});

app.get('/api/calendar/:sid/teaching-content', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  ok(res, { contents: loadCollection(sid, 'teaching_content.json') });
});

// ---------- 固定排课（D3） ----------
app.post('/api/calendar/:sid/fixed-courses', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { class_id, weekday, period, week } = req.body || {};
  if (!class_id || ![1, 2, 3, 4, 5, 6, 7].includes(weekday) || !(period >= 1)) {
    return fail(res, 400, 'class_id/weekday(1-7)/period 必填');
  }
  // week 字段（D3 扩展）：缺省=每周复用；'odd'=单周；'even'=双周；正整数=仅该周；数组=仅这些周
  const weekValid = week === undefined || week === null || week === '' || week === 'odd' || week === 'even'
    || (Number.isInteger(week) && week >= 1)
    || (Array.isArray(week) && week.length > 0 && week.every((n) => Number.isInteger(n) && n >= 1));
  if (!weekValid) return fail(res, 400, 'week 必须是 odd/even/正整数/周数组/缺省');
  const list = loadCollection(sid, 'fixed_courses.json');
  if (list.some((f) => f.weekday === weekday && f.period === period && f.week === (week ?? undefined))) {
    return fail(res, 409, `周${weekday}第${period}节已被占用`);
  }
  const item = { id: genId('fc'), class_id, weekday, period, done_dates: [] };
  if (week !== undefined && week !== null && week !== '') item.week = week;
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'fixed_course', entity_id: item.id, semester_id: sid,
    snapshot_before: null, snapshot_after: item, ts: new Date().toISOString(),
  });
  list.push(item);
  saveCollection(sid, 'fixed_courses.json', list);
  ok(res, { fixed_course: item });
});

/** 完成状态切换（F2：对勾+删除线，可取消，永久留存） */
app.put('/api/calendar/:sid/fixed-courses/:cid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'fixed_courses.json');
  const idx = list.findIndex((f) => f.id === req.params.cid);
  if (idx === -1) return fail(res, 404, '固定排课不存在');
  const before = list[idx];
  let after = { ...before };
  if (req.body.done_dates_append) {
    const dd = before.done_dates || [];
    const d = req.body.done_dates_append;
    after.done_dates = dd.includes(d) ? dd.filter((x) => x !== d) : [...dd, d]; // 切换语义
  } else {
    if (req.body.week !== undefined) {
      const w = req.body.week;
      const weekValid = w === null || w === '' || w === 'odd' || w === 'even'
        || (Number.isInteger(w) && w >= 1)
        || (Array.isArray(w) && w.length > 0 && w.every((n) => Number.isInteger(n) && n >= 1));
      if (!weekValid) return fail(res, 400, 'week 必须是 odd/even/正整数/周数组/null');
      if (w === null || w === '') delete req.body.week; // 清空 → 每周复用
    }
    after = { ...before, ...req.body };
  }
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'fixed_course', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: after, ts: new Date().toISOString(),
  });
  list[idx] = after;
  saveCollection(sid, 'fixed_courses.json', list);
  ok(res, { fixed_course: after });
});

app.put('/api/calendar/:sid/temp-changes/:tid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'temporary_changes.json');
  const idx = list.findIndex((t) => t.id === req.params.tid);
  if (idx === -1) return fail(res, 404, '临时调课不存在');
  const before = list[idx];
  const after = { ...before, ...req.body };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'temporary_change', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: after, ts: new Date().toISOString(),
  });
  list[idx] = after;
  saveCollection(sid, 'temporary_changes.json', list);
  ok(res, { temporary_change: after });
});

app.delete('/api/calendar/:sid/fixed-courses/:cid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'fixed_courses.json');
  const idx = list.findIndex((f) => f.id === req.params.cid);
  if (idx === -1) return fail(res, 404, '固定排课不存在');
  const before = list[idx];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'fixed_course', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: null, ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  saveCollection(sid, 'fixed_courses.json', list);
  ok(res, { deleted: before.id });
});

// ---------- 今日待办（F2）：当日固定课程 + 临时调课 + 个人事务 ----------
app.get('/api/calendar/:sid/todos', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const semester = getSemester(sid);
  const date = req.query.date;
  if (!date || !parseISO(date)) return fail(res, 400, 'date 参数必填');
  const w = weekIndexOf(semester, date);
  const wd = weekday(date);
  if (w < 1) return ok(res, { todos: [], week: w });
  // 法定节假日当天停课：课程/临时调课不列入待办（个人事务事件仍显示）
  const holidays = (readJSON(P.holidays, {}) || {}).data?.items || [];
  const holidayOn = holidays.find((h) => h.start_date <= date && h.end_date >= date);
  const fixed = loadCollection(sid, 'fixed_courses.json');
  const temps = loadCollection(sid, 'temporary_changes.json');
  const events = loadCollection(sid, 'events.json');
  const suspensions = loadCollection(sid, 'suspensions.json');
  const view = mergeWeekView(fixed, temps, w);
  const classById = new Map(readJSON(P.classes, []).map((c) => [c.id, c.name]));
  const todos = [];
  for (const [k, cell] of view.cells.entries()) {
    const [cwd, period] = k.split('-').map(Number);
    if (cwd !== wd) continue;
    if (holidayOn) continue; // 节假日停课
    if (suspensions.some((s) => s.class_id === cell.class_id && s.week === w && s.weekday === cwd && s.period === period)) continue; // 停课标记
    if (cell.temp) {
      const tc = temps.find((t) => t.id === cell.temp_id);
      todos.push({ kind: 'temp', id: cell.temp_id, class_id: cell.class_id, title: `${classById.get(cell.class_id) || '未知班级'} · 临时调课${cell.note ? '（' + cell.note + '）' : ''}`, weekday: cwd, period, done: !!(tc && tc.done) });
    } else {
      const fc = fixed.find((f) => f.id === cell.fixed_id);
      const done = (fc && fc.done_dates || []).includes(date);
      todos.push({ kind: 'course', id: cell.fixed_id, class_id: cell.class_id, title: `${classById.get(cell.class_id) || '未知班级'} · 固定课程`, weekday: cwd, period, done });
    }
  }
  for (const e of events) {
    if (e.date === date) todos.push({ kind: 'task', event_id: e.id, title: `${e.title}`, weekday: wd, period: 99, time: e.time || '', done: !!e.done });
  }
  todos.sort((a, b) => (a.period - b.period) || (a.kind === 'task' ? 1 : -1));
  ok(res, { todos, week: w });
});

// ---------- 素养推送（F3/C2：按日期键控 + 无重复 + 类别轮转） ----------
const CATEGORY_CN = {
  education_proverb: '教育古语', classic_poetry: '古典诗词', education_philosophy: '国内外教育理念',
  education_theory: '教育学理论', education_psychology: '教育心理学',
};
const CAT_ORDER = ['education_proverb', 'classic_poetry', 'education_philosophy', 'education_theory', 'education_psychology'];

function pushState(sid) {
  const s = readJSON(P.sid(sid, 'push_state.json'), { by_date: {}, pushed_ids: [], round: 1, updated_at: null });
  return s;
}
function savePushState(sid, s) { writeJSON(P.sid(sid, 'push_state.json'), s); }

function pickEntry(sid, state, excludeId) {
  const items = ((readJSON(P.culture, {}) || {}).data || {}).items || [];
  const usable = items.filter((it) => !state.pushed_ids.includes(it.id) && it.id !== excludeId);
  if (usable.length === 0) return null;
  // 类别轮转：取"类内已推送数最少"的类别（等价五类循环；内容库规范 §4.5）
  // 注意：按"已推送数"选类，而非"剩余数"——保证五类交替推进
  const pushedByCat = {};
  for (const it of items) {
    if (state.pushed_ids.includes(it.id)) pushedByCat[it.category] = (pushedByCat[it.category] || 0) + 1;
  }
  let bestCat = null;
  let bestN = Infinity;
  for (const c of CAT_ORDER) {
    if (!usable.some((it) => it.category === c)) continue; // 该类已推完
    const n = pushedByCat[c] || 0;
    if (n < bestN) { bestN = n; bestCat = c; }
  }
  if (!bestCat) return null;
  const pool = usable.filter((it) => it.category === bestCat);
  const entry = pool[Math.floor(Math.random() * pool.length)];
  return entry;
}

app.get('/api/calendar/:sid/push/today', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const date = todayISO();
  let state = pushState(sid);
  let entry = null;
  const byDateId = state.by_date ? state.by_date[date] : null; // 旧数据可能缺 by_date，防御
  if (byDateId) {
    entry = ((readJSON(P.culture, {}) || {}).data || {}).items.find((it) => it.id === byDateId) || null;
  }
  if (!entry) {
    entry = pickEntry(sid, state, null);
    if (entry) {
      state.by_date[date] = entry.id;
      state.pushed_ids.push(entry.id);
      savePushState(sid, state);
    }
  }
  if (!entry) return ok(res, { entry: null, exhausted: true, round: state.round, count: state.pushed_ids.length });
  ok(res, {
    entry: { ...entry, category_cn: CATEGORY_CN[entry.category] || entry.category },
    exhausted: false, round: state.round, count: state.pushed_ids.length,
  });
});

app.post('/api/calendar/:sid/push/refresh', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const date = todayISO();
  let state = pushState(sid);
  const currentId = state.by_date[date] || null;
  const entry = pickEntry(sid, state, currentId);
  if (!entry) {
    // 词库耗尽 → 重置进入第二轮（C2 §4.6）
    state.pushed_ids = [];
    state.round += 1;
    savePushState(sid, state);
    return ok(res, { entry: null, exhausted: true, round: state.round, count: 0 });
  }
  // 被换下的原词条一并计入已推送（严格无重复）
  if (currentId && !state.pushed_ids.includes(currentId)) state.pushed_ids.push(currentId);
  state.by_date[date] = entry.id;
  state.pushed_ids.push(entry.id);
  savePushState(sid, state);
  ok(res, {
    entry: { ...entry, category_cn: CATEGORY_CN[entry.category] || entry.category },
    exhausted: false, round: state.round, count: state.pushed_ids.length,
  });
});

// ---------- 临时调课（R4） ----------
app.post('/api/calendar/:sid/temp-changes', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { class_id, week, origin_weekday, origin_period, new_weekday, new_period, note } = req.body || {};
  if (!class_id || !(week >= 1) || !origin_weekday || !new_weekday) return fail(res, 400, '参数不完整');
  const item = { id: genId('tc'), class_id, week, origin_weekday, origin_period, new_weekday, new_period, note: note || '' };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'temporary_change', entity_id: item.id, semester_id: sid,
    snapshot_before: null, snapshot_after: item, ts: new Date().toISOString(),
  });
  const list = loadCollection(sid, 'temporary_changes.json');
  list.push(item);
  saveCollection(sid, 'temporary_changes.json', list);
  ok(res, { temporary_change: item });
});

app.delete('/api/calendar/:sid/temp-changes/:tid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'temporary_changes.json');
  const idx = list.findIndex((t) => t.id === req.params.tid);
  if (idx === -1) return fail(res, 404, '临时调课不存在');
  const before = list[idx];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'temporary_change', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: null, ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  saveCollection(sid, 'temporary_changes.json', list);
  ok(res, { deleted: before.id });
});

// ---------- 停课标记（R4 扩展）：标记停课 = 自动顺延；取消停课 = 自动恢复顺延（原子可撤销） ----------
/** 某班某课时位 → 内容序列定位：{slots, items, idx} 或 {error} */
function locateClassSlot(sid, class_id, week, weekday, period) {
  const semester = getSemester(sid);
  const fixed = loadCollection(sid, 'fixed_courses.json').filter((f) => f.class_id === class_id);
  if (fixed.length === 0) return { error: '该班无固定排课，无法确定课时位序列' };
  const slots = buildSlots(fixed, semesterTotalWeeks(semester));
  const contents = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id === class_id);
  const { items } = bindItems(contents, slots);
  const targetKey = `${week}-${weekday}-${period}`;
  const idx = items.findIndex((it) => {
    const s = slots[it.slotIndex];
    return `${s.week}-${s.weekday}-${s.period}` === targetKey;
  });
  return { slots, items, contents, idx };
}

/** 写回某班内容（合并保留其他班），返回合并结果 */
function saveClassContents(sid, class_id, newItems, slots, before) {
  const newContents = newItems.map((it) => {
    const orig = before.find((c) => c.id === it.id);
    if (!orig) return null;
    const slot = slots[it.slotIndex];
    return { ...orig, week: slot.week, weekday: slot.weekday, period: slot.period, updated_at: new Date().toISOString() };
  }).filter(Boolean);
  newContents.sort((a, b) => (a.seq_index ?? 0) - (b.seq_index ?? 0));
  const others = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id !== class_id);
  saveCollection(sid, 'teaching_content.json', [...others, ...newContents]);
  return newContents;
}

app.post('/api/calendar/:sid/suspensions', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { class_id, week, weekday, period, note } = req.body || {};
  if (!class_id || !(week >= 1) || ![1, 2, 3, 4, 5, 6, 7].includes(weekday) || !(period >= 1)) {
    return fail(res, 400, 'class_id/week/weekday(1-7)/period 必填');
  }
  const list = loadCollection(sid, 'suspensions.json');
  if (list.some((s) => s.class_id === class_id && s.week === week && s.weekday === weekday && s.period === period)) {
    return fail(res, 409, '该课时位已标记停课');
  }
  const loc = locateClassSlot(sid, class_id, week, weekday, period);
  if (loc.error) return fail(res, 400, loc.error);
  // 自动顺延（原子：顺延失败 → 标记不建）
  let contentsAfter = null;
  if (loc.idx !== -1) {
    const r = deferContent(loc.slots, loc.items, loc.idx);
    if (!r.ok) return fail(res, 409, r.reason);
    contentsAfter = saveClassContents(sid, class_id, r.items, loc.slots, loc.contents);
  }
  const item = { id: genId('sus'), class_id, week, weekday, period, note: note || '停课', created_at: new Date().toISOString() };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'suspension', entity_id: item.id, semester_id: sid,
    snapshot_before: null, snapshot_after: item,
    contents_before: loc.contents.map((c) => ({ ...c })),
    contents_after: contentsAfter ? contentsAfter.map((c) => ({ ...c })) : null,
    ts: new Date().toISOString(),
  });
  list.push(item);
  saveCollection(sid, 'suspensions.json', list);
  ok(res, { suspension: item, deferred: contentsAfter !== null });
});

app.delete('/api/calendar/:sid/suspensions/:sid2', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'suspensions.json');
  const idx = list.findIndex((s) => s.id === req.params.sid2);
  if (idx === -1) return fail(res, 404, '停课标记不存在');
  const before = list[idx];
  // 自动恢复顺延（取消停课 = 内容回到原位）
  const loc = locateClassSlot(sid, before.class_id, before.week, before.weekday, before.period);
  let contentsAfter = null;
  if (!loc.error) {
    // 直接按课时位定位 slotIndex（不依赖内容是否存在——顺延后该位置已空）
    const targetSlotIndex = loc.slots.findIndex((s) => `${s.week}-${s.weekday}-${s.period}` === `${before.week}-${before.weekday}-${before.period}`);
    if (targetSlotIndex >= 0) {
      const r = undeferContent(loc.slots, loc.items, targetSlotIndex);
      if (r.ok) contentsAfter = saveClassContents(sid, before.class_id, r.items, loc.slots, loc.contents);
    }
  }
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'suspension', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: null,
    contents_before: loc.contents.map((c) => ({ ...c })),
    contents_after: contentsAfter ? contentsAfter.map((c) => ({ ...c })) : null,
    ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  saveCollection(sid, 'suspensions.json', list);
  ok(res, { deleted: before.id, restored: contentsAfter !== null });
});

// ---------- 授课内容（D4）+ R3 顺延 ----------
app.post('/api/calendar/:sid/teaching-content', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { class_id, week, weekday, period, content, source, preset_id } = req.body || {};
  if (!class_id || !(week >= 1) || !content) return fail(res, 400, 'class_id/week/content 必填');
  const list = loadCollection(sid, 'teaching_content.json');
  if (list.some((c) => c.class_id === class_id && c.week === week && (c.weekday || 1) === (weekday || 1) && (c.period || 1) === (period || 1))) {
    return fail(res, 409, '该班级该周该课时位已存在内容，请用更新');
  }
  // 计算该班下一个 seq_index
  const maxSeq = list
    .filter((c) => c.class_id === class_id)
    .reduce((max, c) => Math.max(max, c.seq_index ?? -1), -1);
  const item = {
    id: genId('tc'), class_id, week, weekday: weekday || 1, period: period || 1,
    seq_index: maxSeq + 1,
    content, source: source === 'preset' ? 'preset' : 'custom', preset_id: source === 'preset' ? preset_id : undefined,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'teaching_content', entity_id: item.id, semester_id: sid,
    snapshot_before: null, snapshot_after: item, ts: new Date().toISOString(),
  });
  list.push(item);
  saveCollection(sid, 'teaching_content.json', list);
  ok(res, { teaching_content: item });
});

app.put('/api/calendar/:sid/teaching-content/:tid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'teaching_content.json');
  const idx = list.findIndex((c) => c.id === req.params.tid);
  if (idx === -1) return fail(res, 404, '授课内容不存在');
  const before = list[idx];
  const after = { ...before, ...req.body, updated_at: new Date().toISOString() };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'teaching_content', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: after, ts: new Date().toISOString(),
  });
  list[idx] = after;
  saveCollection(sid, 'teaching_content.json', list);
  ok(res, { teaching_content: after });
});

/** 批量添加/更新授课内容（G4/I1 风格）：CSV 行数组，班级名自动映射，已有课时位 upsert 覆盖 */
app.post('/api/calendar/:sid/teaching-content/batch', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const rows = req.body?.rows;
  if (!Array.isArray(rows)) return fail(res, 400, 'rows 数组必填');
  const classes = readJSON(P.classes, []);
  const classById = new Map(classes.map((c) => [c.id, c]));
  const classByName = new Map(classes.map((c) => [c.name, c.id]));
  const semester = getSemester(sid);
  const totalWeeks = semesterTotalWeeks(semester);
  const list = loadCollection(sid, 'teaching_content.json');
  const before = list.map((c) => ({ ...c })); // 全量快照（学期内容量小，undo 可整体回滚）
  const errors = [];
  const touched = []; // 本次涉及条目的 before 快照（undo 用）
  const keyOf = (c) => `${c.class_id}-${c.week}-${c.weekday || 1}-${c.period || 1}`;
  const beforeKeys = new Set(list.map(keyOf));

  rows.forEach((r, i) => {
    const rowNo = i + 2; // 含表头
    let classId = r.class_id || (r.class_name ? classByName.get(r.class_name) : null) || null;
    if (!classId) { errors.push({ row: rowNo, reason: `班级无效: ${r.class_name || r.class_id}` }); return; }
    const week = Number(r.week);
    const weekday = Number(r.weekday !== undefined ? r.weekday : 1);
    const period = Number(r.period !== undefined ? r.period : 1);
    const content = String(r.content || '').trim();
    if (!Number.isInteger(week) || week < 1 || week > totalWeeks) { errors.push({ row: rowNo, reason: `周数越界: ${r.week}（1-${totalWeeks}）` }); return; }
    if (![1, 2, 3, 4, 5, 6, 7].includes(weekday)) { errors.push({ row: rowNo, reason: `星期非法: ${r.weekday}` }); return; }
    if (!(period >= 1)) { errors.push({ row: rowNo, reason: `节次非法: ${r.period}` }); return; }
    if (!content) { errors.push({ row: rowNo, reason: '内容为空' }); return; }
    // 固定排课校验：该班该周该课时位必须有课（避免内容悬空）
    const hasSlot = loadCollection(sid, 'fixed_courses.json').some((f) => f.class_id === classId && f.weekday === weekday && f.period === period && fixedInWeek(f, week));
    if (!hasSlot) { errors.push({ row: rowNo, reason: `第${week}周周${weekday}第${period}节非 ${classById.get(classId)?.name || classId} 的固定课时` }); return; }
    // upsert：已有课时位 → 更新；否则新增
    const key = `${classId}-${week}-${weekday}-${period}`;
    const existingIdx = list.findIndex((c) => keyOf(c) === key);
    if (existingIdx >= 0) {
      const orig = list[existingIdx];
      list[existingIdx] = { ...orig, content, updated_at: new Date().toISOString() };
      touched.push({ before: orig, after: list[existingIdx] });
    } else {
      const item = { id: genId('tc'), class_id: classId, week, weekday, period, content, source: r.source === 'preset' ? 'preset' : 'custom', preset_id: r.source === 'preset' ? r.preset_id : undefined, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      list.push(item);
      touched.push({ before: null, after: item });
    }
  });
  if (touched.length > 0) {
    const settings = loadSettings();
    pushUndo(settings, {
      op: 'update', entity: 'teaching_content_batch', entity_id: sid, semester_id: sid,
      snapshot_before: before, snapshot_after: list.map((c) => ({ ...c })), ts: new Date().toISOString(),
    });
    saveCollection(sid, 'teaching_content.json', list);
  }
  ok(res, { success: touched.length, failed: errors.length, errors, touched: touched.length, beforeKeys: [...beforeKeys] });
});

/** 班级内容序列视图（预填/追加用）：该班全部课时位 + 已填内容 + 下一空闲位 */
app.get('/api/calendar/:sid/content-seq', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const classId = req.query.class_id;
  if (!classId) return fail(res, 400, 'class_id 必填');
  const semester = getSemester(sid);
  const fixed = loadCollection(sid, 'fixed_courses.json').filter((f) => f.class_id === classId);
  if (fixed.length === 0) return fail(res, 400, '该班无固定排课，无法确定课时位序列');
  const slots = buildSlots(fixed, semesterTotalWeeks(semester));
  const contents = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id === classId);
  const { items } = bindItems(contents, slots);
  // 组装：每课时位 → 内容（无内容为 null）；记录最后一个占用位
  const seq = slots.map((s, i) => {
    const it = items.find((x) => x.slotIndex === i);
    return { week: s.week, weekday: s.weekday, period: s.period, content: it ? it.content : null, id: it ? it.id : null, seq_index: it ? it.seq_index : undefined };
  });
  const lastOccupied = items.length ? items[items.length - 1].slotIndex : -1;
  const nextFree = lastOccupied + 1;
  const classInfo = readJSON(P.classes, []).find((c) => c.id === classId);
  ok(res, { class: classInfo, seq, total_slots: slots.length, occupied: items.length, next_free: nextFree < slots.length ? seq[nextFree] : null, full: nextFree >= slots.length });
});

/** 班级内容预填/追加：contents 每行一条，从该班下一空闲课时位依次分配 */
app.post('/api/calendar/:sid/content-seq/prefill', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { class_id, contents } = req.body || {};
  if (!class_id || !Array.isArray(contents) || contents.length === 0) return fail(res, 400, 'class_id 与 contents 数组必填');
  const list = contents.map((c) => String(c || '').trim()).filter(Boolean);
  if (list.length === 0) return fail(res, 400, '内容不能为空');
  const semester = getSemester(sid);
  const fixed = loadCollection(sid, 'fixed_courses.json').filter((f) => f.class_id === class_id);
  if (fixed.length === 0) return fail(res, 400, '该班无固定排课，无法确定课时位序列');
  const slots = buildSlots(fixed, semesterTotalWeeks(semester));
  const allContents = loadCollection(sid, 'teaching_content.json');
  const classContents = allContents.filter((c) => c.class_id === class_id);
  const before = classContents.map((c) => ({ ...c }));
  const { items } = bindItems(classContents, slots);
  const start = items.length ? items[items.length - 1].slotIndex + 1 : 0; // 下一空闲位
  const capacity = slots.length - start;
  const assignCount = Math.min(list.length, capacity);
  const overflow = list.length - assignCount;
  const newItems = [];
  // 计算该班现有最大 seq_index
  const maxSeq = classContents.reduce((max, c) => Math.max(max, c.seq_index ?? -1), -1);
  for (let i = 0; i < assignCount; i++) {
    const s = slots[start + i];
    newItems.push({
      id: genId('tc'), class_id, week: s.week, weekday: s.weekday, period: s.period,
      seq_index: maxSeq + 1 + i,
      content: list[i], source: 'custom', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }
  if (newItems.length > 0) {
    const others = allContents.filter((c) => c.class_id !== class_id);
    const settings = loadSettings();
    pushUndo(settings, {
      op: 'update', entity: 'teaching_content_prefill', entity_id: class_id, semester_id: sid,
      snapshot_before: before, snapshot_after: newItems, ts: new Date().toISOString(),
    });
    saveCollection(sid, 'teaching_content.json', [...others, ...classContents, ...newItems]);
  }
  ok(res, { assigned: assignCount, overflow, next_start: start + assignCount, full: start + assignCount >= slots.length });
});

// ---------- 统一课程序列（功能1：一键预填）----------
// 数据：data/<semester_id>/course_sequence.json（统一课程序列，按学段分开：middle/primary）
const SEQ_FILE = (sid) => P.sid(sid, 'course_sequence.json');
const SEQ_DEFAULT = { middle: { items: [] }, primary: { items: [] } };
const seqFor = (data, stage) => {
  // 兼容旧结构 {items:[]} 与现行 {middle:{items},primary:{items}}
  if (data && data.items) return { middle: data, primary: data };
  const m = (data && data.middle) || { items: [] };
  const pr = (data && data.primary) || { items: [] };
  return stage === 'primary' ? pr : m;
};

app.get('/api/calendar/:sid/sequence', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const data = readJSON(SEQ_FILE(sid), null) || { middle: { items: [] }, primary: { items: [] } };
  if (req.query.stage) {
    ok(res, seqFor(data, req.query.stage));
  } else {
    // 兼容：全量返回
    ok(res, data.items ? { middle: data, primary: data } : data);
  }
});

app.put('/api/calendar/:sid/sequence', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const stage = req.query.stage === 'primary' ? 'primary' : 'middle';
  const items = (req.body?.items || []).map((s) => String(s.content || s).trim()).filter(Boolean);
  const before = readJSON(SEQ_FILE(sid), null) || { middle: { items: [] }, primary: { items: [] } };
  const after = JSON.parse(JSON.stringify(before));
  after[stage] = { items: items.map((content, i) => ({ id: `seq-${i + 1}`, content })) };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'course_sequence', entity_id: sid, semester_id: sid,
    snapshot_before: before, snapshot_after: after, ts: new Date().toISOString(),
  });
  writeJSON(SEQ_FILE(sid), after);
  ok(res, after[stage]);
});

/**
 * 一键预填（覆盖式按课时序号对齐）：
 * 每个班的第 N 课时位 = 序列第 N 条（N 从 1 起），各班完全一致；序列之外的课时位保留（临时课不受影响）
 * 序列来源：显式 contents > 各班学段对应的统一序列（middle/primary）
 */
app.post('/api/calendar/:sid/sequence/apply', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const semester = getSemester(sid);
  const totalWeeks = semesterTotalWeeks(semester);
  const allFixed = loadCollection(sid, 'fixed_courses.json');
  const allContents = loadCollection(sid, 'teaching_content.json');
  const classes = readJSON(P.classes, []);
  const seqData = readJSON(SEQ_FILE(sid), null) || { middle: { items: [] }, primary: { items: [] } };
  const explicitContents = (req.body?.contents || []).map((c) => String(c || '').trim()).filter(Boolean);
  // 学段限定（初中/小学）：未指定班级时只应用到该学段有排课的班，杜绝跨学段混填
  const stageFilter = req.body?.stage === 'primary' || req.body?.stage === 'middle' ? req.body.stage : null;
  const classById = new Map(classes.map((c) => [c.id, c]));
  // 目标班：显式 class_ids > 全部有固定排课的班（可选择只取某学段）
  const classIds = Array.isArray(req.body?.class_ids) && req.body.class_ids.length > 0
    ? req.body.class_ids
    : [...new Set(allFixed.filter((f) => !stageFilter || classById.get(f.class_id)?.stage === stageFilter).map((f) => f.class_id))];
  const before = allContents.map((c) => ({ ...c }));
  let newContents = allContents.map((c) => ({ ...c }));
  const report = [];
  let totalChanged = 0;
  const keyOf = (c) => `${c.class_id}-${c.week}-${c.weekday || 1}-${c.period || 1}`;
  for (const classId of classIds) {
    const fixed = allFixed.filter((f) => f.class_id === classId);
    if (fixed.length === 0) { report.push({ class_id: classId, assigned: 0, note: '无固定排课' }); continue; }
    // 该班学段 → 对应序列
    const cls = classes.find((c) => c.id === classId);
    const stage = cls && cls.stage === 'primary' ? 'primary' : 'middle';
    let contents = explicitContents;
    if (contents.length === 0) {
      contents = (seqFor(seqData, stage).items || []).map((i) => i.content).filter(Boolean);
    }
    if (contents.length === 0) { report.push({ class_id: classId, assigned: 0, note: `${stage === 'primary' ? '小学' : '初中'}序列为空` }); continue; }
    const slots = buildSlots(fixed, totalWeeks);
    // 删除该班所有旧条目（避免旧内容残留）
    newContents = newContents.filter((c) => c.class_id !== classId);
    const fillCount = Math.min(contents.length, slots.length);
    let changed = 0;
    for (let si = 0; si < fillCount; si++) {
      const s = slots[si];
      newContents.push({
        id: genId('tc'), class_id: classId, week: s.week, weekday: s.weekday, period: s.period,
        seq_index: si, content: contents[si], source: 'custom', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      changed++;
    }
    totalChanged += changed;
    report.push({ class_id: classId, stage, assigned: fillCount, changed });
  }
  if (totalChanged > 0) {
    const settings = loadSettings();
    pushUndo(settings, {
      op: 'update', entity: 'sequence_apply', entity_id: sid, semester_id: sid,
      snapshot_before: before, snapshot_after: newContents.map((c) => ({ ...c })), ts: new Date().toISOString(),
    });
    saveCollection(sid, 'teaching_content.json', newContents);
  }
  ok(res, { report, total_assigned: totalChanged });
});

// ---------- 课程内容快照（保留最近 2 个版本） ----------
const SNAP_RECENT = (sid) => P.sid(sid, 'snapshots/snapshot-recent.json');
const SNAP_OLD   = (sid) => P.sid(sid, 'snapshots/snapshot-old.json');

app.post('/api/calendar/:sid/snapshot', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const contents = loadCollection(sid, 'teaching_content.json');
  // 将现有 recent → old
  if (exists(SNAP_RECENT(sid))) {
    writeJSON(SNAP_OLD(sid), readJSON(SNAP_RECENT(sid)));
  }
  writeJSON(SNAP_RECENT(sid), contents);
  ok(res, { created_at: new Date().toISOString(), total: contents.length });
});

app.post('/api/calendar/:sid/snapshot/restore', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const snap = readJSON(SNAP_RECENT(sid), null);
  if (!snap) return fail(res, 404, '无可用快照');
  const before = loadCollection(sid, 'teaching_content.json');
  saveCollection(sid, 'teaching_content.json', snap);
  ok(res, { restored: snap.length, previous: before.length });
});

app.get('/api/calendar/:sid/snapshot', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const recent = readJSON(SNAP_RECENT(sid), null);
  const old = readJSON(SNAP_OLD(sid), null);
  ok(res, {
    recent: recent ? { total: recent.length, created_at: recent._snap_time || null } : null,
    old: old ? { total: old.length, created_at: old._snap_time || null } : null,
  });
});

/** 拖动换课（功能3）：交换两个课时位的内容（跨班支持）；无内容的位置 = 移动；空白格 = 创建排课并放入 */
app.post('/api/calendar/:sid/content/swap', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { from, to } = req.body || {};
  if (!from || !to) return fail(res, 400, 'from/to 必填');
  const valid = (p) => p && p.class_id && p.week >= 1 && [1, 2, 3, 4, 5, 6, 7].includes(p.weekday) && p.period >= 1;
  if (!valid(from) || !valid(to)) return fail(res, 400, '课时位参数非法');
  const key = (p) => `${p.class_id}-${p.week}-${p.weekday}-${p.period}`;
  const fk = key(from), tk = key(to);
  if (fk === tk) return fail(res, 400, '不能与自身交换');
  const list = loadCollection(sid, 'teaching_content.json');
  const before = list.map((c) => ({ ...c }));
  const fixedBefore = loadCollection(sid, 'fixed_courses.json').map((c) => ({ ...c }));
  const findIdx = (k) => list.findIndex((c) => key(c) === k);
  const fi = findIdx(fk), ti = findIdx(tk);
  if (fi === -1 && ti === -1) return fail(res, 400, '两个课时位均无内容可交换');
  let fixedChanged = false;
  if (fi >= 0 && ti >= 0) {
    // 换课语义（用户确认）：内容互换，课时位归属（班级/周/节次）不变
    // 交换后：from 课时位显示 to 的内容，to 课时位显示 from 的内容，班级标签不变
    const a = { ...list[fi] }, b = { ...list[ti] };
    list[fi] = { ...a, content: b.content, source: b.source, preset_id: b.preset_id, updated_at: new Date().toISOString() };
    list[ti] = { ...b, content: a.content, source: a.source, preset_id: a.preset_id, updated_at: new Date().toISOString() };
  } else if (fi >= 0) {
    // 移动语义（用户确认）：整节课（排课+内容）搬到目标位置，源位置完全清空
    const fixedList = loadCollection(sid, 'fixed_courses.json');
    const toHasFixed = fixedList.some((f) => f.weekday === to.weekday && f.period === to.period);
    const a = { ...list[fi] };
    // 1. 内容移到目标课时位（归属改为目标班/周/节次）
    list[fi] = { ...a, class_id: toHasFixed ? to.class_id : from.class_id, week: to.week, weekday: to.weekday, period: to.period, updated_at: new Date().toISOString() };
    // 2. 目标为完全空白格 → 为该班创建排课（来源班级）
    if (!toHasFixed) {
      fixedList.push({ id: genId('fc'), class_id: from.class_id, weekday: to.weekday, period: to.period, done_dates: [] });
    }
    // 3. 删除源位置固定排课（整节课搬走，旧位置不再显示任何内容）
    const fromFixedIdx = fixedList.findIndex((f) => f.class_id === from.class_id && f.weekday === from.weekday && f.period === from.period);
    if (fromFixedIdx >= 0) {
      fixedList.splice(fromFixedIdx, 1);
      fixedChanged = true;
    }
    if (fixedChanged) saveCollection(sid, 'fixed_courses.json', fixedList);
  } else {
    const b = { ...list[ti] };
    list[ti] = { ...b, class_id: from.class_id, week: from.week, weekday: from.weekday, period: from.period, updated_at: new Date().toISOString() };
  }
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'content_swap', entity_id: sid, semester_id: sid,
    snapshot_before: before, snapshot_after: list.map((c) => ({ ...c })), ts: new Date().toISOString(),
    fixed_before: fixedBefore, fixed_after: fixedChanged ? loadCollection(sid, 'fixed_courses.json').map((c) => ({ ...c })) : undefined,
  });
  saveCollection(sid, 'teaching_content.json', list);
  ok(res, { swapped: fi >= 0 && ti >= 0, moved: fi >= 0 !== ti >= 0, fixed_changed: fixedChanged });
});

app.delete('/api/calendar/:sid/teaching-content/:tid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'teaching_content.json');
  const idx = list.findIndex((c) => c.id === req.params.tid);
  if (idx === -1) return fail(res, 404, '授课内容不存在');
  const before = list[idx];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'teaching_content', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: null, ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  saveCollection(sid, 'teaching_content.json', list);
  ok(res, { deleted: before.id });
});

/** R3 顺延：替换某班某课时位内容 → 序列链式后移（基于 seq_index，原子） */
app.post('/api/calendar/:sid/shift', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const semester = getSemester(sid);
  const { class_id, week, weekday, period, new_content } = req.body || {};
  if (!class_id || !week || !weekday || !period || !new_content) return fail(res, 400, 'class_id/week/weekday/period/new_content 必填');
  const fixed = loadCollection(sid, 'fixed_courses.json').filter((f) => f.class_id === class_id);
  if (fixed.length === 0) return fail(res, 400, '该班无固定排课，无法确定课时位序列');
  const totalWeeks = semesterTotalWeeks(semester);
  const slots = buildSlots(fixed, totalWeeks);
  const contents = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id === class_id);
  const before = contents.map((c) => ({ ...c }));
  // 用 (week, weekday, period) 直接定位要修改的内容条目（不受 holiday defer 影响）
  const targetContent = contents.find((c) => c.week === week && (c.weekday || 1) === weekday && (c.period || 1) === period);
  if (!targetContent) return fail(res, 400, '该课时位没有内容可替换');
  // 按 seq_index 排序构建序列
  const items = contents
    .map((c) => ({ seq_index: c.seq_index ?? 0, content: c.content, id: c.id }))
    .sort((a, b) => a.seq_index - b.seq_index);
  const pos = items.findIndex((it) => it.id === targetContent.id);
  if (pos === -1) return fail(res, 400, '内部错误：内容不在序列中');
  // 容量检查：该班课时位是否已满
  if (items.length >= slots.length) return fail(res, 409, '该班课时位已满，无法顺延');
  const result = shiftContent(items, new_content, pos);
  if (!result.ok) return fail(res, 409, result.reason);
  // 构建 shift 前的内容位置索引：seq_index → {week, weekday, period, slotIndex}
  // 注意：holiday defer 后 seq_index ≠ slotIndex，所以需从内容实际位置反查 slotIndex
  const slotKeyOf = (s) => `${s.week}-${s.weekday}-${s.period}`;
  const slotIndexByKey = new Map(slots.map((s, i) => [slotKeyOf(s), i]));
  const beforeInfo = new Map();
  let maxSeqBefore = 0;
  for (const c of contents) {
    const sk = slotKeyOf(c);
    const si = slotIndexByKey.get(sk);
    if (si !== undefined) {
      beforeInfo.set(c.seq_index, { week: c.week, weekday: c.weekday || 1, period: c.period || 1, slotIndex: si });
    }
    if (c.seq_index > maxSeqBefore) maxSeqBefore = c.seq_index;
  }
  // 写回：shift 后每个 seq_index 对应之前该 seq_index 的位置
  // （holiday defer 后物理位置与 seq_index 解耦，所以不能直接 slots[seq_index]）
  const newContents = [];
  for (const it of result.items) {
    const beforeItem = beforeInfo.get(it.seq_index);
    if (it.id === null) {
      // 新条目（替换内容或末尾追加）：取该 seq_index 之前的物理位置
      const pos = beforeItem || (() => {
        // lastItem 被推到新 seq_index → 找下一个空闲课时位
        const lastBefore = beforeInfo.get(maxSeqBefore);
        const nextSI = lastBefore ? lastBefore.slotIndex + 1 : it.seq_index;
        if (nextSI < slots.length) {
          const slot = slots[nextSI];
          return { week: slot.week, weekday: slot.weekday, period: slot.period };
        }
        return null;
      })();
      if (!pos) continue;
      newContents.push({
        id: genId('tc'), class_id, week: pos.week, weekday: pos.weekday, period: pos.period,
        seq_index: it.seq_index, content: it.content, source: 'custom',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
    } else {
      const orig = contents.find((c) => c.id === it.id);
      if (!orig) continue;
      // 有 id 的旧条目：查找该 seq_index 在 shift 前的位置
      // 如果 beforeItem 存在 → 用该位置（说明是原有内容被平移）
      // 如果不存在 → 是原最后一条被推到新 seq_index → 用其原位置偏移
      const pos = beforeItem || (() => {
        const origBefore = beforeInfo.get(orig.seq_index);
        const nextSI = origBefore ? origBefore.slotIndex + 1 : it.seq_index;
        if (nextSI < slots.length) {
          const slot = slots[nextSI];
          return { week: slot.week, weekday: slot.weekday, period: slot.period };
        }
        return null;
      })();
      if (!pos) continue;
      newContents.push({
        ...orig, week: pos.week, weekday: pos.weekday, period: pos.period,
        seq_index: it.seq_index, content: it.content, updated_at: new Date().toISOString(),
      });
    }
  }
  newContents.sort((a, b) => (a.seq_index ?? 0) - (b.seq_index ?? 0));
  const others = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id !== class_id);
  const merged = [...others, ...newContents];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'teaching_content_shift', entity_id: class_id, semester_id: sid,
    snapshot_before: before, snapshot_after: newContents, ts: new Date().toISOString(),
  });
  saveCollection(sid, 'teaching_content.json', merged);
  ok(res, { contents: merged });
});

/**
 * 停课顺延（R3 扩展）：某课时位因运动会/考试等停课 →
 * 该班从该课时位起的内容整体后移一位，该课时位置空（当天停课），
 * 被挤出的最后一条落入学期末尾空课时位。原子操作，可撤销。
 */
app.post('/api/calendar/:sid/defer', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const semester = getSemester(sid);
  const { class_id, week, weekday, period } = req.body || {};
  if (!class_id || !week || !weekday || !period) return fail(res, 400, 'class_id/week/weekday/period 必填');
  const fixed = loadCollection(sid, 'fixed_courses.json').filter((f) => f.class_id === class_id);
  if (fixed.length === 0) return fail(res, 400, '该班无固定排课，无法确定课时位序列');
  const totalWeeks = semesterTotalWeeks(semester);
  const slots = buildSlots(fixed, totalWeeks);
  const contents = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id === class_id);
  const before = contents.map((c) => ({ ...c }));
  const { items } = bindItems(contents, slots);
  // 定位停课课时位：目标课时位所在 slotIndex（可能为空 → 该位置本就无内容，无需顺延）
  const targetKey = `${week}-${weekday}-${period}`;
  const idx = items.findIndex((it) => {
    const s = slots[it.slotIndex];
    return `${s.week}-${s.weekday}-${s.period}` === targetKey;
  });
  if (idx === -1) return fail(res, 400, '该课时位没有内容，无需顺延');
  const result = deferContent(slots, items, idx);
  if (!result.ok) return fail(res, 409, result.reason);
  // 写回：按 id 匹配更新位置（无新增条目）
  const newContents = [];
  for (const it of result.items) {
    const orig = contents.find((c) => c.id === it.id);
    if (!orig) continue;
    const slot = slots[it.slotIndex];
    newContents.push({ ...orig, week: slot.week, weekday: slot.weekday, period: slot.period, updated_at: new Date().toISOString() });
  }
  newContents.sort((a, b) => (a.seq_index ?? 0) - (b.seq_index ?? 0));
  const others = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id !== class_id);
  const merged = [...others, ...newContents];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'teaching_content_defer', entity_id: class_id, semester_id: sid,
    snapshot_before: before, snapshot_after: newContents, ts: new Date().toISOString(),
  });
  saveCollection(sid, 'teaching_content.json', merged);
  ok(res, { contents: merged });
});

/** 取消停课顺延（defer 逆操作）：恢复被顺延空出的课时位，后续内容整体前移回原位 */
app.post('/api/calendar/:sid/undefer', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const semester = getSemester(sid);
  const { class_id, week, weekday, period } = req.body || {};
  if (!class_id || !week || !weekday || !period) return fail(res, 400, 'class_id/week/weekday/period 必填');
  const fixed = loadCollection(sid, 'fixed_courses.json').filter((f) => f.class_id === class_id);
  if (fixed.length === 0) return fail(res, 400, '该班无固定排课，无法确定课时位序列');
  const totalWeeks = semesterTotalWeeks(semester);
  const slots = buildSlots(fixed, totalWeeks);
  const contents = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id === class_id);
  const before = contents.map((c) => ({ ...c }));
  const { items } = bindItems(contents, slots);
  const targetKey = `${week}-${weekday}-${period}`;
  const slotIdx = slots.findIndex((s) => `${s.week}-${s.weekday}-${s.period}` === targetKey);
  if (slotIdx === -1) return fail(res, 400, '目标课时位不存在');
  const result = undeferContent(slots, items, slotIdx);
  if (!result.ok) return fail(res, 409, result.reason);
  const newContents = [];
  for (const it of result.items) {
    const orig = contents.find((c) => c.id === it.id);
    if (!orig) continue;
    const slot = slots[it.slotIndex];
    newContents.push({ ...orig, week: slot.week, weekday: slot.weekday, period: slot.period, updated_at: new Date().toISOString() });
  }
  newContents.sort((a, b) => (a.seq_index ?? 0) - (b.seq_index ?? 0));
  const others = loadCollection(sid, 'teaching_content.json').filter((c) => c.class_id !== class_id);
  const merged = [...others, ...newContents];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'teaching_content_defer', entity_id: class_id, semester_id: sid,
    snapshot_before: before, snapshot_after: newContents, ts: new Date().toISOString(),
  });
  saveCollection(sid, 'teaching_content.json', merged);
  ok(res, { contents: merged });
});

// ---------- 事件（D5） ----------
app.get('/api/calendar/:sid/events', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const events = loadCollection(sid, 'events.json');
  const birthdays = loadCollection(sid, 'birthdays.json');
  ok(res, { events, birthdays });
});

app.post('/api/calendar/:sid/events', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { type, title, date, time, location, participants, notes, requirements, color } = req.body || {};
  if (!['course', 'activity'].includes(type) || !title || !date) return fail(res, 400, 'type(course/activity)/title/date 必填');
  // 节次关联（个人事务可出现在指定节次，多选；空 = 全天）
  const rawPeriods = req.body?.periods;
  const periods = Array.isArray(rawPeriods)
    ? [...new Set(rawPeriods.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 30))].sort((a, b) => a - b)
    : [];
  const item = {
    id: genId('ev'), type, title, date, time: time || '', location: location || '',
    participants: participants || '', notes: notes || '', requirements: requirements || '',
    color: color || '#4A90D9', done: false,
    periods: periods.length ? periods : undefined,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'event', entity_id: item.id, semester_id: sid,
    snapshot_before: null, snapshot_after: item, ts: new Date().toISOString(),
  });
  const list = loadCollection(sid, 'events.json');
  list.push(item);
  saveCollection(sid, 'events.json', list);
  ok(res, { event: item });
});

app.put('/api/calendar/:sid/events/:eid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'events.json');
  const idx = list.findIndex((e) => e.id === req.params.eid);
  if (idx === -1) return fail(res, 404, '事件不存在');
  const before = list[idx];
  const after = { ...before, ...req.body, updated_at: new Date().toISOString() };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'update', entity: 'event', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: after, ts: new Date().toISOString(),
  });
  list[idx] = after;
  saveCollection(sid, 'events.json', list);
  ok(res, { event: after });
});

app.delete('/api/calendar/:sid/events/:eid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'events.json');
  const idx = list.findIndex((e) => e.id === req.params.eid);
  if (idx === -1) return fail(res, 404, '事件不存在');
  const before = list[idx];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'event', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: null, ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  saveCollection(sid, 'events.json', list);
  ok(res, { deleted: before.id });
});

// ---------- 生日（D6，--MM-DD 无年日期） ----------
const BD_RE = /^--\d{2}-\d{2}$/;
const isValidBD = (s) => BD_RE.test(s) && !isNaN(new Date(`2000${s.slice(1)}`));

app.post('/api/calendar/:sid/birthdays', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const { role, name, birthday, class_id, note } = req.body || {};
  if (!['teacher', 'student'].includes(role) || !name || !isValidBD(birthday || '')) {
    return fail(res, 400, 'role(teacher/student)/name/birthday(--MM-DD) 必填且格式正确');
  }
  const item = { id: genId('bd'), role, name, birthday, class_id: class_id || null, note: note || '' };
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'birthday', entity_id: item.id, semester_id: sid,
    snapshot_before: null, snapshot_after: item, ts: new Date().toISOString(),
  });
  const list = loadCollection(sid, 'birthdays.json');
  list.push(item);
  saveCollection(sid, 'birthdays.json', list);
  ok(res, { birthday: item });
});

/** 批量导入生日（I1）：逐行校验，部分失败语义 */
app.post('/api/calendar/:sid/birthdays/import', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const rows = req.body?.rows;
  if (!Array.isArray(rows)) return fail(res, 400, 'rows 数组必填');
  const list = loadCollection(sid, 'birthdays.json');
  const imported = [];
  const errors = [];
  rows.forEach((r, i) => {
    const { role, name, birthday, class_id, note } = r || {};
    if (!['teacher', 'student'].includes(role)) { errors.push({ row: i + 2, reason: `role 非法: ${role}` }); return; }
    if (!name) { errors.push({ row: i + 2, reason: '姓名为空' }); return; }
    if (!isValidBD(birthday || '')) { errors.push({ row: i + 2, reason: `生日格式非法: ${birthday}` }); return; }
    const item = { id: genId('bd'), role, name, birthday, class_id: class_id || null, note: note || '' };
    list.push(item);
    imported.push(item);
  });
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'create', entity: 'birthday_import', entity_id: sid, semester_id: sid,
    snapshot_before: [], snapshot_after: imported, ts: new Date().toISOString(),
  });
  saveCollection(sid, 'birthdays.json', list);
  ok(res, { imported, errors, success: imported.length, failed: errors.length });
});

app.delete('/api/calendar/:sid/birthdays/:bid', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const list = loadCollection(sid, 'birthdays.json');
  const idx = list.findIndex((b) => b.id === req.params.bid);
  if (idx === -1) return fail(res, 404, '生日记录不存在');
  const before = list[idx];
  const settings = loadSettings();
  pushUndo(settings, {
    op: 'delete', entity: 'birthday', entity_id: before.id, semester_id: sid,
    snapshot_before: before, snapshot_after: null, ts: new Date().toISOString(),
  });
  list.splice(idx, 1);
  saveCollection(sid, 'birthdays.json', list);
  ok(res, { deleted: before.id });
});

// ---------- 法定节假日自动顺延（节假日当天不上课 → 该课时位内容整体往后顺延，绝不取消） ----------
// 语义（与停课顺延 deferContent 同一引擎）：
// - 节假日落在某班某课时位（日期=该班固定排课对应日期）→ 该课时位内容顺延到该班下一个课时位，
//   其后内容链式后移（跨周），假期课时位置空（当日放假，格子隐藏）
// - 连续假期按块顺延：同一块内所有假期课时位的内容一次性跳跃块大小个课时位（不进位串扰）
// - 幂等：已顺延（假期课时位已空）→ 再次调用不动作；无内容 → 不动作
// - 原子：某班任一假日块顺延失败（学期末尾无后继课时位）→ 该班整次不生效（数据不丢，假期格隐藏）
// - 顺延为日历事实的自动修正，不写入撤销栈（假期是静态配置，撤销无意义；手动改内容不受影响）
function syncHolidayDefers(sid) {
  const semester = getSemester(sid);
  const holidays = (readJSON(P.holidays, {}) || {}).data?.items || [];
  if (holidays.length === 0) return { deferred: [], failed: [] };
  const totalWeeks = semesterTotalWeeks(semester);
  const monday1 = weekStart(semester.start_date);
  const fixed = loadCollection(sid, 'fixed_courses.json');
  const allContents = loadCollection(sid, 'teaching_content.json');
  // 调休补课覆盖：某周某调休日"补某星期"的课 → 该星期当天即使放假也不顺延（课在调休日补上）
  const makeupCovered = new Set();
  for (const m of loadCollection(sid, 'makeup_days.json')) {
    const w = weekIndexOf(semester, m.date);
    if (w >= 1 && Number.isInteger(m.mirror_weekday)) makeupCovered.add(`${w}-${m.mirror_weekday}`);
  }
  const byClass = new Map();
  for (const f of fixed) {
    const arr = byClass.get(f.class_id) || [];
    arr.push(f);
    byClass.set(f.class_id, arr);
  }
  const deferred = [];
  const failed = [];
  let working = allContents;
  for (const [classId, fcs] of byClass) {
    const slots = buildSlots(fcs, totalWeeks);
    const classContents = working.filter((c) => c.class_id === classId);
    const { items } = bindItems(classContents, slots);
    if (items.length === 0) continue;
    // 该班课时位中落在假期范围内的 slotIndex（升序；仅真实放假停课，节气/纪念日不顺延）
    const holidayIdx = [];
    const realHoliday = (x) => !x.kind || x.kind === 'holiday';
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (makeupCovered.has(`${s.week}-${s.weekday}`)) continue; // 该星期由调休日补上 → 不顺延
      const date = addDays(monday1, (s.week - 1) * 7 + (s.weekday - 1));
      if (holidays.some((h) => realHoliday(h) && h.start_date <= date && h.end_date >= date)) holidayIdx.push(i);
    }
    if (holidayIdx.length === 0) continue;
    // 将连续假期 slotIndex 分组为块
    const blocks = [];
    for (const h of holidayIdx) {
      const last = blocks[blocks.length - 1];
      if (last && last.end === h - 1) { last.end = h; last.size++; }
      else { blocks.push({ start: h, end: h, size: 1 }); }
    }
    let cur = items;
    let ok = true;
    const classDeferred = [];
    for (const block of blocks) {
      // 找该假日块中第一个有内容的课时位
      const idx = cur.findIndex((it) => it.slotIndex >= block.start && it.slotIndex <= block.end);
      if (idx === -1) continue; // 该块全空 → 跳过
      // 位移量 = 从第一个有内容的位置到块末的假日格数（而非整个块大小，避免跨过非假日格）
      const shiftBy = block.end - cur[idx].slotIndex + 1;
      if (shiftBy <= 0) continue; // 安全兜底
      // 容量检查
      const lastItem = cur[cur.length - 1];
      if (lastItem.slotIndex + shiftBy >= slots.length) {
        failed.push({ class_id: classId, start_slot: block.start, shift_attempt: shiftBy, reason: '学期末尾无后继课时位，整班保留不动' });
        ok = false;
        break;
      }
      // 块位移：idx 及之后所有条目的 slotIndex + shiftBy
      cur = cur.map((item, i) => {
        if (i < idx) return item;
        return { ...item, slotIndex: item.slotIndex + shiftBy };
      });
      for (let h = block.start; h <= block.end; h++) {
        classDeferred.push({ class_id: classId, week: slots[h].week, weekday: slots[h].weekday, period: slots[h].period });
      }
    }
    if (!ok) continue; // 块失败 → 整班不生效（保留原样）
    if (cur === items) continue; // 无任何变动
    const before = classContents;
    const newContents = cur.map((it) => {
      const orig = before.find((c) => c.id === it.id);
      if (!orig) return null;
      const slot = slots[it.slotIndex];
      return { ...orig, week: slot.week, weekday: slot.weekday, period: slot.period, updated_at: new Date().toISOString() };
    }).filter(Boolean);
    newContents.sort((a, b) => (a.seq_index ?? 0) - (b.seq_index ?? 0));
    const others = working.filter((c) => c.class_id !== classId);
    working = [...others, ...newContents];
    saveCollection(sid, 'teaching_content.json', working);
    deferred.push(...classDeferred);
  }
  return { deferred, failed };
}

// ---------- 周视图数据（引擎合并输出） ----------
app.get('/api/calendar/:sid/week-view', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const semester = getSemester(sid);
  const week = parseInt(req.query.week, 10);
  if (!week || week < 1 || week > semesterTotalWeeks(semester)) return fail(res, 400, `周数越界（学期共 ${semesterTotalWeeks(semester)} 周）`);
  // 法定节假日自动顺延（幂等；假期课时位内容整体后移，绝不取消）
  const holidaySync = syncHolidayDefers(sid);
  const fixed = loadCollection(sid, 'fixed_courses.json');
  const temps = loadCollection(sid, 'temporary_changes.json');
  const contents = loadCollection(sid, 'teaching_content.json');
  const birthdays = loadCollection(sid, 'birthdays.json');
  const events = loadCollection(sid, 'events.json');
  const suspensions = loadCollection(sid, 'suspensions.json').filter((s) => s.week === week);
  const holidays = (readJSON(P.holidays, {}) || {}).data?.items || [];
  const classes = readJSON(P.classes, []);
  const range = weekRange(semester, week);
  // 当周合并视图（R4）
  const merged = mergeWeekView(fixed, temps, week);
  // 停课标记（R4 扩展）：标记过的课时位当周隐藏课程（数据保留，取消标记即恢复）
  const suspendedKeys = new Set(suspensions.map((s) => `${s.weekday}-${s.period}`));
  // 法定节假日停课（D4 扩展）：仅 kind 为放假（缺省）的条目停课；
  // 二十四节气（solar）/纪念日节日（festival）仅展示、不停课、不顺延
  const realHoliday = (x) => !x.kind || x.kind === 'holiday';
  // 计算该周每天对应的日期：真实假期 → 隐藏课程；标记日 → 仅透传展示（前端渲染徽章）
  const holidayWeekdays = new Set();
  const holidayNames = {};
  for (let d = 0; d < 7; d++) {
    const dateStr = addDays(range.start, d);
    const h = holidays.find((x) => realHoliday(x) && x.start_date <= dateStr && x.end_date >= dateStr);
    if (h) {
      const wd = weekday(dateStr);
      holidayWeekdays.add(wd);
      holidayNames[wd] = h.name;
    }
  }
  // 调休日：该周调休日"补"的星期即使当天放假，其排课也保留，供调休日显示补课
  const makeupInRange = loadMakeup(sid).filter((m) => m.date >= range.start && m.date <= range.end);
  const makeupMirrorWeekdays = new Set(makeupInRange.map((m) => m.mirror_weekday));
  const holidayOff = [...merged.cells.keys()].filter((k) => {
    const wd = Number(k.split('-')[0]);
    return holidayWeekdays.has(wd) && !makeupMirrorWeekdays.has(wd);
  });
  // 当日生日（--MM-DD 匹配该周每天）
  const classById = new Map(classes.map((c) => [c.id, c]));
  const dayBirthdays = {};
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.UTC(2024, 0, 1 + d)); // 用 2024 闰年基准做 --MM-DD 匹配
  }
  // 简化：按 weekday 收集（birthday --MM-DD 需要按年匹配实际日期，这里用当年）
  const year = parseInt(range.start.slice(0, 4), 10);
  for (const b of birthdays) {
    const mmdd = b.birthday.slice(1); // 形如 "-09-01"
    const dateStr = `${year}${mmdd}`; // "2026-09-01"
    if (dateStr >= range.start && dateStr <= range.end) {
      const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay() || 7;
      (dayBirthdays[wd] = dayBirthdays[wd] || []).push(b);
    }
  }
  // 当周每天的事件（节假日当天可安排全天任务；事件 time 留空 = 全天）
  const weekEvents = events.filter((e) => e.date >= range.start && e.date <= range.end);
  const suspended = [...merged.cells.keys()].filter((k) => suspendedKeys.has(k));
  ok(res, {
    semester, week, range, total_weeks: semesterTotalWeeks(semester),
    timeline: loadTimeline(sid),
    makeup_days: loadMakeup(sid),
    merged_cells: [...merged.cells.entries()]
      .filter(([k]) => !merged.suppressed.includes(k) && !holidayOff.includes(k) && !suspended.includes(k)) // 临时调课覆盖 + 节假日停课 + 停课标记 当周隐藏
      .map(([k, v]) => ({ key: k, ...v })),
    moved: merged.moved, suppressed: merged.suppressed, holiday_off: holidayOff, holiday_names: holidayNames,
    suspended, suspensions,
    contents, birthdays: dayBirthdays, events: weekEvents,
    holidays: holidays.filter((h) => h.start_date <= range.end && h.end_date >= range.start),
    holiday_deferred: holidaySync.deferred, holiday_defer_failed: holidaySync.failed,
    classes: classes.map((c) => ({ id: c.id, name: c.name, color: c.color, stage: c.stage })),
    classById: Object.fromEntries(classes.map((c) => [c.id, c.name])),
  });
});

// ---------- 全学期视图数据（F9 全景模式 / F8 月视图共用） ----------
app.get('/api/calendar/:sid/full-view', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const semester = getSemester(sid);
  // 法定节假日自动顺延（幂等；月视图/学期视图同样保证内容顺延一致）
  syncHolidayDefers(sid);
  const fixed = loadCollection(sid, 'fixed_courses.json');
  const contents = loadCollection(sid, 'teaching_content.json');
  const birthdays = loadCollection(sid, 'birthdays.json');
  const events = loadCollection(sid, 'events.json');
  const holidays = (readJSON(P.holidays, {}) || {}).data?.items || [];
  const classes = readJSON(P.classes, []);
  ok(res, {
    semester, total_weeks: semesterTotalWeeks(semester),
    fixed_courses: fixed, contents, birthdays, events, holidays, classes,
    makeup_days: loadMakeup(sid),
  });
});

// ---------- 作息时间表（节次/休息段自由配置：名称+起止时间可增删改） ----------
function normalizeTime(t) {
  if (!t) return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hh = parseInt(m[1], 10); const mm = parseInt(m[2], 10);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 默认作息表：9 节，时间留空由教师自行填写 */
function defaultTimeline() {
  return Array.from({ length: 9 }, (_, i) => ({ kind: 'period', no: i + 1, name: `第 ${i + 1} 节`, start: '', end: '' }));
}

/** 读取作息表（文件缺失/为空 → 默认 9 节；坏行尽力容错归一） */
function loadTimeline(sid) {
  const raw = loadCollection(sid, 'periods.json');
  if (!Array.isArray(raw) || raw.length === 0) return defaultTimeline();
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const kind = r && r.kind === 'break' ? 'break' : 'period';
    let no = NaN;
    if (kind === 'period') {
      no = parseInt(r && r.no, 10);
      if (!Number.isInteger(no) || no < 1 || seen.has(no)) { let n = 1; while (seen.has(n)) n++; no = n; }
      seen.add(no);
    }
    const start = normalizeTime(String((r && r.start) || '').trim());
    const end = normalizeTime(String((r && r.end) || '').trim());
    out.push({
      kind,
      ...(kind === 'period' ? { no } : {}),
      name: String((r && r.name) || '').trim() || (kind === 'period' ? `第 ${no} 节` : '休息'),
      start: start === null ? '' : start,
      end: end === null ? '' : end,
    });
  }
  return out;
}

app.get('/api/calendar/:sid/periods', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  ok(res, { periods: loadTimeline(sid) });
});

app.put('/api/calendar/:sid/periods', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const raw = req.body && req.body.periods;
  if (!Array.isArray(raw) || raw.length === 0) return fail(res, 400, 'periods 必须是非空数组');
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const kind = r.kind === 'break' ? 'break' : 'period';
    const name = String(r.name || '').trim();
    if (!name) return fail(res, 400, `第 ${i + 1} 行：名称不能为空`);
    const start = normalizeTime(String(r.start || '').trim());
    const end = normalizeTime(String(r.end || '').trim());
    if (start === null || end === null) return fail(res, 400, `第 ${i + 1} 行：时间格式应为 HH:MM（如 08:30）`);
    if (kind === 'period') {
      const no = parseInt(r.no, 10);
      if (!Number.isInteger(no) || no < 1) return fail(res, 400, `第 ${i + 1} 行：节次序号必须为正整数`);
      if (seen.has(no)) return fail(res, 400, `第 ${i + 1} 行：节次序号 ${no} 重复`);
      seen.add(no);
      out.push({ kind, no, name, start, end });
    } else {
      out.push({ kind, name, start, end });
    }
  }
  saveCollection(sid, 'periods.json', out);
  ok(res, { periods: out });
});

// ---------- 调休补课（makeup days：某日期补上指定星期的课，周视图按镜像星期展示排课） ----------
function loadMakeup(sid) {
  return loadCollection(sid, 'makeup_days.json');
}

app.get('/api/calendar/:sid/makeup-days', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  ok(res, { makeup_days: loadMakeup(sid) });
});

app.put('/api/calendar/:sid/makeup-days', (req, res) => {
  const sid = sidGuard(res, req.params.sid); if (!sid) return;
  const raw = req.body && req.body.makeup_days;
  if (!Array.isArray(raw)) return fail(res, 400, 'makeup_days 必须是数组（可为空）');
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const date = String(r.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      return fail(res, 400, `第 ${i + 1} 行：日期格式应为 YYYY-MM-DD（如 2026-09-20）`);
    }
    if (seen.has(date)) return fail(res, 400, `第 ${i + 1} 行：日期 ${date} 重复`);
    seen.add(date);
    const mirror = parseInt(r.mirror_weekday, 10);
    if (!Number.isInteger(mirror) || mirror < 1 || mirror > 7) {
      return fail(res, 400, `第 ${i + 1} 行：补课星期必须为 1-7（周一~周日）`);
    }
    out.push({ date, mirror_weekday: mirror, note: String(r.note || '').trim().slice(0, 50) });
  }
  saveCollection(sid, 'makeup_days.json', out);
  ok(res, { makeup_days: out });
});

// ---------- 设置与撤销（D9/G3/R5） ----------
app.get('/api/calendar/settings', (req, res) => ok(res, { settings: loadSettings() }));
app.put('/api/calendar/settings', (req, res) => {
  const s = loadSettings();
  const { current_semester_id, preferred_view, theme_id } = req.body || {};
  if (current_semester_id !== undefined && !getSemester(current_semester_id)) return fail(res, 400, '当前学期不存在');
  const after = {
    ...s,
    current_semester_id: current_semester_id !== undefined ? current_semester_id : s.current_semester_id,
    preferred_view: preferred_view !== undefined ? preferred_view : s.preferred_view,
    theme_id: theme_id !== undefined ? theme_id : s.theme_id,
    updated_at: new Date().toISOString(),
  };
  saveSettings(after);
  ok(res, { settings: after });
});

/** 撤销/重做（R5）：通用快照回放 */
function applySnapshot(entity, semesterId, snapshot, entityId, mode, entry) {
  if (entity === 'course_sequence') {
    writeJSON(SEQ_FILE(semesterId), snapshot);
    return;
  }
  switch (entity) {
    case 'semester': {
      const list = listSemesters();
      if (snapshot === null) { saveSemesters(list.filter((s) => s.id !== entityId)); return; }
      const idx = list.findIndex((s) => s.id === snapshot.id);
      if (idx === -1) list.push(snapshot); else list[idx] = snapshot;
      saveSemesters(list);
      return;
    }
    case 'class': {
      const list = readJSON(P.classes, []);
      if (snapshot === null) { writeJSON(P.classes, list.filter((c) => c.id !== entityId)); return; }
      const idx = list.findIndex((c) => c.id === snapshot.id);
      if (idx === -1) list.push(snapshot); else list[idx] = snapshot;
      writeJSON(P.classes, list);
      return;
    }
    default: {
      if (!semesterId) return;
      const fileMap = {
        fixed_course: 'fixed_courses.json', temporary_change: 'temporary_changes.json',
        suspension: 'suspensions.json',
        teaching_content: 'teaching_content.json', teaching_content_shift: 'teaching_content.json',
        teaching_content_defer: 'teaching_content.json',
        teaching_content_batch: 'teaching_content.json', teaching_content_prefill: 'teaching_content.json',
        sequence_apply: 'teaching_content.json', content_swap: 'teaching_content.json',
        event: 'events.json', birthday: 'birthdays.json', birthday_import: 'birthdays.json',
      };
      const file = fileMap[entity];
      if (!file) return;
      let list = loadCollection(semesterId, file);
      if (Array.isArray(snapshot)) { // 批量（shift / import / batch）
        if (entity === 'teaching_content_shift' || entity === 'teaching_content_defer') {
          // 只替换该班条目，保留其他班级（undo/redo 顺延/停课不误删其他班）
          const classId = entityId;
          const others = list.filter((x) => x.class_id !== classId);
          list = [...others, ...snapshot];
        } else if (entity === 'birthday_import') {
          // undo 导入 = 移除导入的条目；redo 导入 = 重新加入
          const ids = new Set(snapshot.map((x) => x.id));
          if (mode === 'undo') list = list.filter((x) => !ids.has(x.id));
          else list = [...list, ...snapshot];
        } else if (entity === 'teaching_content_batch') {
          // 快照为全量 teaching_content（before/after），整体回滚/重放
          list = snapshot;
        } else if (entity === 'sequence_apply' || entity === 'content_swap') {
          // 快照为全量 teaching_content，整体回滚/重放
          list = snapshot;
          // content_swap 若创建了空白格排课 → 同步回滚 fixed_courses
          if (entity === 'content_swap' && entry && entry.fixed_before && entry.fixed_after) {
            const fixed = mode === 'undo' ? entry.fixed_before : entry.fixed_after;
            saveCollection(semesterId, 'fixed_courses.json', fixed.map((c) => ({ ...c })));
          }
        } else if (entity === 'teaching_content_prefill') {
          // undo：恢复预填前该班内容（snapshot = before）；redo：重新加入新条目（snapshot = newItems）
          const classId = entityId;
          if (mode === 'undo') {
            const others = list.filter((x) => x.class_id !== classId);
            list = [...others, ...snapshot];
          } else {
            list = [...list, ...snapshot];
          }
        } else {
          list = snapshot;
        }
      } else if (entity === 'suspension') {
        // 停课标记 undo/redo：同时回滚/重放该班内容顺延（contents_before/contents_after）
        const classId = entry && (entry.snapshot_before || entry.snapshot_after) ? (entry.snapshot_before || entry.snapshot_after).class_id : null;
        if (mode === 'undo') {
          // 撤销：create → 删标记 + 恢复顺延前内容；delete → 恢复标记 + 恢复顺延后内容
          if (snapshot === null) {
            list = list.filter((x) => x.id !== entityId);
          } else {
            const idx = list.findIndex((x) => x.id === snapshot.id);
            if (idx === -1) list.push(snapshot); else list[idx] = snapshot;
          }
          if (classId && entry.contents_before) {
            const tc = loadCollection(semesterId, 'teaching_content.json');
            const others = tc.filter((x) => x.class_id !== classId);
            saveCollection(semesterId, 'teaching_content.json', [...others, ...entry.contents_before.map((c) => ({ ...c }))]);
          }
        } else {
          // 重做：create → 恢复标记 + 重放顺延后内容；delete → 删标记 + 恢复顺延前内容
          if (snapshot === null) {
            list = list.filter((x) => x.id !== entityId);
          } else {
            const idx = list.findIndex((x) => x.id === snapshot.id);
            if (idx === -1) list.push(snapshot); else list[idx] = snapshot;
          }
          if (classId && entry.contents_after) {
            const tc = loadCollection(semesterId, 'teaching_content.json');
            const others = tc.filter((x) => x.class_id !== classId);
            saveCollection(semesterId, 'teaching_content.json', [...others, ...entry.contents_after.map((c) => ({ ...c }))]);
          }
        }
        saveCollection(semesterId, file, list);
      } else if (snapshot === null) {
        list = list.filter((x) => x.id !== entityId);
      } else {
        const idx = list.findIndex((x) => x.id === snapshot.id);
        if (idx === -1) list.push(snapshot); else list[idx] = snapshot;
      }
      saveCollection(semesterId, file, list);
    }
  }
}

app.post('/api/calendar/undo', (req, res) => {
  const settings = loadSettings();
  const sid = req.body?.current_semester_id || settings.current_semester_id;
  const r = undo(settings, sid);
  if (!r.ok) return fail(res, 409, r.reason);
  applySnapshot(r.entry.entity, r.entry.semester_id, r.entry.snapshot_before, r.entry.entity_id, 'undo', r.entry);
  ok(res, { entry: r.entry, settings: loadSettings() });
});

app.post('/api/calendar/redo', (req, res) => {
  const settings = loadSettings();
  const sid = req.body?.current_semester_id || settings.current_semester_id;
  const r = redo(settings, sid);
  if (!r.ok) return fail(res, 409, r.reason);
  applySnapshot(r.entry.entity, r.entry.semester_id, r.entry.snapshot_after, r.entry.entity_id, 'redo', r.entry);
  ok(res, { entry: r.entry, settings: loadSettings() });
});

// ---------- 静态服务（生产模式） ----------
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  // 带内容 hash 的构建产物可永久缓存：文件名变了，浏览器自然拉到新版本。
  app.use('/assets', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  });
  app.use(express.static(distDir));
  // 兼容 base=/calendar/ 构建（DSH apps-proxy 下资源路径为 /calendar/assets/...）：直接访问 8787 首页也能正确加载资源
  app.use('/calendar', express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(PORT, HOST, () => {
  const ip = Object.values(networkInterfaces()).flat()
    .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address || '127.0.0.1';
  console.log(`[teacher-calendar] 服务已启动`);
  console.log(`  本机访问：     http://127.0.0.1:${PORT}`);
  console.log(`  局域网访问：   http://${ip}:${PORT}`);
  console.log(`  端口环境变量： PORT=${PORT}（可自定义端口）`);
});
