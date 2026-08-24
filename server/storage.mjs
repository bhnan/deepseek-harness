// 数据层：JSON 存储 + 原子写入 + manifest 完整性（X3/X4）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.TC_DATA_DIR
  ? path.resolve(process.env.TC_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
ensureDir(DATA_DIR); ensureDir(TMP_DIR);

/** 原子写入：同目录临时文件 + rename（X3） */
export function atomicWrite(relPath, data) {
  const abs = path.join(DATA_DIR, relPath);
  ensureDir(path.dirname(abs));
  const tmp = path.join(TMP_DIR, `${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, abs);
  updateManifest(relPath, abs);
  return abs;
}

export function readJSON(relPath, fallback = null) {
  const abs = path.join(DATA_DIR, relPath);
  try {
    if (!fs.existsSync(abs)) return fallback;
    return JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch {
    return fallback; // 损坏 → 降级为默认（缺失行为表）
  }
}

export function writeJSON(relPath, data) { return atomicWrite(relPath, data); }
export function exists(relPath) { return fs.existsSync(path.join(DATA_DIR, relPath)); }

/** manifest：每文件 sha256 + size + mtime（X4） */
let manifestCache = null;
function updateManifest(relPath, abs) {
  const m = loadManifest();
  const content = fs.readFileSync(abs);
  m.files[relPath] = {
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    size: content.length,
    updated_at: new Date().toISOString(),
  };
  manifestCache = m;
  const absM = path.join(DATA_DIR, 'manifest.json');
  const tmp = path.join(TMP_DIR, `manifest.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf-8');
  fs.renameSync(tmp, absM);
}

export function loadManifest() {
  if (manifestCache) return manifestCache;
  manifestCache = readJSON('manifest.json', { version: 1, files: {} });
  return manifestCache;
}

export function checkIntegrity(relPath) {
  const m = loadManifest();
  const rec = m.files[relPath];
  if (!rec) return { ok: true, note: '未记录' };
  const abs = path.join(DATA_DIR, relPath);
  if (!fs.existsSync(abs)) return { ok: false, note: '文件缺失' };
  const content = fs.readFileSync(abs);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  return { ok: sha === rec.sha256, note: sha === rec.sha256 ? 'ok' : 'checksum 不符' };
}

// ---------- 路径常量 ----------
export const P = {
  semesters: 'semesters.json',
  classes: '_global/classes.json',
  theme: '_global/theme.json',
  culture: '_global/culture_library.json',
  presets: '_global/teaching_presets.json',
  holidays: '_global/holidays.json',
  settings: '_global/settings.json',
  sid: (sid, file) => `${sid}/${file}`,
};

// ---------- 通用 CRUD 助手 ----------
export function listSemesters() { return readJSON(P.semesters, []); }
export function saveSemesters(list) { writeJSON(P.semesters, list); }
export function getSemester(id) { return listSemesters().find((s) => s.id === id) || null; }
export function semesterDirExists(id) { return exists(P.sid(id, 'events.json')); }

export function genId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

export function loadCollection(sid, file) { return readJSON(P.sid(sid, file), []); }
export function saveCollection(sid, file, items) { writeJSON(P.sid(sid, file), items); }

// ---------- 撤销栈（D9：undo_stack / redo_stack，条目=操作快照）----------
export function loadSettings() {
  return readJSON(P.settings, {
    current_semester_id: null, preferred_view: 'week', theme_id: 'fresh',
    undo_stack: [], redo_stack: [], updated_at: null,
  });
}
export function saveSettings(s) { writeJSON(P.settings, s); }

const STACK_MAX = 100; // 对齐 rule-spec C6 建议值

export function pushUndo(settings, entry) {
  settings.undo_stack.push(entry);
  if (settings.undo_stack.length > STACK_MAX) settings.undo_stack.shift();
  settings.redo_stack = [];
  settings.updated_at = new Date().toISOString();
  saveSettings(settings);
  return settings;
}

/** 撤销：取栈顶逆操作回放；按当前学期过滤（UN4：栈按学期隔离） */
export function undo(settings, currentSemesterId) {
  const idx = [...settings.undo_stack].reverse().findIndex(
    (e) => e.semester_id === currentSemesterId || e.semester_id === null
  );
  if (idx === -1) return { ok: false, reason: '无可撤销操作' };
  const entry = settings.undo_stack[settings.undo_stack.length - 1 - idx];
  settings.undo_stack.splice(settings.undo_stack.length - 1 - idx, 1);
  settings.redo_stack.push(entry);
  saveSettings(settings);
  return { ok: true, entry };
}

export function redo(settings, currentSemesterId) {
  const idx = [...settings.redo_stack].reverse().findIndex(
    (e) => e.semester_id === currentSemesterId || e.semester_id === null
  );
  if (idx === -1) return { ok: false, reason: '无可恢复操作' };
  const entry = settings.redo_stack[settings.redo_stack.length - 1 - idx];
  settings.redo_stack.splice(settings.redo_stack.length - 1 - idx, 1);
  settings.undo_stack.push(entry);
  saveSettings(settings);
  return { ok: true, entry };
}
