// 一次性数据修复：调休补课与法定节假日顺延的联动。
// 背景：历史数据在"调休日补课"功能上线前已按节假日顺延过一次，
// 把被调休覆盖的星期（如 10.10 补周三 → 第 6 周周三，当天恰逢国庆假）的内容也顺延走了，
// 导致调休日无课可补。
// 做法：按 seq_index 重建自然课时位（历史偏差仅来自节假日顺延，seq_index 即自然课时位序号），
// 再以"调休星期不顺延"的新规则重跑一遍顺延，最后写回（原文件备份 .bak）。
//
// 用法：node scripts/repair_makeup_defers.mjs [学期id]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSlots, bindItems, semesterTotalWeeks, weekStart, addDays, weekIndexOf } from '../src/engine/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SID = process.argv[2] || '2026-autumn-1';
const DATA = path.join(ROOT, 'data');
const sidDir = path.join(DATA, SID);

const sem = JSON.parse(fs.readFileSync(path.join(DATA, 'semesters.json'), 'utf-8')).find((s) => s.id === SID);
if (!sem) { console.error('semester not found:', SID); process.exit(1); }
const fixed = JSON.parse(fs.readFileSync(path.join(sidDir, 'fixed_courses.json'), 'utf-8'));
const contents = JSON.parse(fs.readFileSync(path.join(sidDir, 'teaching_content.json'), 'utf-8'));
const holidays = (JSON.parse(fs.readFileSync(path.join(DATA, '_global', 'holidays.json'), 'utf-8')).data || {}).items || [];
const makeup = JSON.parse(fs.readFileSync(path.join(sidDir, 'makeup_days.json'), 'utf-8'));

const totalWeeks = semesterTotalWeeks(sem);
const monday1 = weekStart(sem.start_date);
const realHoliday = (x) => !x.kind || x.kind === 'holiday';
// 调休覆盖星期：某周某调休日补某星期 → 该星期当天即使放假也不顺延
const makeupCovered = new Set();
for (const m of makeup) {
  const w = weekIndexOf(sem, m.date);
  if (w >= 1 && Number.isInteger(m.mirror_weekday)) makeupCovered.add(`${w}-${m.mirror_weekday}`);
}

const byClass = new Map();
for (const f of fixed) {
  const arr = byClass.get(f.class_id) || [];
  arr.push(f);
  byClass.set(f.class_id, arr);
}

// 1) 按 seq_index 重建自然课时位（忽略当前物理位置：历史数据已被节假日顺延污染）
const natural = [];
for (const [classId, fcs] of byClass) {
  const slots = buildSlots(fcs, totalWeeks);
  const rows = contents.filter((c) => c.class_id === classId).sort((a, b) => (a.seq_index ?? 0) - (b.seq_index ?? 0));
  rows.forEach((r, i) => {
    const s = slots[i];
    if (!s) { console.warn(`[warn] ${classId} seq ${i} 超出课时位，跳过`); return; }
    natural.push({ ...r, week: s.week, weekday: s.weekday, period: s.period });
  });
}

// 2) 以"调休星期不顺延"的新规则重跑节假日顺延（与 server syncHolidayDefers 同逻辑）
let working = natural;
let deferredTotal = 0;
for (const [classId, fcs] of byClass) {
  const slots = buildSlots(fcs, totalWeeks);
  const classContents = working.filter((c) => c.class_id === classId);
  const { items } = bindItems(classContents, slots);
  if (items.length === 0) continue;
  const holidayIdx = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (makeupCovered.has(`${s.week}-${s.weekday}`)) continue;
    const date = addDays(monday1, (s.week - 1) * 7 + (s.weekday - 1));
    if (holidays.some((h) => realHoliday(h) && h.start_date <= date && h.end_date >= date)) holidayIdx.push(i);
  }
  if (holidayIdx.length === 0) continue;
  const blocks = [];
  for (const h of holidayIdx) {
    const last = blocks[blocks.length - 1];
    if (last && last.end === h - 1) { last.end = h; last.size++; }
    else blocks.push({ start: h, end: h, size: 1 });
  }
  let cur = items;
  let ok = true;
  for (const block of blocks) {
    const idx = cur.findIndex((it) => it.slotIndex >= block.start && it.slotIndex <= block.end);
    if (idx === -1) continue;
    const shiftBy = block.end - cur[idx].slotIndex + 1;
    if (shiftBy <= 0) continue;
    const lastItem = cur[cur.length - 1];
    if (lastItem.slotIndex + shiftBy >= slots.length) { ok = false; break; }
    cur = cur.map((item, i) => (i < idx ? item : { ...item, slotIndex: item.slotIndex + shiftBy }));
  }
  if (!ok || cur === items) continue;
  const before = classContents;
  const newContents = cur.map((it) => {
    const orig = before.find((c) => c.id === it.id);
    if (!orig) return null;
    const slot = slots[it.slotIndex];
    return { ...orig, week: slot.week, weekday: slot.weekday, period: slot.period, updated_at: new Date().toISOString() };
  }).filter(Boolean);
  newContents.sort((a, b) => (a.seq_index ?? 0) - (b.seq_index ?? 0));
  const others = working.filter((c) => c.class_id !== classId);
  working = [...others, ...newContents];
  deferredTotal += 1;
}

// 3) 备份并写回
const target = path.join(sidDir, 'teaching_content.json');
fs.copyFileSync(target, target + '.bak');
fs.writeFileSync(target, JSON.stringify(working, null, 2));
console.log(`[ok] ${SID} teaching_content.json 已重建（${working.length} 条，涉及 ${deferredTotal} 个班），原文件备份为 teaching_content.json.bak`);
console.log(`[info] 调休覆盖星期：${[...makeupCovered].join(', ') || '无'}`);
