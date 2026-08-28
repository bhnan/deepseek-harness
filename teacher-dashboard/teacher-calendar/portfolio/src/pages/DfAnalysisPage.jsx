import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import Chart, { lineOption, barOption, pieOption, scatterOption } from '../components/Chart.jsx';

const DF_SUBJECT = '道德与法治';
const DF_FULL = 100; // 道法满分（百分制）
// 题型满分口径与 engine.mjs QUESTION_FULL 保持一致
const Q_FULL = { 选择: 20, 简答: 10, 材料分析: 8, 论述: 6 };
const Q_LABEL = { 选择: '单项选择', 简答: '简答题', 材料分析: '材料分析题', 论述: '实践探究题' };
const Q_ADVICE = {
  选择: '回归课本夯实基础概念，选择题专项限时训练',
  简答: '背诵要点框架，训练分点作答与关键词表述',
  材料分析: '审题训练 + 结合材料组织观点，观点与材料对应',
  论述: '观点-论据-结论逻辑训练，规范政治学科术语',
};
const TIER_DEF = [
  ['培优层', 85, '主观题模板拔高，向满分冲刺'],
  ['临界优生', 75, '审题与规范表述训练，冲刺优秀'],
  ['临界及格', 60, '核心考点背诵 + 选择题过关'],
  ['基础薄弱', 0, '基础概念 + 背诵默写过关，课堂多提问'],
];
const r1 = (v) => Math.round(v * 10) / 10;

