#!/usr/bin/env node
// 一键预排学期课表：每班每周 2 节（初中 5 班 + 小学 3 班 = 16 课时位）
// 用法: node scripts/prefill-semester.mjs [--semester=2026-autumn-1] [--dry-run]
//
// 流程：
//   1. 删除该学期现有固定排课与授课内容（全部入撤销栈，可一键恢复）
//   2. 创建 16 条固定排课（每周复用模板）：每班 2 节，时段无冲突、同班错开两天
//   3. 初中内容预填：各班第 N 课时位 = 中学统一序列第 N 条（sequence/apply 引擎）
//      （小学仅排课时位，内容由老师在「授课内容」自行编辑）
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const API = (args.find((a) => a.startsWith('--api=')) || '--api=http://127.0.0.1:8787').split('=')[1];
const SEM_ID = (args.find((a) => a.startsWith('--semester=')) || '--semester=2026-autumn-1').split('=')[1];
const DRY = args.includes('--dry-run');

// 课时位表：{ class_name, weekday, period }（每时段唯一，同班两天错开）
const SLOTS = [
  { class_name: '初一(1)班', weekday: 1, period: 1 },
  { class_name: '初一(1)班', weekday: 3, period: 6 },
  { class_name: '初一(2)班', weekday: 1, period: 5 },
  { class_name: '初一(2)班', weekday: 4, period: 2 },
  { class_name: '初一(3)班', weekday: 2, period: 2 },
  { class_name: '初一(3)班', weekday: 4, period: 7 },
  { class_name: '初一(4)班', weekday: 2, period: 6 },
  { class_name: '初一(4)班', weekday: 5, period: 3 },
  { class_name: '初一(5)班', weekday: 3, period: 1 },
  { class_name: '初一(5)班', weekday: 5, period: 7 },
  { class_name: '四(1)班', weekday: 1, period: 3 },
  { class_name: '四(1)班', weekday: 4, period: 5 },
  { class_name: '四(2)班', weekday: 2, period: 4 },
  { class_name: '四(2)班', weekday: 5, period: 1 },
  { class_name: '四(3)班', weekday: 3, period: 3 },
  { class_name: '四(3)班', weekday: 5, period: 5 },
];

async function req(method, p, body) {
  const r = await fetch(`${API}/api/calendar${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(`${method} ${p} → ${j.reason || r.status}`);
  return j;
}

async function main() {
  // 校验学期
  const semesters = (await req('GET', '/semesters')).semesters;
  const sem = semesters.find((s) => s.id === SEM_ID);
  if (!sem) { console.error(`✘ 学期不存在: ${SEM_ID}（可用: ${semesters.map((s) => s.id).join(', ')}）`); process.exit(1); }
  console.log(`✔ 目标学期: ${sem.name}（${sem.start_date} ~ ${sem.end_date}）`);

  // 校验课时位无冲突
  const seen = new Set();
  for (const s of SLOTS) {
    const k = `${s.weekday}-${s.period}`;
    if (seen.has(k)) { console.error(`✘ 课时位冲突: 周${s.weekday}第${s.period}节重复`); process.exit(1); }
    seen.add(k);
  }
  console.log(`✔ 课时位方案: ${SLOTS.length} 个（初中 ${SLOTS.filter((s) => s.class_name.startsWith('初一')).length} + 小学 ${SLOTS.filter((s) => s.class_name.startsWith('四')).length}），无冲突`);

  // 班级映射
  const classes = (await req('GET', '/classes')).classes;
  const byName = new Map(classes.map((c) => [c.name, c]));
  const slots = SLOTS.map((s) => {
    const c = byName.get(s.class_name);
    if (!c) { console.error(`✘ 找不到班级「${s.class_name}」`); process.exit(1); }
    return { ...s, class_id: c.id, stage: c.stage };
  });

  // 现有数据预览
  const sched = (await req('GET', `/${SEM_ID}/schedule`)).fixed_courses;
  const contents = (await req('GET', `/${SEM_ID}/teaching-content`)).contents;
  console.log(`✔ 现有数据: 固定排课 ${sched.length} 条，授课内容 ${contents.length} 条（将重建）`);

  if (DRY) { console.log('  （--dry-run：仅检查，不写入）'); return; }

  // 1. 删除现有固定排课与全部授课内容（逐条入撤销栈，可整体恢复）
  for (const f of sched) {
    await req('DELETE', `/${SEM_ID}/fixed-courses/${f.id}`);
  }
  console.log(`✔ 已清除旧固定排课 ${sched.length} 条`);
  for (const c of contents) {
    await req('DELETE', `/${SEM_ID}/teaching-content/${c.id}`);
  }
  console.log(`✔ 已清除旧授课内容 ${contents.length} 条（旧课时位内容一并清理，避免残留）`);

  // 2. 创建新固定排课
  for (const s of slots) {
    await req('POST', `/${SEM_ID}/fixed-courses`, { class_id: s.class_id, weekday: s.weekday, period: s.period });
  }
  console.log(`✔ 已创建 ${slots.length} 条固定排课`);

  // 3. 初中内容预填（每班第 N 课时位 = 中学序列第 N 条）
  const middleClassIds = slots.filter((s) => s.stage === 'middle').map((s) => s.class_id);
  const apply = await req('POST', `/${SEM_ID}/sequence/apply`, { class_ids: middleClassIds });
  const okReports = apply.report.filter((r) => r.changed > 0 || r.assigned > 0);
  console.log(`✔ 初中内容预填: ${apply.total_assigned} 条（各班前 ${okReports.map((r) => r.assigned).join('/')} 课时位按序列对齐）`);

  // 4. 汇总
  const after = (await req('GET', `/${SEM_ID}/schedule`)).fixed_courses;
  const afterContents = (await req('GET', `/${SEM_ID}/teaching-content`)).contents;
  console.log('\n========== 预排完成 ==========');
  console.log(`学期: ${sem.name}`);
  console.log(`固定排课: ${after.length} 条（每班每周 2 节）`);
  const perClass = {};
  for (const f of after) (perClass[f.class_id] = perClass[f.class_id] || []).push(f);
  for (const [cid, list] of Object.entries(perClass)) {
    const c = byName.get(classes.find((x) => x.id === cid)?.name);
    console.log(`  ${classes.find((x) => x.id === cid)?.name}: ${list.map((f) => `周${f.weekday}第${f.period}节`).join('、')}`);
  }
  console.log(`授课内容: ${afterContents.length} 条（初中按统一序列预填，小学待编辑）`);
  console.log('\n提示：');
  console.log('  · 全部操作已写入撤销栈，可在 GUI 中一键撤销整次预排');
  console.log('  · 小学内容序列为空：请在「授课内容 → 统一课程序列」为小学建立序列后点「一键预填」');
  console.log('  · 每班每周 2 节共 40 课时位（20 周），中学序列 26 条填满前 13 周，其余留空待补');
}

main().catch((e) => { console.error('✘', e.message); process.exit(1); });
