// tc CLI · 命令注册表 + handler + discover 元数据（spec §4 表格的代码化）
// 原则：CLI 只做解析/聚合/名称解析；业务规则全部由服务端裁决（intent R2）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TcError, exitCodeOf, envelopeFromError, makeApi } from './api.mjs';
import {
  parseCSV, gridToScoreRows, normalizeScoreRows, scoreRangeCheck,
  QUESTION_TYPES,
} from './csv.mjs';
import {
  resolveSemester, resolveCalendarClass, resolvePortfolioClass,
  resolveStudent, resolveExam,
} from './resolve.mjs';
import { weekIndexOf } from '../../src/engine/week.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAM_TYPES = ['placement', 'weekly', 'monthly', 'midterm', 'final', 'mock', 'subject', 'other'];
const ROLES = ['homeroom', 'subject'];
const STAGES = ['primary', 'middle'];
const BOOLEAN_FLAGS = new Set(['dry-run', 'current', 'create', 'help']);
const ALIAS = { s: 'semester', c: 'class', w: 'week' };
// 已知旗标全集（跨命令并集）：未知 --flag 直接 USAGE，防 --dryrun 拼错静默退化真实写入
const KNOWN_FLAGS = new Set([
  'semester', 'class', 'week', 'date', 'current', 'name', 'start-date', 'end-date',
  'weekday', 'period', 'rows', 'file', 'contents', 'keyword', 'role', 'stage',
  'type', 'note', 'exam-id', 'exam-name', 'create', 'csv', 'student', 'dry-run',
  'semester-name', 'semester-start', 'semester-end', 'help', 'pretty',
]);
const WEEKDAYS = new Set([1, 2, 3, 4, 5, 6, 7]);

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; // 本地时区，防 UTC 日界偏移
};
const isISODate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v));
const stripMeta = ({ _meta, ...rest }) => rest;
const intOf = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new TcError('USAGE', `${label} 须为整数，收到: ${JSON.stringify(v)}`);
  return n;
};

// ---------- 参数解析 ----------
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      if (!KNOWN_FLAGS.has(key)) throw new TcError('USAGE', `未知参数 --${key}（是否拼写有误？写命令的 --dry-run 需完整拼写）`);
      if (BOOLEAN_FLAGS.has(key)) {
        if (val !== undefined) throw new TcError('USAGE', `--${key} 为开关，不接受值`);
        flags[key] = true;
        continue;
      }
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined) throw new TcError('USAGE', `--${key} 缺少取值`);
      }
      flags[key] = val;
    } else if (a.length === 2 && a.startsWith('-') && ALIAS[a[1]]) {
      const key = ALIAS[a[1]];
      const val = argv[++i];
      if (val === undefined) throw new TcError('USAGE', `-${a[1]} 缺少取值`);
      flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

const need = (flags, keys) => {
  for (const k of keys) {
    if (flags[k] === undefined || flags[k] === '') {
      throw new TcError('USAGE', `缺少必填参数 --${k}`);
    }
  }
};

/** 写命令 dry-run 统一出口：回显将提交内容，零写入（intent R5） */
const dryOut = (method, path, body, extra = {}) =>
  ({ ok: true, dry_run: true, note: '--dry-run：未向服务端写入任何数据', would_submit: { method, path, body }, ...extra });

const oneOf = (flags, key, allowed) => {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) throw new TcError('USAGE', `--${key} 须为 ${allowed.join('/')}，收到: ${v}`);
  return v;
};

/** --week：odd/even/正整数/逗号分隔周数组（服务端会再校验一次，这里只做形态归一） */
export function parseWeekField(raw) {
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  if (s === 'odd' || s === 'even') return s;
  if (/^\d+$/.test(s)) return intOf(s, '--week');
  const parts = s.split(',');
  const arr = parts.map((x) => {
    const t = x.trim();
    if (t === '') throw new TcError('USAGE', `--week 含空段: "${raw}"（示例: 3 或 1,3,5 或 odd）`);
    return intOf(t, '--week');
  });
  if (!arr.length) throw new TcError('USAGE', `--week 非法: ${raw}`);
  return arr;
};

