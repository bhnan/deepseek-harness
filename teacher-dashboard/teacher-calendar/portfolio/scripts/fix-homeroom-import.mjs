#!/usr/bin/env node
/**
 * 修正脚本：恢复「1 个班主任班 + N 个代课班」模型
 * 1. 删除误建的 4 个平行主班（初一(1)/(2)/(4)/(6)班，级联删除其预设学生）
 * 2. 将预设名单（含特征学生的 25 人，源自 全科学情图表演示/data.js 的 c1 班）
 *    导入班主任班「初一(5)班·班主任」，学号重编为 20260201~20260225（避开现有 202601xx）
 * 3. 清空 undo 栈（准备阶段的演示操作不入撤销栈，避免误恢复）
 * 前置：portfolio server 已启动（http://127.0.0.1:8797）
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = process.env.PF_API || 'http://127.0.0.1:8797/api/portfolio';
const DB = join(__dirname, '..', 'data', 'student-portfolio.db');
const MISTAKEN = ['初一(1)班', '初一(2)班', '初一(4)班', '初一(6)班']; // 误建班级名
const HOMEROOM = '初一(5)班·班主任';

/* ---------- 读取演示数据（c1 班 25 人） ---------- */
const dataJs = readFileSync(join(__dirname, '..', '..', '..', '全科学情图表演示', 'data.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(dataJs, sandbox);
const D = sandbox.window.PF_DATA;
const C1_STUDENTS = D.students.filter((s) => s.class_id === 'c1').sort((a, b) => a.student_no.localeCompare(b.student_no));

/* ---------- 补充信息生成（与 import-academic-demo.mjs 同种子，保证可复现） ---------- */
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
const makeIdCard = (birth) => `${randInt(110101, 510999)}${birth.replaceAll('-', '')}${randInt(100, 999)}${pick(['1', '3', '5', '7', '9', 'X'])}`;

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

function buildRow(stu, newNo) {
  const extra = FEATURE_EXTRA[stu.name] || {};
  const r = rnd();
  return {
    name: stu.name,
    student_no: newNo, // 重编号：20260201~20260225
    gender: stu.gender || '',
    birth_date: stu.birth,
    school_id: newNo,
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
// 1. 删除误建班级
const all = await req('GET', '/classes');
const toDelete = all.classes.filter((c) => MISTAKEN.includes(c.name));
for (const c of toDelete) {
  await req('DELETE', `/classes/${c.id}`, { confirm_name: c.name });
  console.log(`🗑 已删除误建班级：${c.name}`);
}

// 2. 导入 25 人到班主任班（学号重编）
const hr = all.classes.find((c) => c.name === HOMEROOM);
const rows = C1_STUDENTS.map((s, i) => buildRow(s, `202602${String(i + 1).padStart(2, '0')}`));
const r = await req('POST', `/classes/${hr.id}/students/import`, { rows });
console.log(`👥 导入班主任班「${HOMEROOM}」：${r.imported} 人${r.failed ? `，失败 ${r.failed}：${r.errors?.map((e) => `行${e.row} ${e.reason}`).join('；')}` : ''}`);

// 3. 清空 undo 栈（准备阶段的演示操作不入撤销栈）
const db = new DatabaseSync(DB);
const n = db.prepare('DELETE FROM undo_log').run().changes;
db.close();
console.log(`🧹 清空撤销栈：${n} 条`);

// 4. 验证
const after = await req('GET', '/classes');
for (const c of after.classes) {
  const s = await req('GET', `/classes/${c.id}/students?page_size=1`);
  console.log(`  ${c.name}（${c.role}）：${s.total} 人`);
}
const hrStu = await req('GET', `/classes/${hr.id}/students?page_size=100`);
console.log(`\n班主任班学生：${hrStu.students.map((x) => `${x.student_no} ${x.name}`).join('、')}`);
