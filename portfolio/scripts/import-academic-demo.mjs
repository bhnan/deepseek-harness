#!/usr/bin/env node
/**
 * 演示学生名单批量导入脚本（import-academic-demo.mjs）
 * 读取 ../全科学情图表演示/data.js 的预设数据，通过 portfolio API 导入：
 * - 创建 4 个平行班（role=homeroom；避开库中已有班级名）
 * - 每班 25 名学生（姓名/学号/性别/出生年月 + 补充信息：住校/压力等级/家长信息/特征备注）
 * 前置：portfolio server 已启动（默认 http://127.0.0.1:8797）
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = process.env.PF_API || 'http://127.0.0.1:8797/api/portfolio';

/* ---------- 读取演示数据 ---------- */
const dataJs = readFileSync(join(__dirname, '..', '..', '..', '全科学情图表演示', 'data.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(dataJs, sandbox);
const D = sandbox.window.PF_DATA;

/* 班级名映射：演示 c1~c4 → 库中班级名（避开已存在的 初一(3)班 / 初一(5)班·班主任） */
const CLASS_NAME_MAP = { c1: '初一(1)班', c2: '初一(2)班', c3: '初一(4)班', c4: '初一(6)班' };

/* ---------- 补充信息生成（固定种子，可复现） ---------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260823);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const randInt = (min, max) => Math.floor(min + rnd() * (max - min + 1));

const SURNAMES = '李王张刘陈杨赵黄周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'.split('');
const PARENT_GIVEN = ['建国', '秀英', '志强', '桂兰', '建华', '秀兰', '国栋', '玉梅', '文军', '丽华', '海燕', '永刚', '春梅', '国庆', '红梅', '建军', '小燕', '国强', '凤英', '德明'];
const DISTRICT = ['滨江小区', '阳光花园', '学府名苑', '锦绣家园', '望江公寓', '文景苑', '绿城桂园', '书香雅苑', '安居花苑', '青竹里'];
const makePhone = () => `13${randInt(0, 9)}${randInt(10000000, 99999999)}`;
const makeIdCard = (birth) => {
  const y = birth.slice(0, 4), m = birth.slice(5, 7), d = birth.slice(8, 10);
  return `${randInt(110101, 510999)}${y}${m}${d}${randInt(100, 999)}${pick(['1', '3', '5', '7', '9', 'X'])}`;
};

/* 特征学生（初一(1)班）的补充信息设计 */
const FEATURE_EXTRA = {
  '张雨欣': { pressure_level: '低', is_boarding: 0, manage_note: '自律性强，班级学习委员，可承担帮带任务' },
  '李想':   { pressure_level: '低', is_boarding: 0, manage_note: '本学期进步明显（483→571），语文突出，数学需持续跟进' },
  '王浩然': { pressure_level: '中', is_boarding: 0 },
  '赵梦琪': { pressure_level: '中', is_boarding: 1, manage_note: '总分距目标线 500 仅 10 分，临界生重点跟进对象' },
  '陈浩宇': { pressure_level: '高', is_boarding: 1, special_note: '近两次考试持续退步且作业完成率下滑，建议家校联动，关注情绪状态' },
  '刘志强': { pressure_level: '高', is_boarding: 1, special_note: '基础薄弱，数学低于班均 20 分以上，需安排基础补差' },
  '王晓峰': { pressure_level: '中', is_boarding: 0, manage_note: '总分靠前但数学严重偏科（55 分），建议与数学老师协同辅导' },
  '林晓彤': { pressure_level: '中', is_boarding: 1 },
  '孙一凡': { pressure_level: '中', is_boarding: 0 },
  '周佳怡': { pressure_level: '低', is_boarding: 0 },
  '吴子豪': { pressure_level: '高', is_boarding: 1, special_note: '成绩波动大（三次考试差 60 分以上），关注考试心态与作息' },
  '郑雅文': { pressure_level: '中', is_boarding: 0 },
};

function buildRow(stu, cid) {
  const extra = FEATURE_EXTRA[stu.name] || {};
  const r = rnd();
  const row = {
    name: stu.name,
    student_no: stu.student_no,
    gender: stu.gender || '',
    birth_date: stu.birth,
    school_id: stu.student_no,
    is_boarding: extra.is_boarding !== undefined ? extra.is_boarding : (r < 0.22 ? 1 : 0),
    pressure_level: extra.pressure_level || (r < 0.15 ? '低' : r < 0.85 ? '中' : '高'),
    parent1_name: pick(SURNAMES) + pick(PARENT_GIVEN),
    parent1_phone: makePhone(),
    parent2_name: pick(SURNAMES) + pick(PARENT_GIVEN),
    parent2_phone: makePhone(),
    address: `${pick(DISTRICT)} ${randInt(1, 88)}栋${randInt(1, 6)}单元${randInt(101, 2601)}室`,
    id_card: makeIdCard(stu.birth),
    manage_note: extra.manage_note || '',
    special_note: extra.special_note || '',
    allergy_note: '',
  };
  return row;
}

/* ---------- API 工具 ---------- */
async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

/* ---------- 主流程 ---------- */
const cidByName = new Map();
let created = 0, skipped = 0;
for (const c of D.classes) {
  const name = CLASS_NAME_MAP[c.id];
  const existed = await req('GET', '/classes').then((d) => d.classes.find((x) => x.name === name));
  if (existed) { cidByName.set(c.id, existed.id); skipped++; continue; }
  const d = await req('POST', '/classes', { name, grade: '初一', stage: 'middle', role: 'homeroom' });
  cidByName.set(c.id, d.class.id);
  created++;
}
console.log(`📚 班级：新建 ${created} 个，已存在跳过 ${skipped} 个`);

let totalImported = 0, totalFailed = 0;
for (const c of D.classes) {
  const cid = cidByName.get(c.id);
  const stus = D.students.filter((s) => s.class_id === c.id);
  const rows = stus.map((s) => buildRow(s, c.id));
  const r = await req('POST', `/classes/${cid}/students/import`, { rows });
  totalImported += r.imported; totalFailed += r.failed;
  console.log(`👥 ${CLASS_NAME_MAP[c.id]}：导入 ${r.imported} 人${r.failed ? `，失败 ${r.failed} 行` : ''}${r.errors?.length ? `（${r.errors.map((e) => `行${e.row}:${e.reason}`).join('；')}）` : ''}`);
  // 检查学生总数
  const chk = await req('GET', `/classes/${cid}/students?page_size=500`);
  console.log(`   → 现班级学生数：${chk.total}`);
}

console.log(`\n✅ 完成：共导入 ${totalImported} 人，失败 ${totalFailed} 行`);
const all = await req('GET', '/classes');
for (const c of all.classes) {
  const n = await req('GET', `/classes/${c.id}/students?page_size=1`);
  console.log(`  ${c.name}（${c.role}）：${n.total} 人`);
}