/** rows 来源三通道：--rows JSON / --file JSON / --csv 文件（长宽表自动识别） */
function loadScoreRows(flags) {
  const sources = ['rows', 'csv'].filter((k) => flags[k] !== undefined);
  if (sources.length === 0) throw new TcError('USAGE', "需要 --rows '<JSON>' 或 --csv '<文件路径>' 之一");
  if (flags.file && sources.length) throw new TcError('USAGE', '--file 与 --rows/--csv 不要同时使用');
  if (sources.length > 1) throw new TcError('USAGE', '--rows 与 --csv 只能二选一');

  if (flags.rows !== undefined) {
    let raw;
    try { raw = JSON.parse(flags.rows); }
    catch (e) { throw new TcError('PARSE_ERROR', `--rows 不是合法 JSON：${e.message}`); }
    const { rows, errors } = normalizeScoreRows(raw);
    return { rows, errors, source: '--rows JSON' };
  }
  const file = flags.csv;
  if (!fs.existsSync(file)) throw new TcError('PARSE_ERROR', `找不到 CSV 文件: ${file}`);
  const grid = parseCSV(fs.readFileSync(file, 'utf-8'));
  const { rows, errors } = gridToScoreRows(grid);
  return { rows, errors, source: `--csv ${path.basename(file)}` };
}

