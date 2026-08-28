// 集成测试：节气/纪念日（不停课）、调休补课、班级与学生档案联动
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}/api/calendar`;
const SID = '2026-autumn-1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mm-test-'));

let server;
let stub;           // 假学生档案服务器
let stubPort;
const posted = [];  // 档案侧收到的建班请求

beforeAll(async () => {
  // 假学生档案（portfolio stub），响应格式与真实接口一致（{ok:true, classes:[...]}）
  const roster = {
    ok: true,
    classes: [
      { id: 'pf-1', name: '初一(1)班', grade: '初一', stage: 'middle', role: 'subject', student_count: 30 },
      { id: 'pf-2', name: '初一(5)班·班主任', grade: '初一', stage: 'middle', role: 'homeroom', student_count: 33 },
      { id: 'pf-3', name: '四(2)班', grade: '四年级', stage: 'primary', role: 'subject', student_count: 5 },
    ],
  };
  stub = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/portfolio/classes') {
      res.end(JSON.stringify(roster));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/portfolio/classes') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b = JSON.parse(body);
        posted.push(b);
        res.end(JSON.stringify({ ok: true, class: { id: `pf-new-${posted.length}`, ...b } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, reason: 'not found' }));
  });
  await new Promise((r) => { stub.listen(0, '127.0.0.1', () => { stubPort = stub.address().port; r(); }); });

  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TC_DATA_DIR: TMP, TC_PORTFOLIO_BASE: `http://127.0.0.1:${stubPort}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/bootstrap`);
      if (r.ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
}, 25000);

