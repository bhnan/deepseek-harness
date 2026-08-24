// 作业台账模块（002）接口测试：创建/名单解析/筛选/编辑/个人回流/小组
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}/api/portfolio`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hw-test-'));

let server, cid, sidA, sidB, sidC;

beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), TC_DATA_DIR: TMP },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const api = async (m, p, b) => {
    const r = await fetch(`${BASE}${p}`, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    return r.json();
  };
  cid = (await api('POST', '/classes', { name: '台账测试班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
  sidA = (await api('POST', `/classes/${cid}/students`, { name: '张三', student_no: 'A001', group_name: '第一组' })).student.id;
  sidB = (await api('POST', `/classes/${cid}/students`, { name: '李四', student_no: 'A002', group_name: '第一组' })).student.id;
  sidC = (await api('POST', `/classes/${cid}/students`, { name: '王五', student_no: 'A003', group_name: '第二组' })).student.id;
});

afterAll(() => { server?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  return r.json();
};

describe('作业台账', () => {
  it('创建单条：名单按学号/姓名解析为 {id,name}，不在花名册给出 warnings', async () => {
    const d = await api('POST', `/classes/${cid}/hw-ledger`, { records: [{
      record_date: '2026-12-05', subjects: ['语文', '数学'], reporter: '梁老师',
      praise: 'A001, 李四', missing: '王五', problem: '张三，外班生',
    }] });
    expect(d.created).toBe(1);
    const r = d.records[0];
    expect(r.praise.map((x) => x.name)).toEqual(['张三', '李四']);
    expect(r.praise[0].id).toBe(sidA);
    expect(r.missing[0].id).toBe(sidC);
    expect(r.problem[0].id).toBe(sidA);
    expect(r.problem[1]).toEqual({ id: '', name: '外班生' }); // 不在花名册
    expect(d.warnings.some((w) => w.includes('外班生'))).toBe(true);
  });

  it('批量多科目：一键生成多行，复用基础字段', async () => {
    const d = await api('POST', `/classes/${cid}/hw-ledger`, { records: [
      { record_date: '2026-12-06', subjects: ['英语'], reporter: '梁老师', praise: '张三', missing: '', problem: '' },
      { record_date: '2026-12-06', subjects: ['美术'], reporter: '梁老师', praise: '', missing: '李四', problem: '王五' },
    ] });
    expect(d.created).toBe(2);
  });

  it('筛选：日期范围 / 科目 / 状态 / 学生 / 填报人 / 小组 叠加', async () => {
    const byDate = await api('GET', `/classes/${cid}/hw-ledger?date_from=2026-12-05&date_to=2026-12-05`);
    expect(byDate.total).toBe(1);
    const bySubj = await api('GET', `/classes/${cid}/hw-ledger?subjects=${encodeURIComponent('语文,数学')}`);
    expect(bySubj.total).toBe(1);
    const byStatus = await api('GET', `/classes/${cid}/hw-ledger?status=missing`);
    expect(byStatus.total).toBe(2); // 12-05 王五 + 12-06 李四
    const byStudent = await api('GET', `/classes/${cid}/hw-ledger?student=${encodeURIComponent('张三')}`);
    expect(byStudent.total).toBe(2); // 表扬 + 问题
    const byReporter = await api('GET', `/classes/${cid}/hw-ledger?reporter=${encodeURIComponent('梁老师')}`);
    expect(byReporter.total).toBe(3);
    const byGroup = await api('GET', `/classes/${cid}/hw-ledger?groups=${encodeURIComponent('第二组')}`);
    expect(byGroup.total).toBe(2); // 王五 缺交 + 问题
  });

  it('编辑记录：可修正名单/补备注（无删除接口）', async () => {
    const list = await api('GET', `/classes/${cid}/hw-ledger`);
    const rec = list.records[0];
    const d = await api('PUT', `/hw-ledger/${rec.id}`, { note: '已通知家长', problem: 'A003' });
    expect(d.ok).toBe(true);
    expect(d.record.note).toBe('已通知家长');
    expect(d.record.problem.map((x) => x.name)).toEqual(['王五']);
  });

  it('个人回流：事件时间线倒序 + 学期统计', async () => {
    const d = await api('GET', `/students/${sidA}/hw-events`);
    // 张三：表扬(12-05, 12-06) + 问题(12-05)
    expect(d.summary.praise).toBe(2);
    expect(d.summary.problem).toBe(1);
    expect(d.summary.missing).toBe(0);
    expect(d.events.length).toBe(3);
    expect(d.events[0].date >= d.events[d.events.length - 1].date).toBe(true); // 倒序
    expect(d.events[0].subjects.length).toBeGreaterThan(0);
    // 未匹配 id 的姓名回退归档
    const extra = await api('POST', `/classes/${cid}/hw-ledger`, { records: [{ record_date: '2026-12-07', subjects: ['道法'], reporter: '梁老师', praise: '', missing: '外班生', problem: '' }] });
    expect(extra.created).toBe(1);
    // 外班生不在花名册，个人事件不归属任何学生
    const d2 = await api('GET', `/students/${sidA}/hw-events`);
    expect(d2.summary.missing).toBe(0);
  });

  it('小组字段：学生创建/更新时写入', async () => {
    const list = await api('GET', `/classes/${cid}/students`);
    const a = list.students.find((s) => s.id === sidA);
    expect(a.group_name).toBe('第一组');
    const u = await api('PUT', `/students/${sidA}`, { group_name: '第三组' });
    expect(u.student.group_name).toBe('第三组');
  });

  it('删除台账记录：DELETE 生效（按用户需求开放删除）', async () => {
    const before = await api('GET', `/classes/${cid}/hw-ledger`);
    const rec = before.records[0];
    const d = await api('DELETE', `/hw-ledger/${rec.id}`);
    expect(d.ok).toBe(true);
    const after = await api('GET', `/classes/${cid}/hw-ledger`);
    expect(after.total).toBe(before.total - 1);
    expect(after.records.some((r) => r.id === rec.id)).toBe(false);
  });

  it('台账创建不可撤销（无删除路径，永久留存）', async () => {
    const before = await api('GET', `/classes/${cid}/hw-ledger`);
    await api('POST', '/undo');
    const after = await api('GET', `/classes/${cid}/hw-ledger`);
    expect(after.total).toBe(before.total); // 台账创建不入撤销栈
  });
});
