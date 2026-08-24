import React, { useState } from 'react';
import { api } from '../api.js';

export default function SettingsPage({ settings, setSettings, notify }) {
  const [form, setForm] = useState({ ...settings });
  const [testResult, setTestResult] = useState('');

  const save = async () => {
    try {
      const d = await api.putSettings(form);
      setSettings((s) => ({ ...s, ...d.settings }));
      notify('设置已保存');
    } catch (e) { notify(e.message); }
  };

  const test = async () => {
    setTestResult('测试中…');
    try {
      const d = await api.calendarTest(form.calendar_api_base);
      setTestResult(d.reachable ? `✅ 连接成功（${d.semesters.length} 个学期）` : `❌ ${d.reason}`);
    } catch (e) { setTestResult(`❌ ${e.message}`); }
  };

  return (
    <div className="page">
      <h2>⚙ 全局设置</h2>
      <div className="card form">
        <label>工作台标题（默认：梁老师的学生成长档案）</label>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <label>教师姓名</label>
        <input value={form.teacher_name} onChange={(e) => setForm({ ...form, teacher_name: e.target.value })} style={{ width: 200 }} />
        <label>默认学段筛选</label>
        <select value={form.stage_filter} onChange={(e) => setForm({ ...form, stage_filter: e.target.value })}>
          <option value="all">全部</option><option value="primary">小学</option><option value="middle">初中</option>
        </select>
        <h4>📅 教学日历联动（唯一联动：沟通安排 → 日历事件）</h4>
        <div className="row">
          <input value={form.calendar_api_base} onChange={(e) => setForm({ ...form, calendar_api_base: e.target.value })} placeholder="http://127.0.0.1:8787" style={{ width: 260 }} />
          <input value={form.calendar_semester_id} onChange={(e) => setForm({ ...form, calendar_semester_id: e.target.value })} placeholder="兜底学期 id（可选）" style={{ width: 180 }} />
          <button className="btn ghost sm" onClick={test}>测试连接</button>
        </div>
        {testResult && <div className="tips">{testResult}</div>}
        <label className="check"><input type="checkbox" checked={form.calendar_link_enabled} onChange={(e) => setForm({ ...form, calendar_link_enabled: e.target.checked })} /> 启用日历联动</label>
        <div className="row">
          <button className="btn primary" onClick={save}>保存设置</button>
          <button className="btn ghost" onClick={async () => { try { await api.backup(); notify('备份完成，可在 data/backups 查看'); } catch (e) { notify(e.message); } }}>💾 一键备份</button>
        </div>
      </div>
    </div>
  );
}
