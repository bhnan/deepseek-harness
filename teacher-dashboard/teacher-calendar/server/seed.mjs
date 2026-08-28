// 种子数据：首次启动初始化（内置静态词库 + 示例数据 + 节假日表）
import { writeJSON, exists, listSemesters, getSemester, genId, P } from './storage.mjs';
import { EDUCATION_PROVERB, CLASSIC_POETRY, EDUCATION_PHILOSOPHY, EDUCATION_THEORY, EDUCATION_PSYCHOLOGY } from './culture_data.mjs';

const HOLIDAYS = [
  { name: '元旦', start_date: '2027-01-01', end_date: '2027-01-03' },
  { name: '春节', start_date: '2027-02-06', end_date: '2027-02-12' },
  { name: '清明节', start_date: '2026-04-04', end_date: '2026-04-06' },
  { name: '劳动节', start_date: '2026-05-01', end_date: '2026-05-05' },
  { name: '端午节', start_date: '2026-06-19', end_date: '2026-06-21' },
  { name: '中秋节', start_date: '2026-09-25', end_date: '2026-09-27' },
  { name: '国庆节', start_date: '2026-10-01', end_date: '2026-10-07' },
];

// 二十四节气（kind: 'solar'：仅日历展示，不停课；日期为天文历计算结果，北京时间）
const SOLAR_TERMS = [
  { name: '小寒', start_date: '2026-01-05', end_date: '2026-01-05', kind: 'solar' },
  { name: '大寒', start_date: '2026-01-20', end_date: '2026-01-20', kind: 'solar' },
  { name: '立春', start_date: '2026-02-04', end_date: '2026-02-04', kind: 'solar' },
  { name: '雨水', start_date: '2026-02-18', end_date: '2026-02-18', kind: 'solar' },
  { name: '惊蛰', start_date: '2026-03-05', end_date: '2026-03-05', kind: 'solar' },
  { name: '春分', start_date: '2026-03-20', end_date: '2026-03-20', kind: 'solar' },
  { name: '清明', start_date: '2026-04-05', end_date: '2026-04-05', kind: 'solar' },
  { name: '谷雨', start_date: '2026-04-20', end_date: '2026-04-20', kind: 'solar' },
  { name: '立夏', start_date: '2026-05-05', end_date: '2026-05-05', kind: 'solar' },
  { name: '小满', start_date: '2026-05-21', end_date: '2026-05-21', kind: 'solar' },
  { name: '芒种', start_date: '2026-06-05', end_date: '2026-06-05', kind: 'solar' },
  { name: '夏至', start_date: '2026-06-21', end_date: '2026-06-21', kind: 'solar' },
  { name: '小暑', start_date: '2026-07-07', end_date: '2026-07-07', kind: 'solar' },
  { name: '大暑', start_date: '2026-07-23', end_date: '2026-07-23', kind: 'solar' },
  { name: '立秋', start_date: '2026-08-07', end_date: '2026-08-07', kind: 'solar' },
  { name: '处暑', start_date: '2026-08-23', end_date: '2026-08-23', kind: 'solar' },
  { name: '白露', start_date: '2026-09-07', end_date: '2026-09-07', kind: 'solar' },
  { name: '秋分', start_date: '2026-09-23', end_date: '2026-09-23', kind: 'solar' },
  { name: '寒露', start_date: '2026-10-08', end_date: '2026-10-08', kind: 'solar' },
  { name: '霜降', start_date: '2026-10-23', end_date: '2026-10-23', kind: 'solar' },
  { name: '立冬', start_date: '2026-11-07', end_date: '2026-11-07', kind: 'solar' },
  { name: '小雪', start_date: '2026-11-22', end_date: '2026-11-22', kind: 'solar' },
  { name: '大雪', start_date: '2026-12-07', end_date: '2026-12-07', kind: 'solar' },
  { name: '冬至', start_date: '2026-12-22', end_date: '2026-12-22', kind: 'solar' },
  { name: '小寒', start_date: '2027-01-05', end_date: '2027-01-05', kind: 'solar' },
  { name: '大寒', start_date: '2027-01-20', end_date: '2027-01-20', kind: 'solar' },
  { name: '立春', start_date: '2027-02-04', end_date: '2027-02-04', kind: 'solar' },
  { name: '雨水', start_date: '2027-02-19', end_date: '2027-02-19', kind: 'solar' },
  { name: '惊蛰', start_date: '2027-03-06', end_date: '2027-03-06', kind: 'solar' },
  { name: '春分', start_date: '2027-03-21', end_date: '2027-03-21', kind: 'solar' },
  { name: '清明', start_date: '2027-04-05', end_date: '2027-04-05', kind: 'solar' },
  { name: '谷雨', start_date: '2027-04-20', end_date: '2027-04-20', kind: 'solar' },
  { name: '立夏', start_date: '2027-05-06', end_date: '2027-05-06', kind: 'solar' },
  { name: '小满', start_date: '2027-05-21', end_date: '2027-05-21', kind: 'solar' },
  { name: '芒种', start_date: '2027-06-06', end_date: '2027-06-06', kind: 'solar' },
  { name: '夏至', start_date: '2027-06-21', end_date: '2027-06-21', kind: 'solar' },
  { name: '小暑', start_date: '2027-07-07', end_date: '2027-07-07', kind: 'solar' },
  { name: '大暑', start_date: '2027-07-23', end_date: '2027-07-23', kind: 'solar' },
  { name: '立秋', start_date: '2027-08-08', end_date: '2027-08-08', kind: 'solar' },
  { name: '处暑', start_date: '2027-08-23', end_date: '2027-08-23', kind: 'solar' },
  { name: '白露', start_date: '2027-09-08', end_date: '2027-09-08', kind: 'solar' },
  { name: '秋分', start_date: '2027-09-23', end_date: '2027-09-23', kind: 'solar' },
  { name: '寒露', start_date: '2027-10-08', end_date: '2027-10-08', kind: 'solar' },
  { name: '霜降', start_date: '2027-10-23', end_date: '2027-10-23', kind: 'solar' },
  { name: '立冬', start_date: '2027-11-07', end_date: '2027-11-07', kind: 'solar' },
  { name: '小雪', start_date: '2027-11-22', end_date: '2027-11-22', kind: 'solar' },
  { name: '大雪', start_date: '2027-12-07', end_date: '2027-12-07', kind: 'solar' },
  { name: '冬至', start_date: '2027-12-22', end_date: '2027-12-22', kind: 'solar' },
];

