// L1 单元测试：学情分析引擎（03 文档 §5.7/5.8/5.9 口径）
import { describe, it, expect } from 'vitest';
import {
  analyzeStudentScores, analyzeClass, compareDfClasses, segmentsOf, stddev,
} from '../server/engine.mjs';

const E = (exam_id, date, subject, score, class_rank, qs) => ({ exam_id, exam_name: exam_id, exam_date: date, subject, score, class_rank, grade_rank: null, question_scores: qs });

describe('个人学情分析', () => {
  it('总分进退步与排名（U-01/U-02）', () => {
    const rows = [
      E('e1', '2026-10-01', '总分', 512, 15),
      E('e1', '2026-10-01', '语文', 88, 3),
      E('e2', '2026-11-01', '总分', 520, 12),
      E('e2', '2026-11-01', '语文', 92, 3),
    ];
    const a = analyzeStudentScores(rows);
    expect(a.trends.length).toBe(2);
    expect(a.trends[1].delta_total).toBe(8);
    expect(a.trends[1].delta_rank).toBe(3); // 名次上升为正
    expect(a.status).toBe('up');
  });

  it('退步判定（delta ≤ -5 → down）', () => {
    const rows = [E('e1', '2026-10-01', '总分', 500, 5), E('e2', '2026-11-01', '总分', 490, 8)];
    expect(analyzeStudentScores(rows).status).toBe('down');
  });

  it('稳定判定（三次 500/505/498 → stable）', () => {
    const rows = [E('e1', '2026-09-01', '总分', 500, 1), E('e2', '2026-10-01', '总分', 505, 1), E('e3', '2026-11-01', '总分', 502, 1)]; // 末两次差 -3 且无大幅波动
    expect(analyzeStudentScores(rows).status).toBe('stable');
  });

  it('波动判定（三次 500/540/460 标准差>8 → volatile）', () => {
    const rows = [E('e1', '2026-09-01', '总分', 500, 1), E('e2', '2026-10-01', '总分', 540, 1), E('e3', '2026-11-01', '总分', 460, 1)];
    expect(analyzeStudentScores(rows).status).toBe('volatile');
  });

  it('短板识别：科目均分低于班均 ≥5 且 ≥2 次（U-05），<5 不误报（U-06）', () => {
    const rows = [
      E('e1', '2026-10-01', '数学', 60, 20), E('e2', '2026-11-01', '数学', 64, 20),
      E('e1', '2026-10-01', '语文', 90, 5), E('e2', '2026-11-01', '语文', 92, 5),
    ];
    const classAvgs = { 数学: 72, 语文: 91 };
    const a = analyzeStudentScores(rows, classAvgs);
    expect(a.weak_points.some((w) => w.subject === '数学')).toBe(true);
    expect(a.weak_points.some((w) => w.subject === '语文')).toBe(false);
  });

  it('题型失分率：选择满分20得12 → loss 0.4 → high（U-07）', () => {
    const rows = [E('e1', '2026-10-01', '道德与法治', 80, 1, { 选择: 12, 简答: 8 })];
    const a = analyzeStudentScores(rows);
    const q = a.question_weak.find((x) => x.question_type === '选择');
    expect(q.avg_loss_rate).toBe(0.4);
    expect(q.level).toBe('high');
  });

  it('无上次考试：trends 首条 delta 为 null，不报错（U-10）', () => {
    const a = analyzeStudentScores([E('e1', '2026-10-01', '总分', 500, 1)]);
    expect(a.trends[0].delta_total).toBeNull();
    expect(a.status).toBe('stable');
  });
});

describe('班级学情分析', () => {
  it('分数段合计=人数；优秀/及格率（U-08/U-09）', () => {
    const totals = [95, 88, 82, 71, 65, 58, 90, 60, 85, 45];
    const seg = segmentsOf(totals);
    expect(seg.lt60 + seg['60-69'] + seg['70-79'] + seg['80-89'] + seg.ge90).toBe(10);
    expect(seg.ge90).toBe(2);
    expect(seg.lt60).toBe(2);
  });

  it('班级统计与进退步人数（对比上次考试）', () => {
    const cur = [
      { student_id: 'a', subject: '总分', score: 510 },
      { student_id: 'b', subject: '总分', score: 480 },
      { student_id: 'c', subject: '总分', score: 490 },
      { student_id: 'a', subject: '语文', score: 90 },
    ];
    const prev = [
      { student_id: 'a', subject: '总分', score: 500 },
      { student_id: 'b', subject: '总分', score: 500 },
      { student_id: 'c', subject: '总分', score: 485 },
    ];
    const a = analyzeClass(cur, prev);
    expect(a.stats.avg_total).toBe(493.33);
    expect(a.stats.excellent_rate).toBe(1); // 单科池 [90] → 100%
    expect(a.stats.pass_rate).toBe(1);
    expect(a.movement).toEqual({ up_count: 2, down_count: 1, stable_count: 0 }); // a+10 up, b-20 down, c+5 up
    expect(a.stats.segments.ge90).toBe(1);
    expect(a.subject_stats.语文.avg).toBe(90);
  });

  it('空数据不报错', () => {
    const a = analyzeClass([]);
    expect(a.stats.avg_total).toBe(0);
    expect(a.movement).toEqual({ up_count: 0, down_count: 0, stable_count: 0 });
  });
});

describe('道法多班对比', () => {
  it('平均分/优秀率/及格率/进退步', () => {
    const rows = [
      { class_id: 'c1', class_name: 'A班', role: 'subject', stage: 'middle', exam_id: 'x1', exam_name: '月考', exam_date: '2026-10-15', prev_avg: 80, scores: [{ subject: '道德与法治', score: 90 }, { subject: '道德与法治', score: 70 }] },
      { class_id: 'c2', class_name: '主班', role: 'homeroom', stage: 'middle', exam_id: 'x2', exam_name: '月考', exam_date: '2026-10-16', prev_avg: 75, scores: [{ subject: '道德与法治', score: 85 }] },
    ];
    const c = compareDfClasses(rows);
    expect(c[0].avg).toBe(80);
    expect(c[0].excellent_rate).toBe(0.5);
    expect(c[0].pass_rate).toBe(1);
    expect(c[0].avg_delta).toBe(0);
    expect(c[1].avg_delta).toBe(10);
    expect(c[1].role).toBe('homeroom'); // 主班自动纳入
  });
});

describe('工具', () => {
  it('stddev', () => {
    expect(stddev([1, 2, 3])).toBeCloseTo(0.8165, 3);
    expect(stddev([5])).toBe(0);
  });
});
