// 学生成长档案工作台 —— API 客户端（与 03 接口文档一一对应）
const BASE = 'api/portfolio';

async function req(method, p, body, isForm = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const r = await fetch(`${BASE}${p}`, opts);
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const d = await r.json();
    if (!d.ok) throw new Error(d.reason || `HTTP ${r.status}`);
    return d;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r; // 文件/CSV/zip 等
}

export const api = {
  // 设置
  getSettings: () => req('GET', '/settings'),
  putSettings: (patch) => req('PUT', '/settings', patch),
  calendarTest: (base) => req('POST', '/calendar/test', { calendar_api_base: base }),

  // 班级
  listClasses: (params = '') => req('GET', `/classes${params}`),
  createClass: (body) => req('POST', '/classes', body),
  updateClass: (id, body) => req('PUT', `/classes/${id}`, body),
  deleteClass: (id, confirmName) => req('DELETE', `/classes/${id}`, { confirm_name: confirmName }),

  // 学生
  listStudents: (cid, params = '') => req('GET', `/classes/${cid}/students${params}`),
  createStudent: (cid, body) => req('POST', `/classes/${cid}/students`, body),
  updateStudent: (sid, body) => req('PUT', `/students/${sid}`, body),
  getStudent: (sid) => req('GET', `/students/${sid}`),
  deleteStudent: (sid) => req('DELETE', `/students/${sid}`),
  importStudents: (cid, rows) => req('POST', `/classes/${cid}/students/import`, { rows }),
  exportStudentsCsv: (cid, masked = true) => req('GET', `/classes/${cid}/students/export?masked=${masked ? 1 : 0}`),
  archiveStudent: (sid) => req('GET', `/students/export/archive/${sid}`),

  // 成绩
  listExams: (cid, type = '') => req('GET', `/classes/${cid}/exams${type ? `?type=${type}` : ''}`),
  createExam: (cid, body) => req('POST', `/classes/${cid}/exams`, body),
  updateExam: (eid, body) => req('PUT', `/exams/${eid}`, body),
  deleteExam: (eid) => req('DELETE', `/exams/${eid}`),
  batchScores: (eid, rows) => req('POST', `/exams/${eid}/scores/batch`, { rows }),
  examScores: (eid) => req('GET', `/exams/${eid}/scores`),
  studentScores: (sid) => req('GET', `/students/${sid}/scores`),
  studentAnalysis: (sid) => req('GET', `/students/${sid}/analysis`),
  classAnalysis: (cid, eid = '', cmpId = '') => req('GET', `/classes/${cid}/analysis${eid || cmpId ? `?${eid ? `exam_id=${eid}` : ''}${eid && cmpId ? '&' : ''}${cmpId ? `compare_exam_id=${cmpId}` : ''}` : ''}`),
  dfCompare: (params = '') => req('GET', `/df/compare${params}`),

  // 作业
  createAssignment: (cid, body) => req('POST', `/classes/${cid}/assignments`, body),
  listAssignments: (cid, params = '') => req('GET', `/classes/${cid}/assignments${params}`),
  updateAssignment: (aid, body) => req('PUT', `/assignments/${aid}`, body),
  deleteAssignment: (aid) => req('DELETE', `/assignments/${aid}`),
  batchHWRecords: (aid, rows) => req('POST', `/assignments/${aid}/records/batch`, { rows }),
  classHWStats: (cid, period = 'semester') => req('GET', `/classes/${cid}/assignment-stats?period=${period}`),
  studentHWStats: (sid) => req('GET', `/students/${sid}/assignment-stats`),

  // 作业台账（台账模式：表扬/未交/问题三名单，永久留存）
  createHwLedger: (cid, records) => req('POST', `/classes/${cid}/hw-ledger`, { records }),
  listHwLedger: (cid, params = '') => req('GET', `/classes/${cid}/hw-ledger${params}`),
  updateHwLedger: (id, body) => req('PUT', `/hw-ledger/${id}`, body),
  deleteHwLedger: (id) => req('DELETE', `/hw-ledger/${id}`),
  studentHwEvents: (sid) => req('GET', `/students/${sid}/hw-events`),

  // 德育
  addMoral: (sid, body) => req('POST', `/students/${sid}/moral-records`, body),
  listMoral: (sid, params = '') => req('GET', `/students/${sid}/moral-records${params}`),
  updateMoral: (rid, body) => req('PUT', `/moral-records/${rid}`, body),
  deleteMoral: (rid) => req('DELETE', `/moral-records/${rid}`),
  moralReport: (sid, semester = '') => req('GET', `/students/${sid}/moral-report${semester ? `?semester=${semester}` : ''}`),

  // 特长荣誉
  addTalent: (sid, body) => req('POST', `/students/${sid}/talents`, body),
  listTalents: (sid) => req('GET', `/students/${sid}/talents`),
  deleteTalent: (tid) => req('DELETE', `/talents/${tid}`),
  addStudentHonor: (sid, body) => req('POST', `/students/${sid}/honors`, body),
  addClassHonor: (cid, body) => req('POST', `/classes/${cid}/honors`, body),
  listHonors: (cid, params = '') => req('GET', `/classes/${cid}/honors${params}`),
  deleteHonor: (hid) => req('DELETE', `/honors/${hid}`),

  // 素材
  uploadMaterial: (formData) => req('POST', '/materials', formData, true),
  listMaterials: (params = '') => req('GET', `/materials${params}`),
  materialFile: (mid) => req('GET', `/materials/${mid}/file`),
  deleteMaterial: (mid) => req('DELETE', `/materials/${mid}`),

  // 评语
  generateComment: (sid, body) => req('POST', `/students/${sid}/comments/generate`, body),
  updateComment: (cid2, body) => req('PUT', `/comments/${cid2}`, body),
  listComments: (sid, params = '') => req('GET', `/students/${sid}/comments${params}`),
  deleteComment: (cid2) => req('DELETE', `/comments/${cid2}`),

  // 话术
  listPhrases: (params = '') => req('GET', `/phrases${params}`),
  createPhrase: (body) => req('POST', '/phrases', body),
  updatePhrase: (pid, body) => req('PUT', `/phrases/${pid}`, body),
  deletePhrase: (pid) => req('DELETE', `/phrases/${pid}`),
  favoritePhrase: (pid, fav) => req('PUT', `/phrases/${pid}/favorite`, { favorite: fav }),
  generatePhrase: (pid, params) => req('POST', `/phrases/${pid}/generate`, { params }),

  // 分层
  autoLayer: (cid, stage = '') => req('POST', `/classes/${cid}/layers/auto`, { stage }),
  adjustLayer: (body) => req('PUT', '/student-layers', body),
  getLayers: (cid) => req('GET', `/classes/${cid}/layers`),
  layerPlans: (cid) => req('GET', `/classes/${cid}/layers/plans`),

  // 沟通（联动）
  createCommunication: (body) => req('POST', '/communications', body),
  listCommunications: (params = '') => req('GET', `/communications${params}`),
  syncCommunication: (cid2) => req('POST', `/communications/${cid2}/sync`),
  updateCommunication: (cid2, body) => req('PUT', `/communications/${cid2}`, body),
  deleteCommunication: (cid2) => req('DELETE', `/communications/${cid2}`),

  // 知识卡片
  pushToday: (kind = '') => req('GET', `/push/today${kind ? `?kind=${kind}` : ''}`),
  pushRefresh: (kind) => req('POST', '/push/refresh', { kind }),
  searchKnowledge: (params = '') => req('GET', `/knowledge${params}`),
  favoriteKnowledge: (kid, fav) => req('PUT', `/knowledge/${kid}/favorite`, { favorite: fav }),
  noteKnowledge: (kid, note) => req('PUT', `/knowledge/${kid}/note`, { note }),
  pushReview: (period = 'month') => req('GET', `/push/review?period=${period}`),

  // 备份/导出/撤销
  backup: () => req('POST', '/backup'),
  listBackups: () => req('GET', '/backups'),
  undo: () => req('POST', '/undo'),
  redo: () => req('POST', '/redo'),
  health: () => req('GET', '/health'),
};