// 纪念日/非放假节日（kind: 'festival'：仅日历展示，不停课）
const FESTIVALS = [
  { name: '学雷锋纪念日', start_date: '2026-03-05', end_date: '2026-03-05', kind: 'festival' },
  { name: '全民国家安全教育日', start_date: '2026-04-15', end_date: '2026-04-15', kind: 'festival' },
  { name: '中国航天日', start_date: '2026-04-24', end_date: '2026-04-24', kind: 'festival' },
  { name: '全国防灾减灾日', start_date: '2026-05-12', end_date: '2026-05-12', kind: 'festival' },
  { name: '国际禁毒日', start_date: '2026-06-26', end_date: '2026-06-26', kind: 'festival' },
  { name: '中国人民抗日战争胜利纪念日', start_date: '2026-09-03', end_date: '2026-09-03', kind: 'festival' },
  { name: '教师节', start_date: '2026-09-10', end_date: '2026-09-10', kind: 'festival' },
  { name: '九一八事变纪念日', start_date: '2026-09-18', end_date: '2026-09-18', kind: 'festival' },
  { name: '烈士纪念日', start_date: '2026-09-30', end_date: '2026-09-30', kind: 'festival' },
  { name: '国家宪法日', start_date: '2026-12-04', end_date: '2026-12-04', kind: 'festival' },
  { name: '南京大屠杀死难者国家公祭日', start_date: '2026-12-13', end_date: '2026-12-13', kind: 'festival' },
  { name: '学雷锋纪念日', start_date: '2027-03-05', end_date: '2027-03-05', kind: 'festival' },
  { name: '全民国家安全教育日', start_date: '2027-04-15', end_date: '2027-04-15', kind: 'festival' },
  { name: '中国航天日', start_date: '2027-04-24', end_date: '2027-04-24', kind: 'festival' },
  { name: '全国防灾减灾日', start_date: '2027-05-12', end_date: '2027-05-12', kind: 'festival' },
  { name: '国际禁毒日', start_date: '2027-06-26', end_date: '2027-06-26', kind: 'festival' },
  { name: '中国人民抗日战争胜利纪念日', start_date: '2027-09-03', end_date: '2027-09-03', kind: 'festival' },
  { name: '教师节', start_date: '2027-09-10', end_date: '2027-09-10', kind: 'festival' },
  { name: '九一八事变纪念日', start_date: '2027-09-18', end_date: '2027-09-18', kind: 'festival' },
  { name: '烈士纪念日', start_date: '2027-09-30', end_date: '2027-09-30', kind: 'festival' },
  { name: '国家宪法日', start_date: '2027-12-04', end_date: '2027-12-04', kind: 'festival' },
  { name: '南京大屠杀死难者国家公祭日', start_date: '2027-12-13', end_date: '2027-12-13', kind: 'festival' },
];

