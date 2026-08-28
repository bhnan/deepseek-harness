// L2 接口测试（M2 成绩：考试 / 成绩批量 / 个人与班级分析 / 道法对比）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8800;
const BASE = `http://127.0.0.1:${PORT}/api/portfolio`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-exam-test-'));

let server, started = false;
beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), TC_DATA_DIR: TMP },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) { started = true; break; } } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!started) throw new Error('服务器启动失败');
}, 20000);
afterAll(() => { server?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

describe('考试管理（I-27~I-40）', () => {
  let cid, eid, e2id, sids;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '成绩测试班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    sids = [];
    for (let i = 1; i <= 5; i++) {
      sids.push((await api('POST', `/classes/${cid}/students`, { name: `学${i}`, student_no: `S${i}` })).student.id);
    }
  });

  it('创建考试 + 回显', async () => {
    const d = await api('POST', `/classes/${cid}/exams`, { name: '第一次月考', type: 'monthly', date: '2026-10-15' });
    expect(d.ok).toBe(true);
    expect(d.exam.type).toBe('monthly');
    eid = d.exam.id;
  });

  it('同班同日同名 409', async () => {
    const d = await api('POST', `/classes/${cid}/exams`, { name: '第一次月考', type: 'monthly', date: '2026-10-15' });
    expect(d.ok).toBe(false);
  });

  it('非法 type / date → 400', async () => {
    expect((await api('POST', `/classes/${cid}/exams`, { name: 'x', type: 'pop', date: '2026-10-15' })).ok).toBe(false);
    expect((await api('POST', `/classes/${cid}/exams`, { name: 'y', type: 'monthly', date: '2026-13-01' })).ok).toBe(false);
  });

  it('成绩批量 5 人 × 3 科 + 总分（I-28）', async () => {
    const rows = [];
    for (const sid of sids) {
      rows.push({ student_id: sid, subject: '语文', score: 88 });
      rows.push({ student_id: sid, subject: '数学', score: 70 });
      rows.push({ student_id: sid, subject: '道德与法治', score: 82 });
      rows.push({ student_id: sid, subject: '总分', score: 240, class_rank: 3 });
    }
    const d = await api('POST', `/exams/${eid}/scores/batch`, { rows });
    expect(d.upserted).toBe(20);
    expect(d.failed).toBe(0);
  });

  it('重复提交覆盖不重复（I-29 幂等）', async () => {
    await api('POST', `/exams/${eid}/scores/batch`, { rows: [{ student_id: sids[0], subject: '语文', score: 90 }] });
    const d = await api('GET', `/exams/${eid}/scores`);
    expect(d.scores.filter((s) => s.subject === '语文').length).toBe(5);
  });

  it('非法分数整批回滚（I-30 原子）', async () => {
    const before = await api('GET', `/exams/${eid}/scores`);
    const d = await api('POST', `/exams/${eid}/scores/batch`, {
      rows: [
        { student_id: sids[0], subject: '语文', score: 105 }, // 非法
        { student_id: sids[1], subject: '语文', score: 91 },  // 合法但整批应回滚
      ],
    });
    expect(d.upserted).toBe(0); // 整批原子：合法行也不写入
    expect(d.failed).toBe(1);
    const after = await api('GET', `/exams/${eid}/scores`);
    expect(after.scores.length).toBe(before.scores.length); // 整批回滚
  });

  it('总分不限制 0-100（I-31）', async () => {
    const d = await api('POST', `/exams/${eid}/scores/batch`, { rows: [{ student_id: sids[0], subject: '总分', score: 560 }] });
    expect(d.upserted).toBe(1);
  });

  it('student_id 不属于该考试班级 → 行级 error（I-32）', async () => {
    const other = (await api('POST', '/classes', { name: '别班', grade: '初一', stage: 'middle', role: 'subject' })).class.id;
    const osid = (await api('POST', `/classes/${other}/students`, { name: '外人' })).student.id;
    const d = await api('POST', `/exams/${eid}/scores/batch`, { rows: [{ student_id: osid, subject: '语文', score: 90 }] });
    expect(d.upserted).toBe(0);
    expect(d.failed).toBe(1);
  });

  it('题型得分存储与回读（I-33）', async () => {
    await api('POST', `/exams/${eid}/scores/batch`, { rows: [{ student_id: sids[0], subject: '道德与法治', score: 82, question_scores: { 选择: 18, 简答: 8, 材料分析: 6, 论述: 5 } }] });
    const d = await api('GET', `/exams/${eid}/scores`);
    const row = d.scores.find((s) => s.student_id === sids[0] && s.subject === '道德与法治');
    expect(row.question_scores.选择).toBe(18);
  });

  it('个人成绩列表 total 投影（I-34）', async () => {
    const d = await api('GET', `/students/${sids[0]}/scores`);
    expect(d.scores.length).toBe(4);
    const subj = d.scores.find((s) => s.subject === '语文');
    expect(subj.total).toBe(560); // 总分行投影
  });

  it('个人学情分析（I-35）', async () => {
    // 第二场考试（退步场景）
    // e1 数学：s0=60 其余 80（制造短板）
    const mathRows = [];
    for (const sid of sids) mathRows.push({ student_id: sid, subject: '数学', score: sid === sids[0] ? 60 : 80 });
    await api('POST', `/exams/${eid}/scores/batch`, { rows: mathRows });
    e2id = (await api('POST', `/classes/${cid}/exams`, { name: '第二次月考', type: 'monthly', date: '2026-11-15' })).exam.id;
    const rows = [];
    for (const sid of sids) {
      rows.push({ student_id: sid, subject: '语文', score: 85 });
      rows.push({ student_id: sid, subject: '数学', score: sid === sids[0] ? 62 : 78 });
      rows.push({ student_id: sid, subject: '总分', score: 220, class_rank: 10 });
    }
    await api('POST', `/exams/${e2id}/scores/batch`, { rows });
    const d = await api('GET', `/students/${sids[0]}/analysis`);
    expect(d.analysis.trends.length).toBe(2);
    expect(d.analysis.trends[1].delta_total).toBe(-340); // 560 → 220
    expect(d.analysis.status).toBe('down');
    expect(d.analysis.weak_points.some((w) => w.subject === '数学')).toBe(true); // 60/62 vs 班均 76/78
  });

  it('班级学情：统计与 movement（I-36/I-37）', async () => {
    const d = await api('GET', `/classes/${cid}/analysis?exam_id=${e2id}`);
    expect(d.analysis.stats.student_count).toBe(5);
    expect(d.analysis.stats.avg_total).toBeGreaterThan(0);
    expect(d.analysis.movement.down_count).toBeGreaterThan(0); // 全员 240→220 退步
    expect(d.ranking.length).toBe(5); // ranking 在响应顶层（03 文档 §5.8）
  });

  it('任意考试对比：compare_exam_id 跨类型（如 期中 vs 第二次月考）', async () => {
    // 期中（midterm 类型，与月考不同类型）
    const mid = (await api('POST', `/classes/${cid}/exams`, { name: '期中考试', type: 'midterm', date: '2026-12-20' })).exam.id;
    const rows = [];
    for (const sid of sids) rows.push({ student_id: sid, subject: '总分', score: 230, class_rank: 2 });
    await api('POST', `/exams/${mid}/scores/batch`, { rows });

    // 显式指定跨类型对比：期中 对照 第二次月考（月考）
    const d = await api('GET', `/classes/${cid}/analysis?exam_id=${mid}&compare_exam_id=${e2id}`);
    expect(d.ok).toBe(true);
    expect(d.prev_exam.id).toBe(e2id); // 任意类型对比生效
    expect(d.analysis.movement.up_count).toBeGreaterThan(0); // 全员 220→230 进步
    expect(d.analysis.movement.up_count + d.analysis.movement.down_count + d.analysis.movement.stable_count).toBeGreaterThan(0);

    // 缺省行为保持：第二次月考 自动对照 第一次月考（同类型）
    const d2 = await api('GET', `/classes/${cid}/analysis?exam_id=${e2id}`);
    expect(d2.prev_exam.id).toBe(eid);

    // 非法：对比考试=当前考试 → 400；对比考试属于其他班级 → 400
    const bad1 = await api('GET', `/classes/${cid}/analysis?exam_id=${mid}&compare_exam_id=${mid}`);
    expect(bad1.ok).toBe(false);
    const other = (await api('POST', '/classes', { name: '别班2', grade: '初一', stage: 'middle', role: 'subject' })).class.id;
    const otherExam = (await api('POST', `/classes/${other}/exams`, { name: '别班考', type: 'monthly', date: '2026-09-01' })).exam.id;
    const bad2 = await api('GET', `/classes/${cid}/analysis?exam_id=${mid}&compare_exam_id=${otherExam}`);
    expect(bad2.ok).toBe(false);
    expect(bad2.reason).toContain('不属于');
  });

  it('删除考试级联成绩；撤销恢复（I-40）', async () => {
    const d = await api('DELETE', `/exams/${eid}`);
    expect(d.ok).toBe(true);
    const after = await api('GET', `/exams/${eid}/scores`);
    expect(after.ok).toBe(false); // 考试已删
    const u = await api('POST', '/undo');
    expect(u.entry.entity).toBe('exam');
    const back = await api('GET', `/exams/${eid}/scores`);
    expect(back.scores.length).toBeGreaterThan(0); // 成绩随撤销恢复
  });
});

