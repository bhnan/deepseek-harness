// API 封装（前端唯一数据通道；未来迁移 DSH host 路由时仅改 base）
const BASE = 'api/calendar';

async function req(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({ ok: false, reason: '响应解析失败' }));
  if (!r.ok || !data.ok) throw new Error(data.reason || `HTTP ${r.status}`);
  return data;
}

export const api = {
  post: (path, body) => req('POST', path, body),
  get: (path) => req('GET', path),

  bootstrap: () => req('GET', '/bootstrap'),
  saveSettings: (patch) => req('PUT', '/settings', patch),

  semesters: () => req('GET', '/semesters'),
  createSemester: (body) => req('POST', '/semesters', body),
  updateSemester: (id, body) => req('PUT', `/semesters/${id}`, body),
  deleteSemester: (id) => req('DELETE', `/semesters/${id}`),

  classes: () => req('GET', '/classes'),
  createClass: (body) => req('POST', '/classes', body),
  updateClass: (id, body) => req('PUT', `/classes/${id}`, body),
  deleteClass: (id) => req('DELETE', `/classes/${id}`),

  schedule: (sid) => req('GET', `/${sid}/schedule`),
  addFixedCourse: (sid, body) => req('POST', `/${sid}/fixed-courses`, body),
  updateFixedCourse: (sid, cid, body) => req('PUT', `/${sid}/fixed-courses/${cid}`, body),
  delFixedCourse: (sid, cid) => req('DELETE', `/${sid}/fixed-courses/${cid}`),
  addTempChange: (sid, body) => req('POST', `/${sid}/temp-changes`, body),
  delTempChange: (sid, tid) => req('DELETE', `/${sid}/temp-changes/${tid}`),
  addSuspension: (sid, body) => req('POST', `/${sid}/suspensions`, body),
  delSuspension: (sid, id) => req('DELETE', `/${sid}/suspensions/${id}`),

  teachingContent: (sid) => req('GET', `/${sid}/teaching-content`),
  addContent: (sid, body) => req('POST', `/${sid}/teaching-content`, body),
  updateContent: (sid, tid, body) => req('PUT', `/${sid}/teaching-content/${tid}`, body),
  delContent: (sid, tid) => req('DELETE', `/${sid}/teaching-content/${tid}`),
  batchContent: (sid, rows) => req('POST', `/${sid}/teaching-content/batch`, { rows }),
  contentSeq: (sid, classId) => req('GET', `/${sid}/content-seq?class_id=${classId}`),
  prefillContent: (sid, classId, contents) => req('POST', `/${sid}/content-seq/prefill`, { class_id: classId, contents }),
  shift: (sid, body) => req('POST', `/${sid}/shift`, body),
  defer: (sid, body) => req('POST', `/${sid}/defer`, body),
  undefer: (sid, body) => req('POST', `/${sid}/undefer`, body),
  getSequence: (sid, stage) => req('GET', `/${sid}/sequence?stage=${stage || ''}`),
  saveSequence: (sid, stage, items) => req('PUT', `/${sid}/sequence?stage=${stage || 'middle'}`, { items }),
  applySequence: (sid, body) => req('POST', `/${sid}/sequence/apply`, body),
  swapContent: (sid, from, to) => req('POST', `/${sid}/content/swap`, { from, to }),

  events: (sid) => req('GET', `/${sid}/events`),
  addEvent: (sid, body) => req('POST', `/${sid}/events`, body),
  updateEvent: (sid, eid, body) => req('PUT', `/${sid}/events/${eid}`, body),
  delEvent: (sid, eid) => req('DELETE', `/${sid}/events/${eid}`),
  addBirthday: (sid, body) => req('POST', `/${sid}/birthdays`, body),
  importBirthdays: (sid, rows) => req('POST', `/${sid}/birthdays/import`, { rows }),
  delBirthday: (sid, bid) => req('DELETE', `/${sid}/birthdays/${bid}`),

  periods: (sid) => req('GET', `/${sid}/periods`),
  savePeriods: (sid, periods) => req('PUT', `/${sid}/periods`, { periods }),
  makeupDays: (sid) => req('GET', `/${sid}/makeup-days`),
  saveMakeupDays: (sid, days) => req('PUT', `/${sid}/makeup-days`, { makeup_days: days }),
  syncPortfolioClasses: () => req('POST', '/classes/sync-portfolio'),

  weekView: (sid, week) => req('GET', `/${sid}/week-view?week=${week}`),
  fullView: (sid) => req('GET', `/${sid}/full-view`),
  todos: (sid, date) => req('GET', `/${sid}/todos?date=${date}`),
  pushToday: (sid) => req('GET', `/${sid}/push/today`),
  pushRefresh: (sid) => req('POST', `/${sid}/push/refresh`),
  toggleDone: (sid, kind, id, date, done) => {
    if (kind === 'course') return req('PUT', `/${sid}/fixed-courses/${id}`, { done_dates_append: date });
    if (kind === 'temp') return req('PUT', `/${sid}/temp-changes/${id}`, { done: !!done });
    return Promise.reject(new Error('未知类型'));
  },

  undo: (sid) => req('POST', '/undo', { current_semester_id: sid }),
  redo: (sid) => req('POST', '/redo', { current_semester_id: sid }),
};
