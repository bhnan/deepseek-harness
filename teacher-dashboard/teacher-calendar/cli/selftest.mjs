// tc CLI 离线自测（plan §4：无第三方依赖，node cli/selftest.mjs 直接运行）
// 覆盖：CSV 解析/长宽表识别/成绩行规范化/参数解析/解析器消歧/周数引擎/退出码映射
// 加 --live 附加探测真实服务连通（只读）。

import assert from 'node:assert/strict';
import { parseCSV, detectScoreFormat, gridToScoreRows, normalizeScoreRows, scoreRangeCheck } from './lib/csv.mjs';
import { TcError, exitCodeOf, envelopeFromError } from './lib/api.mjs';
import { resolveSemester, resolveStudent } from './lib/resolve.mjs';
import { parseArgs, parseWeekField } from './lib/commands.mjs';
import { weekIndexOf } from '../src/engine/week.js';

let pass = 0;
const pending = [];
const t = async (name, fn) => {
  const r = fn();
  if (r && typeof r.then === 'function') {
    await r.then(() => { pass++; console.log(`  ✓ ${name}`); });
  } else {
    pass++;
    console.log(`  ✓ ${name}`);
  }
};

console.log('— CSV 基础 —');
await t('BOM/CRLF/引号转义', () => {
  const g = parseCSV('\ufeff姓名,科目,分数\r\n"张,三",道法,95\r\n');
  assert.deepEqual(g, [['姓名', '科目', '分数'], ['张,三', '道法', '95']]);
});
await t('末尾空行剔除', () => {
  assert.equal(parseCSV('a,b\n1,2\n\n\n').length, 2);
});

console.log('— 长/宽表识别与转换 —');
await t('长表识别', () => {
  assert.equal(detectScoreFormat(['姓名', '科目', '分数', '班级排名']), 'long');
});
await t('长表转换 + 排名 + 原始行号', () => {
  const { rows, errors } = gridToScoreRows(parseCSV('姓名,科目,分数,班级排名\n张三,道法,95,1\n李四,总分,180,2\n'));
  assert.equal(errors.length, 0);
  assert.deepEqual(rows, [
    { student_name: '张三', subject: '道法', score: 95, class_rank: 1, grade_rank: undefined, _src_row: 2 },
    { student_name: '李四', subject: '总分', score: 180, class_rank: 2, grade_rank: undefined, _src_row: 3 },
  ]);
});
await t('审查修复回归：长表空分数 → 报错而非静默 0 分', () => {
  const { rows, errors } = gridToScoreRows(parseCSV('姓名,科目,分数\n张三,道法,\n'));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /分数缺失/);
});
await t('宽表识别（保留列不算科目）', () => {
  assert.equal(detectScoreFormat(['姓名', '学号', '道法', '总分']), 'wide');
});
await t('宽表转换：稀疏空格跳过、坏分数报错', () => {
  const { rows, errors } = gridToScoreRows(parseCSV('姓名,道法,历史\n张三,95,\n李四,abc,88\n'));
  assert.equal(rows.length, 2); // 张三道法 + 李四历史
  assert.deepEqual(rows[0], { student_name: '张三', subject: '道法', score: 95, _src_row: 2 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /道法 分数非法/);
});
await t('无表头结构 → 结构性错误', () => {
  const { errors } = gridToScoreRows(parseCSV('foo,bar\n1,2\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /无法识别表头/);
});

console.log('— --rows JSON 规范化 —');
await t('student_name 通道 + 题型分', () => {
  const { rows, errors } = normalizeScoreRows([
    { student_name: '张三', subject: '道法', score: 88, question_scores: { 选择: 30 } },
  ]);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].question_scores.选择, 30);
});
await t('缺姓名/坏分数/坏题型 → 全量错误', () => {
  const { errors } = normalizeScoreRows([
    { subject: '道法', score: 1 },
    { student_name: '李四', subject: '道法', score: 'abc' },
    { student_name: '王五', subject: '道法', score: 10, question_scores: { 判断: 1 } },
  ]);
  assert.equal(errors.length, 3);
});
await t('服务端同款分数范围校验', () => {
  assert.match(scoreRangeCheck('道法', 101), /0-100/);
  assert.equal(scoreRangeCheck('总分', 720), null);
  assert.match(scoreRangeCheck('总分', -1), /不能为负/);
});

console.log('— 参数解析 —');
await t('短别名/长名/等号/布尔开关', () => {
  const { flags } = parseArgs(['-s', '2026年秋季第一学期', '--class=初一(5)班', '--dry-run', 'extra']);
  assert.equal(flags.semester, '2026年秋季第一学期');
  assert.equal(flags.class, '初一(5)班');
  assert.equal(flags['dry-run'], true);
});
await t('缺值报 USAGE', () => {
  assert.throws(() => parseArgs(['--week']), (e) => e.code === 'USAGE');
});
await t('审查修复回归：未知旗标报 USAGE（防 --dryrun 拼错静默真实写入）', () => {
  assert.throws(() => parseArgs(['--dryrun', '--week', '1']), (e) => e.code === 'USAGE');
});
await t('审查修复回归：--week 尾随逗号报 USAGE', () => {
  assert.throws(() => parseWeekField('1,'), (e) => e.code === 'USAGE');
});
await t('审查修复回归：--rows 支持 student_no 三选一', () => {
  const { rows, errors } = normalizeScoreRows([{ student_no: '30101', subject: '道法', score: 80 }]);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].student_no, '30101');
});

