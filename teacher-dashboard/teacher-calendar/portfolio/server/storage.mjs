// 学生成长档案工作台 —— 存储层（SQLite，04 数据结构文档定稿）
// - node:sqlite DatabaseSync；WAL + foreign_keys ON
// - 迁移：server/migrations/NNN_*.sql 按序执行，schema_version 记录
// - 导出：genId / nowISO / getDB / withTx / undo 栈（快照式）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './crypto.mjs';

// node:sqlite 通过 createRequire 运行时解析：vite-node/vitest 转换本模块时不会静态解析该内置模块
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export { DATA_DIR };

let db = null;

export function DB_FILE() {
  return path.join(DATA_DIR(), 'student-portfolio.db');
}

export function openDB() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE()), { recursive: true });
  db = new DatabaseSync(DB_FILE());
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

export function getDB() {
  return db || openDB();
}

export function closeDB() {
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
}

/** 按文件名序号执行未应用的迁移（只增不改） */
function migrate(database) {
  // 版本表必须先于任何版本查询存在（首次建库时 001 尚未执行）
  database.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  if (!fs.existsSync(dir)) return;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort() : [];
  const current = database.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_version').get().v;
  for (const f of files) {
    const version = parseInt(f, 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      database.exec('COMMIT');
    } catch (e) {
      database.exec('ROLLBACK');
      throw new Error(`迁移 ${f} 失败: ${e.message}`);
    }
  }
}

/** 当前 schema 版本 */
export function schemaVersion() {
  return getDB().prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_version').get().v;
}

// ---------- 通用工具 ----------
export const nowISO = () => new Date().toISOString();
export const todayISO = () => new Date().toISOString().slice(0, 10);

export function genId(prefix) {
  return `pf_${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

/** 事务助手：fn 内全部 SQL 原子；异常回滚并上抛 */
export function withTx(fn) {
  const d = getDB();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 通用行助手 ----------
/** 按主键查一行（无则 undefined） */
export function getById(table, id) {
  const row = getDB().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  return row ?? undefined;
}

/** 插入一行（对象 → 列）；返回该行 */
export function insertRow(table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  getDB().prepare(sql).run(...keys.map((k) => row[k]));
  return row;
}

/** 按主键更新（仅传入字段）；返回更新后行 */
export function updateRow(table, id, patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return getById(table, id);
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`;
  getDB().prepare(sql).run(...keys.map((k) => patch[k]), id);
  return getById(table, id);
}

/** 删除一行，返回是否存在 */
export function deleteRow(table, id) {
  return getDB().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
}

// ---------- 设置 ----------
export function getSetting(key, fallback = null) {
  const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  getDB().prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export function getSettings() {
  return {
    title: getSetting('title', '梁老师的学生成长档案'),
    teacher_name: getSetting('teacher_name', '梁老师'),
    theme_id: getSetting('theme_id', 'fresh'),
    stage_filter: getSetting('stage_filter', 'all'),
    calendar_api_base: getSetting('calendar_api_base', 'http://127.0.0.1:8787'),
    calendar_semester_id: getSetting('calendar_semester_id', ''),
    calendar_link_enabled: getSetting('calendar_link_enabled', true),
  };
}

export function updateSettings(patch) {
  const allowed = ['title', 'teacher_name', 'theme_id', 'stage_filter', 'calendar_api_base', 'calendar_semester_id', 'calendar_link_enabled'];
  for (const k of allowed) {
    if (patch[k] !== undefined) setSetting(k, patch[k]);
  }
  return getSettings();
}

// ---------- 撤销栈（快照式，06 文档 §2.2） ----------
/** 入栈：before/after 为 JSON 快照（批量时传数组） */
export function pushUndo({ op, entity, entity_id, before, after, cascade }) {
  // cascade：级联数据（删除场景）随 after_json 包装存储：{"cascade":[...]}
  let afterJson;
  if (cascade !== undefined) afterJson = JSON.stringify({ cascade, after: after === undefined ? null : after });
  else afterJson = after === undefined ? null : JSON.stringify(after);
  getDB().prepare(
    'INSERT INTO undo_log(op, entity, entity_id, before_json, after_json, ts) VALUES (?,?,?,?,?,?)'
  ).run(op, entity, entity_id, before === undefined ? null : JSON.stringify(before), afterJson, nowISO());
}

/** 解析 undo 条目：after 原始值 + 级联数组 */
export function parseAfter(entry) {
  if (!entry.after_json) return { after: null, cascade: null };
  const j = JSON.parse(entry.after_json);
  if (j && typeof j === 'object' && 'cascade' in j) return { after: j.after, cascade: j.cascade };
  return { after: j, cascade: null };
}

export function popUndo() {
  const row = getDB().prepare('SELECT * FROM undo_log ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  getDB().prepare('DELETE FROM undo_log WHERE id = ?').run(row.id);
  return row;
}

export function popRedo() {
  // 重做 = 撤销的逆：同一机制，由调用方用 after_json 回放；redo 栈暂存于内存调用方
  return null;
}

/** 学期推导（固定口径，06 文档 §4）：2026-10-01 → 2026秋；2027-01-31 → 2026秋（1 月属上一学年秋季）；8 月归秋季（新学期准备期） */
export function semesterOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  if (!y || !m) return '';
  if (m >= 8) return `${y}秋`;      // 08-12 月 → 当年秋季（含 8 月准备期）
  if (m === 1) return `${y - 1}秋`; // 1 月 → 上一学年秋季
  return `${y}春`;                   // 02-07 月
}

/** 学期日期范围（与 semesterOf 同一口径）：秋季 08-01~次年01-31；春季 02-01~07-31 */
export function semesterRange(dateStr) {
  const sem = semesterOf(dateStr);
  const y = sem.slice(0, 4);
  return sem.endsWith('秋')
    ? { from: `${y}-08-01`, to: `${Number(y) + 1}-01-31` }
    : { from: `${y}-02-01`, to: `${y}-07-31` };
}

/** ISO 周号 YYYY-Www（作业周趋势用，纯日历周） */
export function isoWeek(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day); // 周四所在周
  const y = dt.getUTCFullYear();
  const jan1 = Date.UTC(y, 0, 1);
  const week = Math.ceil((((dt - jan1) / 86400000) + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}
