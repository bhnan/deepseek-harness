import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { api } from './api.js';
import { weekIndexOf, weekRange, todayISO, parseISO } from './engine/index.js';
import { datesFor } from './dates.js';
import TopBar from './components/TopBar.jsx';
import WeekView from './components/WeekView.jsx';
import MonthView from './components/MonthView.jsx';
import SemesterView from './components/SemesterView.jsx';
import Modal from './components/Modal.jsx';

export default function App() {
  const [boot, setBoot] = useState(null);
  const [settings, setSettings] = useState(null);
  const [view, setView] = useState('week'); // week | month | semester
  const [week, setWeek] = useState(1);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  // 学段过滤（全部/初中/小学）：跨视图生效
  const [stageFilter, setStageFilter] = useState('all');

  const refreshBoot = useCallback(async () => {
    try {
      const b = await api.bootstrap();
      setBoot(b);
      setSettings(b.settings);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { refreshBoot(); }, [refreshBoot]);

  const semester = useMemo(
    () => (boot?.semesters || []).find((s) => s.id === settings?.current_semester_id) || null,
    [boot, settings]
  );

  // 当前周初始化：跟随今天所在周（学期内），未开学 → 第 1 周
  useEffect(() => {
    if (!semester) return;
    const t = todayISO();
    const w = weekIndexOf(semester, t);
    setWeek(w >= 1 ? w : 1);
  }, [semester?.id]);

  const changeSemester = useCallback(async (sid) => {
    await api.saveSettings({ current_semester_id: sid });
    setSettings((s) => ({ ...s, current_semester_id: sid }));
  }, []);

  const changeTheme = useCallback(async (theme_id) => {
    await api.saveSettings({ theme_id });
    setSettings((s) => ({ ...s, theme_id }));
  }, []);

  // 学段过滤（全部/初中/小学）：持久化，跨周/月/学期视图生效
  const changeStageFilter = useCallback(async (sf) => {
    setStageFilter(sf);
    await api.saveSettings({ preferred_stage: sf });
    setSettings((s) => ({ ...s, preferred_stage: sf }));
  }, []);

  useEffect(() => {
    if (settings?.preferred_stage) setStageFilter(settings.preferred_stage);
  }, [settings?.preferred_stage]);

  const changeView = useCallback(async (v) => {
    setView(v);
    await api.saveSettings({ preferred_view: v });
    setSettings((s) => ({ ...s, preferred_view: v }));
  }, []);

  const notify = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }, []);

  useEffect(() => {
    if (settings?.theme_id) document.documentElement.dataset.theme = settings.theme_id;
  }, [settings?.theme_id]);

  if (!boot || !settings) {
    return <div className="app-loading">加载中…{error && <div className="error">错误：{error}</div>}</div>;
  }

  const progressPct = semester ? progressFor(semester) : 0;
  const weekInfo = semester ? weekRange(semester, Math.max(1, week)) : null;

  return (
    <div className="app">
      <TopBar
        boot={boot} settings={settings} semester={semester}
        progressPct={progressPct} week={week} weekInfo={weekInfo}
        onChangeSemester={changeSemester} onChangeTheme={changeTheme}
        onRefresh={refreshBoot} notify={notify}
      />
      <div className="view-tabs">
        {['week', 'month', 'semester'].map((v) => (
          <button key={v} className={`tab ${view === v ? 'active' : ''}`} onClick={() => changeView(v)}>
            {v === 'week' ? '周视图' : v === 'month' ? '月视图' : '学期视图'}
          </button>
        ))}
        <span className="view-tabs-sep" />
        <div className="stage-filter" title="按学段过滤课程显示">
          {[['all', '全部班级'], ['middle', '仅初中'], ['primary', '仅小学']].map(([k, label]) => (
            <button key={k} className={`stage-chip ${stageFilter === k ? 'active' : ''}`} onClick={() => changeStageFilter(k)}>{label}</button>
          ))}
        </div>
        <span className="view-tabs-spacer" />
        <button className="btn ghost" onClick={async () => { try { await api.undo(semester?.id); refreshBoot(); notify('已撤销'); } catch (e) { notify(e.message); } }}>↩ 撤销</button>
        <button className="btn ghost" onClick={async () => { try { await api.redo(semester?.id); refreshBoot(); notify('已恢复'); } catch (e) { notify(e.message); } }}>↪ 恢复</button>
      </div>
      <main className="view-area">
        {!semester ? (
          <EmptySemester onCreate={refreshBoot} />
        ) : view === 'week' ? (
          <WeekView key={`${semester.id}-w${week}-s${stageFilter}`} boot={boot} semester={semester} week={week} setWeek={setWeek} notify={notify} onDataChange={refreshBoot} stageFilter={stageFilter} />
        ) : view === 'month' ? (
          <MonthView key={`${semester.id}-s${stageFilter}`} boot={boot} semester={semester} week={week} setWeek={setWeek} notify={notify} stageFilter={stageFilter} />
        ) : (
          <SemesterView key={`${semester.id}-s${stageFilter}`} boot={boot} semester={semester} notify={notify} onDataChange={refreshBoot} stageFilter={stageFilter} />
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function progressFor(semester) {
  // 进度 = 自然日口径（与引擎一致）；前端仅展示，真实口径以后端引擎为准
  const t = todayISO();
  if (t < semester.start_date) return 0;
  if (t > semester.end_date) return 100;
  const total = (parseISO(semester.end_date) - parseISO(semester.start_date)) / 86400000 + 1;
  const elapsed = (parseISO(t) - parseISO(semester.start_date)) / 86400000 + 1;
  return Math.round((elapsed / total) * 1000) / 10;
}

function EmptySemester({ onCreate }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="empty-semester">
      <h2>请选择或新建学期</h2>
      <div className="row">
        <select value={name} onChange={(e) => setName(e.target.value)}>
          <option value="">选择规范学期名称…</option>
          <optgroup label="学期">
            <option value="2026年秋季第一学期">2026年秋季第一学期</option>
            <option value="2026年春季第二学期">2026年春季第二学期</option>
            <option value="2027年春季第二学期">2027年春季第二学期</option>
            <option value="2027年秋季第一学期">2027年秋季第一学期</option>
          </optgroup>
          <optgroup label="寒暑假（同样可做计划）">
            <option value="2026年暑假">🏖 2026年暑假</option>
            <option value="2027年寒假">☃ 2027年寒假</option>
            <option value="2027年暑假">🏖 2027年暑假</option>
            <option value="2028年寒假">☃ 2028年寒假</option>
          </optgroup>
        </select>
        <button className="btn primary" disabled={!name} onClick={async () => {
          try {
            await api.createSemester({ name, start_date: datesFor(name).start, end_date: datesFor(name).end });
            onCreate();
          } catch (e) { setErr(e.message); }
        }}>新建学期</button>
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