// 素养词库（五类共 180 条，来源 server/culture_data.mjs；覆盖一学期 100+ 教学日不重复）
const CULTURE = [...EDUCATION_PROVERB, ...CLASSIC_POETRY, ...EDUCATION_PHILOSOPHY, ...EDUCATION_THEORY, ...EDUCATION_PSYCHOLOGY];

// 授课内容预设词库（D4 词库下拉）
const PRESETS = [
  { id: 'tp-01', text: '第一课·中学时代', tags: ['七年级', '第一课'], created_at: '2026-08-19' },
  { id: 'tp-02', text: '少年有梦', tags: ['七年级', '梦想'], created_at: '2026-08-19' },
  { id: 'tp-03', text: '学习伴成长', tags: ['七年级', '学习'], created_at: '2026-08-19' },
  { id: 'tp-04', text: '享受学习', tags: ['七年级', '学习'], created_at: '2026-08-19' },
  { id: 'tp-05', text: '认识自己', tags: ['七年级', '自我'], created_at: '2026-08-19' },
  { id: 'tp-06', text: '做更好的自己', tags: ['七年级', '自我'], created_at: '2026-08-19' },
  { id: 'tp-07', text: '和朋友在一起', tags: ['七年级', '友谊'], created_at: '2026-08-19' },
  { id: 'tp-08', text: '友谊与成长同行', tags: ['七年级', '友谊'], created_at: '2026-08-19' },
  { id: 'tp-09', text: '遵守规则与法律', tags: ['四年级', '规则'], created_at: '2026-08-19' },
  { id: 'tp-10', text: '我们班规我们定', tags: ['四年级', '规则'], created_at: '2026-08-19' },
  { id: 'tp-11', text: '校园里的规则', tags: ['四年级', '规则'], created_at: '2026-08-19' },
  { id: 'tp-12', text: '复习课', tags: ['通用', '复习'], created_at: '2026-08-19' },
  { id: 'tp-13', text: '练习与讲评', tags: ['通用', '练习'], created_at: '2026-08-19' },
  { id: 'tp-14', text: '单元小结', tags: ['通用', '小结'], created_at: '2026-08-19' },
];

function seedClasses() {
  // 两学段分色系（避免跨学段撞色）：初中=莫兰迪色系（低饱和灰调），小学=马卡龙色系（明亮柔和）
  const classes = [
    { id: 'cls-cy1', stage: 'middle', name: '初一(1)班', color: '#A3B8C4' }, // 莫兰迪·雾霾蓝
    { id: 'cls-cy2', stage: 'middle', name: '初一(2)班', color: '#9CAF88' }, // 莫兰迪·灰豆绿
    { id: 'cls-cy3', stage: 'middle', name: '初一(3)班', color: '#C4A6A0' }, // 莫兰迪·灰豆沙
    { id: 'cls-cy4', stage: 'middle', name: '初一(4)班', color: '#B5A8CC' }, // 莫兰迪·灰紫
    { id: 'cls-cy5', stage: 'middle', name: '初一(5)班', color: '#C9B896' }, // 莫兰迪·燕麦黄
    { id: 'cls-xs1', stage: 'primary', name: '四(1)班', color: '#F5A9B8' }, // 马卡龙·樱花粉
    { id: 'cls-xs2', stage: 'primary', name: '四(2)班', color: '#A8D8EA' }, // 马卡龙·天空蓝
    { id: 'cls-xs3', stage: 'primary', name: '四(3)班', color: '#F9D976' }, // 马卡龙·柠檬黄
  ];
  writeJSON(P.classes, classes);
  return classes;
}

