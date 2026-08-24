// 全科学情 · 成绩数据呈现区块（按 08 指令 v1.1 整合）
// 基础区：A 指标卡 / B 分数段(直方图⇄饼图) / C 学科均衡(表+误差条+箱线图) / D 进退步 / E 分层与临界名单 / F 排名明细
// 扩展区：G1 作业-成绩散点 / G2 个人雷达弹层 / G3 分梯队趋势折线
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Chart, { lineOption, pieOption, radarOption } from './Chart.jsx';

/* ---------- 统计工具 ---------- */
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stddev = (a) => {
  const m = mean(a);
  if (m == null || a.length < 2) return null;
  return Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1));
};
const quantile = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  const p = (s.length - 1) * q;
  const i = Math.floor(p);
  return s[i] + (s[i + 1] - s[i]) * (p - i);
};
const r1 = (v) => Math.round(v * 10) / 10;
const fmt = (v) => (v == null ? '—' : r1(v));
const themeColor = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4A90D9';
const UP = '#4CAF50', DOWN = '#E53935', ORANGE = '#f59e0b', PURPLE = '#8e6fc9';

/* 分数线配置（按班级持久化） */
function loadCfg(cid, subjectCount) {
  const def = {
    target: Math.round(subjectCount * 71.4),
    pass: subjectCount * 60,
    range: 10,
    segs: [Math.round(subjectCount * 57.1), Math.round(subjectCount * 64.3), Math.round(subjectCount * 71.4), Math.round(subjectCount * 78.6)],
  };
  try {
    const c = JSON.parse(localStorage.getItem(`pf_cutline_${cid}`) || 'null');
    if (c && c.target) return { ...def, ...c };
  } catch { /* ignore */ }
  return def;
}

