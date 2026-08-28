import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import Chart, { lineOption, barOption, pieOption } from '../components/Chart.jsx';
import ScoreBlocks from '../components/ScoreBlocks.jsx';

/* 撤销最近一步操作（配合删除/停用按钮使用）：调用全局撤销栈并提示被撤销的操作 */
const ENTITY_LABEL = {
  student: '学生', exam: '考试', material: '素材', assignment: '作业', moral_record: '德育记录',
  talent: '特长', honor: '荣誉', comment: '评语', phrase: '话术', communication: '沟通安排',
  class: '班级', settings: '设置', student_import: '批量导入',
};
const undoLast = async (notify, reload) => {
  try {
    const d = await api.undo();
    const e = d.entry;
    const opLabel = { create: '创建', update: '修改', delete: '删除' }[e?.op] || '操作';
    const entLabel = ENTITY_LABEL[e?.entity] || e?.entity || '操作';
    notify(`已撤销：${opLabel}${entLabel}`);
    reload();
  } catch (err) { notify(err.message); }
};



export default function ClassDetailPage({ cid, stageFilter, onBack, onOpenStudent, notify, refreshKey, initialTab }) {
  const [cls, setCls] = useState(null);
  // tab 由侧边栏导航驱动（受控），此处不设内部切换条
  const tab = initialTab || 'students';
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    api.listClasses().then((d) => setCls(d.classes.find((c) => c.id === cid) || null)).catch(() => {});
  }, [cid, refreshKey]);

  if (!cls) return <div className="app-loading">加载班级…</div>;

  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost sm" onClick={onBack}>‹ 返回</button>
        <h2>{cls.name} <span className="tips">（{cls.grade} · {cls.stage === 'primary' ? '小学' : '初中'} · {cls.role === 'homeroom' ? '主班全功能' : '道法代课精简'}）</span></h2>
      </div>
      {tab === 'students' && <StudentsTab cid={cid} cls={cls} onOpenStudent={onOpenStudent} notify={notify} tick={tick} reload={reload} />}
      {tab === 'scores' && <ScoresTab cid={cid} cls={cls} notify={notify} tick={tick} reload={reload} onOpenStudent={onOpenStudent} />}
      {tab === 'hw' && <HWTab cid={cid} cls={cls} notify={notify} tick={tick} reload={reload} />}
      {tab === 'moral' && <MoralTab cid={cid} cls={cls} notify={notify} tick={tick} reload={reload} />}
      {tab === 'honor' && <HonorTab cid={cid} cls={cls} notify={notify} tick={tick} reload={reload} />}
      {tab === 'materials' && <MaterialsTab cid={cid} cls={cls} notify={notify} tick={tick} reload={reload} />}
      {tab === 'comments' && <CommentsTab cid={cid} cls={cls} notify={notify} tick={tick} reload={reload} />}
      {tab === 'phrases' && <PhrasesTab notify={notify} cls={cls} />}
    </div>
  );
}

