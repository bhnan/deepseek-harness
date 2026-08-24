import React, { useEffect, useState, useMemo } from 'react';
import { api } from '../api.js';
import { datesFor } from '../dates.js';
import Modal from './Modal.jsx';
import { weekIndexOf, todayISO, weekday, parseISO, formatMD } from '../engine/index.js';

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
// 假期类型（暑假/寒假）→ 展示名与图标
const isHoliday = (s) => /年(寒|暑)假$/.test(s?.name || '');
const holidayIcon = (s) => (/年暑假$/.test(s?.name || '') ? '🏖' : /年寒假$/.test(s?.name || '') ? '☃' : '');

export default function TopBar({ boot, settings, semester, progressPct, week, onChangeSemester, onChangeTheme, onRefresh, notify }) {
  const [showSemMgr, setShowSemMgr] = useState(false);
  const [todos, setTodos] = useState([]);
  const [push, setPush] = useState(null);
  const today = todayISO();

  // 今日待办（F2）：当日固定课程 + 临时调课 + 个人事务
  useEffect(() => {
    if (!semester) return;
    (async () => {
      try {
        const t = await api.todos(semester.id, today);
        setTodos(t.todos || []);
      } catch { setTodos([]); }
    })();
  }, [semester?.id, today, boot]);

  // 素养推送（F3/C2）
  useEffect(() => {
    if (!semester) return;
    (async () => {
      try {
        const p = await api.pushToday(semester.id);
        // 响应为 {ok, entry, exhausted, round, count}；词条字段在 entry 内
        setPush(p && p.entry ? { ...p.entry, count: p.count, round: p.round, exhausted: p.exhausted } : null);
      } catch { setPush(null); }
    })();
  }, [semester?.id, today, boot]);

  const toggleTodo = async (todo) => {
    try {
      if (todo.kind === 'task') {
        await api.updateEvent(semester.id, todo.event_id, { done: !todo.done });
      } else if (todo.kind === 'course' || todo.kind === 'temp') {
        await api.toggleDone(semester.id, todo.kind, todo.id, today, !todo.done);
      }
      onRefresh();
    } catch (e) { notify(e.message); }
  };

  return (
    <header className="topbar">
      <div className="topbar-section semester-info">
        <select
          className="semester-select"
          value={semester?.id || ''}
          onChange={(e) => onChangeSemester(e.target.value)}
          title="切换学期"
        >
          {boot.semesters.map((s) => (
            <option key={s.id} value={s.id}>{isHoliday(s) ? `${holidayIcon(s)} ${s.name}` : s.name}</option>
          ))}
        </select>
        <button className="btn ghost sm" onClick={() => setShowSemMgr(true)}>学期管理</button>
        <div className="progress-wrap">
          <span className="progress-label">{semester ? formatMD(semester.start_date) + (isHoliday(semester) ? ' 开始' : ' 开学') : ''}</span>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            <span className="progress-pct">{progressPct}%</span>
          </div>
          <span className="progress-label">{semester ? formatMD(semester.end_date) + (isHoliday(semester) ? ' 结束' : ' 放假') : ''}</span>
        </div>
        <span className={`week-badge ${weekIndexOf(semester, today) === 0 ? 'pre' : ''}`}>
          {semester ? (weekIndexOf(semester, today) >= 1 ? `${isHoliday(semester) ? '假期' : '本学期'}第 ${weekIndexOf(semester, today)} 周` : isHoliday(semester) ? '假期未开始' : '未开学') : ''}
        </span>
      </div>

      <div className="topbar-section right">
        <div className="todos">
          <div className="todos-title">今日待办 · {today.slice(5).replace('-', '.')} {WEEKDAY_CN[weekday(today) - 1]}</div>
          {todos.length === 0 ? <div className="todos-empty">今日暂无待办</div> : (
            <ul className="todos-list">
              {todos.slice(0, 6).map((t, i) => (
                <li key={i} className={`todo ${t.done ? 'done' : ''}`} onClick={() => toggleTodo(t)} title="点击切换完成状态">
                  <span className="todo-check">{t.done ? '✅' : '○'}</span>
                  <span className="todo-time">{t.period >= 1 && t.period <= 9 ? `第${t.period}节` : (t.time || '全天')}</span>
                  <span className="todo-text">{t.title}</span>
                </li>
              ))}
              {todos.length > 6 && <li className="todo-more">…共 {todos.length} 项</li>}
            </ul>
          )}
        </div>

        <div className="culture-card">
          {push ? (
            <>
              <div className="culture-cat">{push.category_cn}</div>
              <div className="culture-text">{push.original_text}</div>
              <details className="culture-detail">
                <summary>白话翻译 / 通俗释义</summary>
                {push.vernacular_translation && <div className="culture-line">📖 {push.vernacular_translation}</div>}
                <div className="culture-line">💡 {push.plain_explanation}</div>
              </details>
              <div className="culture-foot">
                <span className="culture-count">第 {push.count} 条 · 第 {push.round} 轮</span>
                <button className="btn ghost sm" onClick={async () => { try { const p = await api.pushRefresh(semester.id); setPush(p && p.entry ? { ...p.entry, count: p.count, round: p.round, exhausted: p.exhausted } : null); } catch (e) { notify(e.message); } }}>换一条</button>
              </div>
            </>
          ) : (
            <div className="todos-empty">素养词库不可用</div>
          )}
        </div>

        <select className="theme-select" value={settings.theme_id} onChange={(e) => onChangeTheme(e.target.value)} title="主题切换">
          {Object.entries(boot.themes || {}).map(([id, t]) => (
            <option key={id} value={id}>{t.name}</option>
          ))}
        </select>
      </div>

      {showSemMgr && (
        <SemesterManager
          boot={boot} semester={semester}
          onClose={() => setShowSemMgr(false)}
          onDone={async () => { await onRefresh(); }}
          notify={notify}
        />
      )}
    </header>
  );
}

