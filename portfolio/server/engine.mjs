// 学生成长档案工作台 —— 学情分析引擎（纯函数，03 文档 §5.7/5.8/5.9 口径定稿）
// 规则（固定，测试基线）：
// - delta_total = 本次总分 − 上次总分；delta_rank 名次上升为正
// - status：末两次总分差 ≥5 → up；≤-5 → down；≥3 次且标准差 > 8 → volatile；否则 stable
// - weak_points：科目平均分低于班级均分 ≥5 分且出现 ≥2 次
// - question_weak：题型失分率 = (满分−均分)/满分 > 0.3 → high；满分口径：选择20/简答10/材料分析8/论述6
// - 班级统计：优秀 ≥85；及格 ≥60；分数段 <60/60-69/70-79/80-89/≥90

export const QUESTION_FULL = { 选择: 20, 简答: 10, 材料分析: 8, 论述: 6 };

/** 标准差 */
export function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
}

/** 该班某科目平均分（供短板判定） */
export function classAvgBySubject(scores, subject) {
  const rows = scores.filter((s) => s.subject === subject && s.score != null);
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => a + b.score, 0) / rows.length;
}

/**
 * 个人学情分析（03 文档 §5.7）
 * @param scores 该生全部成绩行 [{exam_id, exam_name, exam_date, subject, score, class_rank, grade_rank, question_scores}]
 * @param classAvgs 班级各科均分 {科目: 均分}（weak_points 判定用；缺省不判定）
 */
export function analyzeStudentScores(scores, classAvgs = {}) {
  const byExam = new Map();
  for (const s of scores) {
    if (!byExam.has(s.exam_id)) byExam.set(s.exam_id, { exam_id: s.exam_id, exam_name: s.exam_name, exam_date: s.exam_date, rows: [] });
    byExam.get(s.exam_id).rows.push(s);
  }
  const exams = [...byExam.values()].sort((a, b) => (a.exam_date < b.exam_date ? -1 : a.exam_date > b.exam_date ? 1 : 0));
  // trends：总分序列
  const trends = [];
  let prevTotal = null;
  let prevRank = null;
  for (const e of exams) {
    const t = e.rows.find((r) => r.subject === '总分');
    if (!t) continue;
    const total = t.score;
    const rank = t.class_rank != null ? t.class_rank : null;
    trends.push({
      exam_id: e.exam_id, exam_name: e.exam_name, exam_date: e.exam_date,
      total, total_rank: rank,
      delta_total: prevTotal === null ? null : Math.round((total - prevTotal) * 100) / 100,
      delta_rank: prevRank === null || rank === null ? null : prevRank - rank, // 名次上升为正
    });
    prevTotal = total;
    prevRank = rank;
  }
  // status
  // 口径（03 文档 §5.7）：先判波动（≥3 次且标准差>8 → volatile），再判末两次进退（≥5 up / ≤-5 down），否则 stable
  let status = 'stable';
  const totals = trends.map((t) => t.total).filter((v) => v != null);
  if (totals.length >= 3 && stddev(totals) > 8) status = 'volatile';
  else if (totals.length >= 2) {
    const last = totals[totals.length - 1];
    const prev = totals[totals.length - 2];
    if (last - prev >= 5) status = 'up';
    else if (last - prev <= -5) status = 'down';
  }
  // subject_trends
  const subjectTrends = {};
  for (const e of exams) {
    for (const r of e.rows) {
      if (r.subject === '总分') continue;
      (subjectTrends[r.subject] = subjectTrends[r.subject] || []).push({
        exam_id: e.exam_id, exam_date: e.exam_date, score: r.score, class_rank: r.class_rank,
      });
    }
  }
  for (const arr of Object.values(subjectTrends)) arr.sort((a, b) => (a.exam_date < b.exam_date ? -1 : 1));
  // weak_points：科目均分低于班均 ≥5 且出现 ≥2 次
  const weakPoints = [];
  for (const [subject, arr] of Object.entries(subjectTrends)) {
    const avg = arr.reduce((a, b) => a + b.score, 0) / arr.length;
    const classAvg = classAvgs[subject];
    if (classAvg != null && classAvg - avg >= 5 && arr.length >= 2) {
      weakPoints.push({
        subject, avg_score: Math.round(avg * 100) / 100, below_class_avg: Math.round((classAvg - avg) * 100) / 100,
        last_rank: arr[arr.length - 1].class_rank, note: `连续 ${arr.length} 次低于班级均分`,
      });
    }
  }
  // question_weak：仅道德与法治题型（question_scores）
  const questionWeak = [];
  const qAgg = {};
  for (const e of exams) {
    for (const r of e.rows) {
      if (!r.question_scores || typeof r.question_scores !== 'object') continue;
      for (const [q, score] of Object.entries(r.question_scores)) {
        (qAgg[q] = qAgg[q] || []).push(score);
      }
    }
  }
  for (const [q, arr] of Object.entries(qAgg)) {
    const full = QUESTION_FULL[q];
    if (!full) continue;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const loss = (full - avg) / full;
    questionWeak.push({ question_type: q, avg_loss_rate: Math.round(loss * 1000) / 1000, level: loss > 0.3 ? 'high' : 'normal' });
  }
  return { trends, status, subject_trends: subjectTrends, weak_points: weakPoints, question_weak: questionWeak };
}

