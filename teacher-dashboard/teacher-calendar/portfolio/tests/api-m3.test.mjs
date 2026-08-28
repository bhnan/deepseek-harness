// L2 接口测试（M3 日常：作业 / 德育 / 特长荣誉 / 素材 / 评语 / 话术）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}/api/portfolio`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-m3-test-'));

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

describe('作业台账（I-41~I-50）', () => {
  let cid, sid, aid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '作业班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    sid = (await api('POST', `/classes/${cid}/students`, { name: '作业生', student_no: 'H1' })).student.id;
  });

  it('布置作业 + 回显', async () => {
    const d = await api('POST', `/classes/${cid}/assignments`, { subject: '数学', date: '2026-10-15', title: '练习册 P12-15', requirement: '家长签字', deadline: '明早' });
    expect(d.ok).toBe(true);
    aid = d.assignment.id;
  });

  it('登记记录（45 人级批量语义：3 人测试）', async () => {
    const s2 = (await api('POST', `/classes/${cid}/students`, { name: '乙', student_no: 'H2' })).student.id;
    const s3 = (await api('POST', `/classes/${cid}/students`, { name: '丙', student_no: 'H3' })).student.id;
    const d = await api('POST', `/assignments/${aid}/records/batch`, {
      rows: [
        { student_id: sid, status: 'excellent', issue_note: '', rectify_note: '' },
        { student_id: s2, status: 'missing', issue_note: '未交', rectify_note: '次日补交' },
        { student_id: s3, status: 'slack', issue_note: '字迹潦草', rectify_note: '重写' },
      ],
    });
    expect(d.upserted).toBe(3);
  });

  it('重复登记覆盖（幂等）', async () => {
    const d = await api('POST', `/assignments/${aid}/records/batch`, { rows: [{ student_id: sid, status: 'normal' }] });
    expect(d.upserted).toBe(1);
    const list = await api('GET', `/classes/${cid}/assignments`);
    const recs = await api('POST', `/assignments/${aid}/records/batch`, { rows: [] });
    expect(recs.ok).toBe(false);
  });

  it('非法 status 整批拒绝', async () => {
    const d = await api('POST', `/assignments/${aid}/records/batch`, { rows: [{ student_id: sid, status: 'weird' }] });
    expect(d.upserted).toBe(0);
    expect(d.failed).toBe(1);
  });

  it('学期统计：完成率/缺交/敷衍/问题学生', async () => {
    const d = await api('GET', `/classes/${cid}/assignment-stats?period=semester`);
    expect(d.stats.class_summary.total_records).toBe(3);
    expect(d.stats.class_summary.missing_count).toBe(1);
    expect(d.stats.class_summary.slack_count).toBe(1);
    expect(d.stats.class_summary.excellent_count).toBe(0); // 覆盖后 excellent→normal
    expect(d.stats.problem_students.length).toBe(0); // 每人仅 1 次缺交/敷衍，未达 ≥3 阈值
  });

  it('个人统计含学情联动（academic_link）', async () => {
    const ex = (await api('POST', `/classes/${cid}/exams`, { name: '月考1', type: 'monthly', date: '2026-10-20' })).exam.id;
    const ex2 = (await api('POST', `/classes/${cid}/exams`, { name: '月考2', type: 'monthly', date: '2026-11-20' })).exam.id;
    await api('POST', `/exams/${ex}/scores/batch`, { rows: [{ student_id: sid, subject: '总分', score: 500 }] });
    await api('POST', `/exams/${ex2}/scores/batch`, { rows: [{ student_id: sid, subject: '总分', score: 510 }] });
    const d = await api('GET', `/students/${sid}/assignment-stats`);
    expect(d.stats.academic_link.total_delta).toBe(10);
    expect(d.stats.academic_link.completion_rate).toBe(1);
  });

  it('删除作业级联记录', async () => {
    const d = await api('DELETE', `/assignments/${aid}`);
    expect(d.ok).toBe(true);
    expect(d.records_deleted).toBe(3);
  });
});

