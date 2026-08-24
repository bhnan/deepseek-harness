// 学生成长档案工作台 —— 加密模块（AES-256-GCM，定稿契约：04 数据结构文档 §19）
// - 密钥文件：<data>/_global/portfolio_secret.json，{version:1,key:<base64 32B>,created_at}，权限 600
// - 密文格式：v1:<iv_base64url>:<cipher_base64url>
// - AAD = "student-portfolio:v1"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SECRET_FILE = () => path.join(DATA_DIR(), '_global', 'portfolio_secret.json');

let dataDir = null;
export function setDataDir(dir) {
  dataDir = dir;
}
export function DATA_DIR() {
  if (dataDir) return dataDir;
  const d = process.env.TC_DATA_DIR;
  if (d) { dataDir = d; return d; }
  const here = path.dirname(fileURLToPath(import.meta.url)); // server/crypto.mjs
  dataDir = path.join(path.dirname(here), 'data');           // portfolio/data
  return dataDir;
}

const AAD = Buffer.from('student-portfolio:v1', 'utf8');
let key = null;

function loadOrCreateKey() {
  if (key) return key;
  const file = SECRET_FILE();
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.version === 1 && parsed.key) {
      key = Buffer.from(parsed.key, 'base64');
      return key;
    }
    throw new Error('密钥文件损坏（version/key 缺失）');
  }
  key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, key: key.toString('base64'), created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  return key;
}

/** 加密：明文 → v1:<iv>:<cipher>；空串原样返回空串 */
export function encrypt(plain) {
  if (plain === '' || plain == null) return '';
  const k = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${Buffer.concat([ct, tag]).toString('base64url')}`;
}

/** 解密：v1:<iv>:<cipher> → 明文；空串返回空串；失败抛错（禁止静默返回空） */
export function decrypt(stored) {
  if (stored === '' || stored == null) return '';
  const k = loadOrCreateKey();
  const m = /^v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) throw new Error('密文格式非法（须 v1:<iv>:<cipher>）');
  const iv = Buffer.from(m[1], 'base64url');
  const body = Buffer.from(m[2], 'base64url');
  const ct = body.subarray(0, body.length - 16);
  const tag = body.subarray(body.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAAD(AAD);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 脱敏（导出/列表用，固定规则：04 文档 §19） */
export function maskIdCard(v) {
  if (!v) return '';
  const s = String(v);
  return s.length <= 7 ? s.slice(0, 3) + '****' : s.slice(0, 3) + '****' + s.slice(-4);
}
export function maskPhone(v) {
  if (!v) return '';
  const s = String(v);
  return s.length <= 7 ? s.slice(0, 3) + '****' : s.slice(0, 3) + '****' + s.slice(-4);
}
export function maskAddress(v) {
  if (!v) return '';
  const s = String(v);
  return s.length <= 6 ? '****' : s.slice(0, 6) + '****';
}
export function maskName(v) {
  if (!v) return '';
  const s = String(v);
  return s.slice(0, 1) + '**';
}

/** 加密学生行中的敏感字段（原地返回新对象）；enc 字段名清单固定 */
export const SENSITIVE_FIELDS = [
  'id_card', 'address', 'parent1_name', 'parent1_phone', 'parent2_name', 'parent2_phone',
  'guardian_note', 'special_note', 'allergy_note', 'manage_note',
];

export function encryptStudentRow(row) {
  const out = { ...row };
  for (const f of SENSITIVE_FIELDS) {
    if (out[f] !== undefined && out[f] !== '') out[f] = encrypt(out[f]);
  }
  return out;
}

export function decryptStudentRow(row) {
  const out = { ...row };
  for (const f of SENSITIVE_FIELDS) {
    if (out[f] && out[f].startsWith('v1:')) out[f] = decrypt(out[f]);
  }
  return out;
}

/** 列表脱敏（04 文档 §19 固定规则；特批字段返回 🔒 占位）——先解密再脱敏 */
export function maskStudentRow(row) {
  const dec = decryptStudentRow({ ...row });
  const out = { ...dec };
  out.id_card = maskIdCard(dec.id_card);
  out.address = maskAddress(dec.address);
  out.parent1_name = maskName(dec.parent1_name);
  out.parent1_phone = maskPhone(dec.parent1_phone);
  out.parent2_name = maskName(dec.parent2_name);
  out.parent2_phone = maskPhone(dec.parent2_phone);
  out.guardian_note = dec.guardian_note ? '🔒' : '';
  out.special_note = dec.special_note ? '🔒' : '';
  out.allergy_note = dec.allergy_note ? '🔒' : '';
  out.manage_note = dec.manage_note ? '🔒' : '';
  return out;
}