// 学期管理弹窗（F1.3/F1.4：完全开放 + 名称-日期联动）
function SemesterManager({ boot, semester, onClose, onDone, notify }) {
  const [mode, setMode] = useState('list'); // list | create | edit
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  const pickName = (n) => {
    setName(n);
    const d = datesFor(n);
    if (d.start) { setStart(d.start); setEnd(d.end); } // 名称-日期强制联动（R2）
  };

  return (
    <Modal title="学期管理" onClose={onClose} width={560}>
      {mode === 'list' && (
        <>
          <table className="table">
            <thead><tr><th>学期 / 假期</th><th>起止日期</th><th>操作</th></tr></thead>
            <tbody>
              {boot.semesters.map((s) => (
                <tr key={s.id}>
                  <td>{isHoliday(s) ? `${holidayIcon(s)} ${s.name}` : s.name} {s.id === semester?.id && '✅'}</td>
                  <td>{s.start_date.slice(0, 10)} ~ {s.end_date.slice(0, 10)}</td>
                  <td>
                    <button className="btn ghost sm" onClick={() => { setEditing(s); setStart(s.start_date); setEnd(s.end_date); setMode('edit'); }}>编辑</button>
                    <button className="btn danger sm" onClick={async () => {
                      if (!confirm(`删除学期「${s.name}」？数据将归档保留（软删除），当前学期会切换。`)) return;
                      try { await api.deleteSemester(s.id); await onDone(); } catch (e) { notify(e.message); }
                    }}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-foot">
            <button className="btn primary" onClick={() => { setName(''); setStart(''); setEnd(''); setErr(''); setMode('create'); }}>＋ 新建学期</button>
          </div>
        </>
      )}
      {(mode === 'create' || mode === 'edit') && (
        <>
          <div className="form">
            <label>学期 / 假期名称（标准格式）</label>
            <select value={name} onChange={(e) => pickName(e.target.value)} disabled={mode === 'edit'}>
              <option value="">选择…</option>
              <optgroup label="学期">
                {['2026年春季第二学期', '2026年秋季第一学期', '2027年春季第二学期', '2027年秋季第一学期'].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </optgroup>
              <optgroup label="寒暑假（同样可做计划）">
                {['2026年暑假', '2027年寒假', '2027年暑假', '2028年寒假'].map((n) => (
                  <option key={n} value={n}>{holidayIcon({ name: n })} {n}</option>
                ))}
              </optgroup>
            </select>
            <label>开始日期（自动联动，可修改）</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <label>结束日期（自动联动，可修改）</label>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            {err && <div className="error">{err}</div>}
          </div>
          <div className="modal-foot">
            <button className="btn ghost" onClick={() => setMode('list')}>返回</button>
            <button className="btn primary" onClick={async () => {
              try {
                if (mode === 'create') {
                  await api.createSemester({ name, start_date: start, end_date: end });
                } else {
                  await api.updateSemester(editing.id, { start_date: start, end_date: end });
                }
                setMode('list'); await onDone(); notify(mode === 'create' ? '学期已创建' : '学期已更新');
              } catch (e) { setErr(e.message); }
            }}>{mode === 'create' ? '创建' : '保存'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