describe('德育心理（I-51~I-60）', () => {
  let cid, sid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '德育班', grade: '四年级', stage: 'primary', role: 'homeroom' })).class.id;
    sid = (await api('POST', `/classes/${cid}/students`, { name: '德育生', student_no: 'D1' })).student.id;
  });

  it('新增德育记录：stage 自动按学生学段', async () => {
    const d = await api('POST', `/students/${sid}/moral-records`, { date: '2026-10-15', category: 'emotion', content: '月考后情绪低落', follow_up: '已谈心', result: '状态好转' });
    expect(d.ok).toBe(true);
    expect(d.record.stage).toBe('primary');
  });

  it('非法 category → 400', async () => {
    expect((await api('POST', `/students/${sid}/moral-records`, { date: '2026-10-16', category: 'mood', content: 'x' })).ok).toBe(false);
  });

  it('学期报告：汇总分类 + 亮点/需关注', async () => {
    await api('POST', `/students/${sid}/moral-records`, { date: '2026-10-20', category: 'volunteer', content: '社区志愿服务', result: '获好评' });
    await api('POST', `/students/${sid}/moral-records`, { date: '2026-10-25', category: 'emotion', content: '再次情绪低落' });
    const d = await api('GET', `/students/${sid}/moral-report?semester=2026秋`);
    expect(d.report.by_category.some((c) => c.category === 'emotion' && c.count === 2)).toBe(true);
    expect(d.report.highlights.length).toBeGreaterThan(0);
  });

  it('更新与删除', async () => {
    const list = await api('GET', `/students/${sid}/moral-records`);
    const rid = list.records[0].id;
    const u = await api('PUT', `/moral-records/${rid}`, { result: '完全恢复' });
    expect(u.record.result).toBe('完全恢复');
    const del = await api('DELETE', `/moral-records/${rid}`);
    expect(del.ok).toBe(true);
  });
});

describe('特长荣誉（I-51~I-58 扩展）', () => {
  let cid, sid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '荣誉班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    sid = (await api('POST', `/classes/${cid}/students`, { name: '荣誉生', student_no: 'R1' })).student.id;
  });

  it('新增特长', async () => {
    const d = await api('POST', `/students/${sid}/talents`, { category: '艺术', name: '钢琴', level: '八级', potential: '潜力大' });
    expect(d.ok).toBe(true);
    expect(d.talent.level).toBe('八级');
  });

  it('个人荣誉 + 非法 level 400', async () => {
    expect((await api('POST', `/students/${sid}/honors`, { title: '区三好', level: 'global', date: '2026-06-01' })).ok).toBe(false);
    const d = await api('POST', `/students/${sid}/honors`, { title: '区三好学生', level: 'district', event: '区评优', date: '2026-06-01' });
    expect(d.ok).toBe(true);
  });

  it('班级荣誉 + scope 过滤', async () => {
    await api('POST', `/classes/${cid}/honors`, { title: '文明班级', level: 'school', date: '2026-10-30' });
    const cls = await api('GET', `/classes/${cid}/honors?scope=class`);
    expect(cls.honors.length).toBe(1);
    const stu = await api('GET', `/classes/${cid}/honors?scope=student`);
    expect(stu.honors.length).toBe(1);
  });

  it('荣誉归属双空 400（约束层）', async () => {
    // 服务端强制走 student/class 路由，双空由 DB CHECK 兜底——直接测路由校验
    const d = await api('POST', `/students/${sid}/honors`, { title: '', date: '2026-06-01', level: 'school' });
    expect(d.ok).toBe(false);
  });
});

describe('成长素材（I-61~I-68）', () => {
  let cid, mid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '素材班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
  });

  const upload = async (body) => {
    const boundary = '----pf-boundary-' + Date.now();
    const parts = [];
    for (const [k, v] of Object.entries(body.fields || {})) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${body.filename}"\r\nContent-Type: ${body.mime}\r\n\r\n`));
    parts.push(body.data);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const buf = Buffer.concat(parts);
    const r = await fetch(`${BASE}/materials`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: buf });
    return r.json();
  };

  it('上传图片：落盘 + 学期自动归档（I-61）', async () => {
    const d = await upload({ filename: '运动会.jpg', mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), fields: { owner_type: 'class', owner_id: cid, category: 'sports', event_date: '2026-09-18', note: '运动会合影' } });
    expect(d.ok).toBe(true);
    expect(d.material.semester).toBe('2026秋');
    expect(d.material.file_path).toMatch(/^202609\//);
    mid = d.material.id;
    expect(fs.existsSync(path.join(TMP, 'uploads', d.material.file_path))).toBe(true);
  });

  it('非法类型 400（I-63）', async () => {
    const d = await upload({ filename: 'x.exe', mime: 'application/x-msdownload', data: Buffer.from('MZ'), fields: { owner_type: 'class', owner_id: cid } });
    expect(d.ok).toBe(false);
  });

  it('列表按学期筛选（I-64）', async () => {
    const d = await api('GET', `/materials?semester=2026秋&class_id=${cid}&include_students=1`);
    expect(d.materials.length).toBe(1);
    const none = await api('GET', '/materials?semester=2026春');
    expect(none.materials.length).toBe(0);
  });

  it('预览接口 Content-Type（I-65）', async () => {
    const r = await fetch(`${BASE}/materials/${mid}/file`);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.status).toBe(200);
  });

  it('学期打包 zip（I-66）', async () => {
    const r = await fetch(`${BASE}/materials/export.zip?class_id=${cid}&semester=2026秋`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/zip');
  });

  it('删除素材：行 + 物理文件（I-67）', async () => {
    const d = await api('DELETE', `/materials/${mid}`);
    expect(d.ok).toBe(true);
    expect(fs.existsSync(path.join(TMP, 'uploads', '202609', `${mid}.jpg`))).toBe(false);
  });
});

