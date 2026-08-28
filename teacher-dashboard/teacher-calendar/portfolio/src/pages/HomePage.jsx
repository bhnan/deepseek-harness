import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const CAT = { emotion: '心理', family: '家庭', relationship: '人际', conduct: '品德', reward: '奖励', punish: '违纪', volunteer: '志愿', other: '其他' };
const EXAM_TYPE = { placement: '分班测试', weekly: '周考', monthly: '月考', midterm: '期中', final: '期末', mock: '模拟考', subject: '专项', other: '其他' };
const COM_TYPE = { talk: '谈心', home_visit: '家访', parent_meet: '家长约谈', chat: '私聊安排' };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// 工作台首页（当前班级视角）：统计卡 + 成绩趋势 + 待办/考试安排 + 台账动态 + 需关注 + 德育
export default function HomePage({ classes = [], currentClass, onNav, onOpenStudent, notify, refreshKey }) {
  const [stats, setStats] = useState({ studentCount: 0, classCount: 0, concernCount: 0, hwRate: null });
  const [trends, setTrends] = useState([]);
  const [exams, setExams] = useState([]);
  const [concerns, setConcerns] = useState([]);
  const [morals, setMorals] = useState([]);
  const [upcoming, setUpcoming] = useState([]);   // 近期沟通安排（今天起）
  const [ledger, setLedger] = useState([]);        // 最近台账动态
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!currentClass) { setLoaded(true); return; }
    const cid = currentClass.id;
    (async () => {
      try {
        const stus = (await api.listStudents(cid)).students || [];
        const nameById = new Map(stus.map((s) => [s.id, s.name]));
        // 作业统计：台账口径（hw_ledger），近 30 天
        let hwRate = null, problem = [];
        try {
          const ledger = (await api.listHwLedger(cid)).records || [];
          const since = todayISO();
          const d = new Date(since + 'T00:00:00'); d.setDate(d.getDate() - 30);
          const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const recent = ledger.filter((r) => r.record_date >= from);
          hwRate = recent.reduce((a, r) => a + r.missing.length, 0); // 近30天未交人次
          const missCnt = new Map();
          for (const r of recent) for (const x of r.missing) missCnt.set(x.id || x.name, (missCnt.get(x.id || x.name) || 0) + 1);
          problem = [...missCnt.entries()].filter(([, n]) => n >= 2).map(([k, n]) => ({
            student_id: k, student_name: nameById.get(k) || k, missing: n, slack: 0, ledger: true,
          }));
        } catch { /* 无台账 */ }
        if (!alive) return;
        setStats({ studentCount: currentClass.student_count || stus.length, classCount: classes.length, concernCount: problem.length, hwRate });
        setConcerns(problem.slice(0, 6));

        // 考试列表（成绩趋势 + 考试安排）
        const exams = (await api.listExams(cid)).exams || [];
        setExams(exams.slice(0, 5));
        const trendRows = [];
        if (currentClass.role === 'homeroom') {
          for (const e of exams.slice(0, 3)) {
            try { const an = await api.classAnalysis(cid, e.id); if (an.analysis) trendRows.push({ name: e.name, avg: an.analysis.stats.avg_total }); } catch { /* 跳 */ }
          }
        } else {
          try { const df = (await api.dfCompare(`?stage=${currentClass.stage}`)).compare || []; const r = df.find((x) => x.class_id === cid); if (r) trendRows.push({ name: r.exam_name, avg: r.avg }); } catch { /* 跳 */ }
        }
        if (!alive) return;
        setTrends(trendRows.slice(0, 6));

        // 近期沟通安排（今天起）
        try {
          const coms = (await api.listCommunications(`?class_id=${cid}`)).communications || [];
          const today = todayISO();
          setUpcoming(coms.filter((c) => c.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 5).map((c) => ({ ...c, student_name: nameById.get(c.student_id) || '' })));
        } catch { /* 忽略 */ }

        // 最近台账动态
        try { const lr = (await api.listHwLedger(cid)).records || []; if (alive) setLedger(lr.slice(0, 5)); } catch { /* 忽略 */ }

        // 近期德育
        const moralRows = [];
        for (const s of stus.slice(0, 8)) {
          try { const recs = (await api.listMoral(s.id)).records || []; if (recs[0]) moralRows.push({ student_id: s.id, name: s.name, cat: recs[0].category, content: recs[0].content, result: recs[0].result }); } catch { /* 跳 */ }
        }
        if (alive) setMorals(moralRows.slice(0, 5));
      } finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; };
  }, [currentClass?.id, classes, refreshKey]);

  if (!currentClass) return <div className="empty-tip">请先在顶部选择班级，或先在「系统设置」创建班级</div>;

  return (
    <div className="page">
      <div className="stat-cards">
        <button className="stat-card clickable" title="查看学生档案" onClick={() => onNav && onNav('students')}><div className="stat-label">班级学生</div><div className="stat-value">{stats.studentCount} <span>人</span></div></button>
        <div className="stat-card"><div className="stat-label">任教班级</div><div className="stat-value">{stats.classCount} <span>个</span></div></div>
        <button className="stat-card clickable" title="查看作业台账" onClick={() => onNav && onNav('hw')}><div className="stat-label">近30天作业未交</div><div className="stat-value">{stats.hwRate == null ? '—' : stats.hwRate}<span> 人次</span></div></button>
        <button className="stat-card clickable" title="查看考试与成绩" onClick={() => onNav && onNav('full')}><div className="stat-label">已录考试</div><div className="stat-value">{exams.length}<span> 场</span></div></button>
      </div>

      <div className="dash-cols">
        <div className="dash-main">
          <div className="card">
            <div className="card-head"><b>↗ 近期成绩趋势</b><span className="tips clickable" onClick={() => onNav && onNav('full')} style={{ cursor: 'pointer' }}>{currentClass.name} ›</span></div>
            <table className="table">
              <tbody>
                {trends.map((t, i) => (
                  <tr key={i}><td className="tips">{t.name}</td><td className="trend-val"><b>{t.avg}</b> 分</td></tr>
                ))}
                {trends.length === 0 && <tr><td colSpan={2} className="empty-tip">暂无成绩数据</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="card-head"><b>🗓 近期沟通安排</b><span className="tips">自动同步教学日历 · 今天起</span></div>
            {upcoming.map((c, i) => (
              <div key={i} className="concern-item">
                <b>{c.date.slice(5)}</b> · {COM_TYPE[c.type] || c.type}{c.student_name ? ` · ${c.student_name}` : ''}{c.time ? ` ${c.time}` : ''}
                {c.location && <span className="tips"> @{c.location}</span>}
              </div>
            ))}
            {upcoming.length === 0 && <div className="tips">暂无近期安排——可在学生档案「沟通安排」创建</div>}
          </div>

          <div className="card">
            <div className="card-head"><b>🕒 最近台账动态</b><span className="tips clickable" onClick={() => onNav && onNav('hw')} style={{ cursor: 'pointer' }}>作业台账 ›</span></div>
            {ledger.map((r, i) => (
              <div key={i} className="concern-item">
                <b>{r.record_date}</b> · {r.subjects.join('、')}
                <span className="tips">表扬 {r.praise.length} ｜ 未交 {r.missing.length} ｜ 问题 {r.problem.length}{r.note ? ` ｜ ${r.note.slice(0, 10)}` : ''}</span>
              </div>
            ))}
            {ledger.length === 0 && <div className="tips">暂无台账记录——到「作业台账」极速录入</div>}
          </div>
        </div>

        <div className="dash-side">
          <div className="card">
            <div className="card-head"><b>⚠ 作业需关注学生（{stats.concernCount} 人）</b><span className="tips">近30天台账缺交≥2 次</span></div>
            {concerns.map((c, i) => (
              <div key={i} className="concern-item clickable" title="点击查看该生档案" onClick={() => onOpenStudent && onOpenStudent(c.student_id)}>
                <b>{c.student_name}</b><span className="warn-tag">作业需关注</span>
                <div className="tips">缺交 {c.missing} 次 / 30 天</div>
              </div>
            ))}
            {concerns.length === 0 && <div className="tips">暂无需重点关注的学生</div>}
          </div>

          <div className="card">
            <div className="card-head"><b>📅 近期考试安排</b><span className="tips clickable" onClick={() => onNav && onNav('full')} style={{ cursor: 'pointer' }}>全科学情 ›</span></div>
            {exams.map((e, i) => (
              <div key={i} className="concern-item"><b>{e.name}</b><span className="tips">{e.date} · {EXAM_TYPE[e.type] || e.type}</span></div>
            ))}
            {exams.length === 0 && <div className="tips">暂无考试——到「全科学情」新建并录入成绩</div>}
          </div>

          <div className="card">
            <div className="card-head"><b>❤ 近期德育记录</b><span className="tips">全部</span></div>
            {morals.map((m, i) => (
              <div key={i} className="moral-item clickable" title="点击查看该生心理德育" onClick={() => onOpenStudent && onOpenStudent(m.student_id, 'moral')}><b>{m.name}</b> · {CAT[m.cat] || m.cat}
                <div className="tips">{m.content.slice(0, 20)}{m.result ? `，${m.result.slice(0, 10)}` : ''}</div></div>
            ))}
            {morals.length === 0 && <div className="tips">暂无德育记录</div>}
          </div>
        </div>
      </div>
      {!loaded && <div className="tips">加载中…</div>}
    </div>
  );
}
