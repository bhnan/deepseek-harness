import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// 来源轮换顺序（每次「换一条」自动切到下一个内容库）
const ORDER = ['manager', 'df_teaching', 'psychology', 'quote'];
const LABEL = { manager: '班主任干货', df_teaching: '道法干货', psychology: '心理实操', quote: '教学技巧' };

// 标题旁知识卡：始终展开，内容完整展现（不截断）
export default function KnowledgeCard({ notify }) {
  const [kind, setKind] = useState('manager');
  const [item, setItem] = useState(null);

  useEffect(() => {
    api.pushToday(kind).then((d) => setItem(d.item)).catch(() => setItem(null));
  }, [kind]);

  // 换一条：来源轮换到下一个库，并从该库换新条目（覆盖当日记录）
  const refresh = async () => {
    const next = ORDER[(ORDER.indexOf(kind) + 1) % ORDER.length];
    try {
      const d = await api.pushRefresh(next);
      setKind(next);
      setItem(d.item);
      notify(`已从「${LABEL[next]}」换一条`);
    } catch (e) { notify(e.message); }
  };

  return (
    <div className="kc-note kc-note-open">
      <div className="kc-note-head">
        <span className="kc-src">{LABEL[kind]}</span>
        <span className="kc-note-title" title={item ? item.title : ''}>{item ? item.title : '...'}</span>
        <button className="btn ghost xs" title="换一条" onClick={refresh}>↻</button>
        {item && (
          <button className="btn ghost xs" title={item.favorite ? '取消收藏' : '收藏'} onClick={async () => {
            try { await api.favoriteKnowledge(item.id, !item.favorite); setItem({ ...item, favorite: item.favorite ? 0 : 1 }); notify(item.favorite ? '已取消收藏' : '已收藏'); } catch (e) { notify(e.message); }
          }}>{item.favorite ? '⭐' : '☆'}</button>
        )}
      </div>
      {item && (
        <div className="kc-note-body">
          <p>{item.content}</p>
          <div className="kc-note-meta"><span>来源：{item.source || '—'}</span></div>
        </div>
      )}
    </div>
  );
}