// 道法学情分析页（单科专属，聚焦得分率/题型/分层/归因，与全科分析隔离）
export default function DfAnalysisPage({ cid, cls, onBack, onOpenStudent, notify, refreshKey }) {
  const [exams, setExams] = useState([]);
  const [examId, setExamId] = useState('');
  const [dfMap, setDfMap] = useState(new Map());   // exam_id -> 道法成绩行（含 question_scores）
  const [students, setStudents] = useState([]);
  const [nameById, setNameById] = useState(new Map());
  const [compareDf, setCompareDf] = useState([]);
  const [cmpA, setCmpA] = useState('');
  const [cmpB, setCmpB] = useState('');
  const [compare, setCompare] = useState(null);
  const [trackSid, setTrackSid] = useState('');
  const [hwRates, setHwRates] = useState(null);
  const [scoreText, setScoreText] = useState(''); // 道法成绩批量粘贴
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.listExams(cid).then((d) => {
      setExams(d.exams);
      if (!examId && d.exams.length) setExamId(d.exams[0].id);
    }).catch((e) => notify(e.message));
  }, [cid, refreshKey]);

  // 每场考试道法成绩（含题型小分）
  useEffect(() => {
    (async () => {
      const m = new Map();
      for (const e of exams) {
        try {
          const d = await api.examScores(e.id);
          m.set(e.id, d.scores.filter((r) => r.subject === DF_SUBJECT && r.score != null));
        } catch { /* 跳 */ }
      }
      setDfMap(m);
    })();
  }, [exams, refreshKey, tick]);

  useEffect(() => {
    api.listStudents(cid).then((d) => {
      setStudents(d.students);
      setNameById(new Map(d.students.map((x) => [x.id, x.name])));
    }).catch(() => {});
  }, [cid, refreshKey]);

  // 跨班对比（同阶段）
  useEffect(() => {
    api.dfCompare(cls?.stage ? `?stage=${cls.stage}` : '')
      .then((d) => setCompareDf(d.compare || []))
      .catch((e) => notify(e.message));
  }, [cid, cls?.stage, refreshKey]);

  // 默认两次对比 = 最近两次有道法成绩的考试
  useEffect(() => {
    if (!cmpA && !cmpB) {
      const withDf = exams.filter((e) => (dfMap.get(e.id) || []).length > 0);
      if (withDf.length >= 2) { setCmpA(withDf[1].id); setCmpB(withDf[0].id); }
    }
  }, [exams, dfMap]);

  useEffect(() => {
    if (!cmpA || !cmpB) { setCompare(null); return; }
    const ma = new Map((dfMap.get(cmpA) || []).map((r) => [r.student_id, r.score]));
    const mb = new Map((dfMap.get(cmpB) || []).map((r) => [r.student_id, r.score]));
    const rows = [];
    for (const [sid, b] of mb) {
      const a = ma.get(sid);
      if (a == null) continue;
      rows.push({ student_id: sid, name: nameById.get(sid) || sid, scoreA: a, scoreB: b, delta: r1(b - a) });
    }
    rows.sort((x, y) => y.delta - x.delta);
    setCompare({
      rows,
      up: rows.filter((r) => r.delta > 0).length,
      down: rows.filter((r) => r.delta < 0).length,
      stable: rows.length - rows.filter((r) => r.delta > 0).length - rows.filter((r) => r.delta < 0).length,
      nameA: exams.find((e) => e.id === cmpA)?.name || '',
      nameB: exams.find((e) => e.id === cmpB)?.name || '',
    });
  }, [cmpA, cmpB, dfMap, exams, nameById]);

  // 道法成绩批量录入（粘贴/Excel，科目固定为道德与法治）
  const doDfBatch = async (rows) => {
    if (!examId) { notify('请先选择考试'); return; }
    const errs = [];
    const final = [];
    const stu = await api.listStudents(cid);
    const byNo = new Map(stu.students.map((s) => [s.student_no, s.id]));
    for (const r of rows) {
      const sid = byNo.get(r.student_no);
      if (!sid) { errs.push(`学号 ${r.student_no} 不存在`); continue; }
      final.push({ student_id: sid, subject: DF_SUBJECT, score: r.score, class_rank: r.class_rank });
    }
    if (errs.length) { notify(errs[0]); return; }
    try {
      const d = await api.batchScores(examId, final);
      notify(`道法成绩已录入 ${d.upserted} 条${d.failed ? `，失败 ${d.failed}` : ''}`);
      setScoreText(''); setTick((t) => t + 1);
    } catch (e) { notify(e.message); }
  };
  const doDfPaste = () => {
    const rows = [];
    const errs = [];
    scoreText.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l, i) => {
      const p = l.split(/[,，\t]/).map((x) => x.trim());
      const [no, score, rank] = p;
      if (!no || score === undefined || isNaN(Number(score))) { errs.push(`第 ${i + 1} 行格式错误（应为：学号,分数,班级排名可选）`); return; }
      rows.push({ student_no: no, score: Number(score), class_rank: rank ? Number(rank) : undefined });
    });
    if (errs.length) { notify(errs[0]); return; }
    if (!rows.length) { notify('请粘贴至少一行'); return; }
    doDfBatch(rows);
  };
  const doDfExcel = async (file) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      let start = 0;
      if (raw.length && /学号|分数|排名/.test(String(raw[0].join(',') || ''))) start = 1;
      const rows = [];
      for (let i = start; i < raw.length; i++) {
        const p = (raw[i] || []).map((x) => String(x).trim());
        if (!p[0] && !p[1]) continue;
        rows.push({ student_no: p[0], score: Number(p[1]), class_rank: p[2] ? Number(p[2]) : undefined });
      }
      if (!rows.length) { notify('未解析到成绩行（需含 学号/分数 两列）'); return; }
      await doDfBatch(rows);
    } catch (e) { notify(`文件解析失败：${e.message}`); }
  };

  // ---------- 表1/表2：当前考试整体统计 ----------
  const curDf = dfMap.get(examId) || [];
  const n = curDf.length;
  const curExamName = exams.find((e) => e.id === examId)?.name || '';
  const scores = curDf.map((r) => r.score);
  const curAvg = n ? r1(scores.reduce((a, b) => a + b, 0) / n) : null;
  const curMax = n ? Math.max(...scores) : null;
  const curMin = n ? Math.min(...scores) : null;
  const curExcellent = n ? curDf.filter((r) => r.score >= 85).length / n : 0;
  const curPass = n ? curDf.filter((r) => r.score >= 60).length / n : 0;
  const curLow = n ? curDf.filter((r) => r.score < 60).length / n : 0;
  // 年级平均 ≈ 同阶段各班最近一次道法均分的均值（dfCompare 口径）
  const gradeAvg = compareDf.length ? r1(compareDf.reduce((a, c) => a + c.avg, 0) / compareDf.length) : null;
  const gradeDiff = curAvg != null && gradeAvg != null ? r1(curAvg - gradeAvg) : null;
  const gradeExcellent = compareDf.length ? compareDf.reduce((a, c) => a + c.excellent_rate, 0) / compareDf.length : null;
  const gradePass = compareDf.length ? compareDf.reduce((a, c) => a + c.pass_rate, 0) / compareDf.length : null;

  // 表2：方案口径四段（85-100 / 70-84 / 60-69 / <60）+ 累计占比
  const seg4 = [
    { name: '85-100', lo: 85, hi: 999, note: '优秀段' },
    { name: '70-84', lo: 70, hi: 85, note: '良好段' },
    { name: '60-69', lo: 60, hi: 70, note: '及格段' },
    { name: '<60', lo: 0, hi: 60, note: '待合格' },
  ].map((s) => ({ ...s, value: curDf.filter((r) => r.score >= s.lo && r.score < s.hi).length }));
  let cum = 0;
  seg4.forEach((s) => { cum += s.value; s.cum = cum; });
  const segGap = seg4.some((s, i) => s.value === 0 && i > 0 && i < seg4.length - 1 && seg4.slice(0, i).some((x) => x.value > 0) && seg4.slice(i + 1).some((x) => x.value > 0));

  // ---------- 表3：题型得分率 ----------
  const typeStats = useMemo(() => {
    const qAgg = {};
    for (const r of curDf) {
      if (!r.question_scores || typeof r.question_scores !== 'object') continue;
      for (const [q, sc] of Object.entries(r.question_scores)) {
        if (typeof sc !== 'number') continue;
        (qAgg[q] = qAgg[q] || []).push(sc);
      }
    }
    const out = [];
    for (const [q, arr] of Object.entries(qAgg)) {
      const full = Q_FULL[q];
      if (!full) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      out.push({
        key: q, label: Q_LABEL[q] || q, full, avg: r1(avg), rate: r1(avg / full),
        level: avg / full < 0.6 ? '⚠ 薄弱' : avg / full < 0.7 ? '待加强' : '良好',
        advice: Q_ADVICE[q] || '针对性训练',
      });
    }
    return out.sort((a, b) => a.rate - b.rate);
  }, [curDf]);

  // ---------- 表4：失分排行（题型级，题号级待录入） ----------
  const lossRows = typeStats.map((t) => ({ ...t, loss: r1(1 - t.rate) })).sort((a, b) => b.loss - a.loss);

  // ---------- 表5：个人纵向追踪 ----------
  const trackData = useMemo(() => {
    if (!trackSid) return null;
    const rows = exams.map((e) => {
      const arr = dfMap.get(e.id) || [];
      const mine = arr.find((r) => r.student_id === trackSid);
      const avg = arr.length ? arr.reduce((a, b) => a + b.score, 0) / arr.length : null;
      const rank = mine ? arr.filter((r) => r.score > mine.score).length + 1 : null;
      return { name: e.name, mine: mine ? mine.score : null, avg: avg != null ? r1(avg) : null, rank };
    }).filter((r) => r.mine != null);
    const totals = rows.map((r) => r.mine);
    let status = '稳定';
    if (totals.length >= 3) {
      const m = totals.reduce((a, b) => a + b, 0) / totals.length;
      const sd = Math.sqrt(totals.reduce((a, v) => a + (v - m) ** 2, 0) / totals.length);
      if (sd > 8) status = '波动';
    }
    if (totals.length >= 2) {
      const d = totals[totals.length - 1] - totals[totals.length - 2];
      if (d >= 5) status = '上升';
      else if (d <= -5) status = '下滑';
    }
    return { rows, status, name: nameById.get(trackSid) || trackSid };
  }, [trackSid, dfMap, exams, nameById]);

  // ---------- 表6：分层归类 ----------
  const tierRows = curDf.map((r) => {
    const t = TIER_DEF.find(([label, line]) => r.score >= line);
    return { sid: r.student_id, name: nameById.get(r.student_id) || r.student_id, score: r.score, tier: t[0], advice: t[2] };
  }).sort((a, b) => b.score - a.score);
  const tierCnt = {};
  TIER_DEF.forEach(([label]) => { tierCnt[label] = 0; });
  tierRows.forEach((r) => { tierCnt[r.tier]++; });

  // ---------- 表7：成绩-作业联动散点 ----------
  const loadHwRates = async () => {
    if (hwRates) return;
    const rates = {};
    await Promise.all(students.map(async (s) => {
      try { const d = await api.studentHWStats(s.id); rates[s.id] = d.stats.student_stats[0]?.completion_rate ?? null; } catch { rates[s.id] = null; }
    }));
    setHwRates(rates);
  };
  const scatterPts = hwRates ? students.map((s) => {
    const row = curDf.find((r) => r.student_id === s.id);
    return { name: s.name, rate: hwRates[s.id], df: row ? row.score : null };
  }).filter((p) => p.rate != null && p.df != null) : [];
  const methodRisk = scatterPts.filter((p) => p.rate >= 0.8 && p.df < 70);   // 会交作业但分低 → 答题方法
  const attitudeRisk = scatterPts.filter((p) => p.rate < 0.5 && p.df < 70);  // 不交作业且分低 → 态度落实

  // ---------- 历次班均折线 ----------
  const trendSeries = exams.map((e) => {
    const arr = dfMap.get(e.id) || [];
    return { name: e.name, avg: arr.length ? r1(arr.reduce((a, b) => a + b.score, 0) / arr.length) : null };
  }).filter((r) => r.avg != null);

  // ---------- 表8：多班分组柱状图数据 ----------
  const classNames = compareDf.map((c) => c.class_name);
  const multiBar = [
    { name: '平均分', data: compareDf.map((c) => c.avg) },
    { name: '优秀率%', data: compareDf.map((c) => Math.round(c.excellent_rate * 100)) },
    { name: '及格率%', data: compareDf.map((c) => Math.round(c.pass_rate * 100)) },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost sm" onClick={onBack}>‹ 返回</button>
        <h2>⚖ 道法学情分析 <span className="tips">（{cls?.name || ''} · 单科专属：得分率/题型/分层/归因）</span></h2>
      </div>
      <div className="tips">分析口径：道法单科（{DF_SUBJECT}），与全科总分分析隔离；侧重答题能力与知识漏洞，服务备课、讲评、分层辅导与教研上交。</div>

      <div className="card">
        <div className="row">
          <select value={examId} onChange={(e) => setExamId(e.target.value)}>
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name}（{e.date}）</option>)}
          </select>
          <span className="tips">{curExamName ? `已选：${curExamName} · 道法有效成绩 ${n} 人` : ''}</span>
        </div>
        <div className="row" style={{ alignItems: 'center', gap: 6, marginTop: 6 }}>
          <textarea rows={1} placeholder="批量录入道法成绩：每行 学号,分数,班级排名（可选）&#10;如：20260101,92,3（科目自动为道德与法治）" value={scoreText} onChange={(e) => setScoreText(e.target.value)} style={{ flex: 1, resize: 'none' }} />
          <button className="btn primary sm" onClick={doDfPaste} disabled={!examId}>批量录入</button>
          <label className="btn ghost sm file-btn">📥 Excel/CSV
            <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { if (e.target.files[0]) { doDfExcel(e.target.files[0]); e.target.value = ''; } }} />
          </label>
        </div>
        {n === 0 && <div className="empty-tip">该考试暂无道法成绩，可粘贴或导入 Excel 快速录入（科目自动为道德与法治）</div>}
      </div>

      {n > 0 && (
        <>
          {/* 表1 整体学情汇总 */}
          <div className="card">
            <h4>① 道法单科整体学情汇总表 <span className="tips">教研上交 · 本班 vs 年级</span></h4>
            <div className="stat-cards">
              {[
                ['参考人数', n, '人'], ['满分', DF_FULL, '分'], ['平均分', curAvg, '分'],
                ['最高分', curMax, '分'], ['最低分', curMin, '分'],
                ['优秀率', Math.round(curExcellent * 100), '%'], ['及格率', Math.round(curPass * 100), '%'],
                ['低分率', Math.round(curLow * 100), '%'],
                ['年级平均分', gradeAvg ?? '—', '分'],
                ['分差', gradeDiff == null ? '—' : (gradeDiff >= 0 ? `+${gradeDiff}` : gradeDiff), '分'],
              ].map(([k, v, u]) => (
                <div key={k} className="stat-card">
                  <div className="stat-label">{k}</div>
                  <div className="stat-value">{v}<span style={{ fontSize: 12 }}> {u}</span></div>
                </div>
              ))}
            </div>
            {gradeAvg != null && (
              <>
                <Chart option={barOption(
                  ['平均分', '优秀率', '及格率', '低分率'],
                  [
                    { name: `${cls?.name || '本班'}`, data: [curAvg, Math.round(curExcellent * 100), Math.round(curPass * 100), Math.round(curLow * 100)] },
                    { name: '年级（同阶段班均值）', data: [gradeAvg, Math.round((gradeExcellent || 0) * 100), Math.round((gradePass || 0) * 100), null] },
                  ],
                  { name: '数值', yName: '百分制' })} height={240} />
                <div className="tips">分组柱状图：本班与年级核心指标并列对比，一眼定位道法是优势还是薄弱学科。年级口径 = 同阶段各班最近一次考试均值（近似）。</div>
              </>
            )}
          </div>

          {/* 表2 分数段分布 */}
          <div className="card">
            <h4>② 道法分数段分布统计表 <span className="tips">判断两极分化 · 规划培优补差体量</span></h4>
            <table className="table slim">
              <thead><tr><th>分数区间</th><th>段位</th><th>人数</th><th>占比</th><th>累计占比</th></tr></thead>
              <tbody>
                {seg4.map((s) => (
                  <tr key={s.name}><td><b>{s.name}</b></td><td>{s.note}</td><td>{s.value}</td><td>{n ? Math.round((s.value / n) * 100) : 0}%</td><td>{n ? Math.round((s.cum / n) * 100) : 0}%</td></tr>
                ))}
              </tbody>
            </table>
            {segGap && <div className="warn">⚠ 检测到分数断层（某段 0 人）：道法常见「选择题差距小、主观题拉开分差」导致的断层，中间层薄弱需重点关注。</div>}
            <Chart option={barOption(seg4.map((s) => s.name), seg4.map((s) => s.value), { name: '人数', yName: '人' })} height={220} />
            <div className="tips">直方图看成绩聚集情况（课堂讲评用）；家长会可切换饼图看占比。</div>
          </div>

          {/* 表3 题型得分率 */}
          <div className="card">
            <h4>③ 道法各题型得分率统计表 <span className="tips">道法最核心表 · 区分基础识记与答题能力</span></h4>
            {typeStats.length === 0 ? (
              <div className="empty-tip">本场考试未录入题型小分——批量录入成绩时填写 question_scores（选择/简答/材料分析/论述）后自动生成</div>
            ) : (
              <>
                <Chart option={barOption(typeStats.map((t) => t.label), typeStats.map((t) => t.rate * 100), { name: '得分率%', yName: '%', horizontal: true })} height={Math.max(160, typeStats.length * 52)} />
                <table className="table slim">
                  <thead><tr><th>题型</th><th>满分</th><th>班平均分</th><th>得分率</th><th>诊断</th><th>教学建议</th></tr></thead>
                  <tbody>
                    {typeStats.map((t) => (
                      <tr key={t.key}>
                        <td>{t.label}</td><td>{t.full}</td><td>{t.avg}</td>
                        <td className={t.rate < 0.7 ? 'down-text' : 'up-text'}>{Math.round(t.rate * 100)}%</td>
                        <td><span className={`warn-tag ${t.rate < 0.6 ? 'down-text' : ''}`}>{t.level}</span></td>
                        <td className="tips">{t.advice}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="tips">得分率剥离试卷难度：选择题得分率高但材料/探究题暴跌 = 基础识记过关、审题与材料结合能力弱，讲评重点应放在主观题。</div>
              </>
            )}
          </div>

          {/* 表4 失分排行 */}
          <div className="card">
            <h4>④ 失分排行与错因归类 <span className="tips">按失分率从高到低 · 优先安排专题复习</span></h4>
            {lossRows.length === 0 ? (
              <div className="empty-tip">暂无题型数据（录入题型小分后生成）</div>
            ) : (
              <>
                <Chart option={barOption(lossRows.map((t) => t.label), lossRows.map((t) => t.loss * 100), { name: '失分率%', yName: '%', horizontal: true })} height={Math.max(160, lossRows.length * 52)} />
                <div className="tips">典型错因归类：单项选择→概念混淆｜简答→观点缺失/要点不全｜材料分析→不会结合材料/审题不清｜实践探究→表述不规范。题号级知识点错因表需逐题小分数据，当前以题型级呈现。</div>
              </>
            )}
          </div>

          {/* 表5 个人纵向追踪 */}
          <div className="card">
            <h4>⑤ 学生道法个人纵向追踪 <span className="tips">多次考试对比 · 谈心/家校沟通 · 入成长档案</span></h4>
            <div className="row">
              <select value={trackSid} onChange={(e) => setTrackSid(e.target.value)}>
                <option value="">选择学生…</option>
                {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {trackData && <span className="tips">趋势判定：<b>{trackData.status}</b>{trackData.status === '波动' ? '（背诵落实不稳定，成绩起伏明显）' : ''}</span>}
            </div>
            {trackData ? (
              <>
                <Chart option={lineOption(trackData.rows.map((r) => r.name), [
                  { name: trackData.name, data: trackData.rows.map((r) => r.mine) },
                  { name: '班级均分', data: trackData.rows.map((r) => r.avg) },
                ])} height={240} />
                <table className="table slim">
                  <thead><tr><th>考试</th><th>道法得分</th><th>班均</th><th>分差</th><th>班级排名</th></tr></thead>
                  <tbody>
                    {trackData.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.name}</td><td><b>{r.mine}</b></td><td>{r.avg}</td>
                        <td className={r.mine - r.avg >= 0 ? 'up-text' : 'down-text'}>{r.mine - r.avg >= 0 ? '+' : ''}{r1(r.mine - r.avg)}</td>
                        <td>{r.rank} / {n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <div className="tips">选择学生查看其道法历次走势（单条折线 = 单人趋势；叠加班均线对比）</div>}
          </div>

          {/* 表6 分层归类 */}
          <div className="card">
            <h4>⑥ 道法学生分层归类表 <span className="tips">单科培优补差执行表</span></h4>
            <div className="analysis-panels">
              <div className="panel">
                <Chart option={pieOption(TIER_DEF.map(([label]) => ({ name: label, value: tierCnt[label] })).filter((x) => x.value > 0), { name: '分层' })} height={220} />
                <div className="stat-row">
                  {TIER_DEF.map(([label]) => <span key={label}>{label} <b>{tierCnt[label]}</b> 人</span>)}
                </div>
              </div>
              <div className="panel">
                <h4>分层辅导重点</h4>
                {TIER_DEF.map(([label, , advice]) => (
                  <div key={label} className="concern-item"><b>{label}</b><span className="tips">{advice}</span></div>
                ))}
              </div>
            </div>
            <table className="table slim">
              <thead><tr><th>姓名</th><th>道法得分</th><th>所属分层</th><th>辅导重点</th></tr></thead>
              <tbody>
                {tierRows.map((r) => (
                  <tr key={r.sid}>
                    <td><a className="link" onClick={() => onOpenStudent && onOpenStudent(r.sid, 'scores')}>{r.name}</a></td>
                    <td><b>{r.score}</b></td>
                    <td>{r.tier}</td>
                    <td className="tips">{r.advice}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 表7 联动归因 */}
          <div className="card">
            <h4>⑦ 道法成绩-作业落实联动归因 <span className="tips">区分「不愿背诵（态度）」与「会背不会答（方法）」</span></h4>
            {!hwRates ? (
              <button className="btn primary sm" onClick={loadHwRates}>⚡ 生成散点图（读取全班作业完成率）</button>
            ) : scatterPts.length === 0 ? (
              <div className="empty-tip">无足够作业记录与道法成绩数据</div>
            ) : (
              <>
                <Chart option={scatterOption([{ name: '学生', data: scatterPts.map((p) => [p.rate, p.df, p.name]) }], { xName: '作业完成率', yName: '道法分数', xFormatter: (v) => `${Math.round(v * 100)}%` })} height={260} />
                <div className="analysis-panels">
                  {methodRisk.length > 0 && <div className="panel"><h4 className="warn">⚠ 方法问题（作业完成率≥80% 但道法&lt;70）</h4><div className="tips">会交作业但得分低 → 答题方法/审题问题：{methodRisk.map((p) => p.name).join('、')}</div></div>}
                  {attitudeRisk.length > 0 && <div className="panel"><h4 className="warn">⚠ 态度问题（作业完成率&lt;50% 且道法&lt;70）</h4><div className="tips">背诵落实不足 → 态度/管理问题：{attitudeRisk.map((p) => p.name).join('、')}</div></div>}
                  {methodRisk.length === 0 && attitudeRisk.length === 0 && <div className="tips">未发现明显异常学生：成绩与作业落实基本匹配。</div>}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* 历次班均趋势 + 两次对比（保留） */}
      {trendSeries.length > 0 && (
        <div className="card">
          <h4>📈 历次考试道法平均分趋势</h4>
          <Chart option={lineOption(trendSeries.map((t) => t.name), [{ name: '道法平均分', data: trendSeries.map((t) => t.avg) }])} height={240} />
        </div>
      )}

      {compare && (
        <div className="card">
          <h4>⚔ 两次考试道法对比（{compare.nameA} → {compare.nameB}）</h4>
          <div className="row">
            <select value={cmpA} onChange={(e) => setCmpA(e.target.value)}>
              {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <span>→</span>
            <select value={cmpB} onChange={(e) => setCmpB(e.target.value)}>
              {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <span className="tips">进步 {compare.up} 人 · 退步 {compare.down} 人 · 持平 {compare.stable} 人</span>
          </div>
          <Chart option={barOption(['进步', '退步', '持平'], [compare.up, compare.down, compare.stable], { name: '人数' })} height={220} />
          <table className="table">
            <thead><tr><th>学生</th><th>{compare.nameA} 道法</th><th>{compare.nameB} 道法</th><th>变化</th></tr></thead>
            <tbody>
              {compare.rows.slice(0, 15).map((r) => (
                <tr key={r.student_id}>
                  <td><a className="link" onClick={() => onOpenStudent && onOpenStudent(r.student_id, 'scores')}>{r.name}</a></td>
                  <td>{r.scoreA}</td><td>{r.scoreB}</td>
                  <td className={r.delta >= 0 ? 'up-text' : 'down-text'}>{r.delta >= 0 ? '+' : ''}{r.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 表8 多班横向对比 */}
      {compareDf.length > 0 && (
        <div className="card">
          <h4>⑧ 多班级道法横向对比汇总表 <span className="tips">跨班代课 · 一班一策差异化备课</span></h4>
          <Chart option={barOption(classNames, multiBar, { name: '指标', yName: '百分制' })} height={Math.max(200, compareDf.length * 40)} />
          <table className="table">
            <thead><tr><th>班级</th><th>考试</th><th>平均分</th><th>优秀率</th><th>及格率</th><th>低分率</th><th>较上次</th><th>人数</th></tr></thead>
            <tbody>
              {compareDf.map((c) => {
                const low = c.student_count ? (c.segments.lt60 || 0) / c.student_count : 0;
                return (
                  <tr key={c.class_id} className={c.class_id === cid ? 'row-highlight' : ''}>
                    <td>{c.class_id === cid ? `★ ${c.class_name}（本班）` : c.class_name}</td>
                    <td>{c.exam_name}（{c.exam_date}）</td>
                    <td><b>{c.avg}</b></td>
                    <td>{Math.round(c.excellent_rate * 100)}%</td>
                    <td>{Math.round(c.pass_rate * 100)}%</td>
                    <td className={low > 0.3 ? 'down-text' : ''}>{Math.round(low * 100)}%</td>
                    <td className={c.avg_delta >= 0 ? 'up-text' : 'down-text'}>{c.avg_delta == null ? '—' : `${c.avg_delta >= 0 ? '+' : ''}${c.avg_delta}`}</td>
                    <td>{c.student_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="tips">分组柱状图：各班平均分/优秀率/及格率并列对比，直观发现"哪个班选择题薄弱、哪个班材料题薄弱"，实现一班一策。</div>
        </div>
      )}
    </div>
  );
}
