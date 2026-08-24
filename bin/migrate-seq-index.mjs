#!/usr/bin/env node
/**
 * 给 teaching_content 添加 seq_index（该班第N课）
 * 用法：node bin/migrate-seq-index.mjs <sid>
 * 示例：node bin/migrate-seq-index.mjs 2026-autumn-1
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

const sid = process.argv[2];
if (!sid) { console.error('用法: node bin/migrate-seq-index.mjs <sid>'); process.exit(1); }

const semester = (readJSON('semesters.json') || []).find((s) => s.id === sid);
if (!semester) { console.error('学期不存在:', sid); process.exit(1); }

const classes = readJSON('_global/classes.json') || [];
const allFixed = readJSON(`${sid}/fixed_courses.json`) || [];
const contents = readJSON(`${sid}/teaching_content.json`) || [];

// 按班分组固定排课
const fixedByClass = {};
for (const f of allFixed) (fixedByClass[f.class_id] = fixedByClass[f.class_id] || []).push(f);

// 按班分组内容
const contentsByClass = {};
for (const c of contents) (contentsByClass[c.class_id] = contentsByClass[c.class_id] || []).push(c);

// 读假期，判断某日期是否假期
const holidays = readJSON('_global/holidays.json')?.data?.items || [];
const semesterStart = new Date(semester.start_date);
const monday1 = new Date(semesterStart);
monday1.setDate(monday1.getDate() - (monday1.getDay() || 7) + 1);
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function isHoliday(dateStr) {
  return holidays.some((h) => h.start_date <= dateStr && h.end_date >= dateStr);
}

// 构建每个班的 slot 列表（含 holiday 标记）
function buildSlots(fixed, totalWeeks) {
  const slots = [];
  for (let w = 1; w <= totalWeeks; w++) {
    for (const f of fixed) {
      slots.push({ week: w, weekday: f.weekday, period: f.period });
    }
  }
  return slots;
}

// 学期总周数
const totalWeeks = Math.floor(
  (new Date(semester.end_date) - new Date(semester.start_date)) / 86400000 / 7
) + 1;

let totalBefore = 0, totalAfter = 0, totalMigrated = 0;

for (const c of classes) {
  const fixed = fixedByClass[c.id];
  if (!fixed || fixed.length === 0) continue;
  
  const slots = buildSlots(fixed, totalWeeks);
  const classContents = (contentsByClass[c.id] || []).sort((a, b) =>
    (a.week - b.week) || ((a.weekday || 1) - (b.weekday || 1)) || ((a.period || 1) - (b.period || 1))
  );

  totalBefore += classContents.length;

  // 构建 slotIndex 索引
  const keyOf = (s) => `${s.week}-${s.weekday}-${s.period}`;
  const slotIndexByKey = new Map();
  slots.forEach((s, i) => { slotIndexByKey.set(keyOf(s), i); });

  // 为每个内容条目分配 seq_index（按 slotIndex 排序）
  const withSlot = classContents.map((c) => ({
    ...c,
    _slotIndex: slotIndexByKey.get(keyOf(c)) ?? -1,
  })).filter((c) => c._slotIndex >= 0)
    .sort((a, b) => a._slotIndex - b._slotIndex);

  totalMigrated += withSlot.length;

  // 覆盖式写入 seq_index
  for (let i = 0; i < withSlot.length; i++) {
    delete withSlot[i]._slotIndex;
    withSlot[i].seq_index = i;
  }

  contentsByClass[c.id] = withSlot;
  totalAfter += withSlot.length;
}

// 重新组装全部内容（保留无固定排课的班的内容）
const fixedIds = new Set(Object.keys(fixedByClass));
const newContents = [];
for (const c of classes) {
  if (contentsByClass[c.id]) newContents.push(...contentsByClass[c.id]);
}
for (const c of contents) {
  if (!fixedIds.has(c.class_id) && !newContents.find((nc) => nc.id === c.id)) {
    newContents.push(c);
  }
}

writeJSON(`${sid}/teaching_content.json`, newContents);

console.log(`学期: ${sid}`);
console.log(`总内容: ${totalBefore} → ${totalAfter}`);
console.log(`已迁移: ${totalMigrated} 条（含 seq_index）`);
console.log('迁移完成 ✅');