/** 分数段统计（总分口径） */
export function segmentsOf(totals) {
  const seg = { lt60: 0, '60-69': 0, '70-79': 0, '80-89': 0, ge90: 0 };
  for (const t of totals) {
    if (t < 60) seg.lt60++;
    else if (t < 70) seg['60-69']++;
    else if (t < 80) seg['70-79']++;
    else if (t < 90) seg['80-89']++;
    else seg.ge90++;
  }
  return seg;
}

/**
 * 班级学情分析（03 文档 §5.8）
 * @param scores 该考试全部成绩行
 * @param prevScores 上一次同类型考试全部成绩行（可空）
 */
export function analyzeClass(scores, prevScores = []) {
  // 总分序列（每生一行）
  const totals = scores.filter((s) => s.subject === '总分' && s.score != null).map((s) => s.score);
  const n = totals.length;
  const avgTotal = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
  // 优秀率/及格率/分数段 = 单科成绩池口径（百分制，总分不参与）
  const pool = scores.filter((s) => s.subject !== '总分' && s.score != null).map((s) => s.score);
  const pn = pool.length;
  const excellentRate = pn ? pool.filter((t) => t >= 85).length / pn : 0;
  const passRate = pn ? pool.filter((t) => t >= 60).length / pn : 0;
  // 分科统计
  const subjectStats = {};
  const subjects = new Set(scores.filter((s) => s.subject !== '总分').map((s) => s.subject));
  for (const sub of subjects) {
    const rows = scores.filter((s) => s.subject === sub && s.score != null);
    const m = rows.length;
    subjectStats[sub] = {
      avg: m ? Math.round((rows.reduce((a, b) => a + b.score, 0) / m) * 100) / 100 : 0,
      excellent_rate: m ? Math.round((rows.filter((r) => r.score >= 85).length / m) * 1000) / 1000 : 0,
      pass_rate: m ? Math.round((rows.filter((r) => r.score >= 60).length / m) * 1000) / 1000 : 0,
    };
  }
  // movement：对比上次考试（同学生总分差）
  let up = 0, down = 0, stable = 0;
  if (prevScores.length) {
    const prevByStudent = new Map();
    for (const r of prevScores) {
      if (r.subject === '总分') prevByStudent.set(r.student_id, r.score);
    }
    const curByStudent = new Map();
    for (const r of scores) {
      if (r.subject === '总分') curByStudent.set(r.student_id, r.score);
    }
    for (const [sid, cur] of curByStudent) {
      const prev = prevByStudent.get(sid);
      if (prev == null) continue;
      const d = cur - prev;
      if (d >= 5) up++;
      else if (d <= -5) down++;
      else stable++;
    }
  }
  return {
    stats: {
      avg_total: Math.round(avgTotal * 100) / 100,
      excellent_rate: Math.round(excellentRate * 1000) / 1000,
      pass_rate: Math.round(passRate * 1000) / 1000,
      segments: segmentsOf(pool),
      student_count: n,
    },
    subject_stats: subjectStats,
    movement: { up_count: up, down_count: down, stable_count: stable },
    student_count: n,
  };
}

/**
 * 道法多班对比（03 文档 §5.9）：每班最近一次指定类型（缺省取最近一次）考试的统计
 * @param rows 每班 [{ class_id, class_name, role, stage, exam_id, exam_name, exam_date, scores: [...] }]
 */
