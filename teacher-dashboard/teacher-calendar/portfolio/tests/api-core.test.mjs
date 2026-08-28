// L2 接口测试（M0/M1：设置 / 班级 / 学生）——spawn 独立端口 + 隔离数据目录
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}/api/portfolio`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-api-test-'));

let server;
let started = false;

beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), TC_DATA_DIR: TMP },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) { started = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!started) throw new Error('测试服务器启动失败');
}, 20000);

afterAll(() => { server?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (method, p, body, headers) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

describe('设置（I-01~I-06）', () => {
  it('默认设置', async () => {
    const d = await api('GET', '/settings');
    expect(d.settings.title).toBe('梁老师的学生成长档案');
    expect(d.settings.teacher_name).toBe('梁老师');
  });
  it('合法更新并持久化', async () => {
    const d = await api('PUT', '/settings', { title: '测试工作台', theme_id: 'art', stage_filter: 'middle' });
    expect(d.settings.title).toBe('测试工作台');
    expect(d.settings.theme_id).toBe('art');
    const d2 = await api('GET', '/settings');
    expect(d2.settings.title).toBe('测试工作台');
  });
  it('非法 theme_id → 400', async () => {
    const d = await api('PUT', '/settings', { theme_id: 'neon' });
    expect(d.ok).toBe(false);
  });
  it('空 title → 400', async () => {
    const d = await api('PUT', '/settings', { title: '  ' });
    expect(d.ok).toBe(false);
  });
  it('日历连通测试：不可达 → reachable=false', async () => {
    const d = await api('POST', '/calendar/test', { calendar_api_base: 'http://127.0.0.1:9' });
    expect(d.ok).toBe(true);
    expect(d.reachable).toBe(false);
  });
});

describe('班级（I-07~I-14）', () => {
  let cid;
  it('创建主班/代课班', async () => {
    const h = await api('POST', '/classes', { name: '初一(5)班', grade: '初一', stage: 'middle', role: 'homeroom' });
    expect(h.ok).toBe(true);
    expect(h.class.role).toBe('homeroom');
    cid = h.class.id;
    const s = await api('POST', '/classes', { name: '四(1)班', grade: '四年级', stage: 'primary', role: 'subject' });
    expect(s.ok).toBe(true);
  });
  it('重名 409', async () => {
    const d = await api('POST', '/classes', { name: '初一(5)班', grade: '初一', stage: 'middle', role: 'homeroom' });
    expect(d.ok).toBe(false);
  });
  it('非法 stage/role → 400', async () => {
    expect((await api('POST', '/classes', { name: 'x', grade: 'x', stage: 'college', role: 'homeroom' })).ok).toBe(false);
    expect((await api('POST', '/classes', { name: 'y', grade: 'y', stage: 'middle', role: 'boss' })).ok).toBe(false);
  });
  it('学段/板块筛选', async () => {
    const all = await api('GET', '/classes');
    expect(all.total).toBe(2);
    const middle = await api('GET', '/classes?stage=middle&role=homeroom');
    expect(middle.total).toBe(1);
    expect(middle.classes[0].name).toBe('初一(5)班');
    const primary = await api('GET', '/classes?stage=primary');
    expect(primary.total).toBe(1);
  });
  it('改名 + 重名 409', async () => {
    expect((await api('PUT', `/classes/${cid}`, { name: '初一(6)班' })).ok).toBe(true);
    expect((await api('PUT', `/classes/${cid}`, { name: '四(1)班' })).ok).toBe(false);
  });
  it('主班改代课需确认参数', async () => {
    const d = await api('PUT', `/classes/${cid}`, { role: 'subject' });
    expect(d.ok).toBe(false);
    const d2 = await api('PUT', `/classes/${cid}`, { role: 'subject', confirm_role_change: true });
    expect(d2.ok).toBe(true);
  });
  it('删除班级需 confirm_name 一致', async () => {
    const d = await api('DELETE', `/classes/${cid}`, { confirm_name: '错误名字' });
    expect(d.ok).toBe(false);
    const d2 = await api('DELETE', `/classes/${cid}`, { confirm_name: '初一(6)班' });
    expect(d2.ok).toBe(true);
  });
});

describe('学生（I-15~I-26）', () => {
  let cid, sid, scid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '测试主班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    scid = (await api('POST', '/classes', { name: '测试代课班', grade: '四年级', stage: 'primary', role: 'subject' })).class.id;
  });

  it('创建主班学生全字段：加密落库', async () => {
    const d = await api('POST', `/classes/${cid}/students`, {
      name: '李想', student_no: '20260101', gender: '男', birth_date: '2011-09-01',
      school_id: 'G001', id_card: '420111201109011234', address: '湖北省武汉市',
      parent1_name: '李建国', parent1_phone: '13800005678', special_note: '单亲', allergy_note: '青霉素过敏',
      is_boarding: 1, pressure_level: '中',
    });
    expect(d.ok).toBe(true);
    sid = d.student.id;
    expect(d.student.id_card).toBe('420111201109011234'); // 创建响应明文
    // 库中密文
    const fs2 = await import('node:fs');
    const raw = fs2.readFileSync(path.join(TMP, 'student-portfolio.db'), 'utf8');
    expect(raw.includes('420111201109011234')).toBe(false);
  });

  it('列表脱敏：身份证/电话打码、特批字段🔒', async () => {
    const d = await api('GET', `/classes/${cid}/students`);
    const s = d.students.find((x) => x.id === sid);
    expect(s.id_card).toBe('420****1234');
    expect(s.parent1_phone).toBe('138****5678');
    expect(s.parent1_name).toBe('李**');
    expect(s.special_note).toBe('🔒');
    expect(s.allergy_note).toBe('🔒');
  });

  it('详情明文', async () => {
    const d = await api('GET', `/students/${sid}`);
    expect(d.student.id_card).toBe('420111201109011234');
    expect(d.student.special_note).toBe('单亲');
    expect(d.class.role).toBe('homeroom');
  });

  it('代课班提交敏感字段 → 忽略 + warnings', async () => {
    const d = await api('POST', `/classes/${scid}/students`, {
      name: '王小宝', student_no: '40101', id_card: '420111201509011234', special_note: 'x', subject_note: '课堂积极',
    });
    expect(d.ok).toBe(true);
    expect(d.warnings.length).toBeGreaterThan(0);
    expect(d.student.id_card).toBe('');
    expect(d.student.subject_note).toBe('课堂积极');
  });

  it('学号重复 409', async () => {
    const d = await api('POST', `/classes/${cid}/students`, { name: '李想2', student_no: '20260101' });
    expect(d.ok).toBe(false);
  });

  it('非法 gender / 未来出生日期 → 400', async () => {
    expect((await api('POST', `/classes/${cid}/students`, { name: 'x', gender: 'X' })).ok).toBe(false);
    expect((await api('POST', `/classes/${cid}/students`, { name: 'y', birth_date: '2999-01-01' })).ok).toBe(false);
  });

  it('批量导入：43 成功 2 失败（含重复与缺名）', async () => {
    const rows = [];
    for (let i = 1; i <= 45; i++) rows.push({ name: `学生${i}`, student_no: `S${String(i).padStart(3, '0')}`, gender: i % 2 ? '男' : '女' });
    rows[10] = { name: '李想', student_no: '20260101' }; // 重复学号
    rows[20] = { name: '', student_no: 'SXXX' };         // 缺名
    const d = await api('POST', `/classes/${cid}/students/import`, { rows });
    expect(d.imported).toBe(43);
    expect(d.failed).toBe(2);
    expect(d.errors.some((e) => e.reason.includes('重复'))).toBe(true);
    expect(d.errors.some((e) => e.reason.includes('name'))).toBe(true);
  });

  it('导出 masked=1 脱敏', async () => {
    const r = await fetch(`${BASE}/classes/${cid}/students/export?masked=1`);
    const csv = await r.text();
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(csv).toContain('420****1234');
    expect(csv).not.toContain('420111201109011234');
  });

  it('明文导出缺确认头 → 400', async () => {
    const d = await api('GET', `/classes/${cid}/students/export?masked=0`);
    expect(d.ok).toBe(false);
  });

  it('单生档案导出 Markdown', async () => {
    const r = await fetch(`${BASE}/students/export/archive/${sid}`);
    const md = await r.text();
    expect(r.headers.get('content-type')).toContain('text/markdown');
    expect(md).toContain('李想');
    expect(md).toContain('420****1234'); // 默认脱敏
  });

  it('更新学生：改压力等级与姓名', async () => {
    const d = await api('PUT', `/students/${sid}`, { pressure_level: '高', goal_note: '重点高中' });
    expect(d.ok).toBe(true);
    expect(d.student.pressure_level).toBe('高');
    expect(d.student.goal_note).toBe('重点高中');
  });

  it('撤销链：update → import → create（栈序逆回放）', async () => {
    // 栈序：create 李想 → create 王小宝(代课) → import 43 行 → update 李想
    const u1 = await api('POST', '/undo'); // update 回滚
    expect(u1.entry.entity).toBe('student');
    const d1 = await api('GET', `/students/${sid}`);
    expect(d1.student.pressure_level).toBe('中'); // 恢复原值

    const u2 = await api('POST', '/undo'); // import 移除
    expect(u2.entry.entity).toBe('student_import');
    const list2 = await api('GET', `/classes/${cid}/students`);
    expect(list2.students.some((s) => s.student_no.startsWith('S0'))).toBe(false);

    const u3 = await api('POST', '/undo'); // create 王小宝（代课班）删除
    expect(u3.entry.entity).toBe('student');
    const list3 = await api('GET', `/classes/${scid}/students`);
    expect(list3.students.some((s) => s.name === '王小宝')).toBe(false);

    const u4 = await api('POST', '/undo'); // create 李想 删除
    expect(u4.entry.entity).toBe('student');
    const list4 = await api('GET', `/classes/${cid}/students?keyword=${encodeURIComponent('李想')}`);
    expect(list4.students.some((s) => s.name === '李想')).toBe(false);
  });

  it('彻底删除：须先停用 → 级联清除关联数据 → 不可恢复', async () => {
    // 准备：创建学生 + 成绩 + 德育 + 荣誉，制造关联数据
    const s = (await api('POST', `/classes/${cid}/students`, { name: '删除测试员', student_no: 'DEL01', gender: '男' })).student;
    const eid = (await api('POST', `/classes/${cid}/exams`, { name: '删除测试考', type: 'monthly', date: '2026-12-01' })).exam.id;
    await api('POST', `/exams/${eid}/scores/batch`, { rows: [{ student_id: s.id, subject: '语文', score: 90 }] });
    await api('POST', `/students/${s.id}/moral-records`, { date: '2026-12-02', category: 'conduct', content: '测试记录' });
    await api('POST', `/students/${s.id}/honors`, { title: '测试荣誉', level: 'school', date: '2026-12-03' });

    // 在册状态直接删除 → 400（安全设计：必须先停用）
    const deny = await api('DELETE', `/students/${s.id}`);
    expect(deny.ok).toBe(false);
    expect(deny.reason).toContain('停用');

    // 停用后彻底删除 → 级联计数
    await api('PUT', `/students/${s.id}`, { active: 0 });
    const d = await api('DELETE', `/students/${s.id}`);
    expect(d.ok).toBe(true);
    expect(d.cascade.exam_scores).toBe(1);
    expect(d.cascade.moral_records).toBe(1);
    expect(d.cascade.honors).toBe(1);

    // 名单与关联数据均已清除
    const list = await api('GET', `/classes/${cid}/students?active=0`);
    expect(list.students.some((x) => x.id === s.id)).toBe(false);
    const scores = await api('GET', `/exams/${eid}/scores`);
    expect(scores.scores.some((x) => x.student_id === s.id)).toBe(false);
    expect((await api('GET', `/students/${s.id}`)).ok).toBe(false);
  });
});
