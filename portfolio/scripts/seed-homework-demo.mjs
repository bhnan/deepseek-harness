#!/usr/bin/env node
// 为预设 25 名学生补作业记录（演示 G1 散点图），完成率取自 data.js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8797/api/portfolio';
const req = async (m, p, b) => {
  const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d.reason || r.status);
  return d;
};

const dataJs = readFileSync(join(__dirname, '..', '..', '..', '全科学情图表演示', 'data.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(dataJs, sandbox);
const D = sandbox.window.PF_DATA;

const classes = await req('GET', '/classes');
const hr = classes.classes.find((c) => c.name === '初一(5)班·班主任');
const stu = await req('GET', `/classes/${hr.id}/students?page_size=500`);
const demoC1 = D.students.filter((s) => s.class_id === 'c1');
const byName = new Map(stu.students.map((s) => [s.name, s.id]));

const aw1 = await req('POST', `/classes/${hr.id}/assignments`, { subject: '数学', date: '2026-11-10', title: '练习册 P40-42', requirement: '', deadline: '' });
const aw2 = await req('POST', `/classes/${hr.id}/assignments`, { subject: '英语', date: '2026-11-17', title: '单元测试卷订正', requirement: '', deadline: '' });

const rows1 = []; const rows2 = [];
for (const s of demoC1) {
  const sid = byName.get(s.name);
  if (!sid) continue;
  const c = D.homework[s.id] ?? 0.8;
  rows1.push({ student_id: sid, status: c >= 0.8 ? 'excellent' : c >= 0.5 ? 'late' : 'missing' });
  rows2.push({ student_id: sid, status: c >= 0.6 ? 'normal' : 'slack' });
}
const r1 = await req('POST', `/assignments/${aw1.assignment.id}/records/batch`, { rows: rows1 });
const r2 = await req('POST', `/assignments/${aw2.assignment.id}/records/batch`, { rows: rows2 });
console.log('作业记录导入:', r1.upserted, '+', r2.upserted, '条');

// 验证李想
const lx = stu.students.find((x) => x.name === '李想');
const st = await req('GET', `/students/${lx.id}/assignment-stats`);
console.log('李想作业统计:', JSON.stringify(st.stats.student_stats[0]));