describe('道法多班对比（I-38/I-39）', () => {
  it('主班自动纳入对比；按最近考试对齐', async () => {
    // 主班：初一(5)班（上面已建 role=homeroom 有成绩）；代课班：无成绩班应跳过
    const d = await api('GET', '/df/compare?stage=middle');
    expect(d.ok).toBe(true);
    expect(d.compare.some((c) => c.role === 'homeroom')).toBe(true); // 主班纳入
    expect(d.compare.every((c) => c.stage === 'middle')).toBe(true);
  });

  it('学段过滤：primary 只返回小学班', async () => {
    const pcid = (await api('POST', '/classes', { name: '四(1)班', grade: '四年级', stage: 'primary', role: 'subject' })).class.id;
    const psid = (await api('POST', `/classes/${pcid}/students`, { name: '小学生' })).student.id;
    const ex = (await api('POST', `/classes/${pcid}/exams`, { name: '道法随堂', type: 'subject', date: '2026-10-20' })).exam.id;
    await api('POST', `/exams/${ex}/scores/batch`, { rows: [{ student_id: psid, subject: '道德与法治', score: 90 }] });
    const d = await api('GET', '/df/compare?stage=primary');
    expect(d.compare.every((c) => c.stage === 'primary')).toBe(true);
    expect(d.compare.length).toBeGreaterThan(0);
  });
});
