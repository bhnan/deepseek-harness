import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// 知识库轻量检索（入口：顶部知识卡片「更多」）
export default function KnowledgePage({ notify }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ library: '', category: '', keyword: '', favorite: '' });
  const [review, setReview] = useState(null);

  const LIB = { classic: '教育名著精华', psychology: '学段心理专项', master: '名师实操经验', quote: '教育家金句' };
  const CAT = { class_management: '班级常规管理', problem_student: '问题学生专项', cross_stage: '跨学段育人', home_school: '家校沟通', df_teaching: '道法教学', mental_health: '心理健康', self_growth: '教师成长' };

  useEffect(() => {
    const q = new URLSearchParams();
    if (filters.library) q.set('library', filters.library);
    if (filters.category) q.set('category', filters.category);
    if (filters.keyword) q.set('keyword', filters.keyword);
    if (filters.favorite) q.set('favorite', '1');
    api.searchKnowledge(q.toString() ? `?${q}` : '')
      .then((d) => { setItems(d.items); setTotal(d.total); })
      .catch((e) => notify(e.message));
  }, [filters]);

  useEffect(() => { api.pushReview('semester').then((d) => setReview(d.review)).catch(() => {}); }, []);

  return (
    <div className="page">
      <div className="page-head"><h2>📚 知识库（轻量检索）</h2></div>
      <div className="row">
        <input placeholder="关键词检索…" value={filters.keyword} onChange={(e) => setFilters({ ...filters, keyword: e.target.value })} />
        <select value={filters.library} onChange={(e) => setFilters({ ...filters, library: e.target.value })}>
          <option value="">全部库</option>
          {Object.entries(LIB).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
          <option value="">全部分类</option>
          {Object.entries(CAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn ghost sm" onClick={() => setFilters({ library: '', category: '', keyword: '', favorite: filters.favorite ? '' : '1' })}>
          {filters.favorite ? '显示全部' : '只看收藏'}
        </button>
      </div>
      <div className="tips">共 {total} 条</div>
      <div className="knowledge-list">
        {items.map((it) => (
          <div key={it.id} className="card knowledge-item">
            <div className="row">
              <b>{it.favorite ? '⭐ ' : ''}{it.title}</b>
              <span className="chip-static">{LIB[it.library]}</span>
              <span className="chip-static">{CAT[it.category] || it.category}</span>
            </div>
            <p className="pre-wrap">{it.content}</p>
            <div className="kc-meta">
              <span>来源：{it.source || '—'}</span>
              <button className="btn ghost xs" onClick={async () => { try { await api.favoriteKnowledge(it.id, !it.favorite); setFilters({ ...filters }); } catch (e) { notify(e.message); } }}>{it.favorite ? '取消收藏' : '收藏'}</button>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="empty-tip">无匹配条目</div>}
      </div>
      {review && (
        <div className="card">
          <h4>📋 本学期知识复盘</h4>
          <div className="tips">{review.reflection}</div>
          <button className="btn ghost sm" onClick={async () => { try { const r = await api.pushReview('semester'); const u = new URL('/api/portfolio/push/review/export', location.href); u.searchParams.set('period', 'semester'); location.href = u; notify(`导出 ${r.review.pushed.length} 条复盘`); } catch (e) { notify(e.message); } }}>⬇ 导出复盘 Markdown</button>
        </div>
      )}
    </div>
  );
}
