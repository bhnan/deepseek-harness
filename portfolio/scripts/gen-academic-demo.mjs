#!/usr/bin/env node
/**
 * 全科学情演示数据生成器（gen-data.mjs）
 * 生成：4 个初一平行班 × 每班 25 人 × 4 次考试 × 7 科（百分制）+ 总分(700)
 * 固定随机种子，结果可复现；内嵌特征学生设计，保证每个图表区块都有看点。
 * 输出：../全科学情图表演示/data.js  (window.PF_DATA = {...})
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', '..', '..', '全科学情图表演示'); // 工作台根目录/全科学情图表演示
mkdirSync(OUT_DIR, { recursive: true });

/* ---------- 固定种子随机 ---------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260901);
const rand = (min, max) => min + rnd() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const gauss = () => { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (arr) => arr[randInt(0, arr.length - 1)];

/* ---------- 基础设定 ---------- */
const SUBJECTS = ['语文', '数学', '英语', '道德与法治', '历史', '地理', '生物'];
const TOTAL = 700;           // 总分
const TARGET_LINE = 500;     // 目标线（默认）
const PASS_LINE = 420;       // 及格线 = 7 科 × 60
const CLASS_COUNT = 4;
const PER_CLASS = 25;

const CLASS_NAMES = ['初一(1)班', '初一(2)班', '初一(3)班', '初一(4)班'];
// 班级科目偏移：初一(1)班数学明显偏弱（制造“薄弱学科”徽标），(2)班整体略强，(4)班略弱
const CLASS_SUBJECT_OFFSET = [
  { '语文': 1, '数学': -6, '英语': 0, '道德与法治': 1, '历史': -1, '地理': 1, '生物': 1 }, // (1)班：数学短板
  { '语文': 2, '数学': 3, '英语': 3, '道德与法治': 2, '历史': 2, '地理': 2, '生物': 2 }, // (2)班：整体略强
  { '语文': 0, '数学': 0, '英语': 0, '道德与法治': 0, '历史': 0, '地理': 0, '生物': 0 }, // (3)班：居中
  { '语文': -3, '数学': -3, '英语': -3, '道德与法治': -2, '历史': -3, '地理': -3, '生物': -3 }, // (4)班：略弱
];

// 考试：日期 + 难度偏移（分数随学期推进逐渐走高，制造“班级上升趋势”）
const EXAMS = [
  { id: 'e1', name: '分班测试', type: 'placement', date: '2026-09-01', diff: -6 },
  { id: 'e2', name: '第一次月考', type: 'monthly', date: '2026-09-25', diff: -2 },
  { id: 'e3', name: '期中考试', type: 'midterm', date: '2026-10-29', diff: 0 },
  { id: 'e4', name: '第二次月考', type: 'monthly', date: '2026-11-27', diff: 3 },
];

/* ---------- 姓名池 ---------- */
const SURNAMES = '李王张刘陈杨赵黄周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'.split('');
const GIVEN = '雨欣梦琪子涵浩然宇轩梓萱一凡佳怡欣怡思远晓彤志强雅文子豪若曦天佑语桐俊杰思琪嘉豪静怡博文诗涵明轩雨桐晨曦俊熙可欣文博宇航若彤子墨欣妍浩宇语嫣睿哲梦瑶泽宇欣悦锦程紫萱立轩思彤天翊婉婷沐阳慧敏俊宇雨泽佳颖悦宁承宇心怡彦博舒雅亦辰美琳弘毅思源奕辰雨嘉瑞霖若楠启航念慈修远明哲芷晴浩轩语萱峻熙诗语子骞婉清嘉懿熙雯晨宇乐瑶宇哲梦洁凯文思颖浩然'.split('');

function genNames(n) {
  const names = new Set();
  while (names.size < n) {
    const name = pick(SURNAMES) + pick(GIVEN) + pick(GIVEN);
    names.add(name);
  }
  return [...names];
}

