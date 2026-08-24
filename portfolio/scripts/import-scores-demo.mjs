#!/usr/bin/env node
/**
 * 预设成绩导入脚本（import-scores-demo.mjs）
 * 将 全科学情图表演示/data.js 的 4 次考试 × 7 科成绩导入班主任班（初一(5)班·班主任）
 * - 学生映射：演示 c1 班（202601xx）→ 库中 202602xx（按姓名核对）
 * - 导入字段：7 科分数 + 总分 + 班级排名（class_rank 沿用 25 人内排名）
 * - 不导入 grade_rank（单班应用无年级数据）；不覆盖已有考试
 * 前置：portfolio server 已启动（http://127.0.0.1:8797），fix-homeroom-import.mjs 已执行
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = process.env.PF_API || 'http://127.0.0.1:8797/api/portfolio';
const HOMEROOM = '初一(5)班·班主任';

/* ---------- 读取演示数据 ---------- */
const dataJs = readFileSync(join(__dirname, '..', '..', '..', '全科学情图表演示', 'data.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(dataJs, sandbox);
const D = sandbox.window.PF_DATA;

/* ---------- API 工具 ---------- */
async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error || data.reason || JSON.stringify(data)}`);
  return data;
}

/* ---------- 主流程 ---------- */
// 1. 班主任班
const all = await req('GET', '/classes');
const hr = all.classes.find((c) => c.name === HOMEROOM);
if (!hr) throw new Error(`找不到班级 ${HOMEROOM}`);
console.log(`🏫 ${HOMEROOM}（${hr.id}）`);

// 2. 学生映射：演示 c1（202601xx，按姓名）→ 库中 202602xx
const demoC1 = D.students.filter((s) => s.class_id === 'c1');
const stuList = await req('GET', `/classes/${hr.id}/students?page_size=500`);
const idByName = new Map(stuList.students.map((s) => [s.name, s.id]));
let mapped = 0;
const demoIdToDbId = {};
for (const s of demoC1) {
  const dbId = idByName.get(s.name);
  if (!dbId) { console.warn(`⚠ 库中找不到学生「${s.name}」`); continue; }
  demoIdToDbId[s.id] = dbId;
  mapped++;
}
console.log(`👥 学生映射：${mapped}/${demoC1.length} 人`);

// 3. 创建考试（跳过已存在的同名考试）
const existing = await req('GET', `/classes/${hr.id}/exams`);
const existNames = new Set(existing.exams.map((e) => e.name));
const examIdMap = {};
for (const ex of D.exams) {
  if (existNames.has(ex.name)) {
    const dup = existing.exams.find((e) => e.name === ex.name);
    console.log(`⏭ 考试已存在（跳过）：${ex.name}（${dup.date}）`);
    continue;
  }
  const d = await req('POST', `/classes/${hr.id}/exams`, { name: ex.name, type: ex.type, date: ex.date });
  examIdMap[ex.id] = d.exam.id;
  console.log(`📝 创建考试：${ex.name}（${ex.type} ${ex.date}）→ ${d.exam.id}`);
}
// 同名已存在时仍映射（用于数据导入到已有考试？不：为防混淆，重名考试不导入成绩，仅提示）
const usable = D.exams.filter((ex) => examIdMap[ex.id]);
const skipped = D.exams.filter((ex) => !examIdMap[ex.id]);
if (skipped.length) console.log(`⚠ 重名考试未导入成绩：${skipped.map((e) => e.name).join('、')}（班内已有同名考试，请先删除旧测试考试后再导入）`);

// 4. 导入成绩
for (const ex of usable) {
  const rows = [];
  for (const demoStu of demoC1) {
    const dbId = demoIdToDbId[demoStu.id];
    if (!dbId) continue;
    const row = D.scores[ex.id][demoStu.id];
    for (const sub of D.meta.subjects) {
      rows.push({ student_id: dbId, subject: sub, score: row[sub], class_rank: row.class_rank });
    }
    rows.push({ student_id: dbId, subject: '总分', score: row['总分'], class_rank: row.class_rank });
  }
  const r = await req('POST', `/exams/${examIdMap[ex.id]}/scores/batch`, { rows });
  console.log(`📊 ${ex.name}：导入 ${r.upserted} 行${r.failed ? `，失败 ${r.failed}：${r.errors?.map((e) => `行${e.row} ${e.reason}`).join('；')}` : ''}`);
}

// 5. 验证：班级学情
console.log('\n--- 验证：班级学情（最近考试） ---');
const exams = await req('GET', `/classes/${hr.id}/exams`);
const latest = exams.exams[0];
const ana = await req('GET', `/classes/${hr.id}/analysis?exam_id=${latest.id}`);
const a = ana.analysis;
console.log(`考试：${ana.exam.name}（${ana.exam.date}）｜ 对比基准：${ana.prev_exam ? `${ana.prev_exam.name}（${ana.prev_exam.date}）` : '无'}`);
console.log(`stats:`, JSON.stringify(a.stats));
console.log(`subject_stats:`, JSON.stringify(a.subject_stats));
console.log(`movement:`, JSON.stringify(a.movement));
console.log(`排名前5:`, ana.ranking.slice(0, 5).map((r) => `${r.student_name ?? ''} ${r.total}`).join('、'));