function seedSemester(semester, classes) {
  const sid = semester.id;
  const mk = (prefix) => `${prefix}-${sid}`;
  // 固定排课（每周复用）：初一各班每周 2 节，四年级各班每周 2 节
  const fixed = [];
  const cy = classes.filter((c) => c.stage === 'middle');
  const xs = classes.filter((c) => c.stage === 'primary');
  const cySlots = [
    { weekday: 1, period: 1 }, { weekday: 3, period: 2 },
    { weekday: 1, period: 3 }, { weekday: 4, period: 1 },
    { weekday: 2, period: 2 }, { weekday: 5, period: 3 },
    { weekday: 2, period: 4 }, { weekday: 4, period: 4 },
    { weekday: 3, period: 5 }, { weekday: 5, period: 1 },
  ];
  const xsSlots = [
    { weekday: 1, period: 2 }, { weekday: 3, period: 3 },
    { weekday: 2, period: 1 }, { weekday: 4, period: 2 },
    { weekday: 1, period: 4 }, { weekday: 5, period: 2 },
  ];
  let n = 0;
  for (let i = 0; i < cy.length; i++) {
    const s = cySlots[i % cySlots.length];
    fixed.push({ id: `fc-${mk('a')}-${n++}`, class_id: cy[i].id, weekday: s.weekday, period: s.period });
  }
  for (let i = 0; i < xs.length; i++) {
    const s = xsSlots[i % xsSlots.length];
    fixed.push({ id: `fc-${mk('b')}-${n++}`, class_id: xs[i].id, weekday: s.weekday, period: s.period });
  }
  writeJSON(P.sid(sid, 'fixed_courses.json'), fixed);
  writeJSON(P.sid(sid, 'temporary_changes.json'), []);
  // 授课内容（用户确认语义）：同一学段各班第 N 节课内容完全一致，只是上课时间不同
  // 每班第 1 课时位 = 该学段序列第 1 条，第 2 课时位 = 第 2 条……（按课时序号对齐）
  const contents = [];
  const middleSeq = ['第一课·中学时代', '少年有梦', '学习伴成长', '享受学习', '认识自己'];
  const primarySeq = ['我们班规我们定', '校园里的规则', '遵守规则与法律'];
  fixed.forEach((f, slotNo) => {
    const c = classes.find((x) => x.id === f.class_id);
    if (!c) return;
    const seq = c.stage === 'middle' ? middleSeq : primarySeq;
    const presetMap = { '第一课·中学时代': 'tp-01', '少年有梦': 'tp-02', '学习伴成长': 'tp-03', '享受学习': 'tp-04', '认识自己': 'tp-05', '我们班规我们定': 'tp-10', '校园里的规则': 'tp-11', '遵守规则与法律': 'tp-09' };
    // slotNo = 该班第几节课（0 起）；每班第 1 节课都用序列第 1 条，保证各班一致
    const text = seq[0];
    contents.push({
      id: genId('tc'), class_id: f.class_id, week: 1, weekday: f.weekday, period: f.period,
      content: text, source: 'preset', preset_id: presetMap[text] || null,
      created_at: '2026-08-19', updated_at: '2026-08-19',
    });
  });
  writeJSON(P.sid(sid, 'teaching_content.json'), contents);
  // 事件（含生日归入事件体系 + 五要素详情示例）
  const events = [
    { id: genId('ev'), type: 'activity', title: '期中考试', date: '2026-11-05', time: '08:00-11:30', location: '各班教室', participants: '初一、四年级全体', notes: '提前 20 分钟领卷', requirements: '监考老师佩戴监考证', color: '#4A90D9', done: false, created_at: '2026-08-19', updated_at: '2026-08-19' },
    { id: genId('ev'), type: 'activity', title: '秋季运动会', date: '2026-11-12', time: '08:00-11:30', location: '学校操场', participants: '初一(1)-(5)班全体师生', notes: '8:00 前集合完毕、穿运动服、阴雨转室内', requirements: '梁老师 9:30 检录处裁判、提前 10 分钟到场', color: '#7FB069', done: false, created_at: '2026-08-19', updated_at: '2026-08-19' },
    { id: genId('ev'), type: 'activity', title: '家长会', date: '2026-11-20', time: '15:30-17:00', location: '初一(1)班教室', participants: '初一(1)班家长', notes: '准备期中成绩单', requirements: '会后一对一交流 17:00-17:30', color: '#E8A33D', done: false, created_at: '2026-08-19', updated_at: '2026-08-19' },
    { id: genId('ev'), type: 'course', title: '提交教研组学期计划', date: '2026-09-10', time: '下班前', location: '', participants: '', notes: '', requirements: '含跨年级排课说明', color: '#8E7CC3', done: false, created_at: '2026-08-19', updated_at: '2026-08-19' },
  ];
  writeJSON(P.sid(sid, 'events.json'), events);
  // 生日（--MM-DD 无年日期）
  const birthdays = [
    { id: genId('bd'), role: 'student', name: '李想', birthday: '--09-01', class_id: 'cls-cy1', note: '' },
    { id: genId('bd'), role: 'student', name: '张小雨', birthday: '--10-25', class_id: 'cls-xs1', note: '' },
    { id: genId('bd'), role: 'teacher', name: '梁老师', birthday: '--09-15', class_id: null, note: '' },
  ];
  writeJSON(P.sid(sid, 'birthdays.json'), birthdays);
  writeJSON(P.sid(sid, 'push_state.json'), { by_date: {}, pushed_ids: [], round: 1, updated_at: null });
}

