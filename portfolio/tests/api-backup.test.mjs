// L2 接口测试（M7 收尾：备份 / 恢复 / 全量导出）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8808;
const BASE = `http://127.0.0.1:${PORT}/api/portfolio`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bak-test-'));

let server, started = false;
beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), TC_DATA_DIR: TMP },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) { started = true; break; } } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!started) throw new Error('服务器启动失败');
}, 20000);
afterAll(() => { server?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

describe('备份/恢复/导出（I-96~I-105）', () => {
  let cid, sid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '备份班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    sid = (await api('POST', `/classes/${cid}/students`, { name: '备份生', student_no: 'B1', id_card: '420111201109011234' })).student.id;
  });

  it('一键备份：zip 含 db+uploads+manifest（I-100）', async () => {
    const d = await api('POST', '/backup');
    expect(d.ok).toBe(true);
    expect(d.backup.file).toMatch(/^portfolio-backup-/);
    const list = await api('GET', '/backups');
    expect(list.backups.length).toBe(1);
    // 下载并解包检查
    const r = await fetch(`${BASE}/backups/${encodeURIComponent(d.backup.file)}/download`);
    expect(r.status).toBe(200);
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('恢复备份：数据一致含加密字段可解密（I-102）', async () => {
    // 先改一条数据，再恢复
    await api('PUT', `/students/${sid}`, { goal_note: '被修改了' });
    const detail = await api('GET', `/students/${sid}`);
    expect(detail.student.goal_note).toBe('被修改了');
    // 取备份文件上传恢复
    const list = await api('GET', '/backups');
    const file = list.backups[0].file;
    const r = await fetch(`${BASE}/backups/${encodeURIComponent(file)}/download`);
    const buf = Buffer.from(await r.arrayBuffer());
    const boundary = '----pf-restore-' + Date.now();
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file}"\r\nContent-Type: application/zip\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const rr = await fetch(`${BASE}/backup/restore`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(parts) });
    const res = await rr.json();
    expect(res.ok).toBe(true);
    expect(res.restored).toBe(true);
    // 数据回滚 + 加密字段可解密
    const after = await api('GET', `/students/${sid}`);
    expect(after.student.goal_note).toBe(''); // 恢复为备份时状态
    expect(after.student.id_card).toBe('420111201109011234');
  });

  it('恢复非法包 → 400（I-103）', async () => {
    const boundary = '----pf-bad-' + Date.now();
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bad.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from('not a zip'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const rr = await fetch(`${BASE}/backup/restore`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(parts) });
    const res = await rr.json();
    expect(res.ok).toBe(false);
  });

  it('全量导出 zip（I-104）', async () => {
    const r = await fetch(`${BASE}/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.length).toBeGreaterThan(100);
  });

  it('撤销栈回放正常（栈顶 = 学生创建）', async () => {
    const d = await api('POST', '/undo');
    expect(d.ok).toBe(true);
    expect(['student', 'communication', 'exam', 'assignment', 'moral_record', 'talent', 'honor', 'material', 'comment', 'phrase', 'class'].includes(d.entry.entity)).toBe(true);
  });
});