/* ---------- 特征学生设计（绑定初一(1)班，保证每个区块有看点） ---------- */
// 每项: {name, gender, birth, profile: {ability, subjectBias, trend, hw}}
// ability: 基线能力(0~1)；subjectBias: 科目个人偏移；trend: 总分级逐场偏移（按科分摊）；hw: 作业完成率
const FEATURED = [
  { name: '张雨欣', gender: '女', birth: '2013-12-08', p: { ability: 0.88, subjectBias: {}, trend: [0, 2, 4, 5], hw: 0.96 } },          // 培优层(~596)
  { name: '李想',   gender: '男', birth: '2014-02-14', p: { ability: 0.72, subjectBias: { '语文': 10, '数学': -8 }, trend: [0, 10, 25, 40], hw: 0.9 } },  // 进步明星：语文强数学弱
  { name: '王浩然', gender: '男', birth: '2013-11-03', p: { ability: 0.68, subjectBias: {}, trend: [0, -1, 1, 0], hw: 0.85 } },        // 稳定
  { name: '赵梦琪', gender: '女', birth: '2014-03-22', p: { ability: 0.52, subjectBias: { '数学': 5 }, trend: [0, 2, 6, 3], hw: 0.88 } },            // 临界优生：距目标线 500 仅 +5
  { name: '陈浩宇', gender: '男', birth: '2013-10-17', p: { ability: 0.72, subjectBias: {}, trend: [0, -10, -40, -70], hw: 0.5 } },     // 明显退步（同类型月考对比 -25 分）+ 作业滑坡
  { name: '刘志强', gender: '男', birth: '2013-12-30', p: { ability: 0.18, subjectBias: { '数学': -4 }, trend: [0, -2, -4, -6], hw: 0.55 } },          // 基础薄弱(<420)
  { name: '王晓峰', gender: '男', birth: '2014-01-19', p: { ability: 0.62, subjectBias: { '数学': -20, '英语': 8, '语文': 5 }, trend: [0, 0, 2, 3], hw: 0.8 } }, // 严重偏科：数学瘸腿，总分临界
  { name: '林晓彤', gender: '女', birth: '2014-04-05', p: { ability: 0.66, subjectBias: { '英语': 10, '数学': -14, '生物': 6 }, trend: [0, 1, 3, 4], hw: 0.87 } }, // 文强理弱
  { name: '孙一凡', gender: '男', birth: '2013-09-27', p: { ability: 0.38, subjectBias: {}, trend: [0, 1, 2, 3], hw: 0.78 } },           // 临界及格(~478)
  { name: '周佳怡', gender: '女', birth: '2014-05-11', p: { ability: 0.8, subjectBias: {}, trend: [0, 1, 2, 3], hw: 0.95 } },           // 稳定优秀
  { name: '吴子豪', gender: '男', birth: '2014-02-27', p: { ability: 0.7, subjectBias: {}, trend: [0, -25, 20, -30], hw: 0.6 } },        // 大幅波动
  { name: '郑雅文', gender: '女', birth: '2013-10-09', p: { ability: 0.53, subjectBias: {}, trend: [0, -1, 2, 1], hw: 0.82 } },         // 稳步上升
];

/* ---------- 生成学生 ---------- */
const students = [];
const classes = CLASS_NAMES.map((name, i) => ({ id: `c${i + 1}`, name, role: i === 0 ? 'homeroom' : 'parallel' }));

for (let ci = 0; ci < CLASS_COUNT; ci++) {
  const cid = `c${ci + 1}`;
  const names = genNames(PER_CLASS);
  for (let si = 0; si < PER_CLASS; si++) {
    // 特征学生只放主班前几位
    const feat = ci === 0 && si < FEATURED.length ? FEATURED[si] : null;
    const studentNo = `2026${String(ci + 1).padStart(2, '0')}${String(si + 1).padStart(2, '0')}`;
    if (feat) {
      students.push({ id: `s${ci * PER_CLASS + si + 1}`, class_id: cid, name: feat.name, student_no: studentNo, gender: feat.gender, birth: feat.birth });
    } else {
      students.push({
        id: `s${ci * PER_CLASS + si + 1}`, class_id: cid,
        name: names[si], student_no: studentNo, gender: rnd() > 0.5 ? '男' : '女',
        birth: `20${randInt(13, 14)}-${String(randInt(9, 12)).padStart(2, '0')}-${String(randInt(1, 28)).padStart(2, '0')}`,
      });
    }
  }
}

/* ---------- 生成成绩 ---------- */
// 每生 latent：由特征或随机；计算各科得分 = 50 + 35*ability + subjectBias + classOffset + examDiff + noise(±6)
const scores = {};   // exam_id -> student_id -> { subject: score, 总分, class_rank, grade_rank }
const homework = {}; // student_id -> compliance 0~1

