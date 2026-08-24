#!/usr/bin/env node
/**
 * 查看某班授课内容完整有序序列（用于验证数据完整性）
 * 用法：node bin/inspect-class.mjs <semesterId> <班级名>
 * 示例：node bin/inspect-class.mjs 2026-autumn-1 "初一(1)班"
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

const sid = process.argv[2];
const className = process.argv[3];

if (!sid || !className) {
  console.error('用法: node bin/inspect-class.mjs <semesterId> <班级名>');
  console.error('示例: node bin/inspect-class.mjs 2026-autumn-1 "初一(1)班"');
  process.exit(1);
}

// 读取数据
const classes = JSON.parse(readFileSync(join(DATA, '_global', 'classes.json'), 'utf-8'));
const cls = classes.find((c) => c.name === className);
if (!cls) {
  console.error(`班级「${className}」不存在。可用班级：`);
  classes.forEach((c) => console.error(`  ${c.name} (${c.stage})`));
  process.exit(1);
}

const semester = JSON.parse(readFileSync(join(DATA, 'semesters.json'), 'utf-8')).find((s) => s.id === sid);
if (!semester) {
  console.error(`学期「${sid}」不存在`);
  process.exit(1);
}

const fixed = JSON.parse(readFileSync(join(DATA, sid, 'fixed_courses.json'), 'utf-8')).filter((f) => f.class_id === cls.id);
const contents = JSON.parse(readFileSync(join(DATA, sid, 'teaching_content.json'), 'utf-8')).filter((c) => c.class_id === cls.id);
const totalWeeks = 20; // 固定

// 按固定排课构建课时位
const slots = [];
for (let w = 1; w <= totalWeeks; w++) {
  for (const f of fixed) {
    const inWeek = (f.week === undefined || f.week === w || (f.week === 'odd' && w % 2 === 1) || (f.week === 'even' && w % 2 === 0) || (Array.isArray(f.week) && f.week.includes(w)));
    if (inWeek) slots.push({ week: w, weekday: f.weekday, period: f.period });
  }
}

// 绑定时序
const keyOf = (s) => `${s.week}-${s.weekday || 1}-${s.period || 1}`;
const slotIndexByKey = new Map();
slots.forEach((s, i) => { const k = keyOf(s); if (!slotIndexByKey.has(k)) slotIndexByKey.set(k, i); });

const items = [];
let skipped = 0;
const usedKeys = new Set();
for (const c of contents) {
  const idx = slotIndexByKey.get(keyOf(c));
  if (idx === undefined) { skipped++; continue; }
  if (usedKeys.has(idx)) { console.warn(`  ⚠️ 重复课时位: ${keyOf(c)}`); skipped++; continue; }
  usedKeys.add(idx);
  items.push({ slotIndex: idx, ...c });
}
items.sort((a, b) => a.slotIndex - b.slotIndex);

// 读假期
const holidays = (JSON.parse(readFileSync(join(DATA, '_global', 'holidays.json'), 'utf-8'))?.data?.items || []);
const monday1 = new Date(semester.start_date);
monday1.setDate(monday1.getDate() - (monday1.getDay() || 7) + 1);
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

// 输出
console.log(`\n${cls.name}（${cls.stage}）— ${sid}`);
console.log(`${'='.repeat(50)}`);
console.log(`固定排课: ${fixed.map((f) => `周${f.weekday}第${f.period}节`).join('、')}`);
console.log(`课时位总数: ${slots.length}`);
console.log(`内容条目数: ${items.length}（${skipped > 0 ? `⚠️ ${skipped}条无匹配课时位` : '全部匹配'}`);

if (items.length > 0) {
  console.log(`\n完整有序序列:`);
  console.log(`  #  seq   slot  课时位         日期      内容`);
  console.log(`  ${'-'.repeat(65)}`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const slot = slots[it.slotIndex];
    const d = addDays(monday1, (slot.week - 1) * 7 + (slot.weekday - 1));
    const dateStr = d.toISOString().slice(0, 10);
    const isHoliday = holidays.some((h) => h.start_date <= dateStr && h.end_date >= dateStr);
    const flag = isHoliday ? '🎉' : '  ';
    const slotStr = `${slot.week}周${slot.weekday}第${slot.period}节`;
    const si = it.seq_index !== undefined ? it.seq_index : '-';
    console.log(`  ${String(i + 1).padStart(2)}  [${String(si).padStart(2)}]  [${String(it.slotIndex).padStart(2)}]  ${slotStr.padEnd(15)} ${dateStr} ${flag} ${it.content}`);
  }
}

// 检查课时位空洞（该有内容但没有的 slot）
const filledSlots = new Set(items.map((it) => it.slotIndex));
const emptySlots = [];
for (let i = 0; i < items[items.length - 1]?.slotIndex; i++) {
  if (!filledSlots.has(i)) emptySlots.push(i);
}
if (emptySlots.length > 0) {
  console.log(`\n⚠️ 内容序列中空洞（有课时位但无内容）:`);
  for (const si of emptySlots) {
    const s = slots[si];
    const d = addDays(monday1, (s.week - 1) * 7 + (s.weekday - 1));
    const dateStr = d.toISOString().slice(0, 10);
    const isHoliday = holidays.some((h) => h.start_date <= dateStr && h.end_date >= dateStr);
    const flag = isHoliday ? '🎉 假期' : '⚠️ 异常';
    console.log(`  slot[${si}] ${s.week}周${s.weekday}第${s.period}节 ${dateStr} ${flag}`);
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`通过: ${items.length}/${slots.length} 课时位已填充`);
const emptyCount = slots.length - items.length;
console.log(`空位: ${emptyCount}（${emptyCount > 0 ? '学期末/N+1空位' : '无'})`);
process.exit(0);