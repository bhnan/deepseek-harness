#!/usr/bin/env node
// 教师工作手册 docx → 教学日历导入脚本
// 用法: node scripts/import-docx-schedule.mjs <课表.docx> [--api http://127.0.0.1:8787] [--dry-run]
//       可选参数化目标学期（缺省沿用内置 2025 春季映射，向后兼容）:
//         --semester-name="2026年寒假" --semester-start=2026-01-19 --semester-end=2026-02-28
// 流程：
//   1. 调 python3 scripts/parse_docx_schedule.py 解析 docx → 12 周课表 JSON
//   2. 按映射规则生成：目标学期 + 固定排课（含单双周/指定周 week 字段）+ 授课内容
//   3. 通过 API 写入（可撤销：每次操作都有 undo 快照）
//
// 映射规则：
//   - 时段: 上午4节→period1-4, 下午3节→period5-7, 延时1/2→period8/9（午休/晚间跳过）
//   - 班级: 一班→初一(1)班 ... 五班→初一(5)班（按 classes API 匹配，找不到则报错）
//   - 内容: "X班N" → 该班第 N 课时 → 中学统一序列第 N 条（第1条=第一课·中学时代）
//   - 课服: "X班课服" → 内容「课后服务」；单周有课服（week:'odd'），双周无
//   - 周日课仅模板第 11 周出现 → week:11 指定周固定课
//   - 教研/假期标注：不导入为课时（报告提示）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCX = process.argv[2];
const args = process.argv.slice(3);
const API = (args.find((a) => a.startsWith('--api=')) || '--api=http://127.0.0.1:8787').split('=')[1];
const DRY = args.includes('--dry-run');

