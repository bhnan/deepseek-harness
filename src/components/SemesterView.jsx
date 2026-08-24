import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';

const TYPE_CN = { course: '课程', activity: '活动', birthday: '生日' };
const TYPE_COLORS = { course: '#4A90D9', activity: '#7FB069', birthday: '#C97B84' };

// 学期视图（F10–F13，事件管理型）：左侧事件类型栏 + 右侧事件列表（非日历网格）
export default function SemesterView({ boot, semester, notify, onDataChange }) {
  const [data, setData] = useState(null);
  const [filters, setFilters] = useState([]); // 多选类型
  const [editing, setEditing] = useState(null); // 事件编辑
  const [showImport, setShowImport] = useState(false);
  const [multi, setMulti] = useState(new Set()); // 批量选择

  const load = useCallback(async () => {
    try { setData(await api.events(semester.id)); } catch (e) { notify(e.message); }
  }, [semester.id]);

  useEffect(() => { load(); }, [load, boot]); // boot 变化（撤销/恢复等）→ 重新拉取

  const events = useMemo(() => {
    const evs = [...(data?.events || [])];
    const bds = (data?.birthdays || []).map((b) => ({
      id: b.id, type: 'birthday', title: `${b.role === 'teacher' ? '老师' : '学生'}生日 · ${b.name}`,
      date: b.birthday.slice(1), time: '', location: b.class_id || '', participants: b.name,
      notes: b.note, requirements: '', color: TYPE_COLORS.birthday, done: false, _bd: true,
    }));
    const all = [...evs, ...bds].sort((a, b) => a.date.localeCompare(b.date));
    return filters.length ? all.filter((e) => filters.includes(e.type)) : all;
  }, [data, filters]);

  const toggleFilter = (t) => {
    setFilters((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]));
  };

  const deleteEvent = async (e) => {
    try {
      if (e._bd) await api.delBirthday(semester.id, e.id);
      else await api.delEvent(semester.id, e.id);
      notify('已删除'); onDataChange(); load();
    } catch (err) { notify(err.message); }
  };

  const toggleMulti = (id) => {
    setMulti((m) => {
      const n = new Set(m);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  return (
    <div className="semester-view">
      <div className="sem-view-left">
        <div className="sem-filter-title">事件类型</div>
        {['course', 'activity', 'birthday'].map((t) => (
          <button key={t} className={`filter-btn ${filters.includes(t) ? 'active' : ''}`} onClick={() => toggleFilter(t)}>
            <span className="filter-dot" style={{ background: TYPE_COLORS[t] }} />
            {TYPE_CN[t]} {filters.includes(t) && '✓'}
          </button>
        ))}
        <button className="btn ghost sm" onClick={() => setFilters([])}>显示全部</button>
        {filters.length > 0 && <div className="filter-summary">筛选：{filters.map((f) => TYPE_CN[f]).join(' + ')}</div>}
        <div className="sem-actions">
          <button className="btn primary sm" onClick={() => setEditing({})}>＋ 新增事件</button>
          <button className="btn ghost sm" onClick={() => setShowImport(true)}>批量导入生日</button>
          {multi.size > 0 && (
            <button className="btn danger sm" onClick={async () => {
              if (!confirm(`批量删除选中的 ${multi.size} 条？`)) return;
              try {
                for (const id of multi) {
                  const e = events.find((x) => x.id === id);
                  if (e?._bd) await api.delBirthday(semester.id, id);
                  else if (e) await api.delEvent(semester.id, id);
                }
                setMulti(new Set()); notify('批量删除完成'); onDataChange(); load();
              } catch (e) { notify(e.message); }
            }}>批量删除（{multi.size}）</button>
          )}
        </div>
      </div>

      <div className="sem-view-right">
        <div className="sem-list-head">
          <span>事件列表（共 {events.length} 条，按日期排序）</span>
        </div>
        <div className="sem-list">
          {events.length === 0 && <div className="todos-empty">无事件（可点击左侧「新增事件」）</div>}
          {events.map((e) => (
            <div key={e.id} className={`event-card ${multi.has(e.id) ? 'selected' : ''} ${e.done ? 'done' : ''}`} onClick={() => toggleMulti(e.id)}>
              <div className="event-date">{e.date}</div>
              <div className="event-main">
                <div className="event-title">
                  <span className="event-type" style={{ background: TYPE_COLORS[e.type] || e.color }}>{TYPE_CN[e.type] || e.type}</span>
                  {e.title}
                </div>
                {!e._bd && (
                  <details className="event-detail">
                    <summary>五要素详情</summary>
                    <div className="event-fields">
                      <div><b>时间：</b>{e.time || '—'}</div>
                      <div><b>地点：</b>{e.location || '—'}</div>
                      <div><b>参与人员：</b>{e.participants || '—'}</div>
                      <div><b>注意事项：</b>{e.notes || '—'}</div>
                      <div><b>工作要求：</b>{e.requirements || '—'}</div>
                    </div>
                  </details>
                )}
                {e._bd && <div className="event-bd-note">{e.notes || '（生日事件）'}</div>}
              </div>
              <div className="event-ops">
                {!e._bd && (
                  <>
                    <button className={`btn ghost sm ${e.done ? 'done-btn' : ''}`} onClick={(ev) => { ev.stopPropagation(); (async () => { try { await api.updateEvent(semester.id, e.id, { done: !e.done }); onDataChange(); load(); } catch (err) { notify(err.message); } })(); }} title="切换完成状态">
                      {e.done ? '✅ 已完成' : '○ 未完成'}
                    </button>
                    <button className="btn ghost sm" onClick={(ev) => { ev.stopPropagation(); setEditing(e); }}>编辑</button>
                  </>
                )}
                <button className="btn danger sm" onClick={(ev) => { ev.stopPropagation(); if (confirm(`删除「${e.title}」？`)) deleteEvent(e); }}>删除</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <EventEditor
          semester={semester} event={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={async () => { onDataChange(); load(); }}
          notify={notify}
        />
      )}
      {showImport && (
        <BirthdayImport
          semester={semester} boot={boot}
          onClose={() => setShowImport(false)}
          onSaved={async () => { onDataChange(); load(); }}
          notify={notify}
        />
      )}
    </div>
  );
}

// 事件编辑器（F11 五要素详情）
function EventEditor({ semester, event, onClose, onSaved, notify }) {
  const [f, setF] = useState({
    type: event?.type || 'activity', title: event?.title || '', date: event?.date || '',
    time: event?.time || '', location: event?.location || '', participants: event?.participants || '',
    notes: event?.notes || '', requirements: event?.requirements || '', color: event?.color || '#7FB069',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <Modal title={event ? '编辑事件' : '新增事件'} onClose={onClose} width={560}>
      <div className="form">
        <div className="row">
          <select value={f.type} onChange={set('type')}>
            <option value="course">课程</option>
            <option value="activity">活动</option>
          </select>
          <input type="date" value={f.date} onChange={set('date')} />
          <input type="color" value={f.color} onChange={set('color')} title="分类配色（可改）" />
        </div>
        <input value={f.title} onChange={set('title')} placeholder="事件标题（必填）" />
        <input value={f.time} onChange={set('time')} placeholder="时间（如：08:00-11:30）" />
        <input value={f.location} onChange={set('location')} placeholder="地点" />
        <input value={f.participants} onChange={set('participants')} placeholder="参与人员" />
        <textarea value={f.notes} onChange={set('notes')} placeholder="注意事项" rows={2} />
        <textarea value={f.requirements} onChange={set('requirements')} placeholder="工作要求" rows={2} />
        {err && <div className="error">{err}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={async () => {
          if (!f.title || !f.date) { setErr('标题与日期必填'); return; }
          try {
            if (event) await api.updateEvent(semester.id, event.id, f);
            else await api.addEvent(semester.id, f);
            notify('已保存'); onSaved(); onClose();
          } catch (e) { setErr(e.message); }
        }}>保存</button>
      </div>
    </Modal>
  );
}

// 生日批量导入（F13/I1）：CSV 粘贴解析，部分失败语义；班级名自动映射到班级库 class_id（D6）
function BirthdayImport({ semester, boot, onClose, onSaved, notify }) {
  const [csv, setCsv] = useState('姓名,出生日期(MM-DD),学段(选填),班级名(选填)\n李想,09-01,初中,初一(1)班\n张小雨,10-25,小学,四(1)班');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  // 班级名 → id 映射（跨学段，名称匹配）
  const classByName = new Map((boot.classes || []).map((c) => [c.name, c.id]));
  const unmapped = new Set();

  const parse = () => {
    const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
    const rows = [];
    const errors = [];
    lines.forEach((line, i) => {
      if (i === 0 && line.includes('姓名')) return; // 跳过表头
      const parts = line.split(/[,，\t]/).map((p) => p.trim());
      const [name, bd, stage, className] = parts;
      if (!name || !/^\d{2}-\d{2}$/.test(bd || '')) { errors.push({ row: i + 1, reason: `格式错误: ${line}` }); return; }
      const role = stage === '小学' ? 'student' : 'teacher';
      let classId = null;
      if (className) {
        classId = classByName.get(className) || null;
        if (!classId) unmapped.add(className); // 班级库中不存在 → 记入提示，不阻断导入
      }
      rows.push({ role, name, birthday: `--${bd}`, class_id: classId, note: className || '' });
    });
    return { rows, errors };
  };

  return (
    <Modal title="批量导入师生生日（CSV）" onClose={onClose} width={600}>
      <textarea rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} className="csv-area" />
      <div className="row">
        <button className="btn ghost" onClick={() => setCsv('姓名,出生日期(MM-DD),学段(选填),班级名(选填)\n李想,09-01,初中,初一(1)班\n张小雨,10-25,小学,四(1)班')}>恢复示例</button>
        <button className="btn primary" onClick={async () => {
          const { rows, errors } = parse();
          if (rows.length === 0) { setErr('没有可导入的行'); return; }
          try {
            const r = await api.importBirthdays(semester.id, rows);
            const tips = [...errors.map((x) => ({ row: x.row, reason: x.reason })), ...r.errors.map((x) => ({ row: x.row, reason: x.reason }))];
            if (unmapped.size > 0) tips.push({ row: 0, reason: `未匹配到班级库的班级名：${[...unmapped].join('、')}（已存为备注）` });
            setResult({ success: r.success, failed: r.failed, errors: tips });
            if (r.success > 0) { notify(`成功导入 ${r.success} 条`); onSaved(); }
          } catch (e) { setErr(e.message); }
        }}>解析并导入</button>
      </div>
      {err && <div className="error">{err}</div>}
      {result && (
        <div className="import-result">
          <div>✅ 成功 {result.success} 条 · ❌ 失败 {result.failed} 条</div>
          {result.errors.length > 0 && (
            <ul>{result.errors.map((e, i) => <li key={i}>第 {e.row} 行：{e.reason}</li>)}</ul>
          )}
        </div>
      )}
    </Modal>
  );
}
