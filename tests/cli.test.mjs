// 仓库 vitest 用例（tests/cli.test.mjs）——与 cli/selftest.mjs 同源断言的子集双保险。
// 设计约束（plan §4）：只测纯函数与可 mock 的解析器，不依赖网络。

import { describe, it, expect } from 'vitest';
import { parseCSV, detectScoreFormat, gridToScoreRows, normalizeScoreRows, scoreRangeCheck } from '../cli/lib/csv.mjs';
import { TcError, exitCodeOf, envelopeFromError } from '../cli/lib/api.mjs';
import { resolveSemester, resolveStudent } from '../cli/lib/resolve.mjs';
import { parseArgs } from '../cli/lib/commands.mjs';
import { weekIndexOf } from '../src/engine/week.js';

const stubApi = (payload) => ({ call: async () => payload });

describe('csv', () => {
  it('解析 BOM/引号/CRLF', () => {
    expect(parseCSV('\ufeff姓名,分数\r\n"张,三",95\r\n')).toEqual([['姓名', '分数'], ['张,三', '95']]);
  });
  it('长表识别与转换', () => {
    expect(detectScoreFormat(['姓名', '科目', '分数'])).toBe('long');
    const { rows, errors } = gridToScoreRows(parseCSV('姓名,科目,分数\n张三,道法,95\n'));
    expect(errors).toHaveLength(0);
    expect(rows[0]).toMatchObject({ student_name: '张三', subject: '道法', score: 95 });
  });
  it('宽表稀疏跳过 + 坏分报错', () => {
    const { rows, errors } = gridToScoreRows(parseCSV('姓名,道法,历史\n张三,95,\n李四,x,88\n'));
    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });
  it('rows 规范化全量报错', () => {
    const { errors } = normalizeScoreRows([{ subject: '道法', score: 1 }]);
    expect(errors).toHaveLength(1);
  });
  it('分数范围与服务端一致', () => {
    expect(scoreRangeCheck('道法', 101)).toMatch(/0-100/);
    expect(scoreRangeCheck('总分', 720)).toBeNull();
  });
});

describe('argparse', () => {
  it('别名/等号/布尔', () => {
    const { flags } = parseArgs(['-s', '秋', '--class=五班', '--dry-run']);
    expect(flags.semester).toBe('秋');
    expect(flags.class).toBe('五班');
    expect(flags['dry-run']).toBe(true);
  });
  it('缺值 → USAGE', () => {
    expect(() => parseArgs(['--week'])).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });
});

describe('resolve', () => {
  const payload = {
    semesters: [
      { id: 'a', name: '2026年秋季第一学期' },
      { id: 'b', name: '2026年秋季第二学期' },
    ],
    settings: { current_semester_id: 'a' },
  };
  it('唯一子串命中', async () => {
    expect((await resolveSemester(stubApi(payload), '第二')).id).toBe('b');
  });
  it('多义 → RESOLVE_AMBIGUOUS', async () => {
    await expect(resolveSemester(stubApi(payload), '2026年秋季'))
      .rejects.toMatchObject({ code: 'RESOLVE_AMBIGUOUS' });
  });
  it('学生同名 → 候选消歧', async () => {
    const api = stubApi({ students: [{ id: '1', name: '张三' }, { id: '2', name: '张三' }] });
    await expect(resolveStudent(api, { id: 'c' }, '张三'))
      .rejects.toMatchObject({ code: 'RESOLVE_AMBIGUOUS', detail: { candidates: [{ id: '1', name: '张三', student_no: undefined }, { id: '2', name: '张三', student_no: undefined }] } });
  });
});

describe('engine + envelope', () => {
  it('周数口径与全局一致', () => {
    const sem = { start_date: '2026-09-01', end_date: '2027-01-17' };
    expect(weekIndexOf(sem, '2026-09-01')).toBe(1);
    expect(weekIndexOf(sem, '2026-09-07')).toBe(2);
    expect(weekIndexOf(sem, '2026-08-31')).toBe(0);
  });
  it('错误信封结构', () => {
    const env = envelopeFromError(new TcError('SERVICE_DOWN', 'down'));
    expect(env).toMatchObject({ ok: false, error: { code: 'SERVICE_DOWN' } });
    expect(exitCodeOf({ code: 'SERVICE_DOWN' })).toBe(4);
  });
});
