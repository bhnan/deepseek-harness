import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import Chart, { lineOption, barOption } from '../components/Chart.jsx';

const DEF_SUBJECTS = ['语文', '数学', '英语', '历史', '道法', '地理', '生物'];
const LS_KEY = { subjects: 'pf_hw_subjects', colWidths: 'pf_hw_colwidths', praise: 'pf_hw_praise', missing: 'pf_hw_missing', problem: 'pf_hw_problem' };
const COL_DEF = [32, 100, 86, 190, 190, 170, 150, 120]; // 勾选/日期/科目/表扬/未交/问题/备注/操作
const HW_HEADERS = ['', '记录日期', '涉及科目', '作业表扬名单', '未交作业名单', '问题作业名单', '特殊备注', '操作'];
const lsArr = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const lsSave = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const KIND_LABEL = { praise: '表扬', missing: '未交', problem: '问题' };
const SUBJECT_ADD_TIP = '科目可自定义添加/删减';
const KIND_COLOR = { praise: 'up-text', missing: 'down-text', problem: '' };
const KIND_ICON = { praise: '✅ 作业表扬名单', missing: '❌ 未交作业名单', problem: '⚠️ 作业问题/点名名单' };

// 名单录入区（智能搜索点选，模块级组件避免重挂载）
function MemberInput({ kind, members, searchVal, showCand, cands, onSearch, onFocus, onBlur, onAdd, onRemove, placeholder }) {
  return (
    <div className="hw-member">
      <label className={`tips ${KIND_COLOR[kind]}`}>{KIND_ICON[kind]}</label>
      <div className="hw-member-chips">
        {members.map((s) => (
          <span key={s.id} className="chip on" title={s.student_no}>
            {s.name} <b style={{ cursor: 'pointer' }} onClick={() => onRemove(s.id)}>×</b>
          </span>
        ))}
        {members.length === 0 && <span className="tips">未选择</span>}
      </div>
      <input value={searchVal} onChange={(e) => onSearch(e.target.value)} onFocus={onFocus} onBlur={onBlur} placeholder={placeholder} />
      {showCand && cands.length > 0 && (
        <div className="hw-cand">
          {cands.map((s) => (
            <button key={s.id} className="hw-cand-item" onMouseDown={(e) => e.preventDefault()} onClick={() => onAdd(s)}>
              {s.name}<span className="tips"> {s.student_no}{s.group_name ? ` · ${s.group_name}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 作业台账页：顶部筛选 + 极速录入 + 明细表 + 图表（上下分布）；dfOnly=道法作业台账（仅道法科目）
export default function HWLedgerPage({ cid, cls, onBack, onOpenStudent, notify, refreshKey, dfOnly = false }) {
  const [records, setRecords] = useState([]);
  const [students, setStudents] = useState([]);
  const [nameById] = useState(new Map());
  const [subjects, setSubjects] = useState(() => (dfOnly ? ['道法'] : (lsArr(LS_KEY.subjects).length ? lsArr(LS_KEY.subjects) : DEF_SUBJECTS)));

  // 筛选
  const [dateRange, setDateRange] = useState('semester');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selSubjects, setSelSubjects] = useState([]);
  const [studentKw, setStudentKw] = useState('');
  const [status, setStatus] = useState('');
  const [selGroups, setSelGroups] = useState([]);
  const [selReporter, setSelReporter] = useState('');
  const [topList, setTopList] = useState(null);

  // 录入表单：名单为已选学生对象数组 [{id, name, student_no}]
  const [form, setForm] = useState({ date: todayISO(), subjects: dfOnly ? ['道法'] : [], praise: [], missing: [], problem: [], note: '' });
  const [search, setSearch] = useState({ praise: '', missing: '', problem: '' }); // 各名单搜索关键字
  const [showCand, setShowCand] = useState({ praise: false, missing: false, problem: false });
  const [showCustomSubj, setShowCustomSubj] = useState(false);
  const [customSubj, setCustomSubj] = useState('');

  // 表格
  const [selected, setSelected] = useState([]);
  const [editRow, setEditRow] = useState(null);
  // 可拖拽列宽（Excel 风格，localStorage 持久化）
  const [colWidths, setColWidths] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem(LS_KEY.colWidths) || 'null'); if (Array.isArray(v) && v.length === COL_DEF.length) return v; } catch { /* ignore */ }
    return [...COL_DEF];
  });
  const colWidthsRef = useRef(colWidths);
  useEffect(() => { colWidthsRef.current = colWidths; }, [colWidths]);
  const resizeRef = useRef(null);
  const startResize = (idx, e) => {
    e.preventDefault();
    resizeRef.current = { idx, startX: e.clientX, startW: colWidthsRef.current[idx] };
    const move = (ev) => {
      const r = resizeRef.current;
      if (!r) return;
      const w = Math.max(40, Math.round(r.startW + (ev.clientX - r.startX)));
      setColWidths((prev) => { const next = [...prev]; next[r.idx] = w; return next; });
    };
    const up = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem(LS_KEY.colWidths, JSON.stringify(colWidthsRef.current));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  useEffect(() => {
    api.listStudents(cid).then((d) => { setStudents(d.students); nameById.clear(); d.students.forEach((s) => nameById.set(s.id, s.name)); }).catch(() => {});
  }, [cid, refreshKey]); // eslint-disable-line

  useEffect(() => { load(); }, [cid, dateRange, dateFrom, dateTo, selSubjects, studentKw, status, selGroups, selReporter, refreshKey]); // eslint-disable-line

  const load = async () => {
    try {
      const q = new URLSearchParams();
      const [f, t] = rangeOf(dateRange, dateFrom, dateTo);
      if (f) q.set('date_from', f);
      if (t) q.set('date_to', t);
      if (selSubjects.length) q.set('subjects', selSubjects.join(','));
      if (studentKw.trim()) q.set('student', studentKw.trim());
      if (status) q.set('status', status);
      if (selGroups.length) q.set('groups', selGroups.join(','));
      if (selReporter) q.set('reporter', selReporter);
      const d = await api.listHwLedger(cid, `?${q.toString()}`);
      setRecords(d.records || []);
    } catch (e) { notify(e.message); }
  };

  const rangeOf = (r, f, t) => {
    const today = todayISO();
    if (r === 'today') return [today, today];
    if (r === 'yesterday') return [addDays(today, -1), addDays(today, -1)];
    if (r === '7d') return [addDays(today, -6), today];
    if (r === 'week') { const d = new Date(today + 'T00:00:00'); const wd = (d.getDay() + 6) % 7; return [addDays(today, -wd), today]; }
    if (r === 'month') return [today.slice(0, 8) + '01', today];
    if (r === 'semester') { const y = +today.slice(0, 4); const start = (new Date().getMonth() + 1 >= 9) ? `${y}-09-01` : `${y - 1}-09-01`; return [start, today]; }
    if (r === 'custom') return [f || '', t || ''];
    return ['', ''];
  };

  const stats = useMemo(() => {
    let praise = 0, missing = 0, problem = 0;
    for (const r of records) { praise += r.praise.length; missing += r.missing.length; problem += r.problem.length; }
    return { records: records.length, praise, missing, problem };
  }, [records]);

  const trend = useMemo(() => {
    const byDate = new Map();
    for (const r of records) {
      if (!byDate.has(r.record_date)) byDate.set(r.record_date, { praise: 0, missing: 0, problem: 0 });
      const d = byDate.get(r.record_date);
      d.praise += r.praise.length; d.missing += r.missing.length; d.problem += r.problem.length;
    }
    const sorted = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30);
    return { x: sorted.map(([d]) => d.slice(5)), praise: sorted.map(([, v]) => v.praise), missing: sorted.map(([, v]) => v.missing), problem: sorted.map(([, v]) => v.problem) };
  }, [records]);

  const bySubject = useMemo(() => {
    const m = new Map();
    for (const r of records) for (const s of r.subjects) {
      if (!m.has(s)) m.set(s, { missing: 0, problem: 0 });
      m.get(s).missing += r.missing.length; m.get(s).problem += r.problem.length;
    }
    return [...m.entries()].map(([s, v]) => ({ subject: s, ...v })).sort((a, b) => (b.missing + b.problem) - (a.missing + a.problem));
  }, [records]);
  const topBySubject = useMemo(() => bySubject.filter((s) => s.missing > 0).sort((a, b) => b.missing - a.missing), [bySubject]);

  const byGroup = useMemo(() => [], [records, students]);

  const groupNames = useMemo(() => [...new Set(students.map((s) => s.group_name).filter(Boolean))], [students]);

  // 本周快捷日期（今天 + 本周一~日）
  const weekDates = useMemo(() => {
    const today = todayISO();
    const d = new Date(today + 'T00:00:00');
    const wd = (d.getDay() + 6) % 7;
    const monday = addDays(today, -wd);
    return Array.from({ length: 7 }, (_, i) => {
      const iso = addDays(monday, i);
      const dt = new Date(iso + 'T00:00:00');
      const label = iso === today ? `今天（周${WEEK[dt.getDay()]}）` : `周${WEEK[dt.getDay()]}`;
      return { iso, label };
    });
  }, []);

  // 智能搜索：姓名任意字 / 学号数字 均可匹配
  const candsOf = (kw) => {
    const k = kw.trim();
    if (!k) return [];
    return students.filter((s) => s.name.includes(k) || s.student_no.includes(k)).slice(0, 12);
  };
  const addMember = (kind, stu) => {
    setForm((f) => ({ ...f, [kind]: f[kind].some((x) => x.id === stu.id) ? f[kind] : [...f[kind], stu] }));
    setSearch((s) => ({ ...s, [kind]: '' }));
    setShowCand((s) => ({ ...s, [kind]: false }));
  };
  const removeMember = (kind, id) => setForm((f) => ({ ...f, [kind]: f[kind].filter((x) => x.id !== id) }));

  const submit = async () => {
    if (!form.date) { notify('请选择记录日期'); return; }
    const subs = dfOnly ? ['道法'] : form.subjects;
    if (!subs.length) { notify('请选择涉及科目'); return; }
    const body = [{
      record_date: form.date,
      subjects: subs,
      reporter: '',
      praise: form.praise.map((s) => s.student_no || s.name).join(','),
      missing: form.missing.map((s) => s.student_no || s.name).join(','),
      problem: form.problem.map((s) => s.student_no || s.name).join(','),
      note: form.note,
    }];
    try {
      const d = await api.createHwLedger(cid, body);
      const warns = d.warnings || [];
      notify(`已录入 ${d.created} 条${warns.length ? `；${warns[0]}${warns.length > 1 ? ` 等 ${warns.length} 条提示` : ''}` : ''}`);
      clearForm();
      load();
    } catch (e) { notify(e.message); }
  };

  const clearForm = () => {
    setForm({ date: todayISO(), subjects: dfOnly ? ['道法'] : [], praise: [], missing: [], problem: [], note: '' });
    setSearch({ praise: '', missing: '', problem: '' });
  };

  const exportExcel = async (rows = records) => {
    if (!rows.length) { notify('当前筛选下无数据'); return; }
    const data = rows.map((r) => ({
      '记录日期': r.record_date, '涉及科目': r.subjects.join('、'),
      '作业表扬名单': r.praise.map((x) => x.name).join('、'), '未交作业名单': r.missing.map((x) => x.name).join('、'),
      '作业问题名单': r.problem.map((x) => x.name).join('、'), '特殊备注': r.note,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '作业台账');
    XLSX.writeFile(wb, `作业台账-${cls?.name || ''}-${todayISO()}.xlsx`);
    notify(`已导出 ${rows.length} 条`);
  };

  const doPrint = () => {
    const w = window.open('', '_blank');
    if (!w) { notify('浏览器拦截了打印窗口'); return; }
    const rows = records.map((r) => `<tr><td>${r.record_date}</td><td>${r.subjects.join('、')}</td><td>${r.praise.map((x) => x.name).join('、')}</td><td>${r.missing.map((x) => x.name).join('、')}</td><td>${r.problem.map((x) => x.name).join('、')}</td><td>${r.note || ''}</td></tr>`).join('');
    w.document.write(`<html><head><meta charset="utf-8"><title>作业台账-${cls?.name}</title><style>table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #999;padding:4px 6px}th{background:#eee}</style></head><body><h3>${cls?.name} 作业台账（${records.length} 条）</h3><table><thead><tr><th>日期</th><th>科目</th><th>表扬</th><th>未交</th><th>问题</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
    w.document.close(); w.print();
  };

  const saveEdit = async () => {
    try {
      await api.updateHwLedger(editRow.id, {
        record_date: editRow.record_date, subjects: editRow.subjects, reporter: editRow.reporter,
        praise: editRow.praiseText, missing: editRow.missingText, problem: editRow.problemText, note: editRow.note,
      });
      notify('台账已更新（永久留存）'); setEditRow(null); load();
    } catch (e) { notify(e.message); }
  };

  const exportSelected = () => {
    if (!selected.length) { notify('请先勾选记录'); return; }
    exportExcel(records.filter((r) => selected.includes(r.id)));
  };

  const delRow = async (r) => {
    if (!confirm(`删除该条台账记录？（${r.record_date} · ${r.subjects.join('、')}，删除后不可恢复）`)) return;
    try { await api.deleteHwLedger(r.id); notify('已删除'); setSelected((p) => p.filter((x) => x !== r.id)); load(); } catch (e) { notify(e.message); }
  };

  // 复制本条到录入面板：复用日期/科目/名单，微调后快速提交（避免重复录入）
  const copyToForm = (r) => {
    setForm({
      date: r.record_date, subjects: dfOnly ? ['道法'] : r.subjects,
      praise: r.praise.map((x) => ({ id: x.id, name: x.name, student_no: (students.find((s) => s.id === x.id) || {}).student_no || '' })),
      missing: r.missing.map((x) => ({ id: x.id, name: x.name, student_no: (students.find((s) => s.id === x.id) || {}).student_no || '' })),
      problem: r.problem.map((x) => ({ id: x.id, name: x.name, student_no: (students.find((s) => s.id === x.id) || {}).student_no || '' })),
      note: r.note || '',
    });
    notify(`已复制「${r.record_date} · ${dfOnly ? '道法' : r.subjects.join('、')}」到录入面板，可直接修改后提交`);
    document.querySelector('.hw-entry')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const batchNote = async () => {
    if (!selected.length) { notify('请先勾选记录'); return; }
    const note = prompt('批量补充备注（附加到所选记录）：');
    if (note == null) return;
    try {
      for (const r of records.filter((x) => selected.includes(x.id))) {
        await api.updateHwLedger(r.id, { note: r.note ? `${r.note}；${note}` : note });
      }
      notify(`已为 ${selected.length} 条记录补充备注`); setSelected([]); load();
    } catch (e) { notify(e.message); }
  };

  const addSubject = () => {
    const v = customSubj.trim();
    if (!v) return;
    const ns = subjects.includes(v) ? subjects : [...subjects, v];
    setSubjects(ns); lsSave(LS_KEY.subjects, ns); setCustomSubj(''); setShowCustomSubj(false);
  };
  const removeSubject = (s) => {
    const ns = subjects.filter((x) => x !== s);
    setSubjects(ns); lsSave(LS_KEY.subjects, ns);
  };

  const toggleSubjectSel = (s) => setSelSubjects((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));
  const toggleGroupSel = (g) => setSelGroups((p) => (p.includes(g) ? p.filter((x) => x !== g) : [...p, g]));
  const quick = (range, st) => { setDateRange(range); setStatus(st); };

  // 名单渲染（主表格）：姓名可点击跳转档案
  const Names = ({ list }) => (
    <>{list.map((x, i) => (
      <span key={i}>
        {x.id ? <a className="link" onClick={() => onOpenStudent && onOpenStudent(x.id, 'hw')}>{x.name}</a> : <span>{x.name}</span>}
        {i < list.length - 1 ? '、' : ''}
      </span>
    ))}</>
  );

  return (
    <div className="page hw-page">
      <div className="page-head">
        <button className="btn ghost sm" onClick={onBack}>‹ 返回</button>
        <h2>{dfOnly ? '📝 道法作业台账' : '📚 作业台账'} <span className="tips">（{cls?.name || ''} · {dfOnly ? '仅道法科目 · ' : ''}表扬/未交/问题 三名单 · 永久留存）</span></h2>
      </div>

      {/* 顶部筛选栏（正常文档流，不悬浮） */}
      <div className="hw-toolbar">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value)}>
            {[['today', '今日'], ['yesterday', '昨日'], ['7d', '近7天'], ['week', '本周'], ['month', '本月'], ['semester', '本学期'], ['custom', '自定义']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {dateRange === 'custom' && (<><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /><span>至</span><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></>)}
          {!dfOnly && (
            <>
              <select multiple size={1} value={selSubjects} onChange={(e) => setSelSubjects([...e.target.selectedOptions].map((o) => o.value))} title="科目多选（Ctrl 多选）">
                <option value="" disabled>科目多选…</option>
                {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button className={`btn xs ${selSubjects.length ? 'primary' : 'ghost'}`} onClick={() => setSelSubjects([])}>科目：全选清空</button>
            </>
          )}
          {dfOnly && <span className="chip on">道法</span>}
          <input placeholder="学生姓名/学号搜索…" value={studentKw} onChange={(e) => setStudentKw(e.target.value)} style={{ width: 150 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部记录</option><option value="praise">仅表扬</option><option value="missing">仅未交</option><option value="problem">仅问题</option>
          </select>
          {groupNames.length > 0 && (
            <select multiple size={1} value={selGroups} onChange={(e) => setSelGroups([...e.target.selectedOptions].map((o) => o.value))} title="小组多选">
              <option value="" disabled>小组多选…</option>
              {groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          )}
          <button className="btn ghost sm" onClick={() => { setDateRange('semester'); setSelSubjects([]); setStudentKw(''); setStatus(''); setSelGroups([]); setTopList(null); }}>🔄 筛选重置</button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          <button className="btn danger xs" onClick={() => quick('today', 'missing')}>今日缺交</button>
          <button className="btn xs" onClick={() => quick('today', 'problem')}>今日问题</button>
          <button className="btn danger xs" onClick={() => quick('week', 'missing')}>本周缺交</button>
          <button className="btn xs" onClick={() => quick('week', 'problem')}>本周问题</button>
          <button className="btn xs" onClick={() => quick('week', 'praise')}>本周表扬</button>
          <button className="btn xs" onClick={() => { setDateRange('week'); setStatus(''); setTopList(topBySubject); }}>本周各科缺交 TOP</button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => exportExcel()}>📤 批量导出 Excel</button>
          <button className="btn ghost sm" onClick={doPrint}>🖨 批量打印</button>
          <button className="btn ghost sm" onClick={() => notify('名单数据已自动回流至每位学生个人成长档案（作业记录板块）')}>📁 归档成长档案</button>
        </div>
        <div className="stat-cards hw-stats">
          <div className="stat-card"><div className="stat-label">台账记录数</div><div className="stat-value">{stats.records}<span> 条</span></div></div>
          <div className="stat-card"><div className="stat-label">表扬总人次</div><div className="stat-value up-text">{stats.praise}<span> 人次</span></div></div>
          <div className="stat-card"><div className="stat-label">未交总人次</div><div className="stat-value down-text">{stats.missing}<span> 人次</span></div></div>
          <div className="stat-card"><div className="stat-label">问题/点名总人次</div><div className="stat-value" style={{ color: '#f59e0b' }}>{stats.problem}<span> 人次</span></div></div>
        </div>
      </div>

      {/* 极速录入（上下布局·第一块） */}
      <div className="hw-entry card">
        <div className="card-head"><b>⚡ 极速录入</b><span className="tips">时间默认今天（可选本周）· 名单输入姓名/任意字/学号智能搜索点选</span></div>
        <div className="form">
          <div className="row" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="tips">时间</span>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <span className="hw-week">
              {weekDates.map((w) => (
                <button key={w.iso} className={`btn xs ${form.date === w.iso ? 'primary' : 'ghost'}`} onClick={() => setForm({ ...form, date: w.iso })}>{w.label}</button>
              ))}
            </span>
          </div>
          <div className="row" style={{ alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span className="tips">涉及科目</span>
            {dfOnly ? (
              <span className="subj-chips"><span className="chip on">道法 ✓</span></span>
            ) : (
              <span className="subj-chips">
                {subjects.map((s) => (
                  <span key={s} className={`chip ${form.subjects.includes(s) ? 'on' : ''}`} onClick={() => setForm((f) => ({ ...f, subjects: f.subjects.includes(s) ? f.subjects.filter((x) => x !== s) : [...f.subjects, s] }))}>
                    {s}{form.subjects.includes(s) ? ' ✓' : ''}
                  </span>
                ))}
                <button className="btn ghost xs" onClick={() => setShowCustomSubj(!showCustomSubj)}>＋自定义科目</button>
                {showCustomSubj && (<><input placeholder="科目名" value={customSubj} onChange={(e) => setCustomSubj(e.target.value)} style={{ width: 90 }} /><button className="btn primary xs" onClick={addSubject}>添加</button></>)}
              </span>
            )}
          </div>
          <div className="hw-members" style={{ marginTop: 8 }}>
            {(['praise', 'missing', 'problem']).map((kind) => (
              <MemberInput key={kind} kind={kind}
                members={form[kind]} searchVal={search[kind]} showCand={showCand[kind]} cands={candsOf(search[kind])}
                onSearch={(v) => { setSearch((s) => ({ ...s, [kind]: v })); setShowCand((s) => ({ ...s, [kind]: true })); }}
                onFocus={() => setShowCand((s) => ({ ...s, [kind]: true }))}
                onBlur={() => setTimeout(() => setShowCand((s) => ({ ...s, [kind]: false })), 180)}
                onAdd={(stu) => addMember(kind, stu)} onRemove={(id) => removeMember(kind, id)}
                placeholder="输入姓名/任意字/学号搜索…" />
            ))}
          </div>
          <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 6 }}>
            <span className="tips">特殊备注（选填）</span>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="如：美术课未交3人，已通知家长" style={{ flex: 1 }} />
            <button className="btn primary sm" onClick={submit}>提交</button>
            <button className="btn ghost sm" onClick={clearForm}>清空</button>
          </div>
        </div>
      </div>

      {/* 台账明细表格（第二块） */}
      <div className="hw-table-wrap card" style={{ marginTop: 10, padding: 10 }}>
        {topList && topList.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <h4>🏆 本周各科缺交 TOP 榜单 <button className="btn ghost xs" onClick={() => setTopList(null)}>×</button></h4>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {topList.map((s, i) => (
                <span key={s.subject} className="chip" style={{ background: i === 0 ? '#e53935' : 'var(--bg)', color: i === 0 ? '#fff' : 'var(--text)' }}>第{i + 1}名 {s.subject} 缺交 {s.missing} 人次</span>
              ))}
            </div>
          </div>
        )}
        <div className="row" style={{ marginBottom: 6 }}>
          <label className="tips"><input type="checkbox" checked={selected.length > 0 && selected.length === records.length} onChange={(e) => setSelected(e.target.checked ? records.map((r) => r.id) : [])} /> 全选（{selected.length}）</label>
          <button className="btn ghost xs" onClick={exportSelected}>导出所选</button>
          <button className="btn ghost xs" onClick={batchNote}>批量补备注</button>
          <span className="tips">共 {records.length} 条</span>
        </div>
        <div className="table-scroll" style={{ maxHeight: '48vh' }}>
          <table className="table slim hw-table">
            <colgroup>
              {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            <thead><tr>
              {HW_HEADERS.map((h, i) => (
                <th key={i} className="hw-th-resize">
                  {h}
                  {i < HW_HEADERS.length - 1 && <span className="hw-resizer" title="拖动调整列宽" onMouseDown={(e) => startResize(i, e)} />}
                </th>
              ))}
            </tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={selected.includes(r.id)} onChange={(e) => setSelected((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))} /></td>
                  <td className="hw-cell">{r.record_date}</td>
                  <td className="hw-cell">{r.subjects.join('、')}</td>
                  <td className="hw-cell hw-names up-text"><Names list={r.praise} /></td>
                  <td className="hw-cell hw-names down-text"><Names list={r.missing} /></td>
                  <td className="hw-cell hw-names" style={{ color: '#f59e0b' }}><Names list={r.problem} /></td>
                  <td className="hw-cell hw-note" title={r.note}>{r.note || ''}</td>
                  <td className="hw-cell">
                    <button className="btn ghost xs" title="编辑本条" onClick={() => setEditRow({ ...r, praiseText: r.praise.map((x) => x.name).join(','), missingText: r.missing.map((x) => x.name).join(','), problemText: r.problem.map((x) => x.name).join(',') })}>✏️</button>
                    <button className="btn ghost xs" title="复制本条到录入面板" onClick={() => copyToForm(r)}>⧉</button>
                    <button className="btn danger xs" title="删除该条（不可恢复）" onClick={() => delRow(r)}>🗑</button>
                  </td>
                </tr>
              ))}
              {records.length === 0 && <tr><td colSpan={8} className="empty-tip">暂无台账记录，请在上方录入（或调整筛选）</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 行内编辑弹层 */}
      {editRow && (
        <div className="modal-mask" onClick={() => setEditRow(null)}>
          <div className="modal-box" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-head"><h4>✏️ 编辑台账记录（{editRow.record_date} · {editRow.subjects.join('、')}）</h4><button className="btn ghost sm" onClick={() => setEditRow(null)}>×</button></div>
            <div className="form">
              <div className="row">
                <input type="date" value={editRow.record_date} onChange={(e) => setEditRow({ ...editRow, record_date: e.target.value })} />
                <input value={editRow.subjects.join('、')} onChange={(e) => setEditRow({ ...editRow, subjects: e.target.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) })} placeholder="科目（顿号分隔）" />
              </div>
              {[['praiseText', '✅ 表扬名单'], ['missingText', '❌ 未交名单'], ['problemText', '⚠️ 问题名单']].map(([k, l]) => (
                <div key={k} className="row"><span className="tips" style={{ width: 80 }}>{l}</span><input value={editRow[k]} onChange={(e) => setEditRow({ ...editRow, [k]: e.target.value })} /></div>
              ))}
              <textarea rows={2} value={editRow.note} onChange={(e) => setEditRow({ ...editRow, note: e.target.value })} placeholder="特殊备注" />
              <div className="row"><button className="btn primary sm" onClick={saveEdit}>保存</button><button className="btn ghost sm" onClick={() => setEditRow(null)}>取消</button><span className="tips">台账永久留存，仅可编辑补充</span></div>
            </div>
          </div>
        </div>
      )}

      {/* 底部图表区（第三块） */}
      <div className="hw-charts">
        <div className="card">
          <h4>📈 作业人次趋势折线图 <span className="tips">表扬 / 未交 / 问题 人次变化</span></h4>
          {trend.x.length ? <Chart option={lineOption(trend.x, [
            { name: '表扬', data: trend.praise }, { name: '未交', data: trend.missing }, { name: '问题', data: trend.problem },
          ], { yName: '人次' })} height={240} /> : <div className="empty-tip">当前筛选下暂无数据</div>}
        </div>
      </div>
    </div>
  );
}
