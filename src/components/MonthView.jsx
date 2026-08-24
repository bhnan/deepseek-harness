import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { weekRange, todayISO, weekday, formatMD, addDays, weekIndexOf } from '../engine/index.js';
import { DayManager } from './WeekView.jsx';

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 月视图（F8/F9）：传统分页 + 学期全程全景双模式；表头周一~周日；日期 9.1 格式；左侧固定周次栏
export default function MonthView({ boot, semester, week, setWeek, notify, stageFilter = 'all' }) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('page'); // page | panorama
  const [editDay, setEditDay] = useState(null); // {date, holiday, weekday}
  // 初始定位：当前日期所在月（若在学期外则回退学期首月）
  const today = todayISO();
  const [month, setMonth] = useState(() => {
    const t = today.slice(0, 7);
    if (t >= semester.start_date.slice(0, 7) && t <= semester.end_date.slice(0, 7)) return t;
    return semester.start_date.slice(0, 7);
  });

  const load = useCallback(async () => {
    try { setData(await api.fullView(semester.id)); } catch (e) { notify(e.message); }
  }, [semester.id]);

  useEffect(() => { load(); }, [load, boot]); // boot 变化（撤销/恢复等）→ 重新拉取

  // 学期内月份列表
  const months = useMemo(() => {
    if (!data) return [];
    const out = [];
    let d = semester.start_date;
    while (d <= semester.end_date) {
      const m = d.slice(0, 7);
      if (!out.includes(m)) out.push(m);
      d = addDays(d, 1);
    }
    return out;
  }, [data, semester]);

  const classById = useMemo(() => new Map((data?.classes || []).map((c) => [c.id, c])), [data]);

  // 计算某天课程（固定模板 + 当日内容）；学段过滤：全部/初中/小学
  // 法定节假日当天停课：不显示课程（数据保留），仅显示假期徽标
  const dayInfo = useCallback((dateStr) => {
    if (!data) return null;
    const wd = weekday(dateStr);
    const w = weekIndexOf(semester, dateStr); // 学期总周数口径（R1）
    const holiday = data.holidays.find((h) => h.start_date <= dateStr && h.end_date >= dateStr);
    const fixedOfDay = holiday ? [] : data.fixed_courses.filter((f) => f.weekday === wd
      && (stageFilter === 'all' || classById.get(f.class_id)?.stage === stageFilter));
    const birthday = data.birthdays.filter((b) => `${dateStr.slice(0, 4)}${b.birthday.slice(1)}` === dateStr);
    const events = (data.events || []).filter((e) => e.date === dateStr);
    const courses = fixedOfDay.map((f) => {
      const content = data.contents.find((c) => c.class_id === f.class_id && c.week === w && (c.weekday || 1) === wd && (c.period || 1) === f.period);
      return { class: classById.get(f.class_id), period: f.period, content: content?.content, fixed_id: f.id, class_id: f.class_id, week: w, weekday: wd };
    }).sort((a, b) => a.period - b.period);
    return { wd, birthday, holiday, courses, events };
  }, [data, semester, classById, stageFilter]);

  // 周行：某周起 7 天
  const weekRows = useMemo(() => {
    if (!data) return [];
    const rows = [];
    for (let w = 1; w <= data.total_weeks; w++) {
      const r = weekRange(semester, w);
      const days = [];
      let d = r.start;
      for (let i = 0; i < 7; i++) {
        days.push({ date: d, info: dayInfo(d) });
        d = addDays(d, 1);
      }
      rows.push({ week: w, days, start: r.start, end: r.end });
    }
    return rows;
  }, [data, semester, dayInfo]);

  const visibleRows = useMemo(() => {
    if (mode === 'panorama') return weekRows;
    return weekRows.filter((r) => r.start.slice(0, 7) === month || r.end.slice(0, 7) === month);
  }, [weekRows, mode, month]);

  return (
    <div className="month-view">
      <div className="month-nav">
        <span className="week-title">月视图</span>
        <div className="row">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="page">传统分页月视图</option>
            <option value="panorama">学期全程全景视图</option>
          </select>
          {mode === 'page' && (
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{m.replace('-', ' 年 ')} 月</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="month-grid">
        <div className="month-grid-head">
          <div className="week-col">周次</div>
          {WEEKDAY_CN.map((w) => <div key={w} className="month-head-cell">{w}</div>)}
        </div>
        {visibleRows.map((row) => (
          <div className="month-grid-row" key={row.week}>
            <div className="week-col" title={`${row.start} ~ ${row.end}`}>第 {row.week} 周</div>
            {row.days.map((d) => {
              const isToday = d.date === today;
              const outOfSemester = d.date < semester.start_date || d.date > semester.end_date;
              const dayEvents = d.info?.events || [];
              return (
                <div key={d.date}
                  className={`month-cell ${isToday ? 'today' : ''} ${d.info?.holiday ? 'holiday' : d.info?.wd >= 6 ? 'weekend' : ''} ${outOfSemester ? 'outside' : ''} ${dayEvents.length ? 'has-events' : ''}`}
                  title="点击查看/添加当天课程与个人事务"
                  onClick={() => { if (outOfSemester) return; setEditDay({ date: d.date, holiday: d.info?.holiday || null, weekday: d.info?.wd }); }}>
                  <div className="month-date">{formatMD(d.date)}</div>
                  {d.info?.holiday && <div className="month-holiday">{d.info.holiday.name}</div>}
                  <div className="month-birthdays">
                    {d.info?.birthday?.map((b) => <span key={b.id} className="birthday-mini">🎂{b.name}</span>)}
                  </div>
                  {dayEvents.length > 0 && (
                    <div className="month-events">
                      {dayEvents.slice(0, 2).map((ev) => (
                        <div key={ev.id} className={`month-event ${ev.done ? 'done' : ''}`}>
                          {ev.done ? '✅' : '○'} {ev.title}{ev.time ? ` ${ev.time}` : ''}
                        </div>
                      ))}
                      {dayEvents.length > 2 && <div className="month-event-more">…共 {dayEvents.length} 项</div>}
                    </div>
                  )}
                  <div className="month-courses">
                    {d.info?.courses?.map((c, i) => (
                      <div key={i} className="month-course" style={{ borderLeftColor: c.class?.color }}>
                        <span className="mc-period">P{c.period}</span>
                        <span className="mc-class">{c.class?.name}</span>
                        {c.content && <span className="mc-content">{c.content}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {editDay && (
        <DayManager
          boot={boot} semester={semester} week={week} date={editDay.date} holiday={editDay.holiday} weekday={editDay.weekday}
          events={(data?.events || []).filter((e) => e.date === editDay.date)}
          dayCourses={(() => {
            const info = dayInfo(editDay.date);
            return (info?.courses || []).map((c) => ({
              cell: { key: `${editDay.weekday}-${c.period}`, class_id: c.class_id, fixed_id: c.fixed_id },
              content: c.content ? { content: c.content, class_id: c.class_id, week: c.week, weekday: c.weekday, period: c.period } : null,
              cls: c.class,
            }));
          })()}
          onClose={() => setEditDay(null)}
          onSaved={async () => { onDataChange(); load(); }}
          notify={notify}
        />
      )}
    </div>
  );
}
