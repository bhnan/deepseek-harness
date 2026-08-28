// 数据层与系统级测试（对齐测试点文档：X3 原子写入 / X4 完整性 / R5 撤销栈 / D 轨道种子）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离数据目录：必须在 import storage 之前设置
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-'));
process.env.TC_DATA_DIR = TMP;

const storage = await import('../server/storage.mjs');
const seed = await import('../server/seed.mjs');

describe('D 轨道：种子数据完整性', () => {
  beforeAll(() => { seed.seedIfEmpty(); });

  it('默认两学期 + 标准名称', () => {
    const sems = storage.listSemesters();
    expect(sems.length).toBe(2);
    expect(sems[0].name).toBe('2026年秋季第一学期');
    expect(sems[1].name).toBe('2026年春季第二学期');
  });
  it('班级库 8 个（初中 5 + 小学 3），各带 hex 配色', () => {
    const classes = storage.readJSON(storage.P.classes, []);
    expect(classes.length).toBe(8);
    expect(classes.filter((c) => c.stage === 'middle').length).toBe(5);
    expect(classes.filter((c) => c.stage === 'primary').length).toBe(3);
    for (const c of classes) expect(c.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
  it('素养词库 180 条（45+45+35+25+30），五类齐全，白话翻译/通俗释义必填，id 唯一', () => {
    const items = storage.readJSON(storage.P.culture, {}).data?.items || [];
    expect(items.length).toBe(180);
    const cats = new Set(items.map((i) => i.category));
    expect(cats).toEqual(new Set(['education_proverb', 'classic_poetry', 'education_philosophy', 'education_theory', 'education_psychology']));
    const perCat = {};
    for (const i of items) perCat[i.category] = (perCat[i.category] || 0) + 1;
    expect(perCat).toEqual({ education_proverb: 45, classic_poetry: 45, education_philosophy: 35, education_theory: 25, education_psychology: 30 });
    const ids = new Set(items.map((i) => i.id));
    expect(ids.size).toBe(180); // id 全局唯一
    for (const i of items) {
      expect(i.original_text.length).toBeGreaterThan(0);
      expect(i.plain_explanation.length).toBeGreaterThan(0);
      if (i.category === 'education_proverb' || i.category === 'classic_poetry') {
        expect(i.vernacular_translation.length).toBeGreaterThan(0);
      }
      expect(i.original_text).not.toContain('=== '); // 无残留表达式
    }
  });
  it('学期目录六文件齐备（X3 原子写入产物）', () => {
    for (const f of ['fixed_courses.json', 'temporary_changes.json', 'teaching_content.json', 'events.json', 'birthdays.json', 'push_state.json']) {
      expect(fs.existsSync(path.join(TMP, '2026-autumn-1', f))).toBe(true);
    }
  });
});

describe('X3 原子写入', () => {
  it('写入后文件存在且内容一致，tmp 目录无残留', () => {
    const data = { schema_version: '1.0', data: { items: [{ id: 'x1', v: 1 }] } };
    storage.writeJSON('_global/atomic_test.json', data);
    expect(storage.readJSON('_global/atomic_test.json')).toEqual(data);
    const leftovers = fs.readdirSync(path.join(TMP, 'tmp')).filter((f) => f.includes('atomic_test'));
    expect(leftovers.length).toBe(0); // 临时文件已 rename，无残留
  });
  it('损坏 JSON 读入降级为 fallback（缺失行为表）', () => {
    fs.writeFileSync(path.join(TMP, '_global/broken.json'), '{not-json', 'utf-8');
    expect(storage.readJSON('_global/broken.json', 'fallback')).toBe('fallback');
  });
});

describe('X4 数据完整性（manifest checksum）', () => {
  it('写入后 manifest 记录 sha256，校验通过', () => {
    const ok = storage.checkIntegrity('semesters.json');
    expect(ok.ok).toBe(true);
  });
  it('篡改文件后校验失败（损坏可发现）', () => {
    const f = path.join(TMP, '_global/atomic_test.json');
    fs.appendFileSync(f, '// tampered');
    const r = storage.checkIntegrity('_global/atomic_test.json');
    expect(r.ok).toBe(false);
    expect(r.note).toContain('checksum');
    fs.writeFileSync(f, JSON.stringify({ schema_version: '1.0', data: { items: [{ id: 'x1', v: 1 }] } }), 'utf-8'); // 还原
  });
});

describe('R5 撤销栈（settings 持久化）', () => {
  it('入栈上限 100：超出淘汰最旧', () => {
    const s = storage.loadSettings();
    for (let i = 0; i < 105; i++) {
      storage.pushUndo(s, { op: 'create', entity: 'event', entity_id: `e${i}`, semester_id: '2026-autumn-1', snapshot_before: null, snapshot_after: { id: `e${i}` }, ts: new Date().toISOString() });
    }
    const final = storage.loadSettings();
    expect(final.undo_stack.length).toBe(100);
    expect(final.undo_stack[0].entity_id).toBe('e5'); // 最旧 5 条被淘汰
  });
  it('撤销/恢复按当前学期过滤（UN4：栈按学期隔离）', () => {
    const s = storage.loadSettings();
    // 清空栈，构造跨学期条目
    s.undo_stack = [];
    s.redo_stack = [];
    storage.saveSettings(s);
    storage.pushUndo(storage.loadSettings(), { op: 'create', entity: 'event', entity_id: 'a1', semester_id: '2026-autumn-1', snapshot_before: null, snapshot_after: {}, ts: new Date().toISOString() });
    storage.pushUndo(storage.loadSettings(), { op: 'create', entity: 'event', entity_id: 'b1', semester_id: '2026-spring-2', snapshot_before: null, snapshot_after: {}, ts: new Date().toISOString() });
    const r = storage.undo(storage.loadSettings(), '2026-autumn-1');
    expect(r.ok).toBe(true);
    expect(r.entry.entity_id).toBe('a1'); // 只撤销当前学期的条目
  });
});

describe('引擎与数据层联动（种子课表）', () => {
  it('固定排课 8 条无时段重叠（同一 weekday+period 唯一）', () => {
    const fixed = storage.loadCollection('2026-autumn-1', 'fixed_courses.json');
    const keys = fixed.map((f) => `${f.weekday}-${f.period}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('授课内容为课时位级（class+week+weekday+period 唯一）', () => {
    const contents = storage.loadCollection('2026-autumn-1', 'teaching_content.json');
    const keys = contents.map((c) => `${c.class_id}-${c.week}-${c.weekday || 1}-${c.period || 1}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
