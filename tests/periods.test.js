// 作息时间表 API 测试：默认 9 节 / 保存归一化 / week-view 透传 / 校验拒绝
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}/api/calendar`;
const SID = '2026-autumn-1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-periods-test-'));

let server;
let started = false;

beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), TC_DATA_DIR: TMP },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/bootstrap`);
      if (r.ok) { started = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!started) throw new Error('测试服务器启动失败');
}, 20000);

afterAll(() => { server?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

describe('作息时间表（periods）', () => {
  it('未配置时返回默认 9 节（时间为空，可自行填写）', async () => {
    const d = await api('GET', `/${SID}/periods`);
    expect(d.ok).toBe(true);
    expect(d.periods.length).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(d.periods[i]).toMatchObject({ kind: 'period', no: i + 1, name: `第 ${i + 1} 节`, start: '', end: '' });
    }
  });

  it('保存后按时序返回：支持休息段、时间归一化为 HH:MM、name 可自定义', async () => {
    const body = [
      { kind: 'period', no: 1, name: '第一节', start: '8:00', end: '8:40' }, // 8:00 → 08:00
      { kind: 'break', name: '大课间', start: '9:40', end: '10:05' },
      { kind: 'period', no: 2, name: '第二节', start: '10:05', end: '10:45' },
      { kind: 'break', name: '午休', start: '12:00', end: '13:30' },
      { kind: 'period', no: 3, name: '居然可变名', start: '', end: '' },
    ];
    const d = await api('PUT', `/${SID}/periods`, { periods: body });
    expect(d.ok).toBe(true);
    expect(d.periods[0]).toEqual({ kind: 'period', no: 1, name: '第一节', start: '08:00', end: '08:40' });
    expect(d.periods[1]).toEqual({ kind: 'break', name: '大课间', start: '09:40', end: '10:05' });
    expect(d.periods[4]).toEqual({ kind: 'period', no: 3, name: '居然可变名', start: '', end: '' });

    const g = await api('GET', `/${SID}/periods`);
    expect(g.periods).toEqual(d.periods);
  });

  it('week-view 透传 timeline 供周视图渲染', async () => {
    const w = await api('GET', `/${SID}/week-view?week=1`);
    expect(w.ok).toBe(true);
    expect(Array.isArray(w.timeline)).toBe(true);
    expect(w.timeline.length).toBeGreaterThanOrEqual(3);
    expect(w.timeline.some((t) => t.kind === 'break' && t.name === '大课间')).toBe(true);
  });

  it('校验拒绝：名称空 / 时间非法 / 节次序号重复', async () => {
    const r1 = await api('PUT', `/${SID}/periods`, { periods: [{ kind: 'period', no: 1, name: '  ', start: '', end: '' }] });
    expect(r1.ok).toBe(false);
    const r2 = await api('PUT', `/${SID}/periods`, { periods: [{ kind: 'period', no: 1, name: '第1节', start: '25:99', end: '' }] });
    expect(r2.ok).toBe(false);
    const r3 = await api('PUT', `/${SID}/periods`, { periods: [
      { kind: 'period', no: 1, name: '第一节', start: '', end: '' },
      { kind: 'period', no: 1, name: '第一节重复', start: '', end: '' },
    ] });
    expect(r3.ok).toBe(false);
  });
});