import { useEffect } from 'react';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import TabBar from './components/TabBar';
import Breadcrumb from './components/Breadcrumb';
import TableEditor from './components/TableEditor';
import SqlEditor from './components/SqlEditor';
import HistoryTab, { openHistoryTab } from './components/HistoryTab';
import TxTab from './components/TxTab';
import SqlEditorList from './components/SqlEditorList';
import StatusBar from './components/StatusBar';
import ConnectionDialog from './components/ConnectionDialog';
import PasswordDialog from './components/PasswordDialog';
import TxConfirmDialog from './components/TxConfirmDialog';
import Toaster from './components/Toaster';
import { useAppState, activeTab, activeConnectionId, setState, openSqlTab } from './state/store';
import { loadConnections, commit, rollback, setAutoCommit } from './state/actions';

export default function App() {
  const state = useAppState();
  const tab = activeTab(state);
  const connId = activeConnectionId(state);

  useEffect(() => { void loadConnections(); }, []);

  // 애플리케이션 메뉴에서 오는 명령 처리 (preload 가 없으면 조용히 넘어간다)
  useEffect(() => {
    if (!window.api?.onMenu) return;
    return window.api.onMenu((channel) => {
      const s = { ...state };
      const id = activeConnectionId(s);
      switch (channel) {
        case 'menu:new-connection':
          setState({ dialog: { kind: 'connection', connection: null } });
          break;
        case 'menu:new-sql': {
          const t = activeTab(s);
          const session = id ? s.sessions[id] : null;
          if (id && session?.connected) {
            openSqlTab(id, session.currentDatabase ?? '', t && 'schema' in t ? t.schema : (session.currentSchema ?? ''));
          }
          break;
        }
        case 'menu:commit': if (id) void commit(id); break;
        case 'menu:rollback': if (id) void rollback(id); break;
        case 'menu:toggle-autocommit':
          if (id) void setAutoCommit(id, !(s.sessions[id]?.autoCommit ?? true));
          break;
        case 'menu:refresh':
          window.dispatchEvent(new CustomEvent('dbstudio:refresh'));
          break;
        case 'menu:history':
          openHistoryTab();
          break;
        case 'menu:sql-list':
          setState((prev) => ({ sqlListOpen: !prev.sqlListOpen }));
          break;
        case 'menu:explain':
          window.dispatchEvent(new CustomEvent('dbstudio:explain'));
          break;
        default: break;
      }
    });
  }, [state]);

  return (
    <div className="app">
      <Toolbar connectionId={connId} />
      <div className="app-body">
        <Sidebar />
        <main className="workspace">
          <TabBar />
          <Breadcrumb />
          <div className="editor-host">
            {!tab && <EmptyState />}
            {tab?.kind === 'table' && <TableEditor key={tab.id} tab={tab} />}
            {tab?.kind === 'sql' && <SqlEditor key={tab.id} tab={tab} />}
            {tab?.kind === 'history' && <HistoryTab key={tab.id} tab={tab} />}
            {tab?.kind === 'tx' && <TxTab key={tab.id} tab={tab} />}
          </div>
        </main>
      </div>
      <StatusBar connectionId={connId} />
      {state.sqlListOpen && <SqlEditorList />}
      {state.dialog?.kind === 'connection' && <ConnectionDialog connection={state.dialog.connection} />}
      {state.dialog?.kind === 'password' && <PasswordDialog connection={state.dialog.connection} />}
      {state.dialog?.kind === 'txConfirm' && (
        <TxConfirmDialog connectionId={state.dialog.connectionId} action={state.dialog.action} />
      )}
      <Toaster />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <h2>DB Studio</h2>
      <p>왼쪽 트리에서 접속을 선택해 연결한 뒤, 테이블을 더블클릭하면 탭으로 열립니다.</p>
      <ul>
        <li><b>⌘/Ctrl + N</b> — 새 SQL 편집기</li>
        <li><b>⌘/Ctrl + ⇧ + N</b> — 새 접속</li>
        <li><b>⌘/Ctrl + ⌥ + C / R</b> — 커밋 / 롤백</li>
        <li><b>⌘/Ctrl + ⇧ + E</b> — 실행 계획</li>
        <li><b>⌘/Ctrl + ⇧ + H</b> — 쿼리 히스토리</li>
        <li><b>⌘/Ctrl + ⇧ + L</b> — SQL 편집기 목록</li>
        <li><b>F5</b> — 현재 화면 새로 고침</li>
      </ul>
    </div>
  );
}
