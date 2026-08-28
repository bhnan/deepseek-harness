import React from 'react';

// 通用弹窗
export default function Modal({ title, onClose, children, width = 520 }) {
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width }}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