afterAll(() => { server?.kill(); stub?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

/** 往临时数据目录的 holidays.json 追加条目（服务器每次请求实时读取） */
function addHolidays(items) {
  const p = path.join(TMP, '_global', 'holidays.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  d.data.items.push(...items);
  fs.writeFileSync(p, JSON.stringify(d));
}

describe('节气/纪念日标记（不停课）', () => {
  // 数据驱动：从当周 cells 里任取一个课时位反推日期，把标记/假期挂在该日期上断言
  const addDays = (d, n) => { const dt = new Date(`${d}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); };

  it('开学第一周默认无停课，且有课程格子', async () => {
    const w = await api('GET', `/${SID}/week-view?week=1`);
    expect(w.ok).toBe(true);
    expect(w.holiday_off.length).toBe(0);
    expect(w.merged_cells.length).toBeGreaterThan(0);
  });

  it('只加节气/纪念日标记：课程不隐藏，标记随 holidays 透传', async () => {
    const w0 = await api('GET', `/${SID}/week-view?week=1`);
    const [key0] = w0.merged_cells[0].key.split('-');
    const wd = Number(key0);
    const dateStr = addDays(w0.range.start, wd - 1); // 该课时位对应日期（周一=1）
    addHolidays([
      { name: '惊蛰', start_date: dateStr, end_date: dateStr, kind: 'solar' },
      { name: '九一八事变纪念日', start_date: dateStr, end_date: dateStr, kind: 'festival' },
    ]);
    const w = await api('GET', `/${SID}/week-view?week=1`);
    expect(w.ok).toBe(true);
    // 标记日不产生停课
    expect(w.holiday_off.length).toBe(0);
    expect(w.merged_cells.some((c) => c.key === w0.merged_cells[0].key)).toBe(true);
    // 标记随 holidays 列表透传（前端渲染徽章）
    const marks = w.holidays.filter((h) => h.kind && h.kind !== 'holiday');
    expect(marks.some((m) => m.name === '惊蛰' && m.kind === 'solar')).toBe(true);
    expect(marks.some((m) => m.name === '九一八事变纪念日' && m.kind === 'festival')).toBe(true);
  });

  it('真实假期（kind 缺省）仍然停课', async () => {
    const w0 = await api('GET', `/${SID}/week-view?week=1`);
    const [key0] = w0.merged_cells[0].key.split('-');
    const wd = Number(key0);
    const dateStr = addDays(w0.range.start, wd - 1);
    addHolidays([{ name: '临时放假', start_date: dateStr, end_date: dateStr }]);
    const w = await api('GET', `/${SID}/week-view?week=1`);
    expect(w.ok).toBe(true);
    expect(w.holiday_names[String(wd)]).toBe('临时放假');
    expect(w.holiday_off).toContain(w0.merged_cells[0].key);
    expect(w.merged_cells.some((c) => c.key === w0.merged_cells[0].key)).toBe(false);
  });
});

describe('调休补课（makeup-days）', () => {
  it('默认无配置', async () => {
    const d = await api('GET', `/${SID}/makeup-days`);
    expect(d.ok).toBe(true);
    expect(d.makeup_days).toEqual([]);
  });

  it('保存 roundtrip（note 归一化）且 week-view 透传', async () => {
    const body = [
      { date: '2026-09-20', mirror_weekday: 2, note: '  中秋调休·补周二课  ' },
      { date: '2026-10-10', mirror_weekday: 3, note: '' },
    ];
    const d = await api('PUT', `/${SID}/makeup-days`, { makeup_days: body });
    expect(d.ok).toBe(true);
    expect(d.makeup_days[0]).toEqual({ date: '2026-09-20', mirror_weekday: 2, note: '中秋调休·补周二课' });
    expect(d.makeup_days[1]).toEqual({ date: '2026-10-10', mirror_weekday: 3, note: '' });

    const w = await api('GET', `/${SID}/week-view?week=1`);
    expect(w.makeup_days.length).toBe(2);
  });

  it('校验拒绝：坏日期 / 补课星期越界 / 日期重复', async () => {
    const r1 = await api('PUT', `/${SID}/makeup-days`, { makeup_days: [{ date: '2026-9-20', mirror_weekday: 2 }] });
    expect(r1.ok).toBe(false);
    const r2 = await api('PUT', `/${SID}/makeup-days`, { makeup_days: [{ date: '2026-09-20', mirror_weekday: 8 }] });
    expect(r2.ok).toBe(false);
    const r3 = await api('PUT', `/${SID}/makeup-days`, { makeup_days: [
      { date: '2026-09-20', mirror_weekday: 2 }, { date: '2026-09-20', mirror_weekday: 3 },
    ] });
    expect(r3.ok).toBe(false);
    // 数据未被污染
    const g = await api('GET', `/${SID}/makeup-days`);
    expect(g.makeup_days.length).toBe(2);
  });

  it('把调休日重置为空数组', async () => {
    const d = await api('PUT', `/${SID}/makeup-days`, { makeup_days: [] });
    expect(d.ok).toBe(true);
    expect(d.makeup_days).toEqual([]);
  });
});

describe('授课内容学段隔离（一键预填/选择框不得跨学段混填）', () => {
  const contentsFile = () => path.join(TMP, SID, 'teaching_content.json');
  const readContents = () => JSON.parse(fs.readFileSync(contentsFile(), 'utf-8'));
  const stageOf = (cid) => {
    // 种子班级：cls-cy* 初中、cls-xs* 小学
    return cid.startsWith('cls-xs') ? 'primary' : 'middle';
  };

  it('预填带 stage=middle：只填初中班，小学班完全不被触碰', async () => {
    fs.writeFileSync(contentsFile(), JSON.stringify([]));
    const r = await api('POST', `/${SID}/sequence/apply`, { contents: ['初中内容甲'], stage: 'middle' });
    expect(r.ok).toBe(true);
    expect(r.report.length).toBeGreaterThan(0);
    expect(r.report.every((x) => stageOf(x.class_id) === 'middle')).toBe(true);
    const rows = readContents();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => stageOf(c.class_id) === 'middle')).toBe(true); // 没有任何小学班条目
  });

  it('预填带 stage=primary：只填小学班，初中班已有内容原样保留', async () => {
    const before = readContents();
    const r = await api('POST', `/${SID}/sequence/apply`, { contents: ['小学内容乙'], stage: 'primary' });
    expect(r.ok).toBe(true);
    expect(r.report.length).toBeGreaterThan(0);
    expect(r.report.every((x) => stageOf(x.class_id) === 'primary')).toBe(true);
    const rows = readContents();
    // 初中内容仍在（未被清除）
    const middleRows = before.filter((c) => stageOf(c.class_id) === 'middle');
    for (const m of middleRows) {
      expect(rows.some((x) => x.class_id === m.class_id && x.week === m.week && x.weekday === m.weekday && x.period === m.period && x.content === m.content)).toBe(true);
    }
    // 小学新增条目确实写入
    expect(rows.some((c) => stageOf(c.class_id) === 'primary' && c.content === '小学内容乙')).toBe(true);
  });

  it('无 stage（缺省）保持旧行为：全部有排课的班都会被填（向后兼容）', async () => {
    const r = await api('POST', `/${SID}/sequence/apply`, { contents: ['通用内容'] });
    expect(r.ok).toBe(true);
    const stages = new Set(r.report.map((x) => stageOf(x.class_id)));
    expect(stages.has('middle')).toBe(true);
    expect(stages.has('primary')).toBe(true);
  });
});

describe('个人事务节次关联（periods：默认落在指定节，可多选；空=全天）', () => {
  it('POST events 带 periods：去重排序归一化；不带 periods：全天（无字段）', async () => {
    const d = await api('POST', `/${SID}/events`, {
      type: 'activity', title: '批改作业', date: '2026-09-03', time: '08:00-08:40',
      periods: [3, 1, 3, 9], // 乱序 + 重复 + 越界
    });
    expect(d.ok).toBe(true);
    expect(d.event.periods).toEqual([1, 3, 9]);

    const d2 = await api('POST', `/${SID}/events`, { type: 'activity', title: '全天事务', date: '2026-09-03' });
    expect(d2.ok).toBe(true);
    expect(d2.event.periods).toBeUndefined();

    const d3 = await api('POST', `/${SID}/events`, { type: 'activity', title: '空数组=全天', date: '2026-09-03', periods: [] });
    expect(d3.ok).toBe(true);
    expect(d3.event.periods).toBeUndefined();
  });

  it('week-view 透传事件含 periods 供前端按节次渲染', async () => {
    const w = await api('GET', `/${SID}/week-view?week=1`);
    expect(w.ok).toBe(true);
    const evs = w.events.filter((e) => e.title === '批改作业' || e.title === '全天事务');
    expect(evs.length).toBe(2);
    const withPeriods = evs.find((e) => e.title === '批改作业');
    expect(withPeriods.periods).toEqual([1, 3, 9]);
    expect(evs.some((e) => e.title === '全天事务' && e.periods === undefined)).toBe(true);
  });
});

describe('班级与学生档案联动', () => {
  it('同步：档案班级建档/匹配、班主任班隐藏标记、日历独有班级推送', async () => {
    const r = await api('POST', '/classes/sync-portfolio');
    expect(r.ok).toBe(true);
    // 档案 初一(1)班 / 四(2)班 → 匹配种子班级并联动
    const byName = new Map((r.classes || []).map((c) => [c.name, c]));
    expect(byName.get('初一(5)班').homeroom).toBe(true);
    expect(byName.get('初一(1)班').linked_portfolio_id).toBe('pf-1');
    expect(byName.get('四(2)班').linked_portfolio_id).toBe('pf-3');
    // 日历独有班级 → 推送到档案（stub 记录请求）
    expect(posted.length).toBeGreaterThanOrEqual(5);
    const names = posted.map((b) => b.name);
    expect(names).toContain('初一(2)班');
    expect(names).toContain('四(3)班');
    expect(posted.every((b) => b.role === 'subject')).toBe(true);
    expect(posted.some((b) => b.name === '初一(5)班')).toBe(false); // 班主任班不推送
  });

  it('降级：档案不可用时同步接口返回可读错误，班级数据不受影响', async () => {
    stub.close();
    const r = await api('POST', '/classes/sync-portfolio');
    expect(r.ok).toBe(false);
    expect(String(r.reason || r.error || '')).toMatch(/学生档案|档案/);
    const b = await api('GET', '/bootstrap');
    expect(b.ok).toBe(true);
    expect(b.classes.some((c) => c.homeroom)).toBe(true); // 已联动数据仍在
  });
});