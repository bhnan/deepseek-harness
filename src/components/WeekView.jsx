import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import { weekRange, todayISO, formatMD } from '../engine/index.js';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function WeekView({ boot, semester, week, setWeek, notify, onDataChange, stageFilter = 'all' }) {
  const [data, setData] = useState(null);
  const [editCell, setEditCell] = useState(null);
  const [editDay, setEditDay] = useState(null);
  const [showClasses, setShowClasses] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [ctx, setCtx] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [mobileDay, setMobileDay] = useState(null);
  const today = todayISO();
  const notStarted = today < semester.start_date;

  const load = useCallback(async () => {
    try {
      const d = await api.weekView(semester.id, week);
      setData(d);
    } catch (e) { notify(e.message); }
  }, [semester.id, week]);

  useEffect(() => { load(); }, [load, boot]); // boot 变化（撤销/恢复/学期管理等）→ 重新拉取

  const classById = useMemo(() => new Map((data?.classes || []).map((c) => [c.id, c])), [data]);
  const range = data?.range;
  const dates = useMemo(() => {
    if (!range) return [];
    const out = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(Date.UTC(parseInt(range.start.slice(0, 4), 10), parseInt(range.start.slice(5, 7), 10) - 1, parseInt(range.start.slice(8, 10), 10) + d));
      out.push(dt.toISOString().slice(0, 10));
    }
    return out;
  }, [range]);

  const cellKey = (wd, p) => `${wd}-${p}`;
  // 学段过滤：全部/初中/小学（merged_cells 按班级学段过滤，其余课时位视作空）
  const cellsByKey = useMemo(() => {
    const m = new Map();
    for (const c of (data?.merged_cells || [])) {
      if (stageFilter !== 'all' && classById.get(c.class_id)?.stage !== stageFilter) continue;
      m.set(c.key, c);
    }
    return m;
  }, [data, classById, stageFilter]);
  const contentFor = (cell) => {
    if (!cell) return null;
    return (data?.contents || []).find((c) =>
      c.class_id === cell.class_id && c.week === week && (c.weekday || 1) === (cell.key.split('-')[0] * 1) && (c.period || 1) === (cell.key.split('-')[1] * 1)
    );
  };
  const holidayOn = (dateStr) => (data?.holidays || []).find((h) => h.start_date <= dateStr && h.end_date >= dateStr);
  // 停课标记（R4 扩展）：suspended 是该周被标记停课的课时位 key 列表
  const suspendedKeys = useMemo(() => new Set(data?.suspended || []), [data]);
  const suspensionFor = (wd, p) => (data?.suspensions || []).find((s) => s.weekday === wd && s.period === p);
  // 当天高亮（修正）：仅当当前周视图正好包含「今天」时，今天所在列才高亮；
  // 其他周的同星期几一律不高亮（此前误用 weekday 比较导致每周同日都被标亮）
  const todayInView = range && today >= range.start && today <= range.end;

  const onContextMenu = (e, wd, p) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, weekday: wd, period: p });
  };

  const onDragStart = (e, cell) => {
    // 仅固定课内容可拖（临时调课不可拖）
    if (!cell || cell.temp) { e.preventDefault(); return; }
    const payload = { class_id: cell.class_id, week, weekday: cell.key.split('-')[0] * 1, period: cell.key.split('-')[1] * 1 };
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    setDragFrom(cell.key);
  };

  const onDrop = async (e, wd, p) => {
    e.preventDefault();
    setDragFrom(null);
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    const from = JSON.parse(raw);
    const targetCell = cellsByKey.get(cellKey(wd, p));
    if (targetCell && targetCell.temp) { notify('目标位置为临时调课，不能放置'); return; }
    // 目标有固定排课 → 用该班归属；完全空白格 → 交给后端创建排课（来源班级）
    const to = targetCell
      ? { class_id: targetCell.class_id, week, weekday: wd, period: p }
      : { class_id: from.class_id, week, weekday: wd, period: p };
    try {
      const r = await api.swapContent(semester.id, from, to);
      notify(r.swapped ? '已换课：两个课时位内容互换' : '已移动：课程已搬至目标位置，原位置已清空');
      onDataChange(); load();
    } catch (e) { notify(e.message); }
  };

  const deleteCell = async (cell, { whole } = {}) => {
    try {
      if (cell.temp) {
        await api.delTempChange(semester.id, cell.temp_id);
      } else if (whole) {
        await api.delFixedCourse(semester.id, cell.fixed_id);
      } else {
        const content = contentFor(cell);
        if (content) await api.delContent(semester.id, content.id);
      }
      notify(whole ? '已删除固定排课（整学期）' : '已删除该课时');
      onDataChange(); load();
    } catch (e) { notify(e.message); }
  };

  return (
    <div className="week-view">
      <div className="week-nav">
        <span className="week-title">{notStarted ? `未开学（开学日 ${semester.start_date.slice(5).replace('-', '.')}）` : `本学期第 ${week} 周`}</span>
        <span className="week-range">{range ? `${range.start.slice(5).replace('-', '.')} — ${range.end.slice(5).replace('-', '.')}` : ''}</span>
        <div className="week-nav-btns">
          <button className="btn ghost sm" disabled={week <= 1} onClick={() => setWeek(week - 1)}>‹ 上一周</button>
          <button className="btn ghost sm" disabled={week >= (data?.total_weeks || 20)} onClick={() => setWeek(week + 1)}>下一周 ›</button>
          <button className="btn ghost sm" onClick={() => setShowContent(true)}>授课内容</button>
          <button className="btn ghost sm" onClick={() => setShowClasses(true)}>班级管理</button>
        </div>
      </div>

      <div className="week-grid">
        <div className="week-grid-head">
          <div className="period-col">节次</div>
          {WEEKDAYS.map((wd) => {
            const d = dates[wd - 1];
            const h = holidayOn(d);
            const isToday = todayInView && d === today;
            const dayCells = WEEKDAYS.length && PERIODS.map((p) => cellsByKey.get(cellKey(wd, p))).filter(Boolean);
            const dayHasCourses = (dayCells || []).some((c) => !c.temp && contentFor(c));
            const daySuspendedCount = PERIODS.filter((p) => suspendedKeys.has(cellKey(wd, p))).length;
            return (
              <div key={wd} className={`week-head-cell ${isToday ? 'today' : ''} ${h ? 'holiday' : wd >= 6 ? 'weekend' : ''}`}>
                <div className="head-date">
                  <span className="head-week">第{week}周</span>
                  {WEEKDAY_CN[wd - 1]} {d ? formatMD(d) : ''}
                  {(dayHasCourses || daySuspendedCount > 0) && !h && (
                    <button className={`day-defer-btn ${daySuspendedCount > 0 ? 'susp-on' : ''}`}
                      title={daySuspendedCount > 0 ? '当天已标记停课：点击可全部恢复上课（内容回到原位）' : '当天停课标记：点击把当天所有班有内容的课标记为停课（自动顺延，取消时恢复原位）'}
                      onClick={async (e) => {
                        e.stopPropagation();
                        const suspendAll = daySuspendedCount === 0;
                        if (suspendAll && !confirm(`确认将 ${d} 当天所有班有内容的课标记为停课？\n（格子变红提示停课，课程数据保留；学校改主意了再点一次即可全部恢复）`)) return;
                        try {
                          let done = 0;
                          if (suspendAll) {
                            // 标记停课：遍历当前有内容的固定课（含未在 cellsByKey 的已停课格）
                            for (const p of PERIODS) {
                              const k = cellKey(wd, p);
                              if (suspendedKeys.has(k)) continue;
                              const c = cellsByKey.get(k);
                              if (!c || c.temp || !contentFor(c)) continue;
                              try { await api.addSuspension(semester.id, { class_id: c.class_id, week, weekday: wd, period: p }); done++; } catch { /* already */ }
                            }
                          } else {
                            // 恢复上课：删除当天所有停课标记（从 suspensions 数据）
                            for (const s of (data?.suspensions || []).filter((x) => x.weekday === wd)) {
                              try { await api.delSuspension(semester.id, s.id); done++; } catch { /* ignore */ }
                            }
                          }
                          notify(suspendAll ? `已标记 ${done} 节课停课（红色提示）` : `已恢复 ${done} 节课上课`);
                          onDataChange(); load();
                        } catch (e) { notify(e.message); }
                      }}>{daySuspendedCount > 0 ? `停课中(${daySuspendedCount})` : '停课'}</button>
                  )}
                </div>
                {h && <div className="head-holiday">{h.name}</div>}
                <div className="head-birthdays">
                  {(data?.birthdays || {})[wd]?.map((b) => (
                    <span key={b.id} className="birthday-name">🎂 {b.name}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {PERIODS.map((p) => (
          <div className="week-grid-row" key={p}>
            <div className="period-col">第 {p} 节</div>
            {WEEKDAYS.map((wd) => {
              const cell = cellsByKey.get(cellKey(wd, p));
              const content = contentFor(cell);
              const cls = cell ? classById.get(cell.class_id) : null;
              const d = dates[wd - 1];
              const isToday = todayInView && d === today;
              const h = holidayOn(d);
              const suspended = suspendedKeys.has(cellKey(wd, p)); // 停课标记（红色）
              const susp = suspensionFor(wd, p);
              // 当天安排（节假日/周末可放全天任务：事件 time 留空 = 全天）
              const dayEvents = (data?.events || []).filter((e) => e.date === d);
              return (
                <div
                  key={wd}
                  className={`week-cell ${isToday ? 'today' : ''} ${h ? 'holiday' : wd >= 6 ? 'weekend' : ''} ${cell ? 'has-course' : 'empty'} ${suspended ? 'suspended' : ''} ${dragFrom === cellKey(wd, p) ? 'dragging' : ''}`}
                  draggable={!!(cell && !cell.temp && content && !suspended)}
                  onDragStart={(e) => onDragStart(e, cell)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, wd, p)}
                  onClick={(e) => {
                    if (suspended) { onContextMenu(e, wd, p); return; } // 停课格 → 弹出右键菜单（恢复上课/顺延）
                    if (!cell) { setEditDay({ date: d, holiday: h || null, weekday: wd }); return; } // 任意空格 → 当日安排（个人事务）
                    setEditCell({ weekday: wd, period: p, cell, content, date: d, holiday: h });
                  }}
                  onContextMenu={(e) => onContextMenu(e, wd, p)}
                >
                  {suspended && (
                    <div className="cell-inner suspension-badge" title={`${susp ? susp.note : '停课'}：当天停课（点击右键可恢复上课）`}>
                      <div className="cell-content suspension-text">🚫 {susp ? susp.note : '停课'}</div>
                    </div>
                  )}
                  {!suspended && !cell && p === 1 && h && dayEvents.length === 0 && (
                    <div className="cell-inner holiday-off" title="法定节假日：点击可安排全天任务">
                      <div className="cell-content holiday-off-text">🎉 {h.name}</div>
                    </div>
                  )}
                  {!suspended && !cell && dayEvents.length > 0 && (
                    <div className="cell-inner day-events" title="当天安排（点击编辑）">
                      {dayEvents.map((ev) => (
                        <div key={ev.id} className={`day-event ${ev.done ? 'done' : ''}`}>
                          {ev.done ? '✅' : '○'} {ev.title}
                        </div>
                      ))}
                    </div>
                  )}
                  {cell && (
                    <div className="cell-inner" style={cls ? { borderLeft: `4px solid ${cls.color}` } : {}}>
                      <div className="cell-class" style={{ color: cls?.color }}>
                        {cls ? cls.name : '（班级）'} {cell.temp && <span className="temp-tag">临时</span>}
                      </div>
                      <div className="cell-content">{content ? content.content : '（未填写内容）'}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div> {/* week-grid end */}

      {/* ===== 手机单日视图（响应式：大屏隐藏） ===== */}
      {(() => {
        const effectiveDay = mobileDay ?? (dates.findIndex((d) => d === today) >= 0 ? dates.findIndex((d) => d === today) : 0);
        const d = dates[effectiveDay];
        const h = holidayOn(d);
        const isToday = todayInView && d === today;
        const wd = effectiveDay + 1;
        const dayHasCourse = PERIODS.some((p) => cellsByKey.get(cellKey(wd, p)));
        return (
          <div className="week-mobile-day">
            {/* 日期导航 */}
            <div className="mobile-day-nav">
              <button disabled={effectiveDay <= 0} onClick={() => setMobileDay(effectiveDay - 1)}>‹ 前一天</button>
              <button className="today-btn" onClick={() => {
                const todayIdx = dates.findIndex((d) => d === today);
                setMobileDay(todayIdx >= 0 ? todayIdx : effectiveDay);
              }}>今天</button>
              <button disabled={effectiveDay >= 6} onClick={() => setMobileDay(effectiveDay + 1)}>后一天 ›</button>
            </div>
            {/* 日期标题 */}
            <div className="mobile-day-header">
              <div className="mobile-day-date">
                {WEEKDAY_CN[effectiveDay]} {d ? formatMD(d) : ''}
                {isToday && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>· 今天</span>}
              </div>
              {h && <div className="mobile-day-holiday">🎉 {h.name}</div>}
              {(data?.birthdays || {})[wd]?.length > 0 && (
                <div className="mobile-day-birthdays">
                  {data.birthdays[wd].map((b) => <span key={b.id}>🎂 {b.name} </span>)}
                </div>
              )}
            </div>
            {/* 课程列表 */}
            <div className="mobile-day-body" onTouchStart={(e) => {
              const t = e.changedTouches[0]; e.currentTarget.dataset.touchX = t.screenX;
            }} onTouchEnd={(e) => {
              const startX = parseFloat(e.currentTarget.dataset.touchX || '0');
              const dx = e.changedTouches[0].screenX - startX;
              if (Math.abs(dx) > 50) {
                if (dx > 0 && effectiveDay > 0) setMobileDay(effectiveDay - 1);
                else if (dx < 0 && effectiveDay < 6) setMobileDay(effectiveDay + 1);
              }
            }}>
              {PERIODS.map((p) => {
                const cell = cellsByKey.get(cellKey(wd, p));
                const content = contentFor(cell);
                const cls = cell ? classById.get(cell.class_id) : null;
                const suspended = suspendedKeys.has(cellKey(wd, p));
                const susp = suspensionFor(wd, p);
                const dayEvents = (data?.events || []).filter((e) => e.date === d);
                return (
                  <div key={p} className="mobile-period-row">
                    <div className="mobile-period-label">第 {p} 节</div>
                    {suspended ? (
                      <div className="mobile-course-card suspended" onClick={(e) => {
                        setCtx({ x: e.clientX, y: e.clientY, weekday: wd, period: p });
                      }}>
                        <div className="mobile-course-content" style={{ color: '#c0392b', fontWeight: 600 }}>
                          🚫 停课{susp ? `（${susp.note}）` : ''}
                        </div>
                      </div>
                    ) : cell ? (
                      <div className={`mobile-course-card ${cell.temp ? 'temp' : ''}`}
                        style={cls ? { borderLeft: `4px solid ${cls.color}` } : {}}
                        onClick={() => setEditCell({ weekday: wd, period: p, cell, content, date: d, holiday: h })}
                        onContextMenu={(e) => onContextMenu(e, wd, p)}>
                        <div className="mobile-course-class" style={{ background: cls?.color || 'var(--accent)' }}>
                          {cls ? cls.name : '?'}
                        </div>
                        <div className="mobile-course-content">
                          {content ? content.content : '（未填写内容）'}
                          {cell.temp && <span className="temp-tag" style={{ marginLeft: 4 }}>临时</span>}
                        </div>
                      </div>
                    ) : !h && dayEvents.length > 0 ? (
                      <div className="mobile-course-card empty" onClick={() => setEditDay({ date: d, holiday: h || null, weekday: wd })}>
                        <div className="mobile-course-empty-text">
                          {dayEvents.map((ev) => (
                            <span key={ev.id}>{ev.done ? '✅' : '○'} {ev.title}</span>
                          ))}
                        </div>
                      </div>
                    ) : h ? (
                      <div className="mobile-course-card holiday-off" onClick={() => setEditDay({ date: d, holiday: h, weekday: wd })}>
                        <div className="mobile-course-empty-text">🎉 {h.name} · 全天不上课</div>
                      </div>
                    ) : (
                      <div className="mobile-course-card empty" onClick={() => setEditDay({ date: d, holiday: null, weekday: wd })}>
                        <div className="mobile-course-empty-text">空课时 · 点此安排个人事务</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 快速回到今天 */}
            {!isToday && dayHasCourse && (
              <button className="mobile-day-today-btn" onClick={() => {
                const todayIdx = dates.findIndex((d) => d === today);
                setMobileDay(todayIdx >= 0 ? todayIdx : effectiveDay);
              }}>今</button>
            )}
          </div>
        );
      })()}

      {ctx && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onMouseLeave={() => setCtx(null)}>
          <div className="ctx-title">周{ctx.weekday} 第{ctx.period}节</div>
          <button className="ctx-item" onClick={() => { const d = dates[ctx.weekday - 1]; const h = holidayOn(d); const c = cellsByKey.get(cellKey(ctx.weekday, ctx.period)); if (c) { setCtx(null); setEditCell({ weekday: ctx.weekday, period: ctx.period, cell: c, content: contentFor(c) }); return; } setCtx(null); setEditDay({ date: d, holiday: h || null, weekday: ctx.weekday }); }}>✏️ 编辑课程 / 当日安排</button>
          {(() => {
            const d = dates[ctx.weekday - 1];
            const h = holidayOn(d);
            return (
              <button className="ctx-item" title="添加个人事务（批改作业/备课/看电影等，按天安排）"
                onClick={() => { setCtx(null); setEditDay({ date: d, holiday: h || null, weekday: ctx.weekday }); }}>📝 添加个人事务</button>
            );
          })()}
          {(() => {
            const k = cellKey(ctx.weekday, ctx.period);
            const isSus = suspendedKeys.has(k);
            const c = cellsByKey.get(k);
            const ct = c ? contentFor(c) : null;
            // 已停课格：恢复上课 = 取消停课 + 内容回到原位（自动）
            if (isSus) {
              return (
                <button className="ctx-item susp-on" title="取消停课：恢复当天上课，顺延的内容自动回到原位"
                  onClick={async () => {
                    setCtx(null);
                    try {
                      const s = suspensionFor(ctx.weekday, ctx.period);
                      if (s) { const r = await api.delSuspension(semester.id, s.id); notify(r.restored ? '已恢复上课，顺延内容已回到原位' : '已恢复上课'); }
                      onDataChange(); load();
                    } catch (e) { notify(e.message); }
                  }}>✅ 恢复上课（取消停课，内容回原位）</button>
              );
            }
            if (!c || c.temp || !ct) return null;
            return (
              <button className="ctx-item"
                title="运动会/考试等临时停课：标记停课并自动顺延（内容后移一位），取消时自动恢复原位"
                onClick={async () => {
                  setCtx(null);
                  try {
                    const r = await api.addSuspension(semester.id, { class_id: c.class_id, week, weekday: ctx.weekday, period: ctx.period });
                    notify(r.deferred ? '已停课：本节课空出，该班后续内容自动顺延' : '已标记停课');
                    onDataChange(); load();
                  } catch (e) { notify(e.message); }
                }}>🚫 标记停课（自动顺延）</button>
            );
          })()}
          {cellsByKey.get(cellKey(ctx.weekday, ctx.period)) && !cellsByKey.get(cellKey(ctx.weekday, ctx.period)).temp && contentFor(cellsByKey.get(cellKey(ctx.weekday, ctx.period))) && (
            <button className="ctx-item" title="运动会/考试等当天停课：该班从本节课起的内容整体后移一位，本节课空出"
              onClick={async () => {
                const c = cellsByKey.get(cellKey(ctx.weekday, ctx.period));
                const ct = contentFor(c);
                setCtx(null);
                if (!confirm(`停课顺延：${d ? dates[ctx.weekday - 1] : ''} 初一/四班「${ct.content}」这节课当天停上，该班之后的内容依次后移一位（本节课空出，学期末补位）。确认？`)) return;
                try {
                  await api.defer(semester.id, { class_id: c.class_id, week, weekday: ctx.weekday, period: ctx.period });
                  notify('已停课顺延：本节课空出，该班后续内容整体后移（可用撤销恢复）');
                  onDataChange(); load();
                } catch (e) { notify(e.message); }
              }}>停课顺延（仅推后内容，不标记）</button>
          )}
          {cellsByKey.get(cellKey(ctx.weekday, ctx.period)) && (
            <>
              <button className="ctx-item danger" onClick={() => { deleteCell(cellsByKey.get(cellKey(ctx.weekday, ctx.period)), { whole: false }); setCtx(null); }}>删除（仅本周）</button>
              {!cellsByKey.get(cellKey(ctx.weekday, ctx.period)).temp && (
                <button className="ctx-item danger" onClick={() => { deleteCell(cellsByKey.get(cellKey(ctx.weekday, ctx.period)), { whole: true }); setCtx(null); }}>删除固定排课（整学期）</button>
              )}
            </>
          )}
        </div>
      )}

      {editCell && (
        <CellEditor
          boot={boot} semester={semester} week={week} cell={editCell.cell} content={editCell.content}
          weekday={editCell.weekday} period={editCell.period}
          classById={classById}
          onClose={() => setEditCell(null)}
          onSaved={async () => { onDataChange(); load(); }}
          notify={notify}
        />
      )}

      {editDay && (
        <DayManager
          boot={boot} semester={semester} week={week} date={editDay.date} holiday={editDay.holiday} weekday={editDay.weekday}
          events={(data?.events || []).filter((e) => e.date === editDay.date)}
          dayCourses={WEEKDAYS.length ? PERIODS.map((p) => {
            const c = cellsByKey.get(cellKey(editDay.weekday || 1, p));
            if (!c) return null;
            return { cell: c, content: contentFor(c), cls: classById.get(c.class_id) };
          }).filter(Boolean) : []}
          onClose={() => setEditDay(null)}
          onSaved={async () => { onDataChange(); load(); }}
          onEditCourse={(p) => { const c = cellsByKey.get(cellKey(editDay.weekday || 1, p)); setEditDay(null); setEditCell({ weekday: editDay.weekday || 1, period: p, cell: c, content: c ? contentFor(c) : null, date: editDay.date, holiday: editDay.holiday }); }}
          notify={notify}
        />
      )}

      {showClasses && (
        <ClassManager boot={boot} onClose={() => setShowClasses(false)} onSaved={onDataChange} notify={notify} />
      )}

      {/** 课程内容快照 UI 已移到授课内容管理面板中 */}

      {showContent && (
        <ContentManager
          boot={boot} semester={semester}
          onClose={() => setShowContent(false)}
          onSaved={async () => { onDataChange(); load(); }}
          notify={notify}
        />
      )}
    </div>
  );
}

// 全天任务编辑（节假日/周末）：一整天为单位安排自己的任务，不按上下课节次划分
// 当日安排管理（任意日期通用：工作日/周末/假期/寒暑假）
// 个人事务（批改作业/写教案/备课/看电影等）按天管理；同时展示当天课程，可跳转编辑
export function DayManager({ boot, semester, week, date, holiday, weekday, events, dayCourses, onClose, onSaved, onEditCourse, notify }) {
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [err, setErr] = useState('');
  const wd = weekday || 1;
  const WD_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  const add = async () => {
    if (!title.trim()) { setErr('请填写事务内容'); return; }
    try {
      await api.addEvent(semester.id, {
        type: 'activity', title: title.trim(), date, time: time.trim() || '', // time 留空 = 全天
        location: '', participants: '', notes: '', requirements: '', color: holiday ? '#C97B84' : '#7FB069', done: false,
      });
      setTitle(''); setTime(''); setErr('');
      notify('已添加事务'); onSaved();
    } catch (e) { setErr(e.message); }
  };

  const toggle = async (ev) => {
    try { await api.updateEvent(semester.id, ev.id, { done: !ev.done }); onSaved(); } catch (e) { notify(e.message); }
  };

  const remove = async (ev) => {
    if (!confirm(`删除「${ev.title}」？`)) return;
    try { await api.delEvent(semester.id, ev.id); onSaved(); } catch (e) { notify(e.message); }
  };

  return (
    <Modal title={`${WD_CN[wd - 1]} ${date.slice(5).replace('-', '.')} · 当日安排${holiday ? `（${holiday.name}）` : ''}`} onClose={onClose} width={560}>
      <div className="form">
        {holiday && <div className="tips">🎉 {holiday.name}，当天不上课——按一整天安排你自己的事务。</div>}
        {/* 当天课程（只读概览 + 点击编辑） */}
        {dayCourses.length > 0 && (
          <div className="content-block">
            <div className="content-block-title">📚 当天课程（{dayCourses.length} 节）</div>
            <div className="day-plan-list">
              {dayCourses.map(({ cell, content, cls }) => (
                <div key={cell.key} className="day-plan-item">
                  <span className="mc-period">P{cell.key.split('-')[1]}</span>
                  <span className="day-plan-title" style={{ color: cls?.color }}>
                    {cls ? cls.name : '（班级）'}: {content ? content.content : '（未填写内容）'}
                  </span>
                  {cell.temp && <span className="temp-tag">临时</span>}
                  <button className="btn ghost sm" onClick={() => onEditCourse && onEditCourse(cell.key.split('-')[1] * 1)}>编辑</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {dayCourses.length === 0 && (
          <div className="tips">当天没有排课（周末/假期/寒暑假）——可自由安排个人事务。</div>
        )}
        {/* 个人事务 */}
        <div className="content-block">
          <div className="content-block-title">📝 个人事务 / 工作事务</div>
          <div className="day-plan-list">
            {events.length === 0 && <div className="todos-empty">当天还没有事务，添加一条吧（如：批改作业、写教案、备课、听课、看电影、跳舞）</div>}
            {events.map((ev) => (
              <div key={ev.id} className={`day-plan-item ${ev.done ? 'done' : ''}`}>
                <span className="todo-check" onClick={() => toggle(ev)} title="点击切换完成状态">{ev.done ? '✅' : '○'}</span>
                <span className="day-plan-title" onClick={() => toggle(ev)}>{ev.title}</span>
                {ev.time && <span className="day-plan-time">{ev.time}</span>}
                <button className="btn ghost sm" onClick={() => remove(ev)}>删</button>
              </div>
            ))}
          </div>
          <div className="row">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="事务内容（如：批改作业 / 备课 / 看电影）"
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
            <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="时间（选填）" style={{ width: 130 }} />
            <button className="btn primary" onClick={add}>＋ 添加</button>
          </div>
        </div>
        {err && <div className="error">{err}</div>}
      </div>
    </Modal>
  );
}

// 单元格编辑：新增/修改/替换顺延/临时调课/删除
function CellEditor({ boot, semester, week, cell, content, weekday, period, classById, onClose, onSaved, notify }) {
  const [classId, setClassId] = useState(cell?.class_id || '');
  const [text, setText] = useState(content?.content || '');
  const [stage, setStage] = useState('middle');
  const [tempMode, setTempMode] = useState(false);
  const [tempWeekday, setTempWeekday] = useState(weekday);
  const [tempPeriod, setTempPeriod] = useState(period);
  const [tempNote, setTempNote] = useState('');
  // week 模式（D3 扩展）：'every'=每周复用 / 'odd'=单周 / 'even'=双周 / 'no'=仅指定周 / 'list'=周数组（导入数据）
  const [weekMode, setWeekMode] = useState(() => {
    const w = cell && !cell.temp ? cell.week : undefined;
    if (!w) return 'every';
    if (w === 'odd' || w === 'even') return w;
    if (Array.isArray(w)) return 'list';
    return 'no';
  });
  const [weekNo, setWeekNo] = useState(() => {
    const w = cell && !cell.temp ? cell.week : undefined;
    return Array.isArray(w) ? w : (Number.isInteger(w) ? w : 1);
  });
  const [err, setErr] = useState('');

  const classes = useMemo(() => (boot.classes || []).filter((c) => c.stage === stage), [boot, stage]);

  // 统一课程序列（与「授课内容管理」一致：按该班学段取 middle/primary 序列，可直接点选）
  const [seq, setSeq] = useState([]);
  useEffect(() => {
    let alive = true;
    if (!classId) { setSeq([]); return undefined; }
    const cls = (boot.classes || []).find((c) => c.id === classId);
    const st = cls && cls.stage === 'primary' ? 'primary' : 'middle';
    api.getSequence(semester.id, st)
      .then((d) => { if (alive) setSeq((d.items || []).map((i) => i.content)); })
      .catch(() => { if (alive) setSeq([]); });
    return () => { alive = false; };
  }, [classId, semester.id, boot.classes]);

  const save = async () => {
    try {
      if (!classId) { setErr('请选择授课班级'); return; }
      if (cell?.temp) {
        await api.delTempChange(semester.id, cell.temp_id); // 替换临时调课
      }
      // 固定排课：已有则复用；没有则新建（支持单双周/指定周/周数组）
      const fixedWeek = weekMode === 'every' ? undefined : (weekMode === 'odd' || weekMode === 'even' ? weekMode : weekNo);
      let fixedId = cell && !cell.temp ? cell.fixed_id : null;
      if (!fixedId) {
        const r = await api.addFixedCourse(semester.id, { class_id: classId, weekday, period, week: fixedWeek });
        fixedId = r.fixed_course.id;
      } else if (cell && !cell.temp && cell.week !== fixedWeek) {
        // 修改生效周（含数组）→ 更新固定排课
        await api.updateFixedCourse(semester.id, cell.fixed_id, { week: fixedWeek });
      }
      const newText = text.trim();
      if (content && newText && content.content !== newText) {
        // 顺延替换：新内容替换当前位置，原内容自动顺延至下一课时位
        const r = await api.shift(semester.id, { class_id: classId, week, weekday, period, new_content: newText });
        notify('已保存：原内容自动顺延至下一课时位');
        onSaved(); onClose();
        return;
      }
      const body = { class_id: classId, week, weekday, period, content: text || '（未填写内容）', source: 'custom' };
      if (content) await api.updateContent(semester.id, content.id, body);
      else await api.addContent(semester.id, body);
      if (tempMode && !cell?.temp) {
        await api.addTempChange(semester.id, {
          class_id: classId, week, origin_weekday: weekday, origin_period: period,
          new_weekday: tempWeekday, new_period: tempPeriod, note: tempNote || '调课',
        });
        // 注意：不删除原固定课内容——R4 语义"被覆盖的固定课程当周不显示但数据不动"，
        // 展示层由引擎 mergeWeekView 处理（suppressed），数据保留以便撤销/下周恢复
      }
      notify('已保存');
      onSaved(); onClose();
    } catch (e) { setErr(e.message); }
  };

  const doShift = async () => {
    try {
      if (!content) { setErr('该课时位暂无内容可替换'); return; }
      if (!text.trim()) { setErr('请输入替换内容'); return; }
      const r = await api.shift(semester.id, { class_id: classId, week, weekday, period, new_content: text.trim() });
      notify(`已保存：原内容自动顺延至下一课时位`);
      onSaved(); onClose();
    } catch (e) { setErr(e.message); }
  };

  return (
    <Modal title={`周${weekday} 第${period}节 · ${cell ? '编辑课时' : '新增课时'}`} onClose={onClose} width={520}>
      <div className="form">
        <label>授课班级（下拉选择，自动匹配配色）</label>
        <div className="row">
          <select className="stage-tabs" value={stage} onChange={(e) => { setStage(e.target.value); setClassId(''); }}>
            <option value="middle">初中</option>
            <option value="primary">小学</option>
          </select>
          <select value={classId} onChange={(e) => setClassId(e.target.value)} disabled={cell?.temp}>
            <option value="">选择班级…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}（{c.color}）</option>
            ))}
          </select>
        </div>
        <label>授课内容（统一课程序列点选 / 预设词库 / 自定义）</label>
        {(() => {
          // 下拉 = 课程序列（该班学段，第 N 条 = 授课内容管理里的第 N 条）+ 预设词库 + 自定义
          const presetTexts = (boot.presets || []).map((p) => p.text).filter((t) => !seq.includes(t));
          const pick = seq.includes(text) ? `seq:${text}` : (presetTexts.includes(text) ? `p:${text}` : 'custom');
          return (
            <React.Fragment>
              <select
                value={pick}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'custom') return; // 保留当前 text，下方输入框继续编辑
                  setText(v.startsWith('seq:') ? v.slice(4) : v.slice(2));
                }}
              >
                <option value="custom">✍️ 自定义输入…</option>
                {seq.map((s, i) => <option key={`s-${i}`} value={`seq:${s}`}>序列第 {i + 1} 条 · {s}</option>)}
                {presetTexts.map((t, i) => <option key={`p-${i}`} value={`p:${t}`}>预设 · {t}</option>)}
              </select>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={classId ? '直接输入本节课内容（保存后原内容自动顺延至下一课时位）' : '先选择授课班级，可点选统一课程序列'}
              />
            </React.Fragment>
          );
        })()}
        {err && <div className="error">{err}</div>}
        <div className="row tips">
          <label className="check"><input type="checkbox" checked={tempMode} onChange={(e) => setTempMode(e.target.checked)} disabled={!cell} /> 临时调课（仅当周生效）</label>
          {content && <span className="tips">✏️ 修改内容后原内容将自动顺延至该班下一课时位</span>}
        </div>
        {!tempMode && (
          <div className="row">
            <label className="tips">生效周：</label>
            <select value={weekMode} onChange={(e) => setWeekMode(e.target.value)}>
              <option value="every">每周</option>
              <option value="odd">仅单周</option>
              <option value="even">仅双周</option>
              <option value="no">仅指定周</option>
              {weekMode === 'list' && <option value="list">多周（导入）</option>}
            </select>
            {weekMode === 'no' && (
              <input type="number" min={1} max={99} value={typeof weekNo === 'number' ? weekNo : 1} onChange={(e) => setWeekNo(+e.target.value)} style={{ width: 70 }} />
            )}
            {weekMode === 'list' && (
              <span className="tips">{Array.isArray(weekNo) ? `第 ${weekNo.join('、')} 周（来自旧课表导入，保存后保留）` : '多周'}</span>
            )}
          </div>
        )}
        {tempMode && (
          <div className="row">
            <select value={tempWeekday} onChange={(e) => setTempWeekday(+e.target.value)}>
              {[1, 2, 3, 4, 5, 6, 7].map((w) => <option key={w} value={w}>{WEEKDAY_CN[w - 1]}</option>)}
            </select>
            <select value={tempPeriod} onChange={(e) => setTempPeriod(+e.target.value)}>
              {PERIODS.map((p) => <option key={p} value={p}>第{p}节</option>)}
            </select>
            <input value={tempNote} onChange={(e) => setTempNote(e.target.value)} placeholder="备注（如：国庆调休）" />
          </div>
        )}
      </div>
      <div className="modal-foot">
        {cell && (
          <button className="btn danger" onClick={async () => {
            try {
              if (cell.temp) await api.delTempChange(semester.id, cell.temp_id);
              else { await api.delFixedCourse(semester.id, cell.fixed_id); if (content) await api.delContent(semester.id, content.id); }
              notify('已删除'); onSaved(); onClose();
            } catch (e) { setErr(e.message); }
          }}>删除</button>
        )}
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save}>保存</button>
      </div>
    </Modal>
  );
}

// 班级预设库（F5：小学/初中双库、自定义名称+配色、自由增删改）
// 分色系（初中=莫兰迪，小学=马卡龙）：同色系内颜色不重复，跨学段天然区分
function ClassManager({ boot, onClose, onSaved, notify }) {
  const [stage, setStage] = useState('middle');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const list = (boot.classes || []).filter((c) => c.stage === stage);
  const palette = (boot.class_palettes || {})[stage] || [];
  const usedColors = new Set(list.map((c) => c.color.toLowerCase()));
  // 新增默认色：自动选该学段色板中第一个未使用的颜色
  const defaultColor = palette.find((p) => !usedColors.has(p.color.toLowerCase()))?.color || (palette[0]?.color || '#4A90D9');
  const [color, setColor] = useState(defaultColor);

  const stageLabel = stage === 'middle' ? '初中（莫兰迪色系）' : '小学（马卡龙色系）';

  const add = async () => {
    try {
      await api.createClass({ name, stage, color });
      setName(''); setColor(defaultColor); notify('班级已创建'); onSaved();
    } catch (e) { setErr(e.message); }
  };

  return (
    <Modal title="班级预设库管理" onClose={onClose} width={620}>
      <div className="row">
        <select className="stage-tabs" value={stage} onChange={(e) => { setStage(e.target.value); setColor(defaultColor); }}>
          <option value="middle">初中班级库</option>
          <option value="primary">小学班级库</option>
        </select>
        <span className="tips">{stageLabel}：同色系内颜色不重复，跨学段自动分色系</span>
      </div>
      <table className="table">
        <thead><tr><th>班级名称</th><th>专属配色</th><th>操作</th></tr></thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td><span className="color-dot" style={{ background: c.color }} /> <span className="color-label">{c.color}</span></td>
              <td>
                <button className="btn ghost sm" onClick={async () => {
                  const nc = prompt('修改班级名称：', c.name);
                  if (nc && nc !== c.name) { try { await api.updateClass(c.id, { name: nc }); notify('已更新'); onSaved(); } catch (e) { notify(e.message); } }
                }}>改名</button>
                <select className="palette-select" value={c.color} title="改配色（同色系内不可重复）"
                  onChange={async (e) => { try { await api.updateClass(c.id, { color: e.target.value }); onSaved(); } catch (err) { notify(err.message); } }}>
                  {palette.map((p) => (
                    <option key={p.color} value={p.color} disabled={usedColors.has(p.color.toLowerCase()) && c.color.toLowerCase() !== p.color.toLowerCase()}>
                      {p.label} {p.color}
                    </option>
                  ))}
                </select>
                <button className="btn danger sm" onClick={async () => {
                  if (!confirm(`删除班级「${c.name}」？`)) return;
                  try { await api.deleteClass(c.id); notify('已删除'); onSaved(); } catch (e) { notify(e.message); }
                }}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="class-palette">
        <span className="tips">选择配色：</span>
        {palette.map((p) => {
          const used = usedColors.has(p.color.toLowerCase());
          const active = color.toLowerCase() === p.color.toLowerCase();
          return (
            <button key={p.color} type="button"
              className={`palette-swatch ${active ? 'active' : ''} ${used ? 'used' : ''}`}
              style={{ background: p.color }}
              title={`${p.label} ${used ? '（已被使用）' : ''}`}
              onClick={() => { if (!used) { setColor(p.color); setErr(''); } }}
            >
              {active ? '✓' : ''}
            </button>
          );
        })}
      </div>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新班级名称（如：七（1）班 / 启航班）" />
        <button className="btn primary" onClick={add} disabled={!name}>＋ 新增班级</button>
      </div>
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}

// 批量添加授课内容（G4/I1）：CSV 粘贴（班级名,周,星期,节次,内容），班级名自动映射，已有课时位覆盖更新
// 授课内容管理：统一课程序列（一键预填/选择框模式）+ 班级内容序列视图（预填/追加）
function ContentManager({ boot, semester, onClose, onSaved, notify }) {
  const [stage, setStage] = useState('middle');
  const [classId, setClassId] = useState('');
  const [seq, setSeq] = useState(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  // 统一课程序列（按学段分开：初中序列 / 小学序列）
  const [seqStage, setSeqStage] = useState('middle');
  const [seqText, setSeqText] = useState('');
  const [seqLoaded, setSeqLoaded] = useState(false);
  const [seqResult, setSeqResult] = useState(null);
  const [showPicker, setShowPicker] = useState(false);

  const classes = (boot.classes || []).filter((c) => c.stage === stage);
  const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // 加载统一课程序列（按学段）
  useEffect(() => {
    if (seqLoaded) return;
    (async () => {
      try {
        const d = await api.getSequence(semester.id, 'middle');
        setSeqText((d.items || []).map((i) => i.content).join('\n'));
      } catch { /* 首次无序列 */ }
      setSeqLoaded(true);
    })();
  }, [semester.id, seqLoaded]);

  const switchSeqStage = async (st) => {
    setSeqStage(st);
    try {
      const d = await api.getSequence(semester.id, st);
      setSeqText((d.items || []).map((i) => i.content).join('\n'));
    } catch { setSeqText(''); }
  };

  const loadSeq = async (cid) => {
    try {
      const d = await api.contentSeq(semester.id, cid);
      setSeq(d);
      setErr('');
    } catch (e) { setErr(e.message); setSeq(null); }
  };

  const pickClass = (cid) => {
    setClassId(cid);
    setResult(null);
    if (cid) loadSeq(cid);
  };

  const saveSeq = async () => {
    const items = seqText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (items.length === 0) { setErr('序列不能为空'); return; }
    try {
      await api.saveSequence(semester.id, seqStage, items);
      setErr('');
      notify(`统一课程序列已保存（${items.length} 条）`);
      onSaved();
    } catch (e) { setErr(e.message); }
  };

  const applyAll = async () => {
    try {
      const items = seqText.split('\n').map((l) => l.trim()).filter(Boolean);
      if (items.length === 0) { setErr('序列为空，请先在文本框输入课程内容'); return; }
      // 先保存当前文本框内容到序列，再以显式 contents 传递，确保应用的是用户当前看到的
      await api.saveSequence(semester.id, seqStage, items);
      const r = await api.applySequence(semester.id, { contents: items });
      const total = (r.report || []).reduce((a, b) => a + (b.assigned || 0), 0);
      setSeqResult(r);
      notify(`一键预填完成：共填入 ${total} 条（各班第 N 课时 = 序列第 N 条）`);
      onSaved();
    } catch (e) { setErr(e.message); }
  };

  return (
    <Modal title="授课内容管理" onClose={onClose} width={820}>
      <div className="form">
        {/* ===== 区块一：统一课程序列（5 个班共用）===== */}
        <div className="content-block">
          <div className="content-block-title">① 统一课程序列（同班序内容一致：各班第 N 节课 = 序列第 N 条）</div>
          <div className="row">
            <select className="stage-tabs" value={seqStage} onChange={(e) => switchSeqStage(e.target.value)}>
              <option value="middle">初中序列</option>
              <option value="primary">小学序列</option>
            </select>
            <span className="tips">{seqStage === 'middle' ? '初一 5 个班共用' : '四年级 3 个班共用'}</span>
          </div>
          <textarea rows={6} value={seqText} onChange={(e) => setSeqText(e.target.value)} className="csv-area" placeholder={'第一课·中学时代\n少年有梦\n学习伴成长\n享受学习\n认识自己'} />
          <div className="row">
            <button className="btn ghost sm" onClick={() => setSeqText('第一课·中学时代\n少年有梦\n学习伴成长\n享受学习\n认识自己\n和朋友在一起')}>填入示例</button>
            <button className="btn ghost sm" onClick={saveSeq}>保存序列</button>
            <button className="btn primary sm" onClick={applyAll}>⚡ 一键预填到全部班（覆盖式对齐）</button>
            <button className="btn ghost sm" onClick={() => setShowPicker(true)}>☑ 选择框模式（勾选课程填入）</button>
          </div>
          {seqResult && (
            <div className="import-result">
              <div>一键预填结果：</div>
              <ul>
                {(seqResult.report || []).map((r, i) => {
                  const c = classes.concat(boot.classes.filter((x) => x.stage !== stage)).find((x) => x.id === r.class_id);
                  return <li key={i}>{c ? c.name : r.class_id}：填入 {r.assigned} 条{r.note ? `（${r.note}）` : ''}</li>;
                })}
              </ul>
            </div>
          )}
          <div className="tips">各班第 N 节课内容完全一致（仅时间不同）；覆盖仅作用于序列长度内的课时位，序列外的临时课不受影响。临时课直接在周视图对应课时上创建。</div>
        </div>

        {/* ===== 区块二：班级内容序列（单班查看/追加）===== */}
        <div className="content-block">
          <div className="content-block-title">② 班级内容序列（查看 / 单班追加）</div>
          <div className="row">
            <select className="stage-tabs" value={stage} onChange={(e) => { setStage(e.target.value); pickClass(''); }}>
              <option value="middle">初中</option>
              <option value="primary">小学</option>
            </select>
            <select value={classId} onChange={(e) => pickClass(e.target.value)}>
              <option value="">选择班级…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {seq && (
              <span className="tips">
                已填 {seq.occupied}/{seq.total_slots} 条
                {seq.next_free ? ` ｜ 下一课时位：第 ${seq.next_free.week} 周 ${WD[seq.next_free.weekday]} 第 ${seq.next_free.period} 节` : ' ｜ 该班课时位已满'}
              </span>
            )}
          </div>
          {seq && (
            <div className="content-seq">
              <div className="content-seq-list">
                {seq.seq.map((s, i) => (
                  <div key={i} className={`content-seq-item ${s.content ? 'filled' : 'empty'}`}>
                    <span className="seq-slot">第{s.week}周 {WD[s.weekday]} 第{s.period}节</span>
                    <span className="seq-content">{s.content || '（空）'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <label>单班追加内容（每行一条，接到该班下一空闲课时位）</label>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className="csv-area" placeholder={'复习课\n单元小结'} />
          <div className="row">
            <button className="btn primary sm" disabled={!classId} onClick={async () => {
              const list = text.split('\n').map((l) => l.trim()).filter(Boolean);
              if (list.length === 0) { setErr('请输入至少一行内容'); return; }
              try {
                const r = await api.prefillContent(semester.id, classId, list);
                setResult(r);
                setText('');
                await loadSeq(classId);
                onSaved();
                notify(`已追加 ${r.assigned} 条${r.overflow ? `，溢出 ${r.overflow} 条` : ''}`);
              } catch (e) { setErr(e.message); }
            }}>追加到该班</button>
          </div>
          {result && (
            <div className="import-result">
              <div>✅ 已分配 {result.assigned} 条{result.overflow ? ` · ⚠️ 溢出 ${result.overflow} 条` : ''}{result.full ? ' · 课时位已满' : ''}</div>
            </div>
          )}
        </div>

        {/* ===== 区块三：课程内容快照（版本保护）===== */}
        <div className="content-block">
          <div className="content-block-title">③ 课程内容快照（创建后可随时恢复到该版本）</div>
          <div className="row">
            <button className="btn ghost sm" onClick={async () => {
              try {
                const r = await api.post(`/${semester.id}/snapshot`);
                notify(`快照已创建（${r.total} 条内容）`);
              } catch (e) { notify(e.message); }
            }}>📸 创建快照</button>
            <button className="btn ghost sm" onClick={async () => {
              if (!confirm('确认恢复到上一个快照？当前未保存的修改将丢失。')) return;
              try {
                const r = await api.post(`/${semester.id}/snapshot/restore`);
                notify(`已恢复快照（${r.restored} 条内容）`);
                onSaved();
              } catch (e) { notify(e.message); }
            }}>↩️ 恢复快照</button>
            <span className="tips">仅保留最近 2 个版本（当前→上一个）</span>
          </div>
        </div>
        {err && <div className="error">{err}</div>}
      </div>

      {showPicker && (
        <SequencePicker
          boot={boot} semester={semester} seqText={seqText}
          onClose={() => setShowPicker(false)}
          onDone={async () => { onSaved(); }}
          notify={notify}
        />
      )}
    </Modal>
  );
}

// 选择框模式：列出所有可能要学的课（预设词库 + 课程序列），勾选后填入目标班（默认全部）
function SequencePicker({ boot, semester, seqText, onClose, onDone, notify }) {
  const [picked, setPicked] = useState(new Set());
  const [target, setTarget] = useState('all');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  const candidates = [];
  for (const p of boot.presets || []) candidates.push({ key: 'p-' + p.id, text: p.text, src: '预设词库' });
  for (const s of (seqText || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (!candidates.some((c) => c.text === s)) candidates.push({ key: 's-' + s, text: s, src: '课程序列' });
  }

  const toggle = (key) => {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const doApply = async () => {
    const contents = candidates.filter((c) => picked.has(c.key)).map((c) => c.text);
    if (contents.length === 0) { setErr('请至少勾选一门课'); return; }
    try {
      const r = await api.applySequence(semester.id, { contents, class_ids: target === 'all' ? [] : [target] });
      const total = (r.report || []).reduce((a, b) => a + (b.assigned || 0), 0);
      setResult({ total, report: r.report });
      notify(`已按勾选顺序填入 ${total} 条`);
      onDone();
    } catch (e) { setErr(e.message); }
  };

  return (
    <Modal title="选择框模式：勾选课程填入" onClose={onClose} width={620}>
      <div className="form">
        <div className="row">
          <span className="tips">目标班级：</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="all">全部班级</option>
            {(boot.classes || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="tips">已选 {picked.size} 门，按勾选顺序填入空课时位</span>
        </div>
        <div className="picker-list">
          {candidates.map((c) => (
            <label key={c.key} className="check picker-item">
              <input type="checkbox" checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
              <span>{c.text}</span>
              <span className="picker-src">{c.src}</span>
            </label>
          ))}
        </div>
        <div className="row">
          <button className="btn ghost sm" onClick={() => setPicked(new Set())}>清空选择</button>
          <button className="btn primary sm" onClick={doApply}>按勾选顺序填入</button>
        </div>
        {result && (
          <div className="import-result">
            <div>✅ 共填入 {result.total} 条</div>
            <ul>{(result.report || []).map((r, i) => <li key={i}>{r.class_id}：{r.assigned} 条</li>)}</ul>
          </div>
        )}
        {err && <div className="error">{err}</div>}
      </div>
    </Modal>
  );
}
