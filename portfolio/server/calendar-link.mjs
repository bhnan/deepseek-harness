// 学生成长档案工作台 —— 教学日历联动客户端（03 文档 §13.4 固定契约）
// 唯一出站联动：沟通安排 → 日历事件（type=activity，单向）
import { getSetting } from './storage.mjs';

export const COM_TYPE_LABEL = { talk: '谈心', home_visit: '家访', parent_meet: '家长约谈', chat: '私聊安排' };

/** 拉取教学日历学期列表 */
export async function fetchSemesters(base) {
  const r = await fetch(`${base}/api/calendar/bootstrap`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`教学日历响应异常（HTTP ${r.status}）`);
  const d = await r.json();
  return (d.semesters || []).map((s) => ({ id: s.id, start_date: s.start_date, end_date: s.end_date }));
}

/** 按日期匹配学期；无命中 → 兜底学期；仍无 → null */
export function matchSemester(semesters, date, fallbackId) {
  const hit = semesters.find((s) => s.start_date <= date && s.end_date >= date);
  if (hit) return hit.id;
  if (fallbackId) return fallbackId;
  return null;
}

/**
 * 同步沟通安排为日历事件
 * @returns { ok, calendar_event_id, calendar_semester_id, error? }
 */
export async function syncCommunicationToCalendar({ type, title, date, time, location, note, participants }) {
  const base = getSetting('calendar_api_base', 'http://127.0.0.1:8787');
  const enabled = getSetting('calendar_link_enabled', true);
  if (!enabled) return { ok: false, skipped: true, error: '联动已关闭' };
  const label = COM_TYPE_LABEL[type] || type;
  let semesters;
  try {
    semesters = await fetchSemesters(base);
  } catch (e) {
    return { ok: false, error: `无法连接教学日历（${e.message}）` };
  }
  const sid = matchSemester(semesters, date, getSetting('calendar_semester_id', ''));
  if (!sid) return { ok: false, error: '无法确定目标学期（日期不匹配且无兜底学期）' };
  const payload = {
    type: 'activity',
    title: title || `💬 ${label} · ${participants || ''}`,
    date,
    time: time || '',
    location: location || '',
    participants: participants || '',
    notes: `【成长档案】${label}：${note || ''}`,
    requirements: '',
    color: '#C97B84',
  };
  try {
    const r = await fetch(`${base}/api/calendar/${sid}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: `教学日历拒绝（HTTP ${r.status}）：${t.slice(0, 120)}` };
    }
    const d = await r.json();
    if (!d.ok || !d.event || !d.event.id) return { ok: false, error: '教学日历响应缺少 event.id' };
    return { ok: true, calendar_event_id: d.event.id, calendar_semester_id: sid };
  } catch (e) {
    return { ok: false, error: `同步请求失败（${e.message}）` };
  }
}

/** 删除已同步的日历事件（失败返回错误文本，不抛出） */
export async function deleteCalendarEvent(calendarEventId, semesterId) {
  const base = getSetting('calendar_api_base', 'http://127.0.0.1:8787');
  if (!calendarEventId || !semesterId) return null;
  try {
    const r = await fetch(`${base}/api/calendar/${semesterId}/events/${calendarEventId}`, { method: 'DELETE', signal: AbortSignal.timeout(4000) });
    if (!r.ok) return `删除日历事件失败（HTTP ${r.status}）`;
    return null;
  } catch (e) {
    return `删除日历事件失败（${e.message}）`;
  }
}