export function seedIfEmpty() {
  if (!exists(P.semesters)) {
    const semesters = [
      { id: '2026-autumn-1', name: '2026年秋季第一学期', year: 2026, season: 'autumn', semester_index: 1, start_date: '2026-09-01', end_date: '2027-01-17' },
      { id: '2026-spring-2', name: '2026年春季第二学期', year: 2026, season: 'spring', semester_index: 2, start_date: '2026-02-22', end_date: '2026-07-06' },
    ];
    writeJSON(P.semesters, semesters);
    const classes = seedClasses();
    for (const s of semesters) seedSemester(s, classes);
  }
  if (!exists(P.culture)) {
    writeJSON(P.culture, { schema_version: '1.0', data: { items: CULTURE } });
  }
  if (!exists(P.presets)) {
    writeJSON(P.presets, { schema_version: '1.0', data: { items: PRESETS } });
  }
  if (!exists(P.holidays)) {
    writeJSON(P.holidays, { schema_version: '1.0', data: { items: [...HOLIDAYS, ...SOLAR_TERMS, ...FESTIVALS] } });
  }
  if (!exists(P.theme)) {
    writeJSON(P.theme, {
      schema_version: '1.0', themes: {
        fresh: { name: '经典小清新', day_bg: { workday: '#F4F9F7', weekend_holiday: '#FBF1E6', today: '#E3F2FD' }, course_area_today_bg: '#E3F2FD', font: 'system-ui', accent: '#4A90D9' },
        guofeng: { name: '国风雅致风', day_bg: { workday: '#F7F4EE', weekend_holiday: '#EFE6D8', today: '#E8DFD0' }, course_area_today_bg: '#E8DFD0', font: 'STSong, serif', accent: '#8C6E4A' },
        minimal: { name: '极简艺术风', day_bg: { workday: '#FAFAFA', weekend_holiday: '#F0F0F0', today: '#E8E8E8' }, course_area_today_bg: '#E8E8E8', font: 'system-ui', accent: '#333333' },
        tech: { name: '轻量科技风', day_bg: { workday: '#F2F6FA', weekend_holiday: '#E8EEF5', today: '#DCE9F7' }, course_area_today_bg: '#DCE9F7', font: 'system-ui', accent: '#2C6FBB' },
        warm: { name: '温柔治愈暖风', day_bg: { workday: '#FDF6F2', weekend_holiday: '#F9E8DE', today: '#F5DDD0' }, course_area_today_bg: '#F5DDD0', font: 'system-ui', accent: '#C97B84' },
      },
    });
  }
  if (!exists(P.settings)) {
    const semesters = listSemesters();
    writeJSON(P.settings, {
      current_semester_id: semesters[0] ? semesters[0].id : null,
      preferred_view: 'week', theme_id: 'fresh',
      undo_stack: [], redo_stack: [], updated_at: null,
    });
  }
  return { seeded: true, semesters: listSemesters() };
}