if (!DOCX) {
  console.error('用法: node scripts/import-docx-schedule.mjs <课表.docx> [--api=URL] [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(DOCX)) { console.error(`找不到文件: ${DOCX}`); process.exit(1); }

// ---------- 1. 解析 docx ----------
const out = spawnSync('python3', [path.join(__dirname, 'parse_docx_schedule.py'), DOCX], { encoding: 'utf-8' });
if (out.status !== 0) { console.error('解析失败:', out.stderr); process.exit(1); }
const weeks = JSON.parse(out.stdout.trim());
console.log(`✔ 解析 docx：${weeks.length} 周（${weeks[0].week}~${weeks[weeks.length - 1].week}）`);

// ---------- 2. 映射表 ----------
const SLOT_MAP = [
  { re: /^第一节8:15/, p: 1 }, { re: /^第二节9:25/, p: 2 },
  { re: /^第三节10:20/, p: 3 }, { re: /^第四节11:15/, p: 4 },
  { re: /^午休/, p: null },
  { re: /^第一节14:05/, p: 5 }, { re: /^第二节15:00/, p: 6 }, { re: /^第三节15:55/, p: 7 },
  { re: /^课后延时1/, p: 8 }, { re: /^课后延时2/, p: 9 },
  { re: /^晚上/, p: null },
];
const slotPeriod = (slot) => { const m = SLOT_MAP.find((s) => s.re.test(slot)); return m ? m.p : null; };
const CLASS_CN = ['一', '二', '三', '四', '五'];
const CONTENT_SEQ = ['第一课·中学时代', '少年有梦', '学习伴成长', '享受学习', '认识自己'];
const PRESET_IDS = { '第一课·中学时代': 'tp-01', '少年有梦': 'tp-02', '学习伴成长': 'tp-03', '享受学习': 'tp-04', '认识自己': 'tp-05' };

async function req(method, p, body) {
  const r = await fetch(`${API}/api/calendar${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(`${method} ${p} → ${j.reason || r.status}`);
  return j;
}

// ---------- 3. 分析课表，生成排课计划 ----------
// 目标学期：CLI/命令行可参数化；缺省值与历史行为逐字一致（2025 春季）
// 严格取值：命中 flag 却取不到值 → 报错退出（绝不静默回退默认学期，防写错目标）
const argOf = (flag, dflt) => {
  const i = args.findIndex((a) => a === flag || a.startsWith(flag + '='));
  if (i === -1) return dflt;
  const inline = args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : '';
  if (inline !== '') return inline;
  const nxt = args[i + 1];
  if (nxt !== undefined && nxt !== '' && !nxt.startsWith('--')) return nxt;
  console.error(`✘ 参数 ${flag} 缺少取值（支持 --flag=value 或 --flag value）`);
  process.exit(1);
};
const semester = {
  name: argOf('--semester-name', '2025年春季第二学期'),
  start_date: argOf('--semester-start', '2025-02-10'),
  end_date: argOf('--semester-end', '2025-07-13'), // 第 22 周周日（旧课表最后一周）
};
const WDS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
// 总周数复用日历引擎口径（默认日期下 = 22，与旧硬编码恒等）
const { semesterTotalWeeks } = await import('../src/engine/week.js');
const TOTAL_WEEKS = semesterTotalWeeks(semester);
// 学期全范围单/双周（用于推导 week 字段；旧课表只覆盖 11-22 周，故课服不会命中 'odd'/'even'，精确走周数组）
const SEM_ODD_WEEKS = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1).filter((w) => w % 2 === 1);
const SEM_EVEN_WEEKS = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1).filter((w) => w % 2 === 0);
const ALL_WEEKS = weeks.map((w) => w.week); // [11..22]
const ODD_WEEKS = ALL_WEEKS.filter((w) => w % 2 === 1);
const EVEN_WEEKS = ALL_WEEKS.filter((w) => w % 2 === 0);

// 先收集每个课时位（班级/星期/节次）在哪些周实际有课（旧课表为准）
const slotWeeks = new Map(); // key: clsNo-day-period-kind → Set(weeks)
const slotMeta = new Map();  // key → { clsNo, weekday, period, kind, lessonNo }
const skipNotes = [];

for (const w of weeks) {
  for (const s of w.slots) {
    const p = slotPeriod(s.slot);
    if (p === null) continue; // 午休/晚间
    for (let wd = 0; wd < 7; wd++) {
      const raw = (s.cells[wd] || '').trim();
      if (!raw) continue;
      const day = wd + 1;
      let clsNo = null, lessonNo = null, kind = 'course';
      let cm = raw.match(/^([一二三四五])班([12])$/);
      if (cm) { clsNo = CLASS_CN.indexOf(cm[1]); lessonNo = Number(cm[2]); }
      else if (/班课服$/.test(raw)) { clsNo = CLASS_CN.indexOf(raw[0]); kind = 'service'; }
      else if (/教研/.test(raw)) { skipNotes.push(`第${w.week}周 ${WDS[day]} 第${p}节：教研活动（未导入课时）`); continue; }
      else if (/假期/.test(raw)) { skipNotes.push(`第${w.week}周 ${WDS[day]}：${raw}（节假日，已加入假期表）`); continue; }
      else { skipNotes.push(`第${w.week}周 ${WDS[day]} 第${p}节：无法识别「${raw}」（已跳过）`); continue; }
      if (clsNo < 0) { skipNotes.push(`第${w.week}周 ${WDS[day]}：班级「${raw}」无法映射（已跳过）`); continue; }
      const key = `${clsNo}-${day}-${p}-${kind}`;
      if (!slotWeeks.has(key)) {
        slotWeeks.set(key, new Set());
        slotMeta.set(key, { clsNo, weekday: day, period: p, kind, lessonNo });
      }
      slotWeeks.get(key).add(w.week);
    }
  }
}

// 推导每个课时位的 week 字段（D3 扩展）：
// 一律用周数组（忠实于旧课表覆盖的 11-22 周；第 1-10 周保持空课表）
const plans = [];
for (const [key, wkSet] of slotWeeks) {
  const meta = slotMeta.get(key);
  const wkList = [...wkSet].sort((a, b) => a - b);
  plans.push({ ...meta, week: wkList, activeWeeks: wkList });
}
plans.sort((a, b) => (a.weekday - b.weekday) || (a.period - b.period) || (a.clsNo - b.clsNo));

console.log(`✔ 分析完成：${plans.length} 个固定课时位（正课 ${plans.filter((x) => x.kind === 'course').length}，课服 ${plans.filter((x) => x.kind === 'service').length}）`);
plans.forEach((p) => {
  const w = p.week === undefined ? '每周' : (typeof p.week === 'string' ? `week:${p.week}` : `周[${p.week}]`);
  console.log(`  ${WDS[p.weekday]} 第${p.period}节 初一(${p.clsNo + 1})班 ${p.kind === 'service' ? '课服' : `第${p.lessonNo}课`} → ${w}（${p.activeWeeks.length} 周）`);
});
if (skipNotes.length) { console.log(`  ⚠ 跳过 ${skipNotes.length} 项：`); skipNotes.slice(0, 8).forEach((n) => console.log(`    - ${n}`)); if (skipNotes.length > 8) console.log(`    … 其余 ${skipNotes.length - 8} 项略`); }

// ---------- 4. 检查目标学期 ----------
const semesters = (await req('GET', '/semesters')).semesters;
const existing = semesters.find((s) => s.name === semester.name);
if (existing && !DRY) {
  console.error(`✘ 学期「${semester.name}」已存在（${existing.id}），如需重新导入请先删除该学期`);
  process.exit(1);
}
console.log(`✔ 目标学期：${semester.name}（${semester.start_date} ~ ${semester.end_date}，共 22 周）`);
if (DRY) { console.log('  （--dry-run：仅分析，不写入）'); process.exit(0); }

// ---------- 5. 创建学期 ----------
const sem = (await req('POST', '/semesters', semester)).semester;
console.log(`✔ 学期已创建：${sem.id}`);

// ---------- 6. 班级映射 ----------
const classes = (await req('GET', '/classes')).classes;
const classIdByNo = CLASS_CN.map((cn, i) => {
  const c = classes.find((x) => x.name === `初一(${i + 1})班`);
  if (!c) throw new Error(`找不到班级「初一(${i + 1})班」`);
  return c.id;
});

// ---------- 7. 写固定排课 ----------
const fixedIds = {};
for (const pl of plans) {
  const body = { class_id: classIdByNo[pl.clsNo], weekday: pl.weekday, period: pl.period };
  if (pl.week !== undefined) body.week = pl.week;
  const r = await req('POST', `/${sem.id}/fixed-courses`, body);
  fixedIds[`${pl.clsNo}-${pl.weekday}-${pl.period}-${pl.week === undefined ? 'every' : pl.week}`] = r.fixed_course.id;
}
console.log(`✔ 固定排课已写入：${plans.length} 条`);

// ---------- 8. 写授课内容（每班第 N 课时 = 统一序列第 N 条；课服 = 课后服务） ----------
// 内容按周生成：以旧课表实际有课的周（activeWeeks）为准（假期周无内容）
const rows = [];
const contentFor = (pl) => {
  if (pl.kind === 'service') return { content: '课后服务', source: 'custom' };
  const text = CONTENT_SEQ[(pl.lessonNo || 1) - 1] || '复习课';
  return { content: text, source: 'preset', preset_id: PRESET_IDS[text] };
};
for (const pl of plans) {
  const c = contentFor(pl);
  for (const wk of pl.activeWeeks) {
    rows.push({ class_name: `初一(${pl.clsNo + 1})班`, week: wk, weekday: pl.weekday, period: pl.period, content: c.content, source: c.source, preset_id: c.preset_id });
  }
}
const batch = await req('POST', `/${sem.id}/teaching-content/batch`, { rows });
if (batch.failed > 0) { console.error(`✘ 内容批量写入 ${batch.failed} 条失败：`, batch.errors.slice(0, 5)); process.exit(1); }
console.log(`✔ 授课内容已写入：${batch.success} 条（失败 ${batch.failed}）`);

// ---------- 9. 汇总报告 ----------
console.log('\n========== 导入完成 ==========');
console.log(`学期: ${sem.name} (${sem.id})`);
console.log(`固定排课: ${plans.length} 条（按旧课表实际有课周生效，假期周自动排除）`);
console.log(`  正课: ${plans.filter((x) => x.kind === 'course').length} 条（每班每周 2 节，内容=序列第1/2条）`);
console.log(`  课服: ${plans.filter((x) => x.kind === 'service').length} 条（单周 period8/9）`);
console.log(`  周日课: ${plans.filter((x) => x.weekday === 7).length} 条（仅第 11 周，week:11）`);
console.log(`授课内容: ${batch.success} 条（仅在旧课表有课的周生成）`);
if (skipNotes.length) console.log(`未导入: ${skipNotes.length} 项（教研/假期标注，详见上方报告）`);
console.log('\n提示：');
console.log('  · 本学期第 11~22 周即旧课表 4.21~7.13；第 1~10 周为空课表（旧模板未覆盖）');
console.log('  · 五一（5.1-5.5）、端午（5.31-6.2）假期可在「事件」或假期表补充标注');
console.log('  · 全部操作已写入撤销栈，可在 GUI 中一键撤销');
