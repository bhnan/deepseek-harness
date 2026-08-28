#!/usr/bin/env node
/**
 * 重置授课内容：按课程序列给每个班从 W1 开始均匀填充，
 * 删除所有旧条目（无残留、无重复）。
 *
 * 用法：node bin/reset-teaching-content.mjs <sid>
 * 示例：node bin/reset-teaching-content.mjs 2026-autumn-1
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const BASE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(BASE, 'data');

function readJSON(rel) {
  const p = join(DATA, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}
function writeJSON(rel, data) {
  writeFileSync(join(DATA, rel), JSON.stringify(data, null, 2), 'utf-8');
}

// ---------- UTC 日期工具（与 engine/date.js 一致） ----------
function parseISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) ? dt : null;
}
function toISO(dt) {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function addDays(s, n) {
  const dt = parseISO(s); if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() + n);
  return toISO(dt);
}
function diffDays(a, b) {
  return (parseISO(b) - parseISO(a)) / 86400000;
}
function weekday(s) {
  const dt = parseISO(s); if (!dt) return null;
  return dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
}
function weekStart(s) {
  const dt = parseISO(s); if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() - (weekday(s) - 1));
  return toISO(dt);
}

// ---------- 学期与排课 ----------
function semesterTotalWeeks(sem) {
  const w1 = weekStart(sem.start_date);
  return Math.floor(diffDays(w1, sem.end_date) / 7) + 1;
}
function buildSlots(fixed, totalWeeks) {
  const slots = [];
  for (let w = 1; w <= totalWeeks; w++)
    for (const f of fixed)
      slots.push({ week: w, weekday: f.weekday, period: f.period });
  return slots;
}

// ---------- 主流程 ----------
const sid = process.argv[2];
if (!sid) { console.error('用法: node bin/reset-teaching-content.mjs <sid>'); process.exit(1); }

const sem = (readJSON('semesters.json') || []).find((s) => s.id === sid);
if (!sem) { console.error('学期不存在:', sid); process.exit(1); }

const totalWeeks = semesterTotalWeeks(sem);
const classes = readJSON('_global/classes.json') || [];
const allFixed = readJSON(`${sid}/fixed_courses.json`) || [];
const seqData = readJSON(`${sid}/course_sequence.json`) || { middle: { items: [] }, primary: { items: [] } };
const oldContents = readJSON(`${sid}/teaching_content.json`) || [];

const clsMap = {};
for (const c of classes) clsMap[c.id] = c;

// 按班分组固定排课 + 原有条目计数
const byClass = {};
const prevCount = {};
for (const f of allFixed) (byClass[f.class_id] = byClass[f.class_id] || []).push(f);
for (const c of oldContents) prevCount[c.class_id] = (prevCount[c.class_id] || 0) + 1;

const usedIds = new Set();
function genId(p) { let id; do { id = p + '-' + Math.random().toString(36).slice(2, 8); } while (usedIds.has(id)); usedIds.add(id); return id; }

const newContents = [];
const report = [];

for (const cid of Object.keys(byClass).sort()) {
  const fixed = byClass[cid];
  const cls = clsMap[cid];
  const stage = cls?.stage === 'primary' ? 'primary' : 'middle';
  const seqItems = (seqData[stage]?.items || []).filter((i) => i.content);
  const seqTexts = seqItems.map((i) => i.content);

  if (seqTexts.length === 0) {
    report.push({ class_id: cid, name: cls?.name || cid, stage, status: '序列为空' });
    continue;
  }

  const slots = buildSlots(fixed, totalWeeks);
  const fillCount = Math.min(seqTexts.length, slots.length);
  const filled = [];
  for (let si = 0; si < fillCount; si++) {
    const s = slots[si];
    filled.push({
      id: genId('tc'),
      class_id: cid,
      week: s.week,
      weekday: s.weekday,
      period: s.period,
      seq_index: si,
      content: seqTexts[si],
      source: 'seq',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  newContents.push(...filled);
  report.push({
    class_id: cid,
    name: cls?.name || cid,
    stage,
    total_slots: slots.length,
    seq_filled: filled.length,
    previous_total: prevCount[cid] || 0,
    status: 'OK',
  });
}

// 无固定排课的班的内容原样保留（通常不会有）
const fixedIds = new Set(Object.keys(byClass));
for (const c of oldContents) {
  if (!fixedIds.has(c.class_id)) newContents.push(c);
}

newContents.sort((a, b) =>
  (a.week - b.week) || ((a.weekday || 1) - (b.weekday || 1)) || ((a.period || 1) - (b.period || 1))
);

writeJSON(`${sid}/teaching_content.json`, newContents);

console.log(`\n学期: ${sid} (${totalWeeks} 周, ${totalWeeks * 7} 天)`);
console.log(`总条目: ${oldContents.length} → ${newContents.length}`);
console.log('');
for (const r of report) {
  console.log(`  ${r.name.padEnd(12)} ${r.seq_filled} 条序列 / ${r.total_slots} 课时位  （之前 ${r.previous_total} 条）`);
}
console.log('\n重置完成 ✅');