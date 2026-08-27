// tc CLI · CSV / JSON 成绩行规范化（纯函数，无 IO 无网络）
// 上游契约：portfolio POST /exams/:eid/scores/batch 的 rows：
//   { student_id, subject, score, class_rank?, grade_rank?, question_scores? }
// CLI 在此之上接受 student_name，由 resolve 层换成 id（见 commands.mjs gradesImport）。

export const SUBJECT_SCORE_MAX = 100;
export const TOTAL_SUBJECT = '总分';
export const QUESTION_TYPES = ['选择', '简答', '材料分析', '论述'];
export const RESERVED_COLS = new Set(['姓名', '学号', '序号', '班级排名', '年级排名', '备注', '总分排名']);

/** RFC4180 解析：BOM / CRLF / 引号转义 */
export function parseCSV(text) {
  if (typeof text !== 'string') throw new Error('CSV 输入须为字符串');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const grid = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); grid.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); grid.push(row); }
  // 去掉末尾全空行
  while (grid.length && grid[grid.length - 1].every((c) => c.trim() === '')) grid.pop();
  return grid;
}

/** 表头判定：长表(姓名/科目/分数) 优先，否则宽表(姓名 + ≥1 非保留列)；null = 无法识别 */
export function detectScoreFormat(header) {
  const cols = header.map((c) => c.trim());
  const has = (n) => cols.includes(n);
  if (has('姓名') && has('科目') && has('分数')) return 'long';
  if (has('姓名') && cols.some((c, i) => i > 0 && c !== '' && !RESERVED_COLS.has(c))) return 'wide';
  return null;
}

const toInt = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : NaN;
};

/**
 * 宽/长表 → 规范成绩行（学生用 student_name 承载，ID 由调用方解析）
 * 返回 { rows, errors }；errors: [{row, name, reason}]（row 从 2 计，含表头）
 */
export function gridToScoreRows(grid) {
  if (!Array.isArray(grid) || grid.length < 2) {
    return { rows: [], errors: [{ row: 1, reason: 'CSV 至少需要表头 + 1 行数据' }] };
  }
  const header = grid[0].map((c) => c.trim());
  const fmt = detectScoreFormat(header);
  if (!fmt) return { rows: [], errors: [{ row: 1, reason: '无法识别表头：长表需「姓名,科目,分数[,班级排名,年级排名]」；宽表需首列「姓名」+ ≥1 个科目列' }] };

  const rows = [];
  const errors = [];
  const nameIdx = header.indexOf('姓名');

  if (fmt === 'long') {
    const subjIdx = header.indexOf('科目');
    const scoreIdx = header.indexOf('分数');
    const crIdx = header.indexOf('班级排名');
    const grIdx = header.indexOf('年级排名');
    for (let r = 1; r < grid.length; r++) {
      const cells = grid[r].map((c) => (c ?? '').trim());
      if (cells.every((c) => c === '')) continue;
      const name = cells[nameIdx];
      const subject = cells[subjIdx];
      const rawScore = cells[scoreIdx];
      if (!name) { errors.push({ row: r + 1, reason: '姓名为空' }); continue; }
      if (!subject) { errors.push({ row: r + 1, name, reason: '科目为空' }); continue; }
      if (rawScore === '') { errors.push({ row: r + 1, name, reason: '分数缺失（缺考请留空整行科目或直接跳过该行，不可留空分数列）' }); continue; }
      const score = Number(rawScore);
      if (!Number.isFinite(score)) { errors.push({ row: r + 1, name, reason: `分数非法: "${rawScore}"` }); continue; }
      const class_rank = toInt(cells[crIdx]);
      const grade_rank = toInt(cells[grIdx]);
      if (Number.isNaN(class_rank)) { errors.push({ row: r + 1, name, reason: `班级排名须为正整数: "${cells[crIdx]}"` }); continue; }
      if (Number.isNaN(grade_rank)) { errors.push({ row: r + 1, name, reason: `年级排名须为正整数: "${cells[grIdx]}"` }); continue; }
      rows.push({ student_name: name, subject, score, class_rank, grade_rank, _src_row: r + 1 });
    }
    return { rows, errors };
  }

  // 宽表：第 0 列姓名，其余非保留列 = 科目
  const subjectCols = header.map((c, i) => ({ name: c, i }))
    .filter((x) => x.i > 0 && x.name !== '' && !RESERVED_COLS.has(x.name));
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r].map((c) => (c ?? '').trim());
    if (cells.every((c) => c === '')) continue;
    const name = cells[nameIdx];
    if (!name) { errors.push({ row: r + 1, reason: '姓名为空' }); continue; }
    for (const { name: subj, i } of subjectCols) {
      const cell = cells[i];
      if (cell === '') continue; // 稀疏：缺考/未录 → 跳过
      const score = Number(cell);
      if (!Number.isFinite(score)) { errors.push({ row: r + 1, name, reason: `${subj} 分数非法: "${cell}"` }); continue; }
      rows.push({ student_name: name, subject: subj, score, _src_row: r + 1 });
    }
  }
  return { rows, errors };
}

