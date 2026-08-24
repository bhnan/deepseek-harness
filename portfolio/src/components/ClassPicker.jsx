import React, { useEffect, useState, useRef } from 'react';

export function classRoleLabel(c) {
  if (!c) return '';
  if (c.role === 'homeroom') return '班主任班';
  return c.stage === 'primary' ? '小学道法' : '初中道法';
}

// 当前班级选择器：分组（我的班主任班/初中道法班/小学道法班）+ 新增/编辑入口
export default function ClassPicker({ classes, currentClassId, onSelect, onNew, onEdit }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = () => setOpen(false);
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, []);
  const groups = [
    ['我的班主任班', classes.filter((c) => c.role === 'homeroom')],
    ['初中道法班', classes.filter((c) => c.role === 'subject' && c.stage === 'middle')],
    ['小学道法班', classes.filter((c) => c.role === 'subject' && c.stage === 'primary')],
  ].filter(([, arr]) => arr.length);
  const cur = classes.find((c) => c.id === currentClassId);
  return (
    <div className="class-picker" ref={ref}>
      <button className="class-picker-btn" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span className="cp-icon">{cur?.role === 'homeroom' ? '🏫' : '📗'}</span>
        <span className="cp-name">{cur ? cur.name : '选择班级'}</span>
        <span className={`cp-role ${cur?.role || ''}`}>{classRoleLabel(cur)}</span>
        <span className="cp-caret">▾</span>
      </button>
      {open && (
        <div className="class-picker-menu">
          {groups.map(([label, arr]) => (
            <div key={label} className="cp-group">
              <div className="cp-group-label">{label}</div>
              {arr.map((c) => (
                <button key={c.id} className={`cp-item ${c.id === currentClassId ? 'active' : ''}`} onClick={() => { onSelect(c.id); setOpen(false); }}>
                  <span>{c.name}</span>
                  {c.id === currentClassId && <span className="cp-current">当前</span>}
                </button>
              ))}
            </div>
          ))}
          <div className="cp-actions">
            <button className="cp-action" onClick={() => { setOpen(false); onNew(); }}>＋ 新增班级</button>
            {cur && <button className="cp-action" onClick={() => { setOpen(false); onEdit(cur.id); }}>✏️ 编辑当前班级</button>}
          </div>
        </div>
      )}
    </div>
  );
}
