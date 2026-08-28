// L3 集成测试（M4 唯一联动：沟通安排 → 教学日历 stub）
// 用 stub HTTP 服务器模拟教学日历（bootstrap + events），验证请求契约与状态机
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8803;
const CAL_PORT = 8804;
const BASE = `http://127.0.0.1:${PORT}/api/portfolio`;
const CAL_BASE = `http://127.0.0.1:${CAL_PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-link-test-'));

// ---------- stub 教学日历 ----------
const calEvents = [];   // 收到的创建请求
const calDeletes = [];  // 收到的删除
let calFailMode = null; // null | 'down' | 'reject' | 'no-semester'
const calServer = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (calFailMode === 'down') { res.destroy(); return; }
  if (req.url === '/api/calendar/bootstrap' && req.method === 'GET') {
    return send(200, { ok: true, semesters: [
      { id: '2026-autumn-1', name: '2026年秋季第一学期', start_date: '2026-09-01', end_date: '2027-01-17' },
      { id: '2026-spring-2', name: '2026年春季第二学期', start_date: '2026-02-22', end_date: '2026-07-06' },
    ] });
  }
  const m = req.url.match(/^\/api\/calendar\/([\w-]+)\/events$/);
  const dm = req.url.match(/^\/api\/calendar\/([\w-]+)\/events\/([\w-]+)$/);
  if (m && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (calFailMode === 'reject') return send(400, { ok: false, reason: '模拟拒绝' });
      const payload = JSON.parse(body);
      calEvents.push({ sid: m[1], ...payload });
      send(200, { ok: true, event: { id: `ev_${calEvents.length}` } });
    });
    return;
  }
  if (dm && req.method === 'DELETE') {
    calDeletes.push({ sid: dm[1], eid: dm[2] });
    return send(200, { ok: true, deleted: dm[2] });
  }
  send(404, { ok: false, reason: 'not found' });
});
calServer.listen(CAL_PORT);

// ---------- 档案服务 ----------
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
  // 配置联动指向 stub
  await api('PUT', '/settings', { calendar_api_base: CAL_BASE, calendar_semester_id: '2026-autumn-1' });
}, 20000);

afterAll(() => { server?.kill(); calServer.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

describe('联动正向（L-01~L-06）', () => {
  let cid, sid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '联动班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    sid = (await api('POST', `/classes/${cid}/students`, { name: '李想', student_no: 'L1' })).student.id;
  });

  it('创建沟通安排 → 同步成功 + 契约映射（L-01/L-02）', async () => {
    const d = await api('POST', '/communications', { student_id: sid, type: 'talk', date: '2026-10-16', time: '15:30', location: '办公室', note: '月考退步谈心' });
    expect(d.ok).toBe(true);
    expect(d.communication.sync_status).toBe('synced');
    expect(d.communication.calendar_event_id).toBe('ev_1');
    expect(d.communication.calendar_semester_id).toBe('2026-autumn-1');
    const ev = calEvents[0];
    expect(ev.sid).toBe('2026-autumn-1'); // 学期匹配（10-16 落在秋季）
    expect(ev.type).toBe('activity');
    expect(ev.title).toBe('💬 谈心 · 李想（联动班）');
    expect(ev.notes).toContain('【成长档案】');
    expect(ev.color).toBe('#C97B84');
    expect(ev.date).toBe('2026-10-16');
    expect(ev.time).toBe('15:30');
  });

  it('兜底学期：日期无学期命中 → 用配置兜底（L-03）', async () => {
    const d = await api('POST', '/communications', { student_id: sid, type: 'chat', date: '2028-01-01', note: '未来安排' });
    expect(d.communication.sync_status).toBe('synced');
    expect(calEvents[1].sid).toBe('2026-autumn-1'); // 兜底
  });

  it('联动关闭 → pending 不请求日历（L-04）', async () => {
    await api('PUT', '/settings', { calendar_link_enabled: false });
    const before = calEvents.length;
    const d = await api('POST', '/communications', { student_id: sid, type: 'chat', date: '2026-10-20' });
    expect(d.communication.sync_status).toBe('pending');
    expect(calEvents.length).toBe(before);
    await api('PUT', '/settings', { calendar_link_enabled: true });
  });

  it('删除沟通安排 → 调 DELETE 日历事件（L-05）', async () => {
    const list = await api('GET', '/communications?sync_status=synced');
    const target = list.communications.find((c) => c.calendar_event_id === 'ev_1');
    const d = await api('DELETE', `/communications/${target.id}`);
    expect(d.ok).toBe(true);
    expect(calDeletes.some((x) => x.eid === 'ev_1' && x.sid === '2026-autumn-1')).toBe(true);
  });

  it('删除未同步沟通 → 仅本地（L-06）', async () => {
    await api('PUT', '/settings', { calendar_link_enabled: false });
    const d = await api('POST', '/communications', { student_id: sid, type: 'talk', date: '2026-10-21' });
    const before = calDeletes.length;
    await api('DELETE', `/communications/${d.communication.id}`);
    expect(calDeletes.length).toBe(before);
    await api('PUT', '/settings', { calendar_link_enabled: true });
  });
});

describe('联动异常（L-07~L-11）', () => {
  let cid, sid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '联动2班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    sid = (await api('POST', `/classes/${cid}/students`, { name: '王小宝', student_no: 'L2' })).student.id;
  });

  it('日历不可达 → failed + 本地数据完整（L-07）', async () => {
    calFailMode = 'down';
    const d = await api('POST', '/communications', { student_id: sid, type: 'talk', date: '2026-10-22' });
    expect(d.communication.sync_status).toBe('failed');
    expect(d.communication.sync_error).not.toBe('');
    expect(d.communication.id).toBeTruthy();
    calFailMode = null;
  });

  it('重试成功 → synced（L-08）', async () => {
    const list = await api('GET', '/communications?sync_status=failed');
    const target = list.communications[0];
    const d = await api('POST', `/communications/${target.id}/sync`);
    expect(d.communication.sync_status).toBe('synced');
    expect(d.communication.calendar_event_id).toBeTruthy();
  });

  it('重试仍失败 → 保持 failed（L-09）', async () => {
    calFailMode = 'down';
    const list = await api('GET', '/communications?sync_status=synced');
    const target = list.communications[0];
    const d = await api('POST', `/communications/${target.id}/sync`);
    expect(d.communication.sync_status).toBe('failed');
    calFailMode = null;
  });

  it('学期与兜底均无效 → failed（L-10）', async () => {
    await api('PUT', '/settings', { calendar_semester_id: '' });
    const d = await api('POST', '/communications', { student_id: sid, type: 'chat', date: '2028-05-05' });
    expect(d.communication.sync_status).toBe('failed');
    expect(d.communication.sync_error).toContain('无法确定目标学期');
    await api('PUT', '/settings', { calendar_semester_id: '2026-autumn-1' });
  });

  it('日历返回 400 → failed 且 reason 透传（L-11）', async () => {
    calFailMode = 'reject';
    const d = await api('POST', '/communications', { student_id: sid, type: 'talk', date: '2026-10-23' });
    expect(d.communication.sync_status).toBe('failed');
    expect(d.communication.sync_error).toContain('模拟拒绝');
    calFailMode = null;
  });

  it('更新沟通安排 → 删旧事件 + 重建新事件（§2.1 补充约定）', async () => {
    const d = await api('POST', '/communications', { student_id: sid, type: 'talk', date: '2026-10-24', time: '10:00' });
    const cid2 = d.communication.id;
    const oldEv = d.communication.calendar_event_id;
    const u = await api('PUT', `/communications/${cid2}`, { time: '14:00', note: '改到下午' });
    expect(u.communication.sync_status).toBe('synced');
    expect(calDeletes.some((x) => x.eid === oldEv)).toBe(true); // 旧事件已删
    expect(u.communication.calendar_event_id).not.toBe(oldEv);  // 新事件
    expect(calEvents[calEvents.length - 1].time).toBe('14:00');
  });
});