// ---------- 各命令 handler（ctx = { api, flags }） ----------
const H = {
  async discover({ api }) {
    return {
      ok: true,
      services: api.bases,
      conventions: {
        envelope: '成功 {ok:true,...}；失败 {ok:false,error:{code,message,detail?}}',
        exit_codes: '0 成功 | 2 用法错误 | 3 服务端拒绝/数据校验失败 | 4 服务不可达 | 5 名称多义需消歧',
        date_format: 'YYYY-MM-DD',
        resolution: '-s/-c 等可传 id 或中文名称（精确→包含，唯一命中即用）；多义返回 RESOLVE_AMBIGUOUS + 候选清单',
        dry_run: '全部写命令支持 --dry-run（零写入，返回将提交内容摘要）',
        writes_note: '写操作经应用 API 落库，均自动进入应用撤销栈，可在 GUI/undo 撤销（撤销端点未包装为 tc 命令：POST /api/calendar/undo {current_semester_id}）',
      },
      commands: REGISTRY.map(({ handler, ...meta }) => meta),
    };
  },

  async health({ api }) {
    const out = { ok: true, services: {}, checked_at: new Date().toISOString() };
    let allUp = true;
    for (const [app, label] of [['calendar', '教学日历'], ['portfolio', '学生档案']]) {
      const t0 = Date.now();
      try {
        const j = await api.call(app, app === 'calendar' ? '/bootstrap' : '/health');
        out.services[app] = {
          ok: true, latency_ms: Date.now() - t0, base: api.bases[app],
          ...(app === 'calendar'
            ? { semesters: j.semesters?.length, current_semester: j.semesters?.find((s) => s.id === j.settings?.current_semester_id)?.name }
            : { schema_version: j.schema_version, db: j.db }),
        };
      } catch (e) {
        allUp = false;
        out.services[app] = { ok: false, base: api.bases[app], code: e.code, message: e.message };
      }
    }
    out.ok = allUp;
    if (!allUp) {
      out.error = { code: 'SERVICE_DOWN', message: '部分后端服务不可达，详见 services 字段' };
      out.hint = '检查 systemd 服务：systemctl status teacher-calendar / student-portfolio；或用环境变量 TC_CALENDAR_API / TC_PORTFOLIO_API 覆盖地址';
    }
    return out;
  },

  async semesterList({ api }) {
    const boot = await api.call('calendar', '/bootstrap');
    return {
      ok: true,
      current_semester_id: boot.settings?.current_semester_id,
      semesters: boot.semesters,
    };
  },

  async semesterCreate({ api, flags }) {
    need(flags, ['name', 'start-date', 'end-date']);
    if (flags['dry-run']) {
      return dryOut('POST', '/api/calendar/semesters',
        { name: flags['name'], start_date: flags['start-date'], end_date: flags['end-date'] },
        { note2: '名称格式须为「年份+春季/秋季+第X学期」或「年份+寒/暑假」（服务端校验）' });
    }
    const j = await api.call('calendar', '/semesters', {
      method: 'POST',
      body: { name: flags['name'], start_date: flags['start-date'], end_date: flags['end-date'] },
    });
    return { ok: true, semester: j.semester, note: '名称格式须为「年份+春季/秋季+第X学期」或「年份+寒/暑假」（服务端校验）' };
  },

  async scheduleShow({ api, flags }) {
    const sem = await resolveSemester(api, flags.semester);
    let week;
    const notes = [];
    if (flags.week !== undefined) {
      week = intOf(flags.week, '--week');
    } else {
      const date = flags.date || todayISO();
      if (!isISODate(date)) throw new TcError('USAGE', `--date 须为 YYYY-MM-DD，收到: ${date}`);
      const wi = weekIndexOf(sem, date);
      if (wi === 0) { week = 1; notes.push(`日期 ${date} 尚未开学（${sem.start_date}），按第 1 周返回`); }
      else { week = wi; if (!flags.date && date > sem.end_date) notes.push(`今天已超出学期（${sem.end_date}），封顶于最后一周`); }
    }
    const j = await api.call('calendar', `/${sem.id}/week-view?week=${week}`);
    return { ok: true, semester: { id: sem.id, name: sem.name, _resolved: sem._resolved }, week, ...stripMeta(j), ...(notes.length ? { notes } : {}) };
  },

  async courseAdd({ api, flags }) {
    need(flags, ['semester', 'class', 'weekday', 'period']);
    const sem = await resolveSemester(api, flags.semester);
    const cls = await resolveCalendarClass(api, flags.class);
    const weekday = intOf(flags.weekday, '--weekday');
    const period = intOf(flags.period, '--period');
    if (!WEEKDAYS.has(weekday)) throw new TcError('USAGE', `--weekday 须为 1-7（周一=1），收到: ${flags.weekday}`);
    if (period < 1) throw new TcError('USAGE', `--period 须 ≥1`);
    const body = { class_id: cls.id, weekday, period };
    const week = parseWeekField(flags.week);
    if (week !== undefined) body.week = week;
    if (flags['dry-run']) return dryOut('POST', `/api/calendar/${sem.id}/fixed-courses`, body, { class: { id: cls.id, name: cls.name } });
    const j = await api.call(`calendar`, `/${sem.id}/fixed-courses`, { method: 'POST', body });
    return { ok: true, semester: { id: sem.id, name: sem.name, _resolved: sem._resolved }, class: { id: cls.id, name: cls.name, _resolved: cls._resolved }, fixed_course: j.fixed_course };
  },

  async contentBatch({ api, flags }) {
    need(flags, ['semester']);
    const sem = await resolveSemester(api, flags.semester);
    let rows;
    if (flags.rows !== undefined) {
      try { rows = JSON.parse(flags.rows); }
      catch (e) { throw new TcError('PARSE_ERROR', `--rows 不是合法 JSON：${e.message}`); }
    } else if (flags.file) {
      if (!fs.existsSync(flags.file)) throw new TcError('PARSE_ERROR', `找不到文件: ${flags.file}`);
      try { rows = JSON.parse(fs.readFileSync(flags.file, 'utf-8')); }
      catch (e) { throw new TcError('PARSE_ERROR', `--file JSON 解析失败：${e.message}`); }
    } else throw new TcError('USAGE', "需要 --rows '<JSON数组>' 或 --file '<JSON文件>'");
    if (!Array.isArray(rows) || rows.length === 0) throw new TcError('USAGE', 'rows 须为非空数组');
    if (flags['dry-run']) return dryOut('POST', `/api/calendar/${sem.id}/teaching-content/batch`, { rows }, { submitted: rows.length, sample: rows.slice(0, 5) });
    const j = await api.call('calendar', `/${sem.id}/teaching-content/batch`, { method: 'POST', body: { rows } });
    return { ok: true, semester: { id: sem.id, name: sem.name }, submitted: rows.length, ...stripMeta(j) };
  },

  async contentPrefill({ api, flags }) {
    need(flags, ['semester', 'class']);
    const sem = await resolveSemester(api, flags.semester);
    const cls = await resolveCalendarClass(api, flags.class);
    let contents;
    if (flags.contents !== undefined) {
      contents = String(flags.contents).split(';').map((x) => x.trim()).filter(Boolean);
    } else if (flags.file) {
      if (!fs.existsSync(flags.file)) throw new TcError('PARSE_ERROR', `找不到文件: ${flags.file}`);
      try { contents = JSON.parse(fs.readFileSync(flags.file, 'utf-8')); }
      catch (e) { throw new TcError('PARSE_ERROR', `--file JSON 解析失败：${e.message}`); }
    } else throw new TcError('USAGE', '需要 --contents "<a;b;c>" 或 --file <JSON字符串数组>');
    if (!Array.isArray(contents) || contents.length === 0) throw new TcError('USAGE', 'contents 为空');
    if (flags['dry-run']) return dryOut('POST', `/api/calendar/${sem.id}/content-seq/prefill`, { class_id: cls.id, contents }, { class: { id: cls.id, name: cls.name } });
    const j = await api.call('calendar', `/${sem.id}/content-seq/prefill`, {
      method: 'POST', body: { class_id: cls.id, contents },
    });
    return { ok: true, semester: { id: sem.id, name: sem.name }, class: { id: cls.id, name: cls.name }, ...stripMeta(j) };
  },

  async docxImport({ api, flags }) {
    need(flags, ['file']);
    if (!fs.existsSync(flags.file)) throw new TcError('PARSE_ERROR', `找不到 docx 文件: ${flags.file}`);
    const script = path.join(ROOT, 'scripts', 'import-docx-schedule.mjs');
    const args = [script, flags.file, `--api=${api.bases.calendar}`];
    if (flags['dry-run']) args.push('--dry-run');
    for (const [flag, key] of [['--semester-name', 'semester-name'], ['--semester-start', 'semester-start'], ['--semester-end', 'semester-end']]) {
      if (flags[key] !== undefined) args.push(`${flag}=${flags[key]}`);
    }
    const r = spawnSync(process.execPath, args, { encoding: 'utf-8', timeout: 120000 });
    const log = (r.stdout || '').split('\n').filter(Boolean);
    if (r.status !== 0) {
      const timedOut = r.signal === 'SIGTERM';
      throw new TcError(timedOut ? 'UPSTREAM_ERROR' : 'PARSE_ERROR',
        timedOut ? 'docx 导入超时（120s）' : `docx 导入失败（exit ${r.status ?? 'signal'}）：${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`,
        { log, ...(r.stderr ? { stderr: r.stderr.split('\n').filter(Boolean) } : {}) });
    }
    return { ok: true, dry_run: !!flags['dry-run'], log };
  },

  async classList({ api, flags }) {
    const role = oneOf(flags, 'role', ROLES);
    const stage = oneOf(flags, 'stage', STAGES);
    const q = new URLSearchParams();
    if (role) q.set('role', role);
    if (stage) q.set('stage', stage);
    const j = await api.call('portfolio', `/classes${q.toString() ? `?${q}` : ''}`);
    return { ok: true, classes: j.classes, total: j.total };
  },

  async studentList({ api, flags }) {
    need(flags, ['class']);
    const cls = await resolvePortfolioClass(api, flags.class);
    const q = new URLSearchParams({ page_size: '500' });
    if (flags.keyword) q.set('keyword', flags.keyword);
    const j = await api.call('portfolio', `/classes/${cls.id}/students?${q}`);
    return { ok: true, class: { id: cls.id, name: cls.name, role: cls.role, stage: cls.stage, _resolved: cls._resolved }, total: j.total, students: j.students };
  },

  async examList({ api, flags }) {
    need(flags, ['class']);
    const cls = await resolvePortfolioClass(api, flags.class);
    const type = oneOf(flags, 'type', EXAM_TYPES);
    const j = await api.call('portfolio', `/classes/${cls.id}/exams${type ? `?type=${type}` : ''}`);
    return { ok: true, class: { id: cls.id, name: cls.name, _resolved: cls._resolved }, total: j.total, exams: j.exams };
  },

  async examCreate({ api, flags }) {
    need(flags, ['class', 'name', 'type', 'date']);
    oneOf(flags, 'type', EXAM_TYPES); // 校验并给出友好提示
    if (!isISODate(flags.date)) throw new TcError('USAGE', `--date 须为 YYYY-MM-DD，收到: ${flags.date}`);
    const cls = await resolvePortfolioClass(api, flags.class);
    if (flags['dry-run']) return dryOut('POST', `/api/portfolio/classes/${cls.id}/exams`,
      { name: flags.name, type: flags.type, date: flags.date, ...(flags.note ? { note: flags.note } : {}) },
      { class: { id: cls.id, name: cls.name } });
    const j = await api.call('portfolio', `/classes/${cls.id}/exams`, {
      method: 'POST',
      body: { name: flags.name, type: flags.type, date: flags.date, ...(flags.note ? { note: flags.note } : {}) },
    });
    return { ok: true, class: { id: cls.id, name: cls.name, _resolved: cls._resolved }, exam: j.exam };
  },

  async analysisStudent({ api, flags }) {
    need(flags, ['class', 'student']);
    const cls = await resolvePortfolioClass(api, flags.class);
    const stu = await resolveStudent(api, cls, flags.student);
    const j = await api.call('portfolio', `/students/${stu.id}/analysis`);
    const out = { ok: true, class: { id: cls.id, name: cls.name }, student: { id: stu.id, name: stu.name, _resolved: stu._resolved }, analysis: j.analysis };
    if (Array.isArray(j.analysis?.trends) && j.analysis.trends.length === 0) {
      out.note = '该生仅有一次考试记录：status 标签不代表稳定趋势，建议再导入一次考试后再看进退步';
    }
    return out;
  },

  async analysisClass({ api, flags }) {
    need(flags, ['class']);
    const cls = await resolvePortfolioClass(api, flags.class);
    let examId = '';
    if (flags['exam-id']) {
      const exam = await resolveExam(api, cls, flags['exam-id']);
      examId = exam.id;
    }
    const j = await api.call('portfolio', `/classes/${cls.id}/analysis${examId ? `?exam_id=${examId}` : ''}`);
    return { ok: true, class: { id: cls.id, name: cls.name, _resolved: cls._resolved }, ...(j.analysis === null ? { reason: j.reason, analysis: null } : { analysis: j.analysis, exam: j.exam, prev_exam: j.prev_exam }) };
  },

  async gradesImport(ctx) {
    const { api, flags } = ctx;
    need(flags, ['class']);
    if (!flags['exam-id'] && !flags['exam-name']) {
      throw new TcError('USAGE', '需要 --exam-id <id> 或 --exam-name <名称>（配 --create 可自动建考）');
    }
    const cls = await resolvePortfolioClass(api, flags.class);

    // 1) 成绩行来源 + 本地规范化
    const { rows, errors: parseErrors, source } = loadScoreRows(flags);

    // 2) 学生名单索引 + 姓名/学号解析 + 范围预检（行号取解析层原始行号 _src_row，全量列出）
    const { students } = await api.call('portfolio', `/classes/${cls.id}/students?page_size=500`);
    const byName = new Map();
    const byNo = new Map();
    for (const s of students || []) {
      if (s.name) { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(s); }
      if (s.student_no) byNo.set(s.student_no, s);
    }
    const errors = [...parseErrors];
    const prepared = [];
    rows.forEach((r) => {
      const rowNo = r._src_row ?? (prepared.length + errors.length + 2);
      if (r.student_id) { prepared.push(r); return; }
      if (r.student_no) {
        const hit = byNo.get(r.student_no);
        if (!hit) { errors.push({ row: rowNo, name: r.student_no, reason: '该班不存在此学号的学生' }); return; }
        prepared.push({ student_id: hit.id, subject: r.subject, score: r.score, class_rank: r.class_rank, grade_rank: r.grade_rank, ...(r.question_scores ? { question_scores: r.question_scores } : {}) });
        return;
      }
      const hits = byName.get(r.student_name);
      if (!hits || hits.length === 0) {
        errors.push({ row: rowNo, name: r.student_name, reason: '该班不存在此姓名的学生' });
        return;
      }
      if (hits.length > 1) {
        errors.push({ row: rowNo, name: r.student_name, reason: `同名学生 ${hits.length} 人，请改用 student_id 或学号`, candidates: hits.map((s) => ({ id: s.id, student_no: s.student_no })) });
        return;
      }
      const rangeErr = scoreRangeCheck(r.subject, r.score);
      if (rangeErr) { errors.push({ row: rowNo, name: r.student_name, reason: rangeErr }); return; }
      prepared.push({ student_id: hits[0].id, subject: r.subject, score: r.score, class_rank: r.class_rank, grade_rank: r.grade_rank, ...(r.question_scores ? { question_scores: r.question_scores } : {}) });
    });
    // 补对 prepared 的范围检查（student_id 直传的行）
    for (const r of prepared) {
      if (r.student_id && r.student_name === undefined) {
        const rangeErr = scoreRangeCheck(r.subject, r.score);
        if (rangeErr) errors.push({ name: r.student_id, reason: rangeErr });
      }
    }
    if (errors.length) {
      const e = new TcError('VALIDATION', `本地预检未通过（${errors.length} 处），未向服务端提交任何数据`, { errors, source, total_rows: rows.length });
      throw e;
    }

    // 3) 定位考试；dry-run 下绝不创建（缺陷修复：--create 曾在 dry-run 泄漏写入）
    let exam;
    let wouldCreateExam = null;
    if (flags['exam-id']) {
      exam = await resolveExam(api, cls, flags['exam-id']);
    } else {
      const name = flags['exam-name'];
      const { exams } = await api.call('portfolio', `/classes/${cls.id}/exams`);
      const hit = (exams || []).find((x) => x.name === name);
      if (hit) exam = hit;
      else if (flags.create) {
        const type = oneOf(flags, 'type', EXAM_TYPES) || 'weekly';
        const date = flags.date || todayISO();
        if (!isISODate(date)) throw new TcError('USAGE', `--date 须为 YYYY-MM-DD，收到: ${date}`);
        wouldCreateExam = { name, type, date, ...(flags.note ? { note: flags.note } : {}) };
        if (!flags['dry-run']) {
          try {
            const created = await api.call('portfolio', `/classes/${cls.id}/exams`, {
              method: 'POST', body: wouldCreateExam,
            });
            exam = created.exam;
            exam._created = true;
          } catch (e) {
            if (e.httpStatus !== 409) throw e;
            // 409 视为已存在并沿用（spec §5.5 幂等语义）
            const { exams: again } = await api.call('portfolio', `/classes/${cls.id}/exams`);
            exam = (again || []).find((x) => x.name === name);
            if (!exam) throw e;
            exam._reused = true;
          }
        }
      } else {
        throw new TcError('USAGE', `该班不存在考试「${name}」。可加 --create 自动创建（可配 --type/--date/--note），或从下列现有考试中选择`, { existing_exams: (exams || []).map((x) => ({ id: x.id, name: x.name, type: x.type, date: x.date })) });
      }
    }

    // 4) dry-run：零写入
    if (flags['dry-run']) {
      return {
        ok: true, dry_run: true, source,
        class: { id: cls.id, name: cls.name, _resolved: cls._resolved },
        exam: exam ? { id: exam.id, name: exam.name, type: exam.type, date: exam.date, ...(exam._resolved ? { _resolved: exam._resolved } : {}) } : { would_create: wouldCreateExam },
        total_rows: prepared.length,
        sample: prepared.slice(0, 5),
      };
    }

    // 5) 提交（服务端整批原子：任何行非法 → 全部拒绝）
    const payload = prepared.map(({ student_name, student_no, _src_row, ...rest }) => rest);
    const res = await api.call('portfolio', `/exams/${exam.id}/scores/batch`, { method: 'POST', body: { rows: payload } });

    // 6) 回读摘要（spec §5.6：一次交互闭环）
    let summary;
    try {
      const { scores } = await api.call('portfolio', `/exams/${exam.id}/scores`);
      const bySubj = new Map();
      for (const s of scores || []) {
        if (!bySubj.has(s.subject)) bySubj.set(s.subject, { count: 0, sum: 0 });
        const b = bySubj.get(s.subject);
        b.count++; b.sum += s.score;
      }
      summary = Object.fromEntries([...bySubj.entries()].map(([k, v]) => [k, { count: v.count, avg: Math.round((v.sum / v.count) * 10) / 10 }]));
    } catch { summary = undefined; }

    return {
      ok: true,
      class: { id: cls.id, name: cls.name, _resolved: cls._resolved },
      exam: { id: exam.id, name: exam.name, type: exam.type, date: exam.date, ...(exam._created ? { created: true } : {}), ...(exam._reused ? { reused: true } : {}) },
      submitted: payload.length,
      upserted: res.upserted,
      failed: res.failed ?? 0,
      ...(res.errors?.length ? { errors: res.errors } : {}),
      ...(summary ? { summary } : {}),
    };
  },
};