export function compareDfClasses(rows) {
  return rows.map((r) => {
    const scores = r.scores.filter((s) => s.subject === '道德与法治' && s.score != null);
    const n = scores.length;
    const avg = n ? scores.reduce((a, b) => a + b.score, 0) / n : 0;
    return {
      class_id: r.class_id, class_name: r.class_name, role: r.role, stage: r.stage,
      exam_id: r.exam_id, exam_name: r.exam_name, exam_date: r.exam_date,
      avg: Math.round(avg * 100) / 100,
      excellent_rate: n ? Math.round((scores.filter((s) => s.score >= 85).length / n) * 1000) / 1000 : 0,
      pass_rate: n ? Math.round((scores.filter((s) => s.score >= 60).length / n) * 1000) / 1000 : 0,
      segments: segmentsOf(scores.map((s) => s.score)),
      prev_avg: r.prev_avg != null ? Math.round(r.prev_avg * 100) / 100 : null,
      avg_delta: r.prev_avg != null ? Math.round((avg - r.prev_avg) * 100) / 100 : null,
      student_count: n,
    };
  });
}

// ---------- 评语生成引擎（03 文档 §10.1：确定性模板 + 数据填充，可复现） ----------

/**
 * 生成三类评语（talk 谈心 / home_school 家校沟通 / periodic 综合素质）
 * @param profile { name, trends:[{delta_total,delta_rank}], hw:{completion_rate,missing,slack,excellent},
 *                 moralByCat:{emotion:count,...}, honors:[{title,level}], weak:[{subject}], stage }
 */
export function generateComment(profile, type) {
  const { name, trends = [], hw = {}, moralByCat = {}, honors = [], weak = [], stage } = profile;
  const last = trends.length ? trends[trends.length - 1] : null;
  const delta = last && last.delta_total != null ? last.delta_total : null;
  const improved = delta != null && delta >= 0;
  const hwNote = hw.missing + hw.slack > 0 ? `近期作业有 ${hw.missing + hw.slack} 次缺交/敷衍记录` : `作业完成情况良好（完成率 ${Math.round((hw.completion_rate || 1) * 100)}%）`;
  const weakNote = weak.length ? `，需重点关注：${weak.map((w) => w.subject).join('、')}` : '';
  const honorNote = honors.length ? `；本学期获「${honors[0].title}」` : '';
  const moralCount = Object.values(moralByCat).reduce((a, b) => a + b, 0);
  const primary = stage === 'primary';

  if (type === 'talk') {
    if (improved) {
      return `${name}，这次${delta > 0 ? `总分进步了 ${delta} 分` : '成绩保持稳定'}，说明你最近的付出有了回报，老师为你高兴。${weakNote ? `不过${weakNote}，我们一起来想办法，好吗？` : '继续保持这个状态，你会越来越自信。'}`;
    }
    return `${name}，老师注意到你最近状态有些起伏（总分较上次${delta != null ? `下降 ${-delta} 分` : '有所波动'}），先别着急，一次考试说明不了全部。${weakNote ? `我们先把${weak.map((w) => w.subject).join('、')}这一块补一补，老师会陪着你。` : '我们先一起分析原因，从一个小目标开始，好吗？'}`;
  }
  if (type === 'home_school') {
    return `家长您好！${name}本学期${improved && delta != null ? `总分较上次进步 ${delta} 分` : '成绩有一定波动'}。${hwNote}。${weakNote || '整体状态平稳。'}${honorNote}。建议在家多关注${primary ? '学习习惯与情绪状态' : '作息与手机使用时间'}，有需要随时和我沟通。`;
  }
  // periodic：综合素质（德智体美劳五维摘要）
  const moralLine = moralCount > 0
    ? `本学期德育记录 ${moralCount} 条（${Object.entries(moralByCat).map(([k, v]) => `${catLabel(k)}${v}`).join('、')}）`
    : '思想品德表现良好';
  const honorLine = honors.length ? `，荣誉：${honors.map((h) => h.title).join('、')}` : '，积极参加班级活动';
  const hwLine = hw.excellent > 0 ? `作业优秀 ${hw.excellent} 次` : '作业按时完成';
  return `${name}同学：本学期${moralLine}；学习上${improved && delta != null ? `总分进步 ${delta} 分` : '稳步前进'}，${hwLine}${honorLine}${weakNote ? `；需加强${weak.map((w) => w.subject).join('、')}的针对性训练` : ''}。望下学期${primary ? '继续保持好习惯，快乐成长' : '再接再厉，向目标冲刺'}。`;
}

const CAT_LABELS = {
  emotion: '情绪', family: '家庭', relationship: '人际', conduct: '品德',
  reward: '奖励', punish: '违纪', volunteer: '志愿', other: '其他',
};
export function catLabel(k) { return CAT_LABELS[k] || k; }