/**
 * --rows JSON 数组规范化（允许 student_id 或 student_name 二选一）
 * 返回 { rows, errors }
 */
export function normalizeScoreRows(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { rows: [], errors: [{ row: 1, reason: '--rows 须为非空 JSON 数组' }] };
  }
  const rows = [];
  const errors = [];
  raw.forEach((r, i) => {
    const rowNo = i + 2;
    const who = r?.student_name || r?.student_no || r?.student_id || '';
    if (!r?.student_id && !r?.student_name && !r?.student_no) { errors.push({ row: rowNo, reason: '缺 student_id / student_no / student_name（三选一）' }); return; }
    if (!r?.subject || !String(r.subject).trim()) { errors.push({ row: rowNo, name: String(who), reason: 'subject 必填' }); return; }
    const score = Number(r?.score);
    if (!Number.isFinite(score)) { errors.push({ row: rowNo, name: String(who), reason: `score 非法: ${JSON.stringify(r?.score)}` }); return; }
    const class_rank = toInt(r?.class_rank);
    const grade_rank = toInt(r?.grade_rank);
    if (Number.isNaN(class_rank)) { errors.push({ row: rowNo, name: String(who), reason: 'class_rank 须为正整数' }); return; }
    if (Number.isNaN(grade_rank)) { errors.push({ row: rowNo, name: String(who), reason: 'grade_rank 须为正整数' }); return; }
    let question_scores;
    if (r?.question_scores !== undefined) {
      if (typeof r.question_scores !== 'object' || r.question_scores === null || Array.isArray(r.question_scores)) {
        errors.push({ row: rowNo, name: String(who), reason: 'question_scores 须为对象' }); return;
      }
      for (const k of Object.keys(r.question_scores)) {
        if (!QUESTION_TYPES.includes(k)) { errors.push({ row: rowNo, name: String(who), reason: `题型非法: ${k}` }); return; }
        if (!Number.isFinite(Number(r.question_scores[k])) || Number(r.question_scores[k]) < 0) {
          errors.push({ row: rowNo, name: String(who), reason: `题型得分非法: ${k}=${r.question_scores[k]}` }); return;
        }
      }
      question_scores = r.question_scores;
    }
    const row = { subject: String(r.subject).trim(), score, class_rank, grade_rank, _src_row: rowNo };
    if (r.student_id) row.student_id = r.student_id;
    else if (r.student_no) row.student_no = String(r.student_no).trim();
    else row.student_name = String(r.student_name).trim();
    if (question_scores !== undefined) row.question_scores = question_scores;
    rows.push(row);
  });
  return { rows, errors };
}

/** 服务端同款数值范围校验（本地预检用；返回 null = 通过，否则 reason 字符串） */
export function scoreRangeCheck(subject, score) {
  if (subject !== TOTAL_SUBJECT && (score < 0 || score > SUBJECT_SCORE_MAX)) {
    return `科目分数须 0-${SUBJECT_SCORE_MAX}（${subject}）`;
  }
  if (subject === TOTAL_SUBJECT && score < 0) return '总分不能为负';
  return null;
}
