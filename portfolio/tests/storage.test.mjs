// L1 单元测试：加密模块 + 存储层（04 文档 §19 / 06 文档一致性清单）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-test-'));
process.env.TC_DATA_DIR = TMP;

const cryptoMod = await import('../server/crypto.mjs');
const store = await import('../server/storage.mjs');
const seed = await import('../server/seed.mjs');

describe('加密模块（AES-256-GCM）', () => {
  beforeAll(() => { store.openDB(); seed.seedIfEmpty(); });

  it('加密→解密往返一致；两次密文不同（随机 iv）', () => {
    const c1 = cryptoMod.encrypt('420111201109011234');
    const c2 = cryptoMod.encrypt('420111201109011234');
    expect(c1).not.toBe(c2);
    expect(cryptoMod.decrypt(c1)).toBe('420111201109011234');
    expect(cryptoMod.decrypt(c2)).toBe('420111201109011234');
  });

  it('密文格式 v1:<iv>:<cipher>（base64url 三段）', () => {
    const c = cryptoMod.encrypt('test');
    const parts = c.split(':');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('空串原样返回空串', () => {
    expect(cryptoMod.encrypt('')).toBe('');
    expect(cryptoMod.decrypt('')).toBe('');
  });

  it('解密失败抛错（不静默返回空）', () => {
    expect(() => cryptoMod.decrypt('v1:AAAA:BBBB')).toThrow();
    expect(() => cryptoMod.decrypt('bad-format')).toThrow();
  });

  it('密钥文件存在且权限 600', () => {
    const file = cryptoMod.SECRET_FILE();
    expect(fs.existsSync(file)).toBe(true);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('脱敏规则：身份证/手机/地址/姓名', () => {
    expect(cryptoMod.maskIdCard('420111201109011234')).toBe('420****1234');
    expect(cryptoMod.maskPhone('13800005678')).toBe('138****5678');
    expect(cryptoMod.maskAddress('湖北省武汉市武昌区')).toBe('湖北省武汉市****');
    expect(cryptoMod.maskName('李建国')).toBe('李**');
  });

  it('学生行加密后库中无明文（D-05）', () => {
    const enc = cryptoMod.encryptStudentRow({ id_card: '420111201109011234', special_note: '单亲' });
    expect(enc.id_card.startsWith('v1:')).toBe(true);
    const db = store.getDB();
    const raw = fs.readFileSync(path.join(TMP, 'student-portfolio.db'), 'utf8');
    expect(raw.includes('420111201109011234')).toBe(false);
    expect(cryptoMod.decryptStudentRow(enc).special_note).toBe('单亲');
  });
});

describe('存储层', () => {
  it('schema 版本 = 2；21 张业务表 + schema_version（002 作业台账）', () => {
    expect(store.schemaVersion()).toBe(2);
    const n = store.getDB().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    expect(n).toBe(22);
  });

  it('genId 前缀与唯一性', () => {
    const a = store.genId('cls');
    const b = store.genId('cls');
    expect(a).toMatch(/^pf_cls_[0-9a-f]{20}$/);
    expect(a).not.toBe(b);
  });

  it('设置读写与默认值', () => {
    expect(store.getSetting('title')).toBe('梁老师的学生成长档案');
    store.setSetting('title', '测试标题');
    expect(store.getSetting('title')).toBe('测试标题');
    store.setSetting('title', '梁老师的学生成长档案');
  });

  it('学期推导：2026-10-01→2026秋；2026-03-01→2026春；2027-01-31→2026秋；2027-02-01→2027春', () => {
    expect(store.semesterOf('2026-10-01')).toBe('2026秋');
    expect(store.semesterOf('2026-03-01')).toBe('2026春');
    expect(store.semesterOf('2027-01-31')).toBe('2026秋');
    expect(store.semesterOf('2027-02-01')).toBe('2027春');
  });

  it('ISO 周号格式 YYYY-Www', () => {
    expect(store.isoWeek('2026-10-05')).toMatch(/^2026-W\d{2}$/);
  });

  it('撤销栈：push → pop 后进先出', () => {
    store.pushUndo({ op: 'create', entity: 'student', entity_id: 'x1', before: null, after: { a: 1 } });
    store.pushUndo({ op: 'update', entity: 'student', entity_id: 'x2', before: { a: 1 }, after: { a: 2 } });
    const top = store.popUndo();
    expect(top.entity_id).toBe('x2');
    expect(JSON.parse(top.before_json)).toEqual({ a: 1 });
    store.popUndo();
  });

  it('事务原子性：中途失败整批回滚（D-07）', () => {
    const db = store.getDB();
    db.prepare('DELETE FROM classes').run();
    expect(() => store.withTx(() => {
      store.insertRow('classes', { id: 'pf_cls_t1', name: '事务班', grade: '初一', stage: 'middle', role: 'homeroom', sort_order: 0, created_at: 'x', updated_at: 'x' });
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM classes').get().n).toBe(0);
  });

  it('外键级联：删班级级联删学生（D-01）', () => {
    const db = store.getDB();
    store.insertRow('classes', { id: 'pf_cls_c1', name: '级联班', grade: '初一', stage: 'middle', role: 'homeroom', sort_order: 0, created_at: 'x', updated_at: 'x' });
    store.insertRow('students', { id: 'pf_stu_c1', class_id: 'pf_cls_c1', name: '级联生', student_no: '', active: 1, created_at: 'x', updated_at: 'x' });
    db.prepare('DELETE FROM classes WHERE id = ?').run('pf_cls_c1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM students WHERE id = ?').get('pf_stu_c1').n).toBe(0);
  });

  it('枚举防漂移：非法枚举被 CHECK 拒绝（D-02 抽样）', () => {
    const db = store.getDB();
    expect(() => db.prepare("INSERT INTO classes(id,name,grade,stage,role,sort_order,created_at,updated_at) VALUES('pf_cls_e1','x','x','college','homeroom',0,'x','x')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO students(id,class_id,name,pressure_level,created_at,updated_at) VALUES('pf_stu_e1','pf_cls_e1','x','极高','x','x')").run()).toThrow();
  });
});

afterAll(() => { store.closeDB(); fs.rmSync(TMP, { recursive: true, force: true }); });
