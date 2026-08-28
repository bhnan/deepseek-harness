import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import HomePage from './pages/HomePage.jsx';
import ClassDetailPage from './pages/ClassDetailPage.jsx';
import DfAnalysisPage from './pages/DfAnalysisPage.jsx';
import HWLedgerPage from './pages/HWLedgerPage.jsx';
import StudentPage from './pages/StudentPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import KnowledgePage from './pages/KnowledgePage.jsx';
import KnowledgeCard from './components/KnowledgeCard.jsx';
import ClassPicker from './components/ClassPicker.jsx';

const THEMES = { fresh: '简约风', pastel: '小清新风', art: '艺术风' };

const MAIN_NAV = [
  ['home', '工作台首页', '🏠'], ['students', '学生成长档案', '👤'], ['full', '全科学情', '📊'],
  ['df', '道法学情', '⚖'], ['hw', '作业台账', '📚'],
  ['moral', '德育心理', '❤'], ['honor', '特长荣誉', '🏆'], ['comments', '智能评语', '📄'],
  ['materials', '成长素材', '📷'], ['knowledge', '教师知识库', '💡'], ['settings', '系统设置', '⚙'],
];
const DF_NAV = [
  ['home', '工作台首页', '🏠'], ['students', '学生成长档案', '👤'], ['df', '道法学情', '⚖'],
  ['dfhw', '道法作业', '📝'], ['comments', '智能评语', '📄'], ['knowledge', '教师知识库', '💡'], ['settings', '系统设置', '⚙'],
];
const TAB_OF = {
  students: 'students', full: 'scores', df: null, hw: null, dfhw: null,
  moral: 'moral', honor: 'honor', comments: 'comments', materials: 'materials',
};