export default function ScoreBlocks({ cid, examId, exams, notify, onOpenStudent }) {
  const [students, setStudents] = useState([]);
  const [curScores, setCurScores] = useState([]);
  const [prevScores, setPrevScores] = useState([]);
  const [allScores, setAllScores] = useState([]); // 历次 {exam, scores}
  const [cfg, setCfg] = useState(() => loadCfg(cid, 7));
  const [showCfg, setShowCfg] = useState(false);
  const [metric, setMetric] = useState('total');
  const [subject, setSubject] = useState('');
  const [compare, setCompare] = useState(true);
  const [cmpExamId, setCmpExamId] = useState(''); // 对比考试：''=自动（上次同类型），否则任意指定
  const [bMode, setBMode] = useState('hist');
  const [eMode, setEMode] = useState('pie');
  const [tier, setTier] = useState('临界优生');
  const [dFilter, setDFilter] = useState('all');
  const [fSort, setFSort] = useState({ key: '总分', dir: -1 });
  const [fKeyword, setFKeyword] = useState('');
  const [fWeak, setFWeak] = useState(false);
  const [extOn, setExtOn] = useState(false);
  const [g3Mode, setG3Mode] = useState('all');
  const [g3Metric, setG3Metric] = useState('score');
  const [hwRates, setHwRates] = useState(null);
  const [modalSid, setModalSid] = useState(null);

  const exam = exams.find((e) => e.id === examId) || null;
  // 自动对比：上一次同类型考试；若用户显式选择任意考试则优先（不限于同类型）
  const autoPrevExam = useMemo(() => {
    if (!exam) return null;
    return exams.filter((e) => e.type === exam.type && e.date < exam.date).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  }, [exams, exam]);
  const prevExam = cmpExamId ? (exams.find((e) => e.id === cmpExamId) || null) : autoPrevExam;

  /* ---------- 数据加载 ---------- */
  useEffect(() => { api.listStudents(cid).then((d) => setStudents(d.students)).catch(() => {}); }, [cid]);
  useEffect(() => { if (!examId) return; api.examScores(examId).then((d) => setCurScores(d.scores || [])).catch(() => {}); }, [examId, cid]);
  useEffect(() => {
    if (!prevExam) { setPrevScores([]); return; }
    api.examScores(prevExam.id).then((d) => setPrevScores(d.scores || [])).catch(() => {});
  }, [prevExam && prevExam.id]); // eslint-disable-line
  useEffect(() => {
    (async () => {
      const rows = [];
      for (const e of exams.slice(0, 8)) {
        try { const d = await api.examScores(e.id); rows.push({ exam: e, scores: d.scores || [] }); } catch { /* 跳 */ }
      }
      rows.reverse();
      setAllScores(rows);
    })();
  }, [exams]);

  const nameById = useMemo(() => new Map(students.map((s) => [s.id, s.name])), [students]);
  const subjects = useMemo(() => [...new Set(curScores.filter((r) => r.subject !== '总分').map((r) => r.subject))], [curScores]);
  useEffect(() => {
    if (!subject && subjects.length) setSubject(subjects[0]);
  }, [subjects]); // eslint-disable-line
  useEffect(() => {
    if (subjects.length) setCfg(loadCfg(cid, subjects.length));
  }, [cid, subjects.length]); // eslint-disable-line

  const totalSubj = subjects.length;
  const metricKey = metric === 'total' ? '总分' : subject;

  /* ---------- 基础数据计算 ---------- */
  const classScores = (rows, key) => rows.filter((r) => r.subject === key && r.score != null).map((r) => r.score);
  const curList = classScores(curScores, metricKey);
  const prevList = compare && prevExam ? classScores(prevScores, metricKey) : [];
  const n = curList.length;
  const stat = {
    '平均分': mean(curList), '中位数': median(curList), '最高分': curList.length ? Math.max(...curList) : null,
    '最低分': curList.length ? Math.min(...curList) : null,
    '及格率': metric === 'total' ? (curList.filter((v) => v >= cfg.pass).length / (n || 1)) : (curList.filter((v) => v >= 60).length / (n || 1)),
    '优秀率': metric === 'total' ? (curList.filter((v) => v >= 85 * totalSubj).length / (n || 1)) : (curList.filter((v) => v >= 85).length / (n || 1)),
    '标准差': stddev(curList), '参考人数': n,
  };
  const prevStat = prevList.length ? {
    '平均分': mean(prevList), '中位数': median(prevList), '最高分': Math.max(...prevList), '最低分': Math.min(...prevList),
    '及格率': metric === 'total' ? (prevList.filter((v) => v >= cfg.pass).length / prevList.length) : (prevList.filter((v) => v >= 60).length / prevList.length),
    '优秀率': metric === 'total' ? (prevList.filter((v) => v >= 85 * totalSubj).length / prevList.length) : (prevList.filter((v) => v >= 85).length / prevList.length),
    '标准差': stddev(prevList),
  } : null;

  /* 分数段 */
  const segLabels = metric === 'total'
    ? ['<' + cfg.segs[0], ...cfg.segs.map((v, i) => (i < cfg.segs.length - 1 ? `${v}-${cfg.segs[i + 1] - 1}` : '')).slice(0, -1), '≥' + cfg.segs[cfg.segs.length - 1]]
    : ['<60', '60-69', '70-79', '80-89', '≥90'];
  const segCounts = (rows) => {
    const arr = classScores(rows, metricKey);
    const c = segLabels.map(() => 0);
    arr.forEach((v) => {
      let idx = segLabels.length - 1;
      if (metric === 'total') { for (let i = 0; i < cfg.segs.length; i++) { if (v < cfg.segs[i]) { idx = i; break; } } }
      else { if (v < 60) idx = 0; else if (v < 70) idx = 1; else if (v < 80) idx = 2; else if (v < 90) idx = 3; else idx = 4; }
      c[idx]++;
    });
    return c;
  };
  const curSeg = segCounts(curScores);
  const prevSeg = compare && prevExam ? segCounts(prevScores) : null;

  /* 学科均衡 */
  const subStats = subjects.map((sub) => {
    const sc = classScores(curScores, sub);
    const ps = prevExam ? classScores(prevScores, sub) : [];
    return {
      sub, avg: mean(sc), sd: stddev(sc), med: median(sc),
      pass: sc.filter((v) => v >= 60).length / (sc.length || 1),
      exc: sc.filter((v) => v >= 85).length / (sc.length || 1),
      prevAvg: ps.length ? mean(ps) : null,
    };
  });
  const allAvg = mean(subStats.map((r) => r.avg)) || 0;
  const maxSd = Math.max(...subStats.map((r) => r.sd || 0));

  /* 进退步（同类型上次） */
  const movementRows = useMemo(() => {
    if (!prevExam) return [];
    const prevByStu = new Map(prevScores.filter((r) => r.subject === '总分').map((r) => [r.student_id, r]));
    return curScores.filter((r) => r.subject === '总分' && r.score != null)
      .map((r) => {
        const p = prevByStu.get(r.student_id);
        if (!p || p.score == null) return null;
        const dr = (r.class_rank || 99) - (p.class_rank || 99);
        return {
          sid: r.student_id, name: nameById.get(r.student_id) || r.student_id,
          total: r.score, pt: p.score, dt: Math.round((r.score - p.score) * 10) / 10,
          rank: r.class_rank, prank: p.class_rank, dr,
          status: Math.abs(r.score - p.score) < 5 ? '稳' : (r.score > p.score ? '进' : '退'),
        };
      }).filter(Boolean).sort((a, b) => a.dr - b.dr || b.dt - a.dt);
  }, [curScores, prevScores, prevExam, nameById]);

  /* 分层 */
  const tierOf = (t) => (t >= cfg.target + 30 ? '培优层' : t >= cfg.target - cfg.range ? '临界优生' : t >= cfg.pass ? '临界及格' : '基础薄弱');
  const tierRows = useMemo(() => curScores.filter((r) => r.subject === '总分' && r.score != null)
    .map((r) => ({ sid: r.student_id, name: nameById.get(r.student_id) || r.student_id, total: r.score, tier: tierOf(r.score), gap: r.score - cfg.target }))
    .sort((a, b) => b.total - a.total), [curScores, cfg, nameById]); // eslint-disable-line
  const tierCnt = { '培优层': 0, '临界优生': 0, '临界及格': 0, '基础薄弱': 0 };
  tierRows.forEach((r) => { tierCnt[r.tier]++; });
  const targetRows = tierRows.filter((r) => r.total > cfg.target - 30 && r.total < cfg.target - 10);
  const TIER_COLOR = { '培优层': UP, '临界优生': themeColor(), '临界及格': ORANGE, '基础薄弱': DOWN };
  const weakestOf = (sid) => {
    let best = '—', bestGap = Infinity;
    subjects.forEach((sub) => {
      const row = curScores.find((r) => r.student_id === sid && r.subject === sub);
      if (!row || row.score == null) return;
      const s = subStats.find((x) => x.sub === sub);
      const gap = row.score - (s ? s.avg : 0);
      if (gap < bestGap) { bestGap = gap; best = sub; }
    });
    return best;
  };

  /* 排名明细 */
  const rankRows = useMemo(() => {
    const prevRank = new Map(prevScores.filter((r) => r.subject === '总分' && r.class_rank != null).map((r) => [r.student_id, r.class_rank]));
    const byStu = new Map();
    curScores.forEach((r) => { if (!byStu.has(r.student_id)) byStu.set(r.student_id, {}); byStu.get(r.student_id)[r.subject] = r; });
    const rows = [...byStu.entries()].map(([sid, m]) => {
      const t = m['总分'];
      return {
        sid, name: nameById.get(sid) || sid,
        no: (students.find((s) => s.id === sid) || {}).student_no || '',
        total: t ? t.score : null, rank: t ? t.class_rank : null,
        prevRank: prevRank.get(sid) ?? null,
        dr: t && prevRank.get(sid) != null ? t.class_rank - prevRank.get(sid) : 0,
        subjects: subjects.map((sub) => (m[sub] ? m[sub].score : null)),
      };
    }).filter((r) => r.total != null);
    const kw = fKeyword.trim();
    const filtered = kw ? rows.filter((r) => r.name.includes(kw) || r.no.includes(kw)) : rows;
    const weak = fWeak ? filtered.filter((r) => subjects.some((sub, i) => r.subjects[i] != null && r.subjects[i] <= (subStats.find((s) => s.sub === sub)?.avg || 0) - 5)) : filtered;
    const k = fSort.key;
    const sorted = [...weak].sort((a, b) => {
      if (k === '总分') return (b.total - a.total) || a.name.localeCompare(b.name, 'zh');
      if (k === '名次变化') return a.dr - b.dr;
      if (k === '姓名') return a.name.localeCompare(b.name, 'zh');
      const i = subjects.indexOf(k);
      return (b.subjects[i] || -1) - (a.subjects[i] || -1);
    });
    return sorted.map((r, i) => ({ ...r, displayRank: i + 1 }));
  }, [curScores, prevScores, students, nameById, subjects, subStats, fKeyword, fWeak, fSort]);

  /* ---------- 渲染 ---------- */
  const exName = exam ? exam.name : '';
  const primary = themeColor();

  const bOption = useMemo(() => {
    if (bMode === 'pie') {
      const total = curSeg.reduce((a, b) => a + b, 0) || 1;
      return {
        tooltip: { trigger: 'item', formatter: (p) => `${p.name}：${p.value} 人（${((p.value / total) * 100).toFixed(1)}%）` },
        legend: { bottom: 0 },
        series: [{ type: 'pie', radius: ['36%', '64%'], data: segLabels.map((l, i) => ({ name: l, value: curSeg[i], itemStyle: { color: ['#4A90D9', '#5B9BD5', ORANGE, PURPLE, DOWN][i % 5] } })), label: { formatter: '{b}\n{d}%' } }],
      };
    }
    const series = [{ name: exName, type: 'bar', data: curSeg, barMaxWidth: 40, itemStyle: { color: primary }, label: { show: true, position: 'top', formatter: (p) => (p.value ? p.value + '人' : '') } }];
    if (prevExam && prevSeg) series.push({ name: prevExam.name, type: 'bar', data: prevSeg, barMaxWidth: 40, itemStyle: { color: primary, opacity: 0.35 }, label: { show: true, position: 'top', formatter: (p) => (p.value ? p.value + '人' : '') } });
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: series.map((s) => s.name), top: 0 },
      grid: { left: 40, right: 16, top: 34, bottom: 28 },
      xAxis: { type: 'category', data: segLabels, axisLabel: { interval: 0 } },
      yAxis: { type: 'value', minInterval: 1, name: '人数' },
      series,
    };
  }, [bMode, curSeg, prevSeg, prevExam, exName, primary, segLabels]);

  const cErrOption = useMemo(() => ({
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps) => { const i = ps[0].dataIndex; const r = subStats[i]; return `${r.sub}<br/>平均分：${fmt(r.avg)}<br/>标准差：${fmt(r.sd)}<br/>中位数：${fmt(r.med)}`; },
    },
    grid: { left: 50, right: 16, top: 20, bottom: 26 },
    xAxis: { type: 'category', data: subStats.map((r) => r.sub), axisLabel: { interval: 0 } },
    yAxis: { type: 'value', min: 20, max: 100, name: '分数' },
    series: [
      { type: 'bar', name: '平均分', data: subStats.map((r) => r.avg), barMaxWidth: 34, itemStyle: { color: primary }, label: { show: true, position: 'top', formatter: (p) => fmt(p.value) } },
      {
        type: 'custom', name: '±标准差', z: 3,
        renderItem: (params, api) => {
          const i = api.value(0); const avg = api.value(1); const sd = api.value(2);
          const x = api.coord([i, avg])[0];
          const y1 = api.coord([i, avg - sd])[1]; const y2 = api.coord([i, avg + sd])[1];
          const w = api.size([1, 0])[0] * 0.28;
          return { type: 'group', children: [
            { type: 'line', shape: { x1: x, y1, x2: x, y2 }, style: { stroke: '#94a3b8', lineWidth: 1.6 } },
            { type: 'line', shape: { x1: x - w, y1, x2: x + w, y2: y1 }, style: { stroke: '#94a3b8', lineWidth: 1.6 } },
            { type: 'line', shape: { x1: x - w, y1: y2, x2: x + w, y2 }, style: { stroke: '#94a3b8', lineWidth: 1.6 } },
          ] };
        },
        data: subStats.map((r, i) => [i, r.avg, r.sd || 0]),
      },
    ],
  }), [subStats, primary]);

  const cBoxOption = useMemo(() => {
    const boxData = subjects.map((sub) => {
      const arr = classScores(curScores, sub).sort((a, b) => a - b);
      return [arr[0], quantile(arr, 0.25), quantile(arr, 0.5), quantile(arr, 0.75), arr[arr.length - 1]];
    });
    const outliers = subjects.map((sub, i) => {
      const arr = classScores(curScores, sub).sort((a, b) => a - b);
      const q1 = quantile(arr, 0.25); const q3 = quantile(arr, 0.75); const iqr = q3 - q1;
      return curScores.filter((r) => r.subject === sub && r.score != null && (r.score <= q1 - 1.5 * iqr || r.score >= q3 + 1.5 * iqr))
        .map((r) => [i, r.score, nameById.get(r.student_id) || '']);
    }).flat();
    return {
      tooltip: { trigger: 'item' },
      grid: { left: 50, right: 16, top: 20, bottom: 26 },
      xAxis: { type: 'category', data: subjects, axisLabel: { interval: 0 } },
      yAxis: { type: 'value', min: 10, max: 100 },
      series: [
        { name: '成绩分布', type: 'boxplot', data: boxData, itemStyle: { color: primary, colorAlpha: 0.25 } },
        { name: '离群学生', type: 'scatter', data: outliers, symbolSize: 9, itemStyle: { color: DOWN }, label: { show: true, position: 'top', formatter: (p) => p.data[2], fontSize: 10, color: '#c62828' } },
      ],
    };
  }, [subjects, curScores, nameById, primary]); // eslint-disable-line

  const eOption = useMemo(() => {
    const pieData = Object.entries(tierCnt).map(([k, v]) => ({ name: k, value: v, itemStyle: { color: TIER_COLOR[k] } }));
    if (eMode === 'bar') {
      return {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 90, right: 30, top: 10, bottom: 26 },
        xAxis: { type: 'value', minInterval: 1 },
        yAxis: { type: 'category', data: Object.keys(tierCnt).slice().reverse() },
        series: [{ type: 'bar', data: Object.keys(tierCnt).slice().reverse().map((k) => ({ value: tierCnt[k], itemStyle: { color: TIER_COLOR[k] } })), barMaxWidth: 26, label: { show: true, position: 'right', formatter: (p) => p.value + '人' } }],
      };
    }
    return {
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}：${p.value} 人（${((p.value / (tierRows.length || 1)) * 100).toFixed(1)}%）` },
      legend: { bottom: 0 },
      series: [{ type: 'pie', radius: ['36%', '64%'], data: pieData, label: { formatter: '{b}\n{d}%' } }],
    };
  }, [eMode, tierCnt, tierRows, TIER_COLOR]); // eslint-disable-line

  const g3Option = useMemo(() => {
    if (!allScores.length) return null;
    const xs = allScores.map((r) => r.exam.date.slice(5).replace('-', '/') + ' ' + r.exam.name);
    const totalsOf = (rows) => rows.filter((r) => r.subject === '总分' && r.score != null).map((r) => r.score);
    const ranksOf = (rows) => rows.filter((r) => r.subject === '总分' && r.class_rank != null).map((r) => r.class_rank);
    if (g3Mode === 'all') {
      const data = allScores.map((r) => (g3Metric === 'score' ? r1(mean(totalsOf(r.scores))) : r1(mean(ranksOf(r.scores)))));
      const opt = lineOption(xs, [{ name: g3Metric === 'score' ? '班级总分均分' : '平均名次', data }], { yName: g3Metric === 'score' ? '总分均分' : '名次' });
      if (g3Metric === 'score') opt.series[0].markLine = { silent: true, data: [{ yAxis: cfg.target, lineStyle: { type: 'dashed', color: ORANGE }, label: { formatter: '目标线 ' + cfg.target } }] };
      return opt;
    }
    // 分梯队：按最近一次考试（allScores 末尾=最早？rows.reverse() 后 allScores[0] 是最早。用 examId 对应场）
    const baseIdx = Math.max(0, allScores.findIndex((r) => r.exam.id === examId));
    const base = allScores[baseIdx] || allScores[allScores.length - 1];
    const ordered = base.scores.filter((r) => r.subject === '总分' && r.score != null).sort((a, b) => a.score - b.score);
    const nTop = Math.ceil(ordered.length * 0.25);
    const sets = { top: new Set(ordered.slice(-nTop).map((r) => r.student_id)), bot: new Set(ordered.slice(0, nTop).map((r) => r.student_id)) };
    const mk = (set, label, color) => {
      const ids = [...set];
      return {
        name: label, type: 'line', smooth: true, symbolSize: 7,
        data: allScores.map((r) => {
          const totals = r.scores.filter((x) => x.subject === '总分' && set.has(x.student_id));
          if (!totals.length) return null;
          return g3Metric === 'score' ? r1(mean(totals.map((x) => x.score))) : r1(mean(totals.map((x) => x.class_rank).filter(Boolean)));
        }),
        lineStyle: { width: 2.5, color }, itemStyle: { color },
      };
    };
    const opt = lineOption(xs, [mk(sets.top, '前 25%（培优梯队）', UP), mk(sets.bot, '后 25%（需关注）', DOWN)], { yName: g3Metric === 'score' ? '总分均分' : '名次' });
    if (g3Metric === 'score') opt.series[0].markLine = { silent: true, data: [{ yAxis: cfg.target, lineStyle: { type: 'dashed', color: ORANGE }, label: { formatter: '目标线 ' + cfg.target } }] };
    return opt;
  }, [allScores, g3Mode, g3Metric, cfg.target, examId]);

  const exportRankCsv = () => {
    const head = ['名次', '姓名', '学号', '总分', ...subjects, '名次变化'];
    const body = rankRows.map((r) => [r.displayRank, r.name, r.no, r.total, ...r.subjects, r.dr === 0 ? '' : r.dr]);
    const csv = '\ufeff' + [head, ...body].map((row) => row.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${exName}-排名明细.csv`;
    a.click();
  };

  const loadHwRates = async () => {
    if (hwRates) return;
    const rates = {};
    await Promise.all(students.map(async (s) => {
      try { const d = await api.studentHWStats(s.id); rates[s.id] = d.stats.student_stats[0]?.completion_rate ?? null; } catch { rates[s.id] = null; }
    }));
    setHwRates(rates);
  };
  const g1Pts = hwRates ? students.map((s) => {
    const total = (curScores.find((r) => r.student_id === s.id && r.subject === '总分') || {}).score;
    return { name: s.name, compliance: hwRates[s.id], total };
  }).filter((p) => p.compliance != null && p.total != null) : [];
  const g1Option = useMemo(() => {
    if (!g1Pts.length) return null;
    const n = g1Pts.length; const mx = mean(g1Pts.map((p) => p.compliance)); const my = mean(g1Pts.map((p) => p.total));
    let num = 0; let den = 0;
    g1Pts.forEach((p) => { num += (p.compliance - mx) * (p.total - my); den += (p.compliance - mx) ** 2; });
    const b = den ? num / den : 0; const a = my - b * mx;
    return {
      tooltip: { trigger: 'item', formatter: (p) => `${p.data[2]}<br/>作业完成率：${(p.data[0] * 100).toFixed(0)}%<br/>总分：${p.data[1]}` },
      grid: { left: 50, right: 24, top: 24, bottom: 34 },
      xAxis: { type: 'value', min: 0.2, max: 1, name: '作业完成率', axisLabel: { formatter: (v) => (v * 100).toFixed(0) + '%' } },
      yAxis: { type: 'value', name: '总分', scale: true },
      series: [
        { name: '学生', type: 'scatter', data: g1Pts.map((p) => [p.compliance, p.total, p.name]), symbolSize: 11, itemStyle: { color: primary, opacity: 0.75 } },
        { name: '趋势线', type: 'line', data: [[0.2, a + b * 0.2], [1, a + b]], symbol: 'none', lineStyle: { type: 'dashed', color: DOWN, width: 1.6 } },
      ],
    };
  }, [g1Pts, primary]);

  const g2 = modalSid ? (() => {
    const s = students.find((x) => x.id === modalSid);
    const radar = {
      tooltip: {},
      legend: { data: ['该生', '班级均分'], bottom: 0 },
      radar: { indicator: subjects.map((sub) => ({ name: sub, max: 100 })), radius: '60%' },
      series: [{
        type: 'radar',
        data: [
          { value: subjects.map((sub) => (curScores.find((r) => r.student_id === modalSid && r.subject === sub) || {}).score ?? null), name: '该生', areaStyle: { color: primary, opacity: 0.25 }, lineStyle: { color: primary, width: 2 } },
          { value: subjects.map((sub) => r1(subStats.find((x) => x.sub === sub)?.avg)), name: '班级均分', lineStyle: { type: 'dashed', color: ORANGE, width: 1.5 }, symbol: 'none' },
        ],
      }],
    };
    const trend = lineOption(allScores.map((r) => r.exam.name), [{ name: '总分', data: allScores.map((r) => (r.scores.find((x) => x.student_id === modalSid && x.subject === '总分') || {}).score ?? null) }], { yName: '总分' });
    const weak = subjects.map((sub) => ({ sub, gap: (curScores.find((r) => r.student_id === modalSid && r.subject === sub) || {}).score - (subStats.find((x) => x.sub === sub)?.avg || 0) }))
      .filter((w) => w.gap <= -5).sort((a, b) => a.gap - b.gap);
    return { s, radar, trend, weak };
  })() : null;

  return subjects.length === 0 ? <div className="empty-tip">暂无成绩数据——录入成绩后自动生成全部学情图表</div> : (
    <div className="score-blocks">
      {/* 顶部口径控制 */}
      <div className="row score-toolbar">
        <span className="seg-btns">
          <button className={metric === 'total' ? 'on' : ''} onClick={() => setMetric('total')}>总分</button>
          <button className={metric === 'subject' ? 'on' : ''} onClick={() => setMetric('subject')}>单科</button>
        </span>
        {metric === 'subject' && (
          <select value={subject} onChange={(e) => setSubject(e.target.value)}>
            {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <label className="tips" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> 对比
        </label>
        <select value={cmpExamId} onChange={(e) => setCmpExamId(e.target.value)} disabled={!compare} title="自由选择任意考试对比（不限于同类型）">
          <option value="">自动（上次同类型）</option>
          {exams.filter((e) => e.id !== examId).map((e) => <option key={e.id} value={e.id}>{e.name}（{e.date}）</option>)}
        </select>
        {compare && <span className="tips">当前对照：{prevExam ? prevExam.name : '无（自动上次同类型不存在）'}</span>}
      </div>

      {/* A 指标卡 */}
      <div className="panel">
        <h4>① 整体水平指标卡 <span className="tips">{exName} · {metric === 'total' ? `总分（${totalSubj} 科）` : subject}</span></h4>
        <div className="stat-cards">
          {Object.entries(stat).map(([k, v]) => {
            const pv = prevStat ? prevStat[k] : null;
            let diff = null;
            if (pv != null && v != null && k !== '参考人数') {
              const isRate = k.includes('率');
              diff = isRate ? { v: `${((v - pv) * 100 >= 0 ? '+' : '')}${((v - pv) * 100).toFixed(1)}pp`, cls: Math.abs(v - pv) < 0.001 ? '' : (v > pv ? 'up-text' : 'down-text') }
                : { v: `${(v - pv >= 0 ? '+' : '')}${r1(v - pv)}`, cls: v === pv ? '' : (v > pv ? 'up-text' : 'down-text') };
            }
            return (
              <div className="stat-card" key={k}>
                <div className="stat-label">{k}</div>
                <div className="stat-value">{k.includes('率') ? `${Math.round(v * 100)}%` : fmt(v)}</div>
                <div className={`stat-label ${diff ? diff.cls : ''}`}>{diff ? `较${prevExam ? prevExam.name : '对照'} ${diff.v}` : prevStat ? `${prevExam ? prevExam.name : '对照'} ${k.includes('率') ? Math.round(pv * 100) + '%' : fmt(pv)}` : ''}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* B 分数段 */}
      <div className="panel">
        <h4>
          ② 分数段分布
          <span className="seg-btns" style={{ marginLeft: 8 }}>
            <button className={bMode === 'hist' ? 'on' : ''} onClick={() => setBMode('hist')}>直方图</button>
            <button className={bMode === 'pie' ? 'on' : ''} onClick={() => setBMode('pie')}>饼图</button>
          </span>
          <span className="tips">直方图·校内报告 ｜ 饼图·家长会</span>
        </h4>
        <Chart option={bOption} height={240} />
      </div>

      {/* C 学科均衡 */}
      <div className="panel">
        <h4>③ 学科均衡分析 <span className="tips">薄弱 / 优势 / 两极分化 自动标注</span></h4>
        <table className="table slim">
          <thead><tr><th>科目</th><th>平均分</th><th>及格率</th><th>优秀率</th><th>标准差</th><th>较上次均分差</th><th>科目均分差</th><th>自动标注</th></tr></thead>
          <tbody>
            {subStats.map((r) => {
              const gap = r.avg - allAvg;
              let badge = '';
              if (gap <= -5) badge += ' <span class="warn-tag">薄弱学科</span>';
              if (gap >= 5) badge += ' <span class="warn-tag up-text">优势学科</span>';
              if (r.sd === maxSd && maxSd > 8) badge += ' <span class="warn-tag" style="color:#8e6fc9">两极分化</span>';
              return (
                <tr key={r.sub}>
                  <td>{r.sub}</td><td><b>{fmt(r.avg)}</b></td>
                  <td>{Math.round(r.pass * 100)}%</td><td>{Math.round(r.exc * 100)}%</td>
                  <td>{fmt(r.sd)}</td>
                  <td className={r.prevAvg == null ? '' : (r.avg >= r.prevAvg ? 'up-text' : 'down-text')}>{r.prevAvg == null ? '—' : `${r.avg >= r.prevAvg ? '+' : ''}${fmt(r.avg - r.prevAvg)}`}</td>
                  <td className={gap <= -5 ? 'down-text' : gap >= 5 ? 'up-text' : ''}>{gap >= 0 ? '+' : ''}{fmt(gap)}</td>
                  <td dangerouslySetInnerHTML={{ __html: badge || '—' }} />
                </tr>
              );
            })}
          </tbody>
        </table>
        <Chart option={cErrOption} height={260} />
        <div className="tips">各科平均分 ± 标准差误差条：直观展示学科内部差距。</div>
        <details style={{ marginTop: 6 }}>
          <summary className="tips" style={{ cursor: 'pointer' }}>📦 展开箱线图（中位数 / 四分位 / 离群点）</summary>
          <Chart option={cBoxOption} height={280} />
          <div className="tips">离群点标注学生姓名，用于定位各科显著低于班级水平的学生。</div>
        </details>
      </div>

      {/* D 进退步 */}
      <div className="panel">
        <h4>④ 进退步分析 <span className="tips">对照 {prevExam ? prevExam.name : '上次同类型考试'}</span></h4>
        {!prevExam ? <div className="empty-tip">需 ≥2 次同类型考试</div> : (
          <>
            <div className="stat-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
              <div className="stat-card"><div className="stat-label">进步</div><div className="stat-value up-text">{movementRows.filter((r) => r.status === '进').length} 人</div></div>
              <div className="stat-card"><div className="stat-label">退步</div><div className="stat-value down-text">{movementRows.filter((r) => r.status === '退').length} 人</div></div>
              <div className="stat-card"><div className="stat-label">持平</div><div className="stat-value">{movementRows.filter((r) => r.status === '稳').length} 人</div></div>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              {[['all', '全部'], ['up10', '进步≥10名'], ['down10', '退步≥10名'], ['down20', '退步≥20分']].map(([k, l]) => (
                <button key={k} className={`btn ghost sm ${dFilter === k ? 'primary' : ''}`} onClick={() => setDFilter(k)}>{l}</button>
              ))}
            </div>
            <table className="table slim">
              <thead><tr><th>姓名</th><th>本次总分</th><th>{prevExam.name}</th><th>总分差</th><th>本次名次</th><th>上次名次</th><th>名次变化</th><th>状态</th></tr></thead>
              <tbody>
                {movementRows.filter((r) => (dFilter === 'up10' && r.dr <= -10) || (dFilter === 'down10' && r.dr >= 10) || (dFilter === 'down20' && r.dt <= -20) || dFilter === 'all').map((r) => (
                  <tr key={r.sid}>
                    <td><a className="link" onClick={() => onOpenStudent && onOpenStudent(r.sid, 'scores')}>{r.name}</a></td>
                    <td><b>{r.total}</b></td><td>{r.pt}</td>
                    <td className={r.dt > 0 ? 'up-text' : r.dt < 0 ? 'down-text' : ''}>{r.dt > 0 ? '+' : ''}{r.dt}</td>
                    <td>{r.rank}</td><td>{r.prank}</td>
                    <td className={r.dr > 0 ? 'down-text' : r.dr < 0 ? 'up-text' : ''}>{r.dr > 0 ? `▼ ${r.dr}` : r.dr < 0 ? `▲ ${-r.dr}` : '＝'}</td>
                    <td><span className={`warn-tag ${r.status === '进' ? 'up-text' : r.status === '退' ? 'down-text' : ''}`}>{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* E 分层与临界名单 */}
      <div className="panel">
        <h4>
          ⑤ 分层归类与临界名单
          <span className="seg-btns" style={{ marginLeft: 8 }}>
            <button className={eMode === 'pie' ? 'on' : ''} onClick={() => setEMode('pie')}>占比饼图</button>
            <button className={eMode === 'bar' ? 'on' : ''} onClick={() => setEMode('bar')}>条形图</button>
          </span>
          <button className="btn ghost sm" onClick={() => setShowCfg(!showCfg)}>⚙ 分数线设置</button>
        </h4>
        {showCfg && (
          <div className="row" style={{ marginTop: 6 }}>
            <label className="tips">目标线 <input type="number" style={{ width: 70 }} value={cfg.target} onChange={(e) => setCfg({ ...cfg, target: +e.target.value })} /></label>
            <label className="tips">及格线 <input type="number" style={{ width: 70 }} value={cfg.pass} onChange={(e) => setCfg({ ...cfg, pass: +e.target.value })} /></label>
            <label className="tips">临界范围 <input type="number" style={{ width: 60 }} value={cfg.range} onChange={(e) => setCfg({ ...cfg, range: +e.target.value })} /></label>
            <label className="tips">分段阈值 <input type="text" style={{ width: 170 }} value={cfg.segs.join(',')} onChange={(e) => setCfg({ ...cfg, segs: e.target.value.split(/[,，\s]+/).map(Number).filter((x) => !isNaN(x)).slice(0, 4) })} /></label>
            <button className="btn primary sm" onClick={() => { localStorage.setItem(`pf_cutline_${cid}`, JSON.stringify(cfg)); setShowCfg(false); notify('分数线已保存'); }}>保存</button>
          </div>
        )}
        <Chart option={eOption} height={230} />
        <div className="row" style={{ marginTop: 6 }}>
          {[...Object.entries(tierCnt), ['目标生', targetRows.length]].map(([k, v]) => (
            <button key={k} className={`btn sm ${tier === k ? 'primary' : 'ghost'}`} onClick={() => setTier(k)}>{k} {v}人</button>
          ))}
        </div>
        <table className="table slim">
          <thead><tr><th>姓名</th><th>总分</th><th>距目标线</th><th>各科分</th><th>最薄弱科目</th></tr></thead>
          <tbody>
            {(tier === '目标生' ? targetRows : tierRows.filter((r) => r.tier === tier)).map((r) => {
              const abs = Math.abs(r.gap);
              return (
                <tr key={r.sid}>
                  <td><a className="link" onClick={() => onOpenStudent && onOpenStudent(r.sid, 'scores')}>{r.name}</a></td>
                  <td><b>{r.total}</b></td>
                  <td className={abs <= 5 ? (r.gap >= 0 ? 'up-text' : 'down-text') : ''}>{r.gap >= 0 ? '+' : ''}{r.gap}</td>
                  <td>{subjects.map((sub) => { const row = curScores.find((x) => x.student_id === r.sid && x.subject === sub); return row ? `${sub}${row.score}` : ''; }).filter(Boolean).join(' ')}</td>
                  <td><span className="warn-tag">{weakestOf(r.sid)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="tips">四层：培优 ≥目标线+30 ｜ 临界优生 [目标线−{cfg.range}, 目标线+30) ｜ 临界及格 [及格线, 目标线−{cfg.range}) ｜ 基础薄弱 &lt;及格线；目标生 = (目标线−30, 目标线−{cfg.range})。</div>
      </div>

      {/* F 排名明细 */}
      <div className="panel">
        <h4>⑥ 班级排名明细表 <span className="tips">≥班均浅绿 ｜ ≤班均−5 浅红</span></h4>
        <div className="row">
          <input placeholder="姓名 / 学号" value={fKeyword} onChange={(e) => setFKeyword(e.target.value)} style={{ width: 130 }} />
          <label className="tips" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={fWeak} onChange={(e) => setFWeak(e.target.checked)} /> 只看薄弱
          </label>
          <button className="btn ghost sm" onClick={exportRankCsv}>⤓ 导出 CSV</button>
        </div>
        <div className="table-scroll">
          <table className="table slim">
            <thead><tr>
              <th className="clickable" onClick={() => setFSort({ key: '总分', dir: -1 })}>名次</th>
              <th className="clickable" onClick={() => setFSort({ key: '姓名', dir: 1 })}>姓名</th>
              <th>学号</th>
              <th className="clickable" onClick={() => setFSort({ key: '总分', dir: -1 })}>总分</th>
              {subjects.map((sub) => <th key={sub} className="clickable" onClick={() => setFSort({ key: sub, dir: -1 })}>{sub}</th>)}
              <th className="clickable" onClick={() => setFSort({ key: '名次变化', dir: 1 })}>名次变化</th>
            </tr></thead>
            <tbody>
              {rankRows.map((r) => {
                const totalAvg = mean(rankRows.map((x) => x.total)) || 0;
                return (
                  <tr key={r.sid}>
                    <td>{r.displayRank}</td>
                    <td><a className="link" onClick={() => setModalSid(r.sid)}>{r.name}</a></td>
                    <td>{r.no}</td>
                    <td className={r.total >= totalAvg ? 'cell-up' : r.total <= totalAvg - 35 ? 'cell-down' : ''}><b>{r.total}</b></td>
                    {r.subjects.map((v, i) => {
                      const avg = subStats[i]?.avg || 0;
                      return <td key={i} className={v != null && v >= avg ? 'cell-up' : v != null && v <= avg - 5 ? 'cell-down' : ''}>{v ?? '—'}</td>;
                    })}
                    <td className={r.dr > 0 ? 'down-text' : r.dr < 0 ? 'up-text' : ''}>{r.dr > 0 ? `▼ ${r.dr}` : r.dr < 0 ? `▲ ${-r.dr}` : '＝'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="tips">点击表头排序；点击姓名查看个人学情（雷达图 + 历次成绩折线）。</div>
      </div>

      {/* 扩展区 */}
      <div className="panel">
        <h4>◇ 扩展图表（按需生成）
          <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => { setExtOn(!extOn); if (!extOn) loadHwRates(); }}>
            {extOn ? '⚡ 收起' : '⚡ 一键生成'}
          </button>
        </h4>
        {extOn && (
          <>
            <h5 style={{ marginTop: 10 }}>G1 · 成绩-作业联动散点图 <span className="tips">X=作业完成率 ｜ Y=总分 ｜ 仅展示关联，不作因果定性</span></h5>
            {g1Option ? <Chart option={g1Option} height={240} /> : <div className="empty-tip">无作业记录或成绩数据（在「作业台账」录入后生成）</div>}
            <h5 style={{ marginTop: 12 }}>G3 · 多考趋势（分梯队）
              <span className="seg-btns" style={{ marginLeft: 8 }}>
                <button className={g3Mode === 'all' ? 'on' : ''} onClick={() => setG3Mode('all')}>班级单线</button>
                <button className={g3Mode === 'tier' ? 'on' : ''} onClick={() => setG3Mode('tier')}>分梯队</button>
              </span>
              <span className="seg-btns" style={{ marginLeft: 8 }}>
                <button className={g3Metric === 'score' ? 'on' : ''} onClick={() => setG3Metric('score')}>分数</button>
                <button className={g3Metric === 'rank' ? 'on' : ''} onClick={() => setG3Metric('rank')}>排名</button>
              </span>
            </h5>
            {g3Option ? <Chart option={g3Option} height={260} /> : <div className="empty-tip">暂无历次考试数据</div>}
            <div className="tips">梯队按所选考试总分排名分位：前 25%（培优）与后 25%（需关注）的走势对比——观察整学期是否分化。</div>
          </>
        )}
      </div>

      {/* G2 个人弹层 */}
      {g2 && (
        <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setModalSid(null); }}>
          <div className="modal-box" style={{ width: 680 }}>
            <div className="card-head">
              <h4>{g2.s.name} · 个人学情
                <span className="tips"> {g2.s.student_no} ｜ {g2.s.gender} ｜ 点击外部关闭</span>
              </h4>
              <button className="btn ghost sm" onClick={() => setModalSid(null)}>×</button>
            </div>
            <h5 style={{ marginTop: 8 }}>🛰 偏科雷达图（含班级均分参考线）</h5>
            <Chart option={g2.radar} height={240} />
            <h5 style={{ marginTop: 8 }}>📈 历次考试总分轨迹</h5>
            <Chart option={g2.trend} height={200} />
            <div className="tips">
              {g2.weak.length ? `⚠ 相对班级明显偏弱：${g2.weak.map((w) => `${w.sub}（低于班均 ${r1(-w.gap)} 分）`).join('、')}` : '各科相对均衡，无明显短板。'}
              {' '}· <a className="link" onClick={() => { setModalSid(null); onOpenStudent && onOpenStudent(modalSid, 'scores'); }}>查看完整档案 →</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
