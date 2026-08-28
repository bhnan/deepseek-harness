import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// 班级列表页（主班 / 代课）
export default function ClassesPage({ role, stageFilter, onOpenClass, notify, refreshKey }) {
  const [classes, setClasses] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [grade, setGrade] = useState('');
  const [stage, setStage] = useState(role === 'homeroom' ? 'middle' : 'primary');
  const [err, setErr] = useState('');

  useEffect(() => {
    const stage = stageFilter === 'all' ? '' : stageFilter;
    api.listClasses(`?role=${role}${stage ? `&stage=${stage}` : ''}`)
      .then((d) => setClasses(d.classes))
      .catch((e) => notify(e.message));
  }, [role, stageFilter, refreshKey]);

  const add = async () => {
    try {
      await api.createClass({ name, grade, stage, role });
      setShowNew(false); setName(''); setGrade(''); setErr('');
      notify('班级已创建');
    } catch (e) { setErr(e.message); }
  };

  const isSubject = role === 'subject';

  return (
    <div className="page">
      <div className="page-head">
        <h2>{isSubject ? '📗 道法代课班级（学科精简）' : '🏫 班主任主班（全功能档案）'}</h2>
        <button className="btn primary sm" onClick={() => setShowNew(!showNew)}>＋ 新建班级</button>
      </div>
      {showNew && (
        <div className="card form">
          <div className="row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="班级名，如：初一(5)班 / 四(1)班" />
            <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="年级，如：初一 / 四年级" style={{ width: 140 }} />
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="middle">初中</option>
              <option value="primary">小学</option>
            </select>
            <button className="btn primary" onClick={add} disabled={!name || !grade}>创建</button>
          </div>
          {err && <div className="error">{err}</div>}
        </div>
      )}
      <div className="class-grid">
        {classes.map((c) => (
          <div key={c.id} className="class-card" onClick={() => onOpenClass(c.id)}>
            <div className="class-card-name">{c.name}</div>
            <div className="class-card-meta">
              <span>{c.grade} · {c.stage === 'primary' ? '小学' : '初中'}</span>
              <span className={`role-tag ${c.role}`}>{c.role === 'homeroom' ? '主班' : '代课'}</span>
            </div>
            <div className="class-card-count">👥 {c.student_count} 名学生</div>
          </div>
        ))}
        {classes.length === 0 && <div className="empty-tip">暂无班级，点击右上角「新建班级」开始</div>}
      </div>
      {isSubject && <div className="tips">💡 代课班仅保留道法学科功能（成绩/分层/作业/评语），主班自动纳入道法对比分析。</div>}
    </div>
  );
}