const studentAbility = {};   // sid -> { ability, bias, trend, hw }
for (const stu of students) {
  const feat = FEATURED.find((f) => f.name === stu.name);
  if (feat && stu.class_id === 'c1') {
    studentAbility[stu.id] = { ...feat.p, ability: feat.p.ability };
  } else {
    studentAbility[stu.id] = {
      ability: clamp(0.62 + gauss() * 0.13, 0.18, 0.96),
      subjectBias: {},
      trend: [0, rand(-6, 6), rand(-10, 10), rand(-14, 14)], // 总分级偏移
      hw: clamp(0.82 + (gauss() * 0.12) + 0, 0.4, 0.99),
    };
  }
}
// 作业完成率与成绩的关联由 ability 隐含（ability 高的 hw 也高），再加噪声

for (const ex of EXAMS) {
  scores[ex.id] = {};
  const exIdx = EXAMS.indexOf(ex);
  for (const stu of students) {
    const prof = studentAbility[stu.id];
    const classOff = CLASS_SUBJECT_OFFSET[Number(stu.class_id.slice(1)) - 1];
    const row = {};
    let total = 0;
    for (const sub of SUBJECTS) {
      const bias = prof.subjectBias[sub] || 0;
      const raw = 50 + 35 * prof.ability + bias + classOff[sub] + ex.diff + prof.trend[exIdx] / SUBJECTS.length + gauss() * 5.5;
      const score = Math.round(clamp(raw, 8, 99.5));
      row[sub] = score;
      total += score;
    }
    row['总分'] = total;
    scores[ex.id][stu.id] = row;
  }
  // 排名（按总分；同分按姓名序）
  const list = students.map((s) => ({ sid: s.id, total: scores[ex.id][s.id]['总分'], name: s.name }));
  list.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
  const classGroups = {};
  list.forEach((item, i) => {
    scores[ex.id][item.sid].grade_rank = i + 1;
    const cid = students.find((s) => s.id === item.sid).class_id;
    (classGroups[cid] = classGroups[cid] || []).push(item);
  });
  for (const cid of Object.keys(classGroups)) {
    classGroups[cid].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
    classGroups[cid].forEach((item, i) => { scores[ex.id][item.sid].class_rank = i + 1; });
  }
  // 作业完成率（随考试固定一份）
  if (ex.id === 'e4') {
    for (const stu of students) {
      const prof = studentAbility[stu.id];
      homework[stu.id] = Math.round(clamp(prof.hw + gauss() * 0.05, 0.3, 0.99) * 100) / 100;
    }
  }
}

/* ---------- 输出 ---------- */
const data = {
  meta: {
    school: '示例初中 · 2026 秋季学期', grade: '初一', sem: '2026 秋',
    subjects: SUBJECTS, total_subject: TOTAL, target_line: TARGET_LINE, pass_line: PASS_LINE,
    seg_subject: ['<60', '60-69', '70-79', '80-89', '>=90'],
    seg_total: ['<400', '400-449', '450-499', '500-549', '>=550'],
    tier: { top: 0.25, mid: 0.5, bottom: 0.25 },
  },
  classes, exams: EXAMS, students, scores, homework,
};

const js = `/* 自动生成于 ${new Date().toISOString()} —— 运行 gen-data.mjs 可复现 */\nwindow.PF_DATA = ${JSON.stringify(data)};\n`;
writeFileSync(join(OUT_DIR, 'data.js'), js, 'utf8');

// 摘要输出
const c1 = students.filter((s) => s.class_id === 'c1');
const e4 = scores['e4'];
console.log('✅ data.js 已生成 →', join(OUT_DIR, 'data.js'));
console.log('班级数:', classes.length, '| 学生数:', students.length, '| 考试:', EXAMS.map((e) => e.name).join(' / '));
console.log('主班初一(1)班最近考试均分:', Math.round(c1.reduce((a, s) => a + e4[s.id]['总分'], 0) / c1.length));
console.log('年级最近考试均分:', Math.round(students.reduce((a, s) => a + e4[s.id]['总分'], 0) / students.length));
const featured = FEATURED.map((f) => f.name).join('、');
console.log('特征学生(初一1班):', featured);