// ---------- Tab1 学生名单 ----------
function StudentsTab({ cid, cls, onOpenStudent, notify, tick, reload }) {
  const [students, setStudents] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', student_no: '', gender: '', birth_date: '', is_boarding: 0, pressure_level: '中', id_card: '', parent1_name: '', parent1_phone: '', group_name: '' });
  const [importText, setImportText] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    // active=0：接口返回全班（含停用），前端区分展示
    api.listStudents(cid, `${keyword ? `?keyword=${encodeURIComponent(keyword)}` : '?'}${showInactive ? 'active=0' : ''}`)
      .then((d) => setStudents(d.students))
      .catch((e) => notify(e.message));
  }, [cid, keyword, showInactive, tick]);

  const save = async () => {
    try {
      await api.createStudent(cid, form);
      setShowForm(false); setErr(''); setForm({ name: '', student_no: '', gender: '', birth_date: '', is_boarding: 0, pressure_level: '中', id_card: '', parent1_name: '', parent1_phone: '', group_name: '' });
      notify('学生已添加'); reload();
    } catch (e) { setErr(e.message); }
  };

  const doImport = async () => {
    const rows = importText.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { const p = l.split(/[,，\t]/).map((x) => x.trim()); return { name: p[0], student_no: p[1], gender: p[2] || '', birth_date: p[3] || '' }; });
    if (!rows.length) { setErr('请粘贴至少一行：姓名,学号,性别,出生年月'); return; }
    try {
      const d = await api.importStudents(cid, rows);
      notify(`导入 ${d.imported} 行${d.failed ? `，失败 ${d.failed} 行` : ''}`);
      setImportText(''); reload();
    } catch (e) { setErr(e.message); }
  };

  const del = async (s) => {
    if (!confirm(`停用学生「${s.name}」？（档案保留）`)) return;
    try { await api.updateStudent(s.id, { active: 0 }); reload(); notify('已停用（可点旁边「撤销」恢复）'); } catch (e) { notify(e.message); }
  };

  const restore = async (s) => {
    if (!confirm(`恢复学生「${s.name}」的在册状态？`)) return;
    try { await api.updateStudent(s.id, { active: 1 }); reload(); notify('已恢复在册'); } catch (e) { notify(e.message); }
  };

  // 彻底删除：仅停用状态可用，双重确认（输入姓名），不可恢复
  const purge = async (s) => {
    if (!confirm(`彻底删除将永久清除「${s.name}」的全部档案（成绩/作业/德育/特长/荣誉/评语/素材/沟通记录），且不可恢复！确定继续？`)) return;
    const name = prompt(`请输入「${s.name}」确认彻底删除（此操作不可撤销）：`);
    if (name !== s.name) { notify('姓名不一致，已取消'); return; }
    try {
      const d = await api.deleteStudent(s.id);
      const n = Object.values(d.cascade || {}).reduce((a, b) => a + b, 0);
      notify(`已彻底删除「${s.name}」，清除关联数据 ${n} 条（不可恢复）`);
      reload();
    } catch (e) { notify(e.message); }
  };

  // 停用学生排后面
  const sorted = [...students].sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));

  return (
    <div className="card">
      <div className="row">
        <input placeholder="搜索姓名/学号…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <button className="btn primary sm" onClick={() => setShowForm(!showForm)}>＋ 新增学生</button>
        <button className="btn ghost sm" onClick={async () => {
          try { const r = await api.exportStudentsCsv(cid); const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${cls.name}-学生名单.csv`; a.click(); } catch (e) { notify(e.message); }
        }}>导出名单</button>
        <button className={`btn ${showInactive ? 'ghost active' : 'ghost'} sm`} onClick={() => setShowInactive(!showInactive)} title="显示已停用学生（档案保留）">
          {showInactive ? '🙈 隐藏已停用' : '👁 显示已停用'}
        </button>
      </div>
      {showForm && (
        <div className="form">
          <div className="row">
            <input placeholder="姓名*" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="学号" value={form.student_no} onChange={(e) => setForm({ ...form, student_no: e.target.value })} style={{ width: 110 }} />
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              <option value="">性别</option><option>男</option><option>女</option>
            </select>
            <input type="date" value={form.birth_date} onChange={(e) => setForm({ ...form, birth_date: e.target.value })} />
          </div>
          <div className="row">
            <input placeholder="身份证号（加密存储🔒）" value={form.id_card} onChange={(e) => setForm({ ...form, id_card: e.target.value })} />
            <input placeholder="家长1姓名" value={form.parent1_name} onChange={(e) => setForm({ ...form, parent1_name: e.target.value })} style={{ width: 120 }} />
            <input placeholder="家长1电话" value={form.parent1_phone} onChange={(e) => setForm({ ...form, parent1_phone: e.target.value })} style={{ width: 130 }} />
            <input placeholder="小组（如：第一组）" value={form.group_name} onChange={(e) => setForm({ ...form, group_name: e.target.value })} style={{ width: 110 }} />
            <select value={form.pressure_level} onChange={(e) => setForm({ ...form, pressure_level: e.target.value })}>
              <option value="低">压力低</option><option value="中">压力中</option><option value="高">压力高</option>
            </select>
          </div>
          <div className="row">
            <button className="btn primary sm" onClick={save}>保存</button>
            <button className="btn ghost sm" onClick={() => setShowForm(false)}>取消</button>
            {err && <span className="error">{err}</span>}
          </div>
        </div>
      )}
      <div className="import-box">
        <textarea rows={2} placeholder="批量导入：每行 姓名,学号,性别,出生年月" value={importText} onChange={(e) => setImportText(e.target.value)} />
        <button className="btn ghost sm" onClick={doImport}>批量导入</button>
      </div>
      <table className="table">
        <thead><tr><th>姓名</th><th>学号</th><th>性别</th><th>出生年月</th><th>小组</th><th>住校</th><th>压力</th><th>🔒 备注</th><th>操作</th></tr></thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'row-inactive'}>
              <td><a onClick={() => onOpenStudent(s.id)} className="link">{s.name}{!s.active && <span className="warn-tag">已停用</span>}</a></td>
              <td>{s.student_no}</td>
              <td>{s.gender || ''}</td>
              <td>{s.birth_date || ''}</td>
              <td>{s.group_name || ''}</td>
              <td>{s.is_boarding ? '住校' : '走读'}</td>
              <td>{s.pressure_level}</td>
              <td>{s.special_note || s.allergy_note || s.manage_note ? '🔒' : ''}</td>
              <td>
                {s.active ? (
                  <button className="btn danger xs" onClick={() => del(s)}>停用</button>
                ) : (
                  <>
                    <button className="btn ghost xs" onClick={() => restore(s)}>↩ 恢复</button>
                    <button className="btn danger xs" onClick={() => purge(s)} title="永久清除该生全部档案，不可恢复">🗑 彻底删除</button>
                  </>
                )}
                <button className="btn ghost xs" onClick={() => undoLast(notify, reload)} title="撤销最近一步操作（含停用/删除/修改）">撤销</button>
              </td>
            </tr>
          ))}
          {students.length === 0 && <tr><td colSpan={9} className="empty-tip">暂无学生</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Tab2 成绩分析 ----------
function ScoresTab({ cid, cls, notify, tick, reload, onOpenStudent }) {
  const [exams, setExams] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [examId, setExamId] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newExam, setNewExam] = useState({ name: '', type: 'monthly', date: '' });
  const [scoreText, setScoreText] = useState('');
  const [trendSeries, setTrendSeries] = useState([]);     // 历次平均分
  const [cmpA, setCmpA] = useState('');                    // 对比考试 A
  const [cmpB, setCmpB] = useState('');                    // 对比考试 B
  const [compare, setCompare] = useState(null);            // 对比结果

  useEffect(() => {
    api.listExams(cid).then((d) => {
      setExams(d.exams);
      if (!examId && d.exams.length) setExamId(d.exams[0].id);
    }).catch((e) => notify(e.message));
  }, [cid, tick]);

  useEffect(() => {
    if (!examId) return;
    api.classAnalysis(cid, examId).then((d) => setAnalysis(d)).catch((e) => notify(e.message));
  }, [examId, tick]);

  // 历次考试平均分折线
  useEffect(() => {
    (async () => {
      const rows = [];
      for (const e of exams.slice(0, 8)) {
        try { const d = await api.classAnalysis(cid, e.id); if (d.analysis) rows.push({ name: e.name, avg: d.analysis.stats.avg_total }); } catch { /* 跳 */ }
      }
      rows.reverse();
      setTrendSeries(rows);
    })();
  }, [exams, tick]);

  // 默认对比 = 最近两次考试
  useEffect(() => {
    if (exams.length >= 2 && !cmpA && !cmpB) { setCmpA(exams[1].id); setCmpB(exams[0].id); }
  }, [exams]);

  useEffect(() => {
    if (!cmpA || !cmpB) { setCompare(null); return; }
    (async () => {
      try {
        const [da, db] = await Promise.all([api.examScores(cmpA), api.examScores(cmpB)]);
        const stu = await api.listStudents(cid);
        const nameById = new Map(stu.students.map((x) => [x.id, x.name]));
        const agg = (scores) => {
          const m = new Map();
          for (const r of scores) {
            if (r.subject !== '总分') continue;
            m.set(r.student_id, { total: r.score, rank: r.class_rank });
          }
          return m;
        };
        const ma = agg(da.scores), mb = agg(db.scores);
        const rows = [];
        for (const [sid, b] of mb) {
          const a = ma.get(sid);
          if (!a) continue;
          rows.push({
            student_id: sid, name: nameById.get(sid) || sid,
            totalA: a.total, totalB: b.total, deltaTotal: Math.round((b.total - a.total) * 100) / 100,
            rankA: a.rank, rankB: b.rank,
            deltaRank: a.rank != null && b.rank != null ? a.rank - b.rank : null,
          });
        }
        rows.sort((x, y) => y.deltaTotal - x.deltaTotal);
        const up = rows.filter((r) => r.deltaTotal > 0).length;
        const down = rows.filter((r) => r.deltaTotal < 0).length;
        const stable = rows.length - up - down;
        setCompare({ rows, up, down, stable, nameA: da.exam.name, nameB: db.exam.name });
      } catch (e) { notify(e.message); }
    })();
  }, [cmpA, cmpB, tick]);

  const createExam = async () => {
    try {
      const d = await api.createExam(cid, newExam);
      setExamId(d.exam.id); setShowNew(false); setNewExam({ name: '', type: 'monthly', date: '' });
      notify('考试已创建'); reload();
    } catch (e) { notify(e.message); }
  };

  const doBatch = async () => {
    if (!examId) { notify('请先选择考试'); return; }
    const rows = [];
    const errs = [];
    scoreText.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l, i) => {
      const p = l.split(/[,，\t]/).map((x) => x.trim());
      const [no, subject, score, rank] = p;
      if (!no || !subject || score === undefined) { errs.push(`第 ${i + 1} 行格式错误`); return; }
      rows.push({ student_no: no, subject, score: Number(score), class_rank: rank ? Number(rank) : undefined });
    });
    if (errs.length) { notify(errs[0]); return; }
    try {
      const stu = await api.listStudents(cid);
      const byNo = new Map(stu.students.map((s) => [s.student_no, s.id]));
      const final = [];
      for (const r of rows) {
        const sid = byNo.get(r.student_no);
        if (!sid) { errs.push(`学号 ${r.student_no} 不存在`); continue; }
        final.push({ student_id: sid, subject: r.subject, score: r.score, class_rank: r.class_rank });
      }
      if (errs.length) { notify(errs[0]); return; }
      const d = await api.batchScores(examId, final);
      notify(`成绩已录入 ${d.upserted} 条${d.failed ? `，失败 ${d.failed}` : ''}`);
      setScoreText(''); reload();
    } catch (e) { notify(e.message); }
  };

  // 解析 Excel/CSV 文件 → 填入粘贴框（学号,科目,分数,班级排名 列）
  const doExcelFile = async (file) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      let start = 0;
      if (rows.length && /学号|科目|分数|排名/.test(String(rows[0].join(',') || ''))) start = 1;
      const lines = [];
      for (let i = start; i < rows.length; i++) {
        const p = (rows[i] || []).map((x) => String(x).trim());
        if (!p[0] && !p[1] && !p[2]) continue; // 空行跳过
        const parts = [p[0], p[1], p[2]];
        if (p[3]) parts.push(p[3]);
        lines.push(parts.join(','));
      }
      if (!lines.length) { notify('未解析到成绩行（需含 学号/科目/分数 三列）'); return; }
      setScoreText(lines.join('\n'));
      notify(`已从文件解析 ${lines.length} 行，确认无误后点击「批量录入成绩」`);
    } catch (e) { notify(`文件解析失败：${e.message}`); }
  };

  const avg = analysis?.analysis?.stats;
  const segs = avg ? Object.entries(avg.segments).map(([k, v]) => ({ name: k, value: v })) : [];

  return (
    <div className="card">
      <div className="row">
        <select value={examId} onChange={(e) => setExamId(e.target.value)}>
          {exams.map((e) => <option key={e.id} value={e.id}>{e.name}（{e.date}）</option>)}
        </select>
        <button className="btn ghost sm" onClick={() => setShowNew(!showNew)}>＋ 新建考试</button>
      </div>
      {showNew && (
        <div className="row">
          <input placeholder="考试名称*" value={newExam.name} onChange={(e) => setNewExam({ ...newExam, name: e.target.value })} />
          <select value={newExam.type} onChange={(e) => setNewExam({ ...newExam, type: e.target.value })}>
            {[['placement', '分班测试'], ['weekly', '周考'], ['monthly', '月考'], ['midterm', '期中'], ['final', '期末'], ['mock', '模拟考'], ['subject', '专项'], ['other', '其他']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input type="date" value={newExam.date} onChange={(e) => setNewExam({ ...newExam, date: e.target.value })} />
          <button className="btn primary sm" onClick={createExam} disabled={!newExam.name || !newExam.date}>创建</button>
        </div>
      )}
      <div className="row" style={{ alignItems: 'center', gap: 6 }}>
        <textarea rows={1} placeholder="批量粘贴成绩：每行 学号,科目,分数,班级排名（可选）&#10;如：20260101,语文,92,3" value={scoreText} onChange={(e) => setScoreText(e.target.value)} style={{ flex: 1, resize: 'none' }} />
        <button className="btn primary sm" onClick={doBatch}>批量录入</button>
        <label className="btn ghost sm file-btn">📥 Excel/CSV
          <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { if (e.target.files[0]) { doExcelFile(e.target.files[0]); e.target.value = ''; } }} />
        </label>
      </div>
      <div className="tips">文件格式：第 1 列学号、第 2 列科目（如 语文/数学/道德与法治）、第 3 列分数、第 4 列班级排名（可选）；首行含表头会自动跳过。Word 表格请直接复制整表粘贴到上方输入框（同样支持）。</div>

      {/* 完整学情区块（08 指令 v1.1：A 指标卡 / B 分数段 / C 学科均衡 / D 进退步 / E 分层临界 / F 排名明细 / 扩展 G1-G3） */}
      <ScoreBlocks cid={cid} examId={examId} exams={exams} notify={notify} onOpenStudent={onOpenStudent} />

      {trendSeries.length > 0 && (
        <div className="card">
          <h4>📈 历次考试平均分趋势</h4>
          <Chart option={lineOption(trendSeries.map((t) => t.name), [{ name: '平均分', data: trendSeries.map((t) => t.avg) }])} height={240} />
        </div>
      )}

      {exams.length >= 2 && (
        <div className="card">
          <h4>⚔ 两次考试对比（{compare ? `${compare.nameA} → ${compare.nameB}` : ''}）</h4>
          <div className="row">
            <select value={cmpA} onChange={(e) => setCmpA(e.target.value)}>
              {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <span>→</span>
            <select value={cmpB} onChange={(e) => setCmpB(e.target.value)}>
              {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            {compare && <span className="tips">进步 {compare.up} 人 · 退步 {compare.down} 人 · 持平 {compare.stable} 人</span>}
          </div>
          {compare && (
            <>
              <Chart option={barOption(['进步', '退步', '持平'], [compare.up, compare.down, compare.stable], { name: '人数' })} height={220} />
              <table className="table">
                <thead><tr><th>学生</th><th>{compare.nameA}</th><th>{compare.nameB}</th><th>总分变化</th><th>名次变化</th></tr></thead>
                <tbody>
                  {compare.rows.slice(0, 15).map((r) => (
                    <tr key={r.student_id}>
                      <td><a className="link" onClick={() => onOpenStudent && onOpenStudent(r.student_id, 'scores')}>{r.name}</a></td>
                      <td>{r.totalA}{r.rankA ? `（第${r.rankA}名）` : ''}</td>
                      <td>{r.totalB}{r.rankB ? `（第${r.rankB}名）` : ''}</td>
                      <td className={r.deltaTotal >= 0 ? 'up-text' : 'down-text'}>{r.deltaTotal >= 0 ? '+' : ''}{r.deltaTotal}</td>
                      <td className={r.deltaRank >= 0 ? 'up-text' : 'down-text'}>{r.deltaRank == null ? '—' : (r.deltaRank >= 0 ? `↑${r.deltaRank}` : `↓${-r.deltaRank}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {analysis && (
        <div className="panel">
          <h4>🏅 排名（总分，点击学生查看个人分析）</h4>
          <div className="tips">完整排名明细（各科分数 + 条件格式 + 导出 CSV）见上方「⑥ 班级排名明细表」。</div>
        </div>
      )}
    </div>
  );
}

// ---------- Tab3 作业台账 ----------
function HWTab({ cid, cls, notify, tick, reload }) {
  const [stats, setStats] = useState(null);
  const [period, setPeriod] = useState('semester');
  const [assignments, setAssignments] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [aw, setAw] = useState({ subject: '数学', date: '', title: '', requirement: '', deadline: '' });
  const [recText, setRecText] = useState('');
  const [recAid, setRecAid] = useState('');

  useEffect(() => {
    api.listAssignments(cid).then((d) => setAssignments(d.assignments)).catch((e) => notify(e.message));
    api.classHWStats(cid, period).then((d) => setStats(d.stats)).catch((e) => notify(e.message));
  }, [cid, period, tick]);

  const createAw = async () => {
    try {
      await api.createAssignment(cid, aw);
      setShowNew(false); setAw({ subject: '数学', date: '', title: '', requirement: '', deadline: '' });
      notify('作业已布置'); reload();
    } catch (e) { notify(e.message); }
  };

  const doRec = async () => {
    if (!recAid) { notify('请选择作业'); return; }
    const rows = recText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const p = l.split(/[,，\t]/).map((x) => x.trim());
      return { student_no: p[0], status: p[1] || 'normal', issue_note: p[2] || '', rectify_note: p[3] || '' };
    });
    try {
      const stu = await api.listStudents(cid);
      const byNo = new Map(stu.students.map((s) => [s.student_no, s.id]));
      const final = [];
      const bad = [];
      for (const r of rows) {
        const sid = byNo.get(r.student_no);
        if (!sid) { bad.push(r.student_no); continue; }
        final.push({ student_id: sid, status: r.status, issue_note: r.issue_note, rectify_note: r.rectify_note });
      }
      if (bad.length) { notify(`学号不存在：${bad.join('、')}`); return; }
      const d = await api.batchHWRecords(recAid, final);
      notify(`已登记 ${d.upserted} 条`); setRecText(''); reload();
    } catch (e) { notify(e.message); }
  };

  return (
    <div className="card">
      <div className="row">
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          {[['week', '本周'], ['month', '本月'], ['semester', '本学期']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn ghost sm" onClick={() => setShowNew(!showNew)}>＋ 布置作业</button>
      </div>
      {showNew && (
        <div className="row">
          <input placeholder="科目*" value={aw.subject} onChange={(e) => setAw({ ...aw, subject: e.target.value })} style={{ width: 90 }} />
          <input type="date" value={aw.date} onChange={(e) => setAw({ ...aw, date: e.target.value })} />
          <input placeholder="作业内容*" value={aw.title} onChange={(e) => setAw({ ...aw, title: e.target.value })} />
          <button className="btn primary sm" onClick={createAw} disabled={!aw.title || !aw.date}>布置</button>
        </div>
      )}
      <div className="row">
        <select value={recAid} onChange={(e) => setRecAid(e.target.value)}>
          <option value="">选择作业登记…</option>
          {assignments.map((a) => <option key={a.id} value={a.id}>{a.date} {a.subject}·{a.title.slice(0, 14)}</option>)}
        </select>
      </div>
      <textarea rows={3} placeholder="登记：每行 学号,状态,问题备注,整改要求&#10;状态：excellent优质/normal正常/late补交/missing缺交/slack敷衍/copy抄袭&#10;如：20260101,missing,未交,次日补交" value={recText} onChange={(e) => setRecText(e.target.value)} />
      <button className="btn primary sm" onClick={doRec}>批量登记</button>
      {stats && (
        <div className="analysis-panels">
          <div className="panel">
            <h4>班级作业统计</h4>
            <div className="stat-row">
              <span>记录 <b>{stats.class_summary.total_records}</b></span>
              <span>完成率 <b>{Math.round(stats.class_summary.completion_rate * 100)}%</b></span>
              <span>缺交 <b>{stats.class_summary.missing_count}</b></span>
              <span>敷衍 <b>{stats.class_summary.slack_count}</b></span>
              <span>优秀 <b>{stats.class_summary.excellent_count}</b></span>
            </div>
            {stats.class_summary.top_issues.length > 0 && (
              <div className="tips">高频问题：{stats.class_summary.top_issues.map((t) => `${t.issue}×${t.count}`).join('、')}</div>
            )}
          </div>
          {stats.problem_students.length > 0 && (
            <div className="panel">
              <h4>⚠ 问题学生清单（缺交+敷衍≥3）</h4>
              <div>{stats.problem_students.map((p) => `${p.student_name || p.student_id}（缺${p.missing}/敷${p.slack}）`).join('、')}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Tab4 德育心理 ----------
function MoralTab({ cid, cls, notify, tick, reload }) {
  const [students, setStudents] = useState([]);
  const [sid, setSid] = useState('');
  const [report, setReport] = useState(null);
  const [form, setForm] = useState({ date: '', category: 'emotion', content: '', follow_up: '', result: '' });
  const [err, setErr] = useState('');

  useEffect(() => {
    api.listStudents(cid).then((d) => setStudents(d.students)).catch((e) => notify(e.message));
  }, [cid, tick]);

  useEffect(() => {
    if (!sid) { setReport(null); return; }
    api.moralReport(sid).then((d) => setReport(d.report)).catch(() => setReport(null));
  }, [sid, tick]);

  const add = async () => {
    if (!sid) { setErr('请先选择学生'); return; }
    try {
      await api.addMoral(sid, form);
      setForm({ date: '', category: 'emotion', content: '', follow_up: '', result: '' });
      setErr(''); notify('德育记录已添加'); reload();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="card">
      <div className="row">
        <select value={sid} onChange={(e) => setSid(e.target.value)}>
          <option value="">选择学生…</option>
          {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div className="row">
        <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {[['emotion', '情绪心理'], ['family', '家庭动态'], ['relationship', '人际关系'], ['conduct', '思想品德'], ['reward', '奖励'], ['punish', '违纪'], ['volunteer', '志愿服务'], ['other', '其他']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input placeholder="记录内容*" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
      </div>
      <div className="row">
        <input placeholder="跟进措施" value={form.follow_up} onChange={(e) => setForm({ ...form, follow_up: e.target.value })} />
        <input placeholder="跟进结果" value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })} />
        <button className="btn primary sm" onClick={add}>添加</button>
      </div>
      {err && <div className="error">{err}</div>}
      {report && (
        <div className="panel">
          <h4>📋 德育学期汇总（{report.semester}）</h4>
          <div className="tips">{report.summary}</div>
          <div className="row">
            {report.by_category.map((c) => <span key={c.category} className="chip-static">{c.label}×{c.count}</span>)}
          </div>
          {report.concerns.length > 0 && <div className="warn">需关注：{report.concerns.join('；')}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- Tab5 特长荣誉 ----------
function HonorTab({ cid, cls, notify, tick, reload }) {
  const [honors, setHonors] = useState([]);
  const [scope, setScope] = useState('class');
  const [form, setForm] = useState({ title: '', level: 'school', event: '', date: '' });

  useEffect(() => {
    api.listHonors(cid, `?scope=${scope}`).then((d) => setHonors(d.honors)).catch((e) => notify(e.message));
  }, [cid, scope, tick]);

  const add = async () => {
    try {
      if (scope === 'class') await api.addClassHonor(cid, form);
      else { notify('个人荣誉请进入学生档案页添加'); return; }
      setForm({ title: '', level: 'school', event: '', date: '' });
      notify('荣誉已归档'); reload();
    } catch (e) { notify(e.message); }
  };

  const LEVEL = { school: '校级', district: '区级', city: '市级', province: '省级', national: '国家级' };

  return (
    <div className="card">
      <div className="row">
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="class">班级荣誉</option>
          <option value="student">个人荣誉</option>
        </select>
      </div>
      {scope === 'class' && (
        <div className="row">
          <input placeholder="荣誉名称*" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
            {Object.entries(LEVEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <button className="btn primary sm" onClick={add} disabled={!form.title || !form.date}>归档</button>
        </div>
      )}
      {scope === 'student' && <div className="tips">个人特长/荣誉在学生个人档案页维护（点击学生姓名进入）。</div>}
      <table className="table">
        <thead><tr><th>荣誉</th><th>级别</th><th>赛事/评比</th><th>日期</th></tr></thead>
        <tbody>
          {honors.map((h) => (
            <tr key={h.id}><td>{h.title}</td><td>{LEVEL[h.level]}</td><td>{h.event}</td><td>{h.date}</td></tr>
          ))}
          {honors.length === 0 && <tr><td colSpan={4} className="empty-tip">暂无荣誉记录</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Tab6 成长素材 ----------
function MaterialsTab({ cid, cls, notify, tick, reload }) {
  const [materials, setMaterials] = useState([]);
  const [semester, setSemester] = useState('');

  useEffect(() => {
    api.listMaterials(`?class_id=${cid}&include_students=1${semester ? `&semester=${semester}` : ''}`)
      .then((d) => setMaterials(d.materials)).catch((e) => notify(e.message));
  }, [cid, semester, tick]);

  const upload = async (files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('owner_type', 'class');
      fd.append('owner_id', cid);
      fd.append('category', 'activity');
      fd.append('note', '');
      try {
        await api.uploadMaterial(fd);
        notify(`已上传 ${f.name}`);
      } catch (e) { notify(`${f.name}: ${e.message}`); }
    }
    reload();
  };

  const CAT = { class_performance: '课堂表现', sports: '运动会', activity: '活动实践', daily: '日常风采', award_cert: '获奖证书', class_honor: '班级荣誉', photo: '活动合影', df_activity: '道法活动', df_honor: '道法表彰', other: '其他' };

  return (
    <div className="card">
      <div className="row">
        <label className="btn primary sm file-btn">📤 上传素材
          <input type="file" multiple hidden onChange={(e) => upload([...e.target.files])} />
        </label>
        <select value={semester} onChange={(e) => setSemester(e.target.value)}>
          <option value="">全部学期</option>
          <option value="2026秋">2026秋</option>
          <option value="2026春">2026春</option>
        </select>
        <button className="btn ghost sm" onClick={async () => {
          try { const r = await api.listMaterials(`?class_id=${cid}&semester=${semester}`); const u = new URL('/api/portfolio/materials/export.zip', location.href); u.searchParams.set('class_id', cid); if (semester) u.searchParams.set('semester', semester); location.href = u; notify(`打包 ${r.materials.length} 个素材`); } catch (e) { notify(e.message); }
        }}>📦 学期打包下载</button>
      </div>
      <div className="material-grid">
        {materials.map((m) => (
          <div key={m.id} className="material-item">
            <a href={`/api/portfolio/materials/${m.id}/file`} target="_blank" rel="noreferrer" className="material-thumb" title={m.file_name}>
              {m.mime.startsWith('image/') ? <img src={`/api/portfolio/materials/${m.id}/file`} alt={m.file_name} /> : <span className="material-file">📄 {m.file_name.slice(-8)}</span>}
            </a>
            <div className="material-meta">
              <span title={m.file_name}>{m.file_name.slice(0, 16)}</span>
              <span className="tips">{CAT[m.category] || m.category} · {m.semester}</span>
            </div>
            <button className="btn danger xs" onClick={async () => { if (confirm('删除该素材？')) { try { await api.deleteMaterial(m.id); notify('已删除（可点旁边「撤销」恢复）'); reload(); } catch (e) { notify(e.message); } } }}>删</button>
            <button className="btn ghost xs" onClick={() => undoLast(notify, reload)} title="撤销最近一步操作（含删除/停用/修改）">撤销</button>
          </div>
        ))}
        {materials.length === 0 && <div className="empty-tip">暂无素材，点击「上传素材」</div>}
      </div>
    </div>
  );
}

// ---------- Tab7 智能评语 ----------
function CommentsTab({ cid, cls, notify, tick, reload }) {
  const [students, setStudents] = useState([]);
  const [sid, setSid] = useState('');
  const [type, setType] = useState('talk');
  const [comments, setComments] = useState([]);
  const [gen, setGen] = useState('');

  useEffect(() => {
    api.listStudents(cid).then((d) => setStudents(d.students)).catch((e) => notify(e.message));
  }, [cid, tick]);

  useEffect(() => {
    if (!sid) { setComments([]); return; }
    api.listComments(sid, `?type=${type}`).then((d) => setComments(d.comments)).catch(() => setComments([]));
  }, [sid, type, tick]);

  const generate = async () => {
    if (!sid) { notify('请选择学生'); return; }
    try {
      const d = await api.generateComment(sid, { type });
      setGen(d.comment.content);
      notify('评语已生成（可修改后保存）');
      reload();
    } catch (e) { notify(e.message); }
  };

  return (
    <div className="card">
      <div className="row">
        <select value={sid} onChange={(e) => setSid(e.target.value)}>
          <option value="">选择学生…</option>
          {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {[['talk', '谈心话术'], ['home_school', '家校沟通评语'], ['periodic', '综合素质评语']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn primary sm" onClick={generate}>✨ 自动生成</button>
        <button className="btn ghost sm" onClick={async () => { try { const r = await api.listComments(sid); const u = new URL('/api/portfolio/classes/' + cid + '/comments/export', location.href); u.searchParams.set('type', type); location.href = u; notify('导出评语 CSV'); } catch (e) { notify(e.message); } }}>导出 CSV</button>
      </div>
      {gen && <div className="panel"><textarea rows={4} value={gen} onChange={(e) => setGen(e.target.value)} /></div>}
      <table className="table">
        <thead><tr><th>类型</th><th>学期</th><th>内容</th><th>状态</th></tr></thead>
        <tbody>
          {comments.map((c) => (
            <tr key={c.id}>
              <td>{c.type}</td><td>{c.period}</td>
              <td>{c.content.slice(0, 60)}…</td>
              <td>{c.saved ? '✅ 已保存' : '未保存'}</td>
            </tr>
          ))}
          {comments.length === 0 && <tr><td colSpan={4} className="empty-tip">暂无评语</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Tab8 家校话术 ----------
function PhrasesTab({ cls, notify }) {
  const [phrases, setPhrases] = useState([]);
  const [stage, setStage] = useState(cls.stage === 'primary' ? 'primary' : 'middle');
  const [out, setOut] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ category: 'homework', tone: 'gentle', title: '', content: '' });

  useEffect(() => {
    api.listPhrases(`?stage=${stage}`).then((d) => setPhrases(d.phrases)).catch((e) => notify(e.message));
  }, [stage]);

  const generate = async (p) => {
    try {
      const d = await api.generatePhrase(p.id, { 班级: cls.name });
      setOut(d.content + (d.unresolved.length ? `\n（未替换：${d.unresolved.join('、')}）` : ''));
    } catch (e) { notify(e.message); }
  };

  const save = async () => {
    try {
      await api.createPhrase({ ...form, stage });
      setShowNew(false); setForm({ category: 'homework', tone: 'gentle', title: '', content: '' });
      notify('话术模板已保存'); setStage(stage);
    } catch (e) { notify(e.message); }
  };

  return (
    <div className="card">
      <div className="row">
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="middle">初中话术</option>
          <option value="primary">小学话术</option>
        </select>
        <button className="btn ghost sm" onClick={() => setShowNew(!showNew)}>＋ 新增模板</button>
      </div>
      {showNew && (
        <div className="form">
          <div className="row">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {[['homework', '作业布置'], ['supervise', '家校监督'], ['safety', '安全专项'], ['material', '物资携带'], ['custom', '自定义']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
              <option value="gentle">温和</option><option value="strict">严谨</option>
            </select>
            <input placeholder="模板标题*" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <textarea rows={3} placeholder="模板内容*（支持 {班级} {科目} {作业} {截止} 等占位符）" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          <button className="btn primary sm" onClick={save} disabled={!form.title || !form.content}>保存模板</button>
        </div>
      )}
      {out && <div className="panel"><b>生成结果：</b><pre className="pre-wrap">{out}</pre></div>}
      <table className="table">
        <thead><tr><th>分类</th><th>语气</th><th>标题</th><th>操作</th></tr></thead>
        <tbody>
          {phrases.map((p) => (
            <tr key={p.id}>
              <td>{p.category}</td><td>{p.tone === 'gentle' ? '温和' : '严谨'}</td>
              <td>{p.title}{p.favorite ? ' ⭐' : ''}</td>
              <td>
                <button className="btn ghost xs" onClick={() => generate(p)}>一键生成</button>
                <button className="btn ghost xs" onClick={async () => { try { await api.favoritePhrase(p.id, !p.favorite); setStage(stage); } catch (e) { notify(e.message); } }}>{p.favorite ? '取消收藏' : '收藏'}</button>
              </td>
            </tr>
          ))}
          {phrases.length === 0 && <tr><td colSpan={4} className="empty-tip">暂无话术模板</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