console.log('— 解析器消歧 —');
const stubApi = (payload) => ({ call: async () => payload });
const semesterPayload = {
  semesters: [
    { id: 'a', name: '2026年秋季第一学期' },
    { id: 'b', name: '2026年秋季第二学期' },
    { id: 'c', name: '2026年寒假' },
  ],
  settings: { current_semester_id: 'c' },
};
await t('current → 当前学期', async () => {
  const s = await resolveSemester(stubApi(semesterPayload), 'current');
  assert.equal(s.id, 'c');
});
await t('唯一子串命中', async () => {
  const s = await resolveSemester(stubApi(semesterPayload), '寒假');
  assert.equal(s.id, 'c');
});
await t('子串多义 → RESOLVE_AMBIGUOUS + 候选', async () => {
  await assert.rejects(
    () => resolveSemester(stubApi(semesterPayload), '2026年秋季'),
    (e) => e.code === 'RESOLVE_AMBIGUOUS' && e.detail.candidates.length === 2,
  );
});
await t('未命中 → RESOLVE_NOT_FOUND 附全量清单', async () => {
  await assert.rejects(
    () => resolveSemester(stubApi(semesterPayload), '不存在的'),
    (e) => e.code === 'RESOLVE_NOT_FOUND' && e.detail.candidates.length === 3,
  );
});
await t('学生同名多义要求消歧', async () => {
  const api = stubApi({ students: [
    { id: 's1', name: '张三', student_no: '01' },
    { id: 's2', name: '张三', student_no: '02' },
  ] });
  await assert.rejects(
    () => resolveStudent(api, { id: 'cls' }, '张三'),
    (e) => e.code === 'RESOLVE_AMBIGUOUS' && e.detail.candidates.length === 2,
  );
});

console.log('— 引擎周数口径（复用 src/engine，零重复实现） —');
await t('weekIndexOf：开学当周=1、周一为界、未开学=0', () => {
  const sem = { start_date: '2026-09-01', end_date: '2027-01-17' };
  assert.equal(weekIndexOf(sem, '2026-09-01'), 1);
  assert.equal(weekIndexOf(sem, '2026-09-06'), 1);
  assert.equal(weekIndexOf(sem, '2026-09-07'), 2);
  assert.equal(weekIndexOf(sem, '2026-08-31'), 0);
});

console.log('— 信封与退出码 —');
await t('退出码映射 2/3/4/5', () => {
  assert.equal(exitCodeOf({ code: 'USAGE' }), 2);
  assert.equal(exitCodeOf({ code: 'VALIDATION' }), 3);
  assert.equal(exitCodeOf({ code: 'SERVICE_DOWN' }), 4);
  assert.equal(exitCodeOf({ code: 'RESOLVE_AMBIGUOUS' }), 5);
});
await t('错误信封含 code/message/detail', () => {
  const env = envelopeFromError(new TcError('VALIDATION', '预检失败', { errors: [1] }));
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'VALIDATION');
  assert.deepEqual(env.error.detail.errors, [1]);
});

console.log(`\n全部通过：${pass} 项`);

if (process.argv.includes('--live')) {
  const { makeApi } = await import('./lib/api.mjs');
  const api = makeApi();
  const cal = await api.call('calendar', '/bootstrap');
  const pf = await api.call('portfolio', '/health');
  console.log(`--live：日历 ${cal.semesters.length} 学期 ✓ | 档案 schema v${pf.schema_version} ✓`);
}