// 班级管理弹窗：新建 / 编辑（改名/改学段/改板块）/ 删除
function ClassManagerModal({ mode, classId, classes, onClose, onDone, notify }) {
  const editing = classes.find((c) => c.id === classId);
  const [name, setName] = useState(editing?.name || '');
  const [grade, setGrade] = useState(editing?.grade || '');
  const [stage, setStage] = useState(editing?.stage || 'middle');
  const [role, setRole] = useState(editing?.role || 'subject');
  const [confirmName, setConfirmName] = useState('');
  const [err, setErr] = useState('');

  const save = async () => {
    try {
      if (mode === 'new') {
        const d = await api.createClass({ name, grade, stage, role });
        notify('班级已创建'); onDone(d.class.id);
      } else {
        await api.updateClass(classId, { name, grade, stage, role });
        notify('班级已更新'); onDone(classId);
      }
    } catch (e) { setErr(e.message); }
  };
  const del = async () => {
    if (confirmName !== name) { setErr('请输入班级名确认删除'); return; }
    try { await api.deleteClass(classId, name); notify('班级已删除'); onDone(null); } catch (e) { setErr(e.message); }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'new' ? '＋ 新增班级' : `✏️ 编辑班级：${editing?.name || ''}`}</h3>
        <div className="form">
          <label>班级名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：初一(5)班 / 四(1)班" />
          <label>年级</label>
          <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="如：初一 / 四年级" />
          <label>学段</label>
          <select value={stage} onChange={(e) => setStage(e.target.value)}><option value="middle">初中</option><option value="primary">小学</option></select>
          <label>板块（权限）</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="homeroom">班主任主班（全功能）</option>
            <option value="subject">道法代课班（精简）</option>
          </select>
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button className="btn primary sm" onClick={save} disabled={!name || !grade}>保存</button>
            <button className="btn ghost sm" onClick={onClose}>取消</button>
          </div>
          {mode === 'edit' && (
            <div className="del-row">
              <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={`输入班级名「${editing?.name || ''}」确认删除`} />
              <button className="btn danger sm" onClick={del}>删除班级</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState(null);
  const [classes, setClasses] = useState([]);
  const [currentClassId, setCurrentClassId] = useState('');
  const [route, setRoute] = useState({ page: 'home', tab: null });
  const [toast, setToast] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [classModal, setClassModal] = useState(null); // {mode, classId}

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const notify = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(''), 2500); }, []);

  useEffect(() => {
    api.getSettings().then((d) => setSettings(d.settings)).catch((e) => notify(e.message));
    api.listClasses().then((d) => {
      const cls = d.classes || [];
      setClasses(cls);
      const main = cls.find((c) => c.role === 'homeroom') || cls[0];
      if (main) setCurrentClassId(main.id);
    }).catch((e) => notify(e.message));
  }, [refreshKey]);

  useEffect(() => {
    if (settings?.theme_id) document.documentElement.dataset.theme = settings.theme_id;
  }, [settings?.theme_id]);

  if (!settings) return <div className="app-loading">加载中…</div>;

  const currentClass = classes.find((c) => c.id === currentClassId) || null;
  const nav = currentClass?.role === 'homeroom' ? MAIN_NAV : DF_NAV;
  const navPage = (page) => setRoute({ page, tab: TAB_OF[page] || null });
  window.__topNav = navPage;

  // 班级管理完成后刷新
  const onClassDone = (cid) => {
    setClassModal(null);
    api.listClasses().then((d) => { setClasses(d.classes); if (cid) setCurrentClassId(cid); else { const m = d.classes.find((c) => c.role === 'homeroom') || d.classes[0]; if (m) setCurrentClassId(m.id); } });
  };

  return (
    <div className="app">
      <div className="topbar">
        <KnowledgeCard notify={notify} />
        <div className="topbar-right">
          <select value={settings.theme_id} onChange={async (e) => { try { const d = await api.putSettings({ theme_id: e.target.value }); setSettings((s) => ({ ...s, ...d.settings })); } catch (err) { notify(err.message); } }}>
            {Object.entries(THEMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn ghost sm" onClick={async () => { try { await api.undo(); notify('已撤销'); refresh(); } catch (e) { notify(e.message); } }}>↩ 撤销</button>
          <button className="btn ghost sm" onClick={async () => { try { await api.backup(); notify('备份完成'); } catch (e) { notify(e.message); } }}>💾 备份</button>
        </div>
      </div>

      <div className="app-body">
        <aside className="sidenav">
          {/* 切换班级：左侧边栏顶部（导航列表上方） */}
          <div className="sidenav-class">
            <ClassPicker classes={classes} currentClassId={currentClassId} onSelect={setCurrentClassId}
              onNew={() => setClassModal({ mode: 'new', classId: null })} onEdit={(cid) => setClassModal({ mode: 'edit', classId: cid })} />
          </div>
          <nav className="sidenav-list">
            {nav.map(([page, label, icon]) => (
              <button key={page} className={`sidenav-item ${route.page === page ? 'active' : ''}`} onClick={() => navPage(page)}>
                <span className="sidenav-icon">{icon}</span>{label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="main-area">
          {route.page === 'home' && (
            <HomePage classes={classes} currentClass={currentClass}
              onNav={(page, extra) => setRoute({ page, tab: TAB_OF[page] || null, ...extra })}
              onOpenStudent={(sid, tab) => setRoute({ page: 'student', sid, cid: currentClassId, tab })}
              notify={notify} refreshKey={refreshKey} />
          )}
          {['students', 'full', 'moral', 'honor', 'comments', 'materials'].includes(route.page) && (
            <ClassDetailPage cid={currentClassId} initialTab={route.tab || 'students'} stageFilter={settings.stage_filter} onBack={() => setRoute({ page: 'home' })}
              onOpenStudent={(sid, tab) => setRoute({ page: 'student', sid, cid: currentClassId, tab })} notify={notify} refreshKey={refreshKey} />
          )}
          {['hw', 'dfhw'].includes(route.page) && (
            <HWLedgerPage cid={currentClassId} cls={currentClass} dfOnly={route.page === 'dfhw'} onBack={() => setRoute({ page: 'home' })}
              onOpenStudent={(sid, tab) => setRoute({ page: 'student', sid, cid: currentClassId, tab })} notify={notify} refreshKey={refreshKey} />
          )}
          {route.page === 'df' && (
            <DfAnalysisPage cid={currentClassId} cls={currentClass} onBack={() => setRoute({ page: 'home' })}
              onOpenStudent={(sid, tab) => setRoute({ page: 'student', sid, cid: currentClassId, tab })} notify={notify} refreshKey={refreshKey} />
          )}
          {route.page === 'student' && (
            <StudentPage sid={route.sid} initialTab={route.tab} onBack={() => setRoute({ page: 'home' })} notify={notify} refreshKey={refreshKey} />
          )}
          {route.page === 'knowledge' && <KnowledgePage notify={notify} />}
          {route.page === 'settings' && <SettingsPage settings={settings} setSettings={setSettings} notify={notify} />}
          {!currentClass && route.page !== 'home' && route.page !== 'knowledge' && route.page !== 'settings' && <div className="empty-tip">请先在顶部选择班级（或点击「＋ 新增班级」）</div>}
        </main>
      </div>

      {classModal && <ClassManagerModal mode={classModal.mode} classId={classModal.classId} classes={classes} onClose={() => setClassModal(null)} onDone={onClassDone} notify={notify} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