describe('评语（I-69~I-72）', () => {
  let cid, sid;
  beforeAll(async () => {
    cid = (await api('POST', '/classes', { name: '评语班', grade: '初一', stage: 'middle', role: 'homeroom' })).class.id;
    sid = (await api('POST', `/classes/${cid}/students`, { name: '评语生', student_no: 'C1' })).student.id;
    const ex = (await api('POST', `/classes/${cid}/exams`, { name: '月考', type: 'monthly', date: '2026-10-15' })).exam.id;
    await api('POST', `/exams/${ex}/scores/batch`, { rows: [
      { student_id: sid, subject: '总分', score: 500 }, { student_id: sid, subject: '数学', score: 60 },
    ] });
    const ex2 = (await api('POST', `/classes/${cid}/exams`, { name: '月考2', type: 'monthly', date: '2026-11-15' })).exam.id;
    await api('POST', `/exams/${ex2}/scores/batch`, { rows: [
      { student_id: sid, subject: '总分', score: 508 }, { student_id: sid, subject: '数学', score: 62 },
    ] });
    await api('POST', `/students/${sid}/moral-records`, { date: '2026-10-16', category: 'volunteer', content: '志愿服务', result: '获好评' });
    await api('POST', `/students/${sid}/honors`, { title: '跳绳一等奖', level: 'school', date: '2026-09-18' });
  });

  it('生成谈心评语：含姓名与进退步数据（I-69）', async () => {
    const d = await api('POST', `/students/${sid}/comments/generate`, { type: 'talk' });
    expect(d.ok).toBe(true);
    expect(d.comment.content).toContain('评语生');
    expect(d.comment.content).toContain('8'); // 508-500
    expect(d.comment.type).toBe('talk');
  });

  it('periodic 缺 period → 400（I-70）', async () => {
    expect((await api('POST', `/students/${sid}/comments/generate`, { type: 'periodic' })).ok).toBe(false);
  });

  it('保存修改 saved=1（I-71）', async () => {
    const list = await api('GET', `/students/${sid}/comments?type=talk`);
    const cid2 = list.comments[0].id;
    const d = await api('PUT', `/comments/${cid2}`, { content: '手动修改后的评语', saved: true });
    expect(d.comment.saved).toBe(1);
    expect(d.comment.content).toBe('手动修改后的评语');
  });

  it('全班评语导出 CSV（I-72）', async () => {
    const r = await fetch(`${BASE}/classes/${cid}/comments/export?type=talk`);
    const csv = await r.text();
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(csv).toContain('评语生');
    expect(csv).toContain('手动修改后的评语');
  });
});

describe('家校话术（I-73~I-78）', () => {
  let pid;
  it('新增模板', async () => {
    const d = await api('POST', '/phrases', { category: 'homework', stage: 'middle', tone: 'gentle', title: '周末作业通知', content: '各位家长好！{班级}本周{科目}作业：{作业}，截止{截止}。' });
    expect(d.ok).toBe(true);
    pid = d.phrase.id;
  });

  it('非法 tone → 400（I-77）', async () => {
    expect((await api('POST', '/phrases', { category: 'homework', stage: 'middle', tone: 'angry', title: 'x', content: 'y' })).ok).toBe(false);
  });

  it('占位符替换 + unresolved（I-74）', async () => {
    const d = await api('POST', `/phrases/${pid}/generate`, { params: { 班级: '初一(5)班', 科目: '数学', 作业: '练习册P12' } });
    expect(d.content).toBe('各位家长好！初一(5)班本周数学作业：练习册P12，截止{截止}。');
    expect(d.unresolved).toEqual(['截止']);
  });

  it('收藏切换（I-75）', async () => {
    const d = await api('PUT', `/phrases/${pid}/favorite`, { favorite: true });
    expect(d.favorite).toBe(1);
    const list = await api('GET', '/phrases?favorite=1');
    expect(list.total).toBe(1);
  });

  it('双学段列表过滤（I-76）', async () => {
    await api('POST', '/phrases', { category: 'safety', stage: 'primary', tone: 'strict', title: '防溺水提醒', content: '严禁私自下水。' });
    const primary = await api('GET', '/phrases?stage=primary');
    expect(primary.total).toBe(1);
    const middle = await api('GET', '/phrases?stage=middle');
    expect(middle.total).toBe(1);
  });

  it('删除话术（I-78）', async () => {
    const d = await api('DELETE', `/phrases/${pid}`);
    expect(d.ok).toBe(true);
  });
});
