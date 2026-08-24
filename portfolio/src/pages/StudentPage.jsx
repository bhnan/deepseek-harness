import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Chart, { lineOption, barOption, radarOption } from '../components/Chart.jsx';

const TABS = [
  ['base', '基础信息'], ['scores', '成绩分析'], ['hw', '作业台账'],
  ['honor', '特长荣誉'], ['moral', '心理德育'], ['materials', '成长素材'], ['comments', '智能评语'],
];
const CAT = { emotion: '心理', family: '家庭', relationship: '人际', conduct: '品德', reward: '奖励', punish: '违纪', volunteer: '志愿', other: '其他' };

// 学生个人成长档案（一人一档）：子标签式
export default function StudentPage({ sid, initialTab, onBack, notify, refreshKey }) {
  const [stu, setStu] = useState(null);
  const [tab, setTab] = useState(initialTab || 'base');
  const [scores, setScores] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [classAvg, setClassAvg] = useState(null);
  const [hw, setHw] = useState(null);
  const [hwEvents, setHwEvents] = useState(null);
  const [talents, setTalents] = useState([]);
  const [honors, setHonors] = useState([]);
  const [morals, setMorals] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [comments, setComments] = useState([]);
  const [showSensitive, setShowSensitive] = useState(false);
  const [editBase, setEditBase] = useState(false);
  const [baseForm, setBaseForm] = useState({});
  const [tick, setTick] = useState(0);
  const reloadData = () => setTick((t) => t + 1);
  // 各板块表单
  const [talentForm, setTalentForm] = useState({ category: '', name: '', level: '', potential: '' });
  const [honorForm, setHonorForm] = useState({ title: '', level: 'school', event: '', date: '' });
  const [moralForm, setMoralForm] = useState({ date: '', category: 'emotion', content: '', follow_up: '', result: '' });
  const [hwForm, setHwForm] = useState({ date: '', subjects: '道法', kind: 'praise', note: '' });
  const [genCmtId, setGenCmtId] = useState('');
  const [comForm, setComForm] = useState({ type: 'talk', date: '', time: '', location: '', note: '' });
  const [genType, setGenType] = useState('talk');
  const [genOut, setGenOut] = useState('');

  useEffect(() => {
    api.getStudent(sid).then((d) => setStu(d)).catch((e) => notify(e.message));
    api.studentScores(sid).then((d) => setScores(d.scores)).catch(() => {});
    api.studentAnalysis(sid).then((d) => setAnalysis(d.analysis)).catch(() => {});
    api.studentHWStats(sid).then((d) => setHw(d.stats)).catch(() => {});
    api.studentHwEvents(sid).then((d) => setHwEvents(d)).catch(() => {});
    api.listTalents(sid).then((d) => setTalents(d.talents)).catch(() => {});
    api.listMoral(sid).then((d) => setMorals(d.records)).catch(() => {});
    api.listMaterials(`?owner_id=${sid}`).then((d) => setMaterials(d.materials)).catch(() => {});
    api.listComments(sid).then((d) => setComments(d.comments)).catch(() => {});
  }, [sid, refreshKey, tick]);

  // 班级最近考试均分（雷达对比用）
  useEffect(() => {
    if (!stu) return;
    api.classAnalysis(stu.class.id).then((d) => setClassAvg(d.analysis ? d.analysis.subject_stats : null)).catch(() => {});
    api.listHonors(stu.class.id, `?scope=student&student_id=${sid}`).then((d) => setHonors(d.honors)).catch(() => {});
  }, [sid, stu?.class?.id, refreshKey, tick]);

  const addCom = async () => {
    try {
      const d = await api.createCommunication({ student_id: sid, ...comForm });
      notify(d.communication.sync_status === 'synced' ? '沟通安排已创建并同步到教学日历 ✅' : `沟通安排已创建（同步${d.communication.sync_status === 'failed' ? '失败，可重试' : '待同步'}）`);
      setComForm({ type: 'talk', date: '', time: '', location: '', note: '' });
    } catch (e) { notify(e.message); }
  };

  // 基础信息编辑
  const startEditBase = () => {
    const cur = stu?.student || {};
    setBaseForm({
      gender: cur.gender || '', birth_date: cur.birth_date || '', is_boarding: cur.is_boarding ? 1 : 0, pressure_level: cur.pressure_level || '中',
      school_id: cur.school_id || '', puberty_status: cur.puberty_status || '', goal_note: cur.goal_note || '', subject_note: cur.subject_note || '',
      group_name: cur.group_name || '',
      id_card: cur.id_card || '', address: cur.address || '', parent1_name: cur.parent1_name || '', parent1_phone: cur.parent1_phone || '',
      parent2_name: cur.parent2_name || '', parent2_phone: cur.parent2_phone || '', guardian_note: cur.guardian_note || '',
      special_note: cur.special_note || '', allergy_note: cur.allergy_note || '', manage_note: cur.manage_note || '',
    });
    setEditBase(true);
  };
  const saveBase = async () => {
    try {
      const d = await api.updateStudent(sid, baseForm);
      setStu({ ...stu, student: d.student });
      setEditBase(false);
      notify('基础信息已保存');
    } catch (e) { notify(e.message); }
  };

  const genComment = async () => {
    try {
      const d = await api.generateComment(sid, { type: genType });
      setGenOut(d.comment.content);
      setGenCmtId(d.comment.id);
      notify('评语已生成（可保存）');
    } catch (e) { notify(e.message); }
  };

  // 单人作业记录 PDF 导出（打印窗口，纸质成长档案归档）
  const exportHwPdf = () => {
    const w = window.open('', '_blank');
    if (!w) { notify('浏览器拦截了打印窗口'); return; }
    const evs = (hwEvents?.events || []).map((ev) => {
      const tag = ev.kind === 'praise' ? '✅ 表扬' : ev.kind === 'missing' ? '❌ 缺交' : '⚠️ 问题';
      return `<tr><td>${ev.date}</td><td>${ev.subjects.join('、')}</td><td>${tag}</td><td>${ev.reporter || ''}</td><td>${ev.note || ''}</td></tr>`;
    }).join('');
    w.document.write(`<html><head><meta charset="utf-8"><title>${s.name}-作业记录</title><style>table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #999;padding:4px 6px}th{background:#eee}h3{margin-bottom:4px}.sum{font-size:13px;color:#555;margin-bottom:8px}</style></head><body><h3>${s.name}（${s.student_no}）· 作业记录档案</h3><div class="sum">表扬 ${hwEvents?.summary?.praise || 0} 次 ｜ 缺交 ${hwEvents?.summary?.missing || 0} 次 ｜ 作业问题 ${hwEvents?.summary?.problem || 0} 次</div><table><thead><tr><th>日期</th><th>科目</th><th>类型</th><th>填报人</th><th>备注</th></tr></thead><tbody>${evs || '<tr><td colspan="5">暂无记录</td></tr>'}</tbody></table></body></html>`);
    w.document.close(); w.print();
  };

  // ---------- 各板块增删 ----------
  const addTalent = async () => {
    if (!talentForm.category || !talentForm.name) { notify('请填写类别与特长名称'); return; }
    try { await api.addTalent(sid, talentForm); setTalentForm({ category: '', name: '', level: '', potential: '' }); notify('特长已添加'); reloadData(); } catch (e) { notify(e.message); }
  };
  const removeTalent = async (id) => {
    if (!confirm('删除该特长记录？')) return;
    try { await api.deleteTalent(id); notify('已删除'); reloadData(); } catch (e) { notify(e.message); }
  };
  const addHonor = async () => {
    if (!honorForm.title || !honorForm.date) { notify('请填写荣誉名称与日期'); return; }
    try { await api.addStudentHonor(sid, honorForm); setHonorForm({ title: '', level: 'school', event: '', date: '' }); notify('荣誉已归档'); reloadData(); } catch (e) { notify(e.message); }
  };
  const removeHonor = async (id) => {
    if (!confirm('删除该荣誉记录？')) return;
    try { await api.deleteHonor(id); notify('已删除'); reloadData(); } catch (e) { notify(e.message); }
  };
  const addMoral = async () => {
    if (!moralForm.date || !moralForm.content) { notify('请填写日期与记录内容'); return; }
    try { await api.addMoral(sid, moralForm); setMoralForm({ date: '', category: 'emotion', content: '', follow_up: '', result: '' }); notify('德育记录已添加'); reloadData(); } catch (e) { notify(e.message); }
  };
  const removeMoral = async (id) => {
    if (!confirm('删除该德育记录？')) return;
    try { await api.deleteMoral(id); notify('已删除'); reloadData(); } catch (e) { notify(e.message); }
  };
  const uploadMaterial = async (files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f); fd.append('owner_type', 'student'); fd.append('owner_id', sid);
      fd.append('category', 'daily'); fd.append('note', '');
      try { await api.uploadMaterial(fd); notify(`已上传 ${f.name}`); } catch (e) { notify(`${f.name}: ${e.message}`); }
    }
    reloadData();
  };
  const removeMaterial = async (id) => {
    if (!confirm('删除该素材？')) return;
    try { await api.deleteMaterial(id); notify('已删除'); reloadData(); } catch (e) { notify(e.message); }
  };
  const addHwRecord = async () => {
    if (!hwForm.date || !hwForm.subjects) { notify('请填写日期与科目'); return; }
    const field = hwForm.kind;
    const body = { record_date: hwForm.date, subjects: hwForm.subjects.split(/[,，、]/).map((x) => x.trim()).filter(Boolean), reporter: '', praise: '', missing: '', problem: '', note: hwForm.note };
    body[field] = s.name;
    try {
      const d = await api.createHwLedger(stu.class.id, [body]);
      notify(`作业记录已补录${d.warnings?.length ? `（${d.warnings[0]}）` : ''}`);
      setHwForm({ date: '', subjects: '道法', kind: 'praise', note: '' });
      reloadData();
    } catch (e) { notify(e.message); }
  };
  const saveComment = async () => {
    try { await api.updateComment(genCmtId, { content: genOut, saved: 1 }); notify('评语已保存'); reloadData(); } catch (e) { notify(e.message); }
  };
  const removeComment = async (id) => {
    if (!confirm('删除该条评语？')) return;
    try { await api.deleteComment(id); notify('已删除'); reloadData(); } catch (e) { notify(e.message); }
  };

  if (!stu) return <div className="app-loading">加载档案…</div>;
  const s = stu.student;

  // 成绩分析数据
  const examTotals = [];
  const examNames = [];
  for (const sc of scores) if (sc.subject === '总分') { examTotals.push(sc.total); examNames.push(sc.exam_name); }
  // 最近一次考试各科（本人 vs 班均）
  const lastExamScores = {};
  const lastExamName = scores.length ? scores[scores.length - 1].exam_name : null;
  for (const sc of scores) if (sc.exam_name === lastExamName && sc.subject !== '总分') lastExamScores[sc.subject] = sc.score;
  const radarSubjects = Object.keys({ ...lastExamScores, ...(classAvg || {}) }).slice(0, 8);
  // 科目进退步（上次 vs 本次）
  const subjectDeltas = [];
  for (const [sub, arr] of Object.entries(analysis?.subject_trends || {})) {
    if (arr.length >= 2) {
      const last = arr[arr.length - 1].score, prev = arr[arr.length - 2].score;
      subjectDeltas.push({ subject: sub, delta: Math.round((last - prev) * 100) / 100, last });
    }
  }
  const weakSet = new Set((analysis?.weak_points || []).map((w) => w.subject));

  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost sm" onClick={onBack}>‹ 返回</button>
        <h2>👤 {s.name} · 个人成长档案（{stu.class?.name}）</h2>
      </div>
      <div className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {/* ---------- 基础信息 ---------- */}
      {tab === 'base' && (
        <div className="student-layout">
          <div className="card">
            <div className="row">
              <h4>基础信息</h4>
              <button className="btn ghost sm" onClick={() => (editBase ? setEditBase(false) : startEditBase())}>{editBase ? '取消' : '✏️ 编辑'}</button>
            </div>
            {!editBase ? (
              <>
                <table className="kv"><tbody>
                  <tr><td>学号</td><td>{s.student_no}</td></tr>
                  <tr><td>性别 / 出生</td><td>{s.gender || '—'} / {s.birth_date || '—'}</td></tr>
                  <tr><td>住校 / 压力</td><td>{s.is_boarding ? '住校' : '走读'} / {s.pressure_level}</td></tr>
                  <tr><td>学籍号</td><td>{s.school_id || '—'}</td></tr>
                  <tr><td>青春期状态</td><td>{s.puberty_status || '—'}</td></tr>
                  <tr><td>升学目标</td><td>{s.goal_note || '—'}</td></tr>
                  <tr><td>道法学科备注</td><td>{s.subject_note || '—'}</td></tr>
                </tbody></table>
                <button className="btn ghost sm" onClick={() => setShowSensitive(!showSensitive)}>{showSensitive ? '隐藏' : '查看'} 🔒 敏感信息（家长/住址）</button>
                {showSensitive && (
                  <table className="kv"><tbody>
                    <tr><td>身份证</td><td>{s.id_card}</td></tr>
                    <tr><td>家庭住址</td><td>{s.address}</td></tr>
                    <tr><td>家长1</td><td>{s.parent1_name} {s.parent1_phone}</td></tr>
                    <tr><td>家长2</td><td>{s.parent2_name} {s.parent2_phone}</td></tr>
                    <tr><td>监护人备注</td><td>{s.guardian_note || '—'}</td></tr>
                    <tr><td>家庭特殊情况</td><td>{s.special_note || '—'}</td></tr>
                    <tr><td>过敏史</td><td>{s.allergy_note || '—'}</td></tr>
                    <tr><td>管理注意</td><td>{s.manage_note || '—'}</td></tr>
                  </tbody></table>
                )}
              </>
            ) : (
              <div className="form">
                <div className="row">
                  <select value={baseForm.gender} onChange={(e) => setBaseForm({ ...baseForm, gender: e.target.value })}>
                    <option value="">性别</option><option>男</option><option>女</option>
                  </select>
                  <input type="date" value={baseForm.birth_date} onChange={(e) => setBaseForm({ ...baseForm, birth_date: e.target.value })} />
                  <select value={baseForm.is_boarding} onChange={(e) => setBaseForm({ ...baseForm, is_boarding: Number(e.target.value) })}>
                    <option value={0}>走读</option><option value={1}>住校</option>
                  </select>
                  <select value={baseForm.pressure_level} onChange={(e) => setBaseForm({ ...baseForm, pressure_level: e.target.value })}>
                    <option value="低">压力低</option><option value="中">压力中</option><option value="高">压力高</option>
                  </select>
                </div>
                <div className="row">
                  <input placeholder="学籍号" value={baseForm.school_id} onChange={(e) => setBaseForm({ ...baseForm, school_id: e.target.value })} />
                  <input placeholder="小组（如：第一组）" value={baseForm.group_name} onChange={(e) => setBaseForm({ ...baseForm, group_name: e.target.value })} style={{ width: 110 }} />
                  <input placeholder="青春期状态" value={baseForm.puberty_status} onChange={(e) => setBaseForm({ ...baseForm, puberty_status: e.target.value })} style={{ width: 160 }} />
                </div>
                <input placeholder="升学目标" value={baseForm.goal_note} onChange={(e) => setBaseForm({ ...baseForm, goal_note: e.target.value })} />
                <input placeholder="道法学科备注" value={baseForm.subject_note} onChange={(e) => setBaseForm({ ...baseForm, subject_note: e.target.value })} />
                <button className="btn ghost sm" onClick={() => setShowSensitive(!showSensitive)}>{showSensitive ? '收起' : '编辑'} 🔒 敏感信息（家长/住址）</button>
                {showSensitive && (
                  <>
                    <div className="row">
                      <input placeholder="身份证号" value={baseForm.id_card} onChange={(e) => setBaseForm({ ...baseForm, id_card: e.target.value })} />
                      <input placeholder="家庭住址" value={baseForm.address} onChange={(e) => setBaseForm({ ...baseForm, address: e.target.value })} />
                    </div>
                    <div className="row">
                      <input placeholder="家长1姓名" value={baseForm.parent1_name} onChange={(e) => setBaseForm({ ...baseForm, parent1_name: e.target.value })} style={{ width: 120 }} />
                      <input placeholder="家长1电话" value={baseForm.parent1_phone} onChange={(e) => setBaseForm({ ...baseForm, parent1_phone: e.target.value })} style={{ width: 130 }} />
                    </div>
                    <div className="row">
                      <input placeholder="家长2姓名" value={baseForm.parent2_name} onChange={(e) => setBaseForm({ ...baseForm, parent2_name: e.target.value })} style={{ width: 120 }} />
                      <input placeholder="家长2电话" value={baseForm.parent2_phone} onChange={(e) => setBaseForm({ ...baseForm, parent2_phone: e.target.value })} style={{ width: 130 }} />
                    </div>
                    <input placeholder="监护人备注" value={baseForm.guardian_note} onChange={(e) => setBaseForm({ ...baseForm, guardian_note: e.target.value })} />
                    <input placeholder="家庭特殊情况" value={baseForm.special_note} onChange={(e) => setBaseForm({ ...baseForm, special_note: e.target.value })} />
                    <input placeholder="过敏史" value={baseForm.allergy_note} onChange={(e) => setBaseForm({ ...baseForm, allergy_note: e.target.value })} />
                    <input placeholder="管理注意" value={baseForm.manage_note} onChange={(e) => setBaseForm({ ...baseForm, manage_note: e.target.value })} />
                  </>
                )}
                <div className="row">
                  <button className="btn primary sm" onClick={saveBase}>保存</button>
                  <button className="btn ghost sm" onClick={() => setEditBase(false)}>取消</button>
                </div>
                <div className="tips">姓名与学号如需修改，请到「学生名单」页停用后重新添加，或在班级管理页联系管理员调整。</div>
              </div>
            )}
          </div>
          <div className="card">
            <h4>💬 沟通安排（自动同步教学日历）</h4>
            <div className="row">
              <select value={comForm.type} onChange={(e) => setComForm({ ...comForm, type: e.target.value })}>
                {[['talk', '谈心'], ['home_visit', '家访'], ['parent_meet', '家长约谈'], ['chat', '私聊安排']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input type="date" value={comForm.date} onChange={(e) => setComForm({ ...comForm, date: e.target.value })} />
              <input placeholder="时间" value={comForm.time} onChange={(e) => setComForm({ ...comForm, time: e.target.value })} style={{ width: 90 }} />
            </div>
            <div className="row">
              <input placeholder="地点" value={comForm.location} onChange={(e) => setComForm({ ...comForm, location: e.target.value })} style={{ width: 110 }} />
              <input placeholder="备注" value={comForm.note} onChange={(e) => setComForm({ ...comForm, note: e.target.value })} />
              <button className="btn primary sm" onClick={addCom} disabled={!comForm.date}>＋ 创建并同步</button>
            </div>
            <h4>🎯 特长与荣誉（概览）</h4>
            {talents.map((t, i) => <div key={i} className="concern-item">🎯 {t.category}·{t.name}（{t.level || '—'}）{t.potential ? `｜${t.potential}` : ''}</div>)}
            {honors.map((h, i) => <div key={i} className="concern-item">🏆 {h.title}（{h.level}）{h.date}</div>)}
            {talents.length === 0 && honors.length === 0 && <div className="tips">暂无，可在「特长荣誉」标签补充</div>}
          </div>
        </div>
      )}

      {/* ---------- 成绩分析 ---------- */}
      {tab === 'scores' && (
        <div className="card">
          <div className="stat-row">
            <span>状态 <b>{analysis?.status === 'up' ? '📈 进步' : analysis?.status === 'down' ? '📉 退步' : analysis?.status === 'volatile' ? '📊 波动' : '✅ 稳定'}</b></span>
            <span>考试次数 <b>{analysis?.trends.length || 0}</b></span>
            {analysis?.weak_points.length > 0 && <span className="warn">⚠ 短板：{analysis.weak_points.map((w) => w.subject).join('、')}</span>}
          </div>
          {examTotals.length > 0 && (
            <>
              <h4>📈 总分趋势（折线图）</h4>
              <Chart option={lineOption(examNames, [{ name: '总分', data: examTotals }])} height={240} />
            </>
          )}
          {radarSubjects.length > 0 && (
            <>
              <h4>🕸 最近一次考试各科 vs 班级均分（雷达图）</h4>
              <Chart option={radarOption(radarSubjects.map((x) => ({ name: x, max: 100 })), [
                { name: s.name, value: radarSubjects.map((x) => lastExamScores[x] ?? 0) },
                { name: '班级均分', value: radarSubjects.map((x) => (classAvg && classAvg[x] ? Math.round(classAvg[x].avg) : 0)) },
              ])} height={280} />
            </>
          )}
          {subjectDeltas.length > 0 && (
            <>
              <h4>📊 科目进退步（上次 → 本次）</h4>
              <Chart option={barOption(subjectDeltas.map((x) => x.subject), subjectDeltas.map((x) => x.delta), { name: '变化分' })} height={220} />
              <table className="table">
                <thead><tr><th>科目</th><th>本次得分</th><th>变化</th><th>短板</th></tr></thead>
                <tbody>
                  {subjectDeltas.map((x) => (
                    <tr key={x.subject}><td>{x.subject}</td><td>{x.last}</td>
                      <td className={x.delta >= 0 ? 'up-text' : 'down-text'}>{x.delta >= 0 ? `+${x.delta}` : x.delta}</td>
                      <td>{weakSet.has(x.subject) ? '⚠ 低于班均' : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {analysis && (
            <table className="table">
              <thead><tr><th>考试</th><th>总分</th><th>较上次</th><th>名次</th></tr></thead>
              <tbody>
                {analysis.trends.map((t, i) => (
                  <tr key={i}><td>{t.exam_name}</td><td>{t.total}</td>
                    <td className={t.delta_total >= 0 ? 'up-text' : 'down-text'}>{t.delta_total == null ? '—' : (t.delta_total >= 0 ? `+${t.delta_total}` : t.delta_total)}</td>
                    <td>{t.total_rank || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------- 作业台账 ---------- */}
      {tab === 'hw' && (
        <div className="card">
          <div className="row">
            <h4>📚 个人作业记录（台账自动回流）</h4>
            <button className="btn ghost sm" onClick={exportHwPdf}>🖨 导出 PDF（纸质归档）</button>
          </div>
          <div className="panel" style={{ marginTop: 6 }}>
            <b>＋ 手动补录作业记录</b>
            <div className="row" style={{ marginTop: 4 }}>
              <input type="date" value={hwForm.date} onChange={(e) => setHwForm({ ...hwForm, date: e.target.value })} />
              <input placeholder="科目（如 道法）" value={hwForm.subjects} onChange={(e) => setHwForm({ ...hwForm, subjects: e.target.value })} style={{ width: 100 }} />
              <select value={hwForm.kind} onChange={(e) => setHwForm({ ...hwForm, kind: e.target.value })}>
                <option value="praise">表扬</option><option value="missing">未交</option><option value="problem">问题</option>
              </select>
              <input placeholder="备注（选填）" value={hwForm.note} onChange={(e) => setHwForm({ ...hwForm, note: e.target.value })} style={{ flex: 1 }} />
              <button className="btn primary sm" onClick={addHwRecord}>补录</button>
            </div>
          </div>
          {hwEvents && (
            <div className="stat-row">
              <span className="up-text">表扬 <b>{hwEvents.summary.praise}</b> 次</span>
              <span className="down-text">缺交 <b>{hwEvents.summary.missing}</b> 次</span>
              <span style={{ color: '#f59e0b' }}>作业问题 <b>{hwEvents.summary.problem}</b> 次</span>
              <span>共 <b>{hwEvents.summary.total}</b> 条</span>
            </div>
          )}
          <div className="timeline">
            {hwEvents && hwEvents.events.map((ev, i) => (
              <div key={i} className="tl-item">
                <span className="tl-date">{ev.date}</span>
                <span>
                  <b>{ev.subjects.join('、')}</b>
                  <span className={`warn-tag ${ev.kind === 'praise' ? 'up-text' : ev.kind === 'missing' ? 'down-text' : ''}`}>
                    {ev.kind === 'praise' ? '✅ 表扬' : ev.kind === 'missing' ? '❌ 缺交' : '⚠️ 问题'}
                  </span>
                  <span className="tips"> 填报：{ev.reporter}{ev.note ? `｜${ev.note}` : ''}</span>
                </span>
              </div>
            ))}
            {hwEvents && hwEvents.events.length === 0 && <div className="tips">暂无作业记录——可在上方手动补录，或由班主任在「作业台账」录入后自动回流</div>}
          </div>
        </div>
      )}

      {/* ---------- 特长荣誉 ---------- */}
      {tab === 'honor' && (
        <div className="card">
          <h4>🎯 个人特长</h4>
          <div className="panel">
            <div className="row">
              <select value={talentForm.category} onChange={(e) => setTalentForm({ ...talentForm, category: e.target.value })}>
                <option value="">类别…</option>
                {['体育', '艺术', '科技', '文学', '劳动', '其他'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input placeholder="特长名称*" value={talentForm.name} onChange={(e) => setTalentForm({ ...talentForm, name: e.target.value })} />
              <input placeholder="水平（如：入门/校队）" value={talentForm.level} onChange={(e) => setTalentForm({ ...talentForm, level: e.target.value })} style={{ width: 110 }} />
              <input placeholder="潜力方向" value={talentForm.potential} onChange={(e) => setTalentForm({ ...talentForm, potential: e.target.value })} style={{ flex: 1 }} />
              <button className="btn primary sm" onClick={addTalent}>添加</button>
            </div>
          </div>
          {talents.map((t, i) => (
            <div key={i} className="concern-item">🎯 {t.category} · {t.name}（{t.level || '入门'}）{t.potential ? `｜潜力：${t.potential}` : ''}
              <button className="btn danger xs" style={{ float: 'right' }} onClick={() => removeTalent(t.id)}>🗑</button>
            </div>
          ))}
          {talents.length === 0 && <div className="tips">暂无特长记录</div>}
          <h4>🏆 个人荣誉</h4>
          <div className="panel">
            <div className="row">
              <input placeholder="荣誉名称*" value={honorForm.title} onChange={(e) => setHonorForm({ ...honorForm, title: e.target.value })} />
              <select value={honorForm.level} onChange={(e) => setHonorForm({ ...honorForm, level: e.target.value })}>
                {[['school', '校级'], ['district', '区级'], ['city', '市级'], ['province', '省级'], ['national', '国家级']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input placeholder="赛事/评比" value={honorForm.event} onChange={(e) => setHonorForm({ ...honorForm, event: e.target.value })} style={{ flex: 1 }} />
              <input type="date" value={honorForm.date} onChange={(e) => setHonorForm({ ...honorForm, date: e.target.value })} />
              <button className="btn primary sm" onClick={addHonor}>归档</button>
            </div>
          </div>
          {honors.map((h, i) => (
            <div key={i} className="concern-item">🏆 {h.title}（{h.level}）｜{h.event}｜{h.date}
              <button className="btn danger xs" style={{ float: 'right' }} onClick={() => removeHonor(h.id)}>🗑</button>
            </div>
          ))}
          {honors.length === 0 && <div className="tips">暂无荣誉记录</div>}
        </div>
      )}

      {/* ---------- 心理德育 ---------- */}
      {tab === 'moral' && (
        <div className="card">
          <h4>❤ 心理与德育记录（共 {morals.length} 条）</h4>
          <div className="panel">
            <div className="row">
              <input type="date" value={moralForm.date} onChange={(e) => setMoralForm({ ...moralForm, date: e.target.value })} />
              <select value={moralForm.category} onChange={(e) => setMoralForm({ ...moralForm, category: e.target.value })}>
                {[['emotion', '情绪心理'], ['family', '家庭动态'], ['relationship', '人际关系'], ['conduct', '思想品德'], ['reward', '奖励'], ['punish', '违纪'], ['volunteer', '志愿服务'], ['other', '其他']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input placeholder="记录内容*" value={moralForm.content} onChange={(e) => setMoralForm({ ...moralForm, content: e.target.value })} style={{ flex: 1 }} />
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <input placeholder="跟进措施" value={moralForm.follow_up} onChange={(e) => setMoralForm({ ...moralForm, follow_up: e.target.value })} style={{ flex: 1 }} />
              <input placeholder="跟进结果" value={moralForm.result} onChange={(e) => setMoralForm({ ...moralForm, result: e.target.value })} style={{ flex: 1 }} />
              <button className="btn primary sm" onClick={addMoral}>添加</button>
            </div>
          </div>
          {morals.map((m, i) => (
            <div key={i} className="concern-item">
              <b>{m.date} · {CAT[m.category] || m.category}</b>
              <button className="btn danger xs" style={{ float: 'right' }} onClick={() => removeMoral(m.id)}>🗑</button>
              <div className="tips">{m.content}{m.follow_up ? `｜跟进：${m.follow_up}` : ''}{m.result ? `｜结果：${m.result}` : ''}</div>
            </div>
          ))}
          {morals.length === 0 && <div className="tips">暂无记录</div>}
        </div>
      )}

      {/* ---------- 成长素材 ---------- */}
      {tab === 'materials' && (
        <div className="card">
          <div className="row">
            <h4>📷 成长素材</h4>
            <label className="btn primary sm file-btn">📤 上传素材
              <input type="file" multiple hidden onChange={(e) => uploadMaterial([...e.target.files])} />
            </label>
          </div>
          <div className="material-grid">
            {materials.map((m) => (
              <div key={m.id} className="material-item">
                <a href={`/api/portfolio/materials/${m.id}/file`} target="_blank" rel="noreferrer" className="material-thumb" title={m.file_name}>
                  {m.mime.startsWith('image/') ? <img src={`/api/portfolio/materials/${m.id}/file`} alt={m.file_name} /> : <span className="material-file">📄 {m.file_name.slice(-8)}</span>}
                </a>
                <div className="material-meta">
                  <span title={m.file_name}>{m.file_name.slice(0, 14)}</span>
                  <span className="tips">{m.event_date} · {m.semester}</span>
                  <button className="btn danger xs" onClick={() => removeMaterial(m.id)}>🗑 删除</button>
                </div>
              </div>
            ))}
            {materials.length === 0 && <div className="empty-tip">暂无素材——点击「上传素材」添加</div>}
          </div>
        </div>
      )}

      {/* ---------- 智能评语 ---------- */}
      {tab === 'comments' && (
        <div className="card">
          <div className="row">
            <select value={genType} onChange={(e) => setGenType(e.target.value)}>
              {[['talk', '谈心话术'], ['home_school', '家校沟通评语'], ['periodic', '综合素质评语']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button className="btn primary sm" onClick={genComment}>✨ 自动生成</button>
          </div>
          {genOut && (
            <div className="panel" style={{ marginTop: 8 }}>
              <textarea rows={5} value={genOut} onChange={(e) => setGenOut(e.target.value)} />
              <div className="row" style={{ marginTop: 4 }}>
                <button className="btn primary sm" onClick={saveComment}>💾 保存评语</button>
                <button className="btn ghost sm" onClick={() => { setGenOut(''); setGenCmtId(''); }}>放弃</button>
              </div>
            </div>
          )}
          <h4>📄 已生成评语（{comments.length} 条）</h4>
          {comments.map((c, i) => (
            <div key={c.id} className="concern-item">
              <b>{c.type === 'talk' ? '谈心话术' : c.type === 'home_school' ? '家校沟通评语' : '综合素质评语'} · {c.period}{c.saved ? ' ✅' : ''}</b>
              <div className="tips">{c.content}</div>
              <div className="row" style={{ marginTop: 4 }}>
                {!c.saved && <button className="btn ghost xs" onClick={() => { setGenOut(c.content); setGenCmtId(c.id); }}>编辑/保存</button>}
                <button className="btn danger xs" onClick={() => removeComment(c.id)}>🗑 删除</button>
              </div>
            </div>
          ))}
          {comments.length === 0 && <div className="tips">暂无评语</div>}
        </div>
      )}
    </div>
  );
}