// ---------- 注册表（= discover 输出来源） ----------
const REGISTRY = [
  { name: 'discover', summary: '输出全部命令能力清单（Agent 自描述入口，无需读文档）', usage: 'tc discover', writes: false },
  { name: 'health', summary: '两个后端服务连通性与摘要', usage: 'tc health', writes: false },
  { name: 'semester list', summary: '学期列表（含当前学期）', usage: 'tc semester list', writes: false },
  { name: 'semester create', summary: '创建学期', usage: 'tc semester create --name <名称> --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD>', writes: true },
  { name: 'schedule show', summary: '某周合并课表视图（固定⊕临时调课⊕节假日停课）', usage: 'tc schedule show -s <学期> [--week N | --date YYYY-MM-DD | --current]', writes: false },
  { name: 'course add', summary: '添加固定课时位', usage: 'tc course add -s <学期> -c <班级> --weekday 1-7 --period N [--week odd|even|N|N,M]', writes: true },
  { name: 'content batch', summary: '授课内容批量 upsert（rows 支持 class_name；服务端部分成功语义）', usage: 'tc content batch -s <学期> --rows <JSON数组> | --file <JSON文件>', writes: true, payload_schema: { rows: [{ class_name: '班级名称（或 class_id）', week: '周数 1起', weekday: '1-7 周一=1', period: '节次 ≥1', content: '授课内容文本' }] } },
  { name: 'content prefill', summary: '按班级下一空闲课时位顺次预填内容序列', usage: 'tc content prefill -s <学期> -c <班级> --contents "<a;b;c>" | --file <JSON数组文件>', writes: true },
  { name: 'docx import', summary: '解析教师工作手册 docx → 生成学期排课与授课内容', usage: 'tc docx import --file <x.docx> [--semester-name N --semester-start D --semester-end D] [--dry-run]', writes: true },
  { name: 'class list', summary: '档案班级列表（可按 role/stage 过滤）', usage: 'tc class list [--role homeroom|subject] [--stage primary|middle]', writes: false },
  { name: 'student list', summary: '某班学生名单', usage: 'tc student list -c <班级> [--keyword <关键词>]', writes: false },
  { name: 'exam list', summary: '某班考试列表', usage: 'tc exam list -c <班级> [--type placement|weekly|monthly|midterm|final|mock|subject|other]', writes: false },
  { name: 'exam create', summary: '创建考试', usage: 'tc exam create -c <班级> --name <名称> --type <类型> --date <YYYY-MM-DD> [--note <备注>]', writes: true },
  { name: 'grades import', summary: '成绩导入（姓名自动解析ID；本地预检全量报错；服务端整批原子；附回读摘要）', usage: 'tc grades import -c <班级> (--exam-id <id> | --exam-name <名称> [--create] [--type T] [--date D]) (--rows <JSON> | --csv <文件>) [--dry-run]', writes: true, payload_schema: { rows: [{ student_name: '学生姓名（或 student_id 二选一）', subject: '科目名，如 道法/语文/总分', score: '数值；单科 0-100，总分仅 ≥0', class_rank: '可选正整数', grade_rank: '可选正整数', question_scores: '可选对象，键限 选择/简答/材料分析/论述' }] } },
  { name: 'analysis student', summary: '学生个人进退步/波动/短板分析', usage: 'tc analysis student -c <班级> --student <姓名>', writes: false },
  { name: 'analysis class', summary: '班级学情分析（平均分/优秀率/及格率/分数段；缺省最近一次考试）', usage: 'tc analysis class -c <班级> [--exam-id <id>]', writes: false },
];

