// L2 接口测试（M6 知识卡片：推送/换一条/检索/收藏笔记/复盘导出）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8806;
const BASE = `http://127.0.0.1:${PORT}/api/portfolio`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ki-test-'));

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

describe('知识卡片（I-86~I-95）', () => {
  it('种子库四类齐全（≥20/库）', async () => {
    const d = await api('GET', '/knowledge');
    const byLib = {};
    for (const i of d.items) byLib[i.library] = (byLib[i.library] || 0) + 1;
    expect(byLib.classic).toBeGreaterThanOrEqual(20);
    expect(byLib.psychology).toBeGreaterThanOrEqual(20);
    expect(byLib.master).toBeGreaterThanOrEqual(20);
    expect(byLib.quote).toBeGreaterThanOrEqual(20);
    expect(d.total).toBeGreaterThanOrEqual(80);
  });

  it('检索组合过滤（I-86）', async () => {
    const d = await api('GET', '/knowledge?library=quote&keyword=课堂');
    expect(d.items.every((i) => i.library === 'quote')).toBe(true);
    expect(d.total).toBeGreaterThan(0);
    const stage = await api('GET', '/knowledge?stage=primary');
    expect(stage.items.every((i) => i.stage === 'primary' || i.stage === 'all')).toBe(true);
  });

  it('收藏/笔记持久化（I-87）', async () => {
    const list = await api('GET', '/knowledge?library=classic');
    const kid = list.items[0].id;
    await api('PUT', `/knowledge/${kid}/favorite`, { favorite: true });
    await api('PUT', `/knowledge/${kid}/note`, { note: '已用于家长会' });
    const fav = await api('GET', '/knowledge?favorite=1');
    expect(fav.total).toBe(1);
    expect(fav.items[0].note).toBe('已用于家长会');
  });

  it('当日推送：4 类齐全且固定（I-88）', async () => {
    const d1 = await api('GET', '/push/today');
    expect(d1.items.length).toBe(4);
    const kinds = new Set(d1.items.map((i) => i.kind));
    expect(kinds).toEqual(new Set(['manager', 'df_teaching', 'psychology', 'quote']));
    expect(d1.items.every((i) => i.item && i.item.id)).toBe(true);
    const d2 = await api('GET', '/push/today');
    expect(d2.items.map((i) => i.item.id)).toEqual(d1.items.map((i) => i.item.id)); // 当日固定
  });

  it('单类查询 ?kind=（卡片标签切换）', async () => {
    const d = await api('GET', '/push/today?kind=quote');
    expect(d.item.library).toBe('quote');
  });

  it('换一条：同类换新且当日记录更新（I-90）', async () => {
    const before = await api('GET', '/push/today?kind=quote');
    const d = await api('POST', '/push/refresh', { kind: 'quote' });
    expect(d.item.id).not.toBe(before.item.id);
    const after = await api('GET', '/push/today?kind=quote');
    expect(after.item.id).toBe(d.item.id); // 当日记录已更新
  });

  it('非法 kind → 400（I-95）', async () => {
    expect((await api('POST', '/push/refresh', { kind: 'poetry' })).ok).toBe(false);
  });

  it('df_teaching 学段适配（I-92）', async () => {
    await api('PUT', '/settings', { stage_filter: 'middle' });
    const d = await api('GET', '/push/today?kind=df_teaching');
    expect(['middle', 'all']).toContain(d.item.stage);
    await api('PUT', '/settings', { stage_filter: 'all' });
  });

  it('月复盘：范围正确、含收藏笔记（I-93/I-94）', async () => {
    const d = await api('GET', '/push/review?period=month');
    expect(d.review.pushed.length).toBeGreaterThan(0);
    expect(d.review.favorites.length).toBeGreaterThan(0);
    expect(d.review.reflection).toContain('推送');
    const r = await fetch(`${BASE}/push/review/export?period=month`);
    expect(r.headers.get('content-type')).toContain('text/markdown');
    const md = await r.text();
    expect(md).toContain('知识卡片复盘');
  });
});