const HANDLERS = {
  'discover': H.discover, 'health': H.health,
  'semester list': H.semesterList, 'semester create': H.semesterCreate,
  'schedule show': H.scheduleShow, 'course add': H.courseAdd,
  'content batch': H.contentBatch, 'content prefill': H.contentPrefill,
  'docx import': H.docxImport,
  'class list': H.classList, 'student list': H.studentList,
  'exam list': H.examList, 'exam create': H.examCreate,
  'grades import': H.gradesImport,
  'analysis student': H.analysisStudent, 'analysis class': H.analysisClass,
};

export function usageEnvelope() {
  return {
    ok: true,
    hint: 'tc <group> <action> [options]；详情运行 tc discover；帮助：tc help [命令名]',
    commands: REGISTRY.map((c) => c.usage),
  };
}

/** 入口 dispatch：返回 { envelope, exitCode } */
export async function dispatch(argv, { api } = {}) {
  api = api || makeApi();

  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length >= 2) {
      const key = argv.slice(1).join(' ');
      const meta = REGISTRY.find((c) => c.name === key);
      if (meta) return { envelope: { ok: true, ...meta, handler_note: '参数详见 usage；发现服务请运行 tc discover' }, exitCode: 0 };
      const e = new TcError('USAGE', `未知命令: ${key}`);
      e.detail = { available: REGISTRY.map((c) => c.name) };
      return { envelope: envelopeFromError(e), exitCode: 2 };
    }
    return { envelope: usageEnvelope(), exitCode: 0 };
  }

  let key;
  if (argv.length >= 2 && HANDLERS[`${argv[0]} ${argv[1]}`]) key = `${argv[0]} ${argv[1]}`;
  else if (HANDLERS[argv[0]]) key = argv[0];
  if (!key) {
    const e = new TcError('USAGE', `未知命令: ${argv.join(' ')}`);
    e.detail = { available: REGISTRY.map((c) => c.name) };
    return { envelope: envelopeFromError(e), exitCode: exitCodeOf(e) };
  }

  let flags;
  try {
    ({ flags } = parseArgs(argv.slice(key.split(' ').length)));
    if (flags.help) return { envelope: { ok: true, ...REGISTRY.find((c) => c.name === key) }, exitCode: 0 };
    const data = await HANDLERS[key]({ api, flags });
    // handler 主动返回 ok:false（如 health 部分宕机）→ 退出码按其 error.code 映射
    const exitCode = data.ok === false && data.error ? exitCodeOf({ code: data.error.code }) : 0;
    return { envelope: { command: key, ...data }, exitCode };
  } catch (err) {
    if (err instanceof TcError) return { envelope: envelopeFromError(err), exitCode: exitCodeOf(err) };
    return {
      envelope: envelopeFromError(new TcError('UPSTREAM_ERROR', `内部错误：${err?.message || err}`)),
      exitCode: 3,
    };
  }
}

export { REGISTRY, QUESTION_TYPES };
