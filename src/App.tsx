import { useEffect, useState, type DragEvent } from 'react';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import TabBar, { draggedTabId } from './components/TabBar';
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
import {
  useAppState, activeTab, activeConnectionId, setState, openSqlTab,
  paneTabs, paneActiveId, isSplit, setFocusedPane, moveTab, type AppState,
} from './state/store';
import { loadConnections, loadSettings, commit, rollback, setAutoCommit } from './state/actions';
import { restoreWorkspace } from './state/workspace';

export default function App() {
  const state = useAppState();
  const connId = activeConnectionId(state);
  const split = isSplit(state);

  useEffect(() => {
    void loadConnections();
    void loadSettings();
    // 지난 실행에서 열려 있던 SQL 편집기를 그대로 되살린다.
    void restoreWorkspace();
  }, []);

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
          {state.tabs.length === 0 ? (
            <div className="editor-host"><EmptyState /></div>
          ) : (
            <div className={`pane-row ${split ? 'split' : ''}`}>
              <EditorPane pane={0} state={state} />
              {split && <EditorPane pane={1} state={state} />}
            </div>
          )}
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

/**
 * 화면 한 쪽 — 탭 막대 + 위치 표시 + 편집기.
 * 분할이 없을 때 탭을 오른쪽 40% 영역으로 끌면 화면이 나뉜다.
 * 분할 중에는 반대쪽 화면의 편집기 영역에 떨어뜨리면 그 화면으로 옮겨 간다.
 */
function EditorPane({ pane, state }: { pane: 0 | 1; state: AppState }) {
  const [dropHint, setDropHint] = useState<'right' | 'here' | null>(null);
  const split = isSplit(state);
  const tabs = paneTabs(state, pane);
  const active = tabs.find((t) => t.id === paneActiveId(state, pane)) ?? tabs[0] ?? null;

  /**
   * 이 좌표에 떨어뜨리면 무슨 일이 생기는지.
   * dragover(미리보기)와 drop(실제 이동)이 같은 계산을 쓴다.
   */
  const zoneAt = (e: DragEvent): 'right' | 'here' | null => {
    const dragId = draggedTabId();
    if (!dragId) return null;
    if (!split) {
      // 오른쪽 절반쯤으로 끌면 분할. 하나뿐인 탭을 나눠 봐야 왼쪽이 비니 의미가 없다.
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const inRight = e.clientX > box.left + box.width * 0.6;
      return inRight && paneTabs(state, 0).length > 1 ? 'right' : null;
    }
    // 분할 중: 다른 화면에서 온 탭이면 이 화면으로 받는다.
    const dragged = state.tabs.find((t) => t.id === dragId);
    return dragged && (dragged.pane === 1 ? 1 : 0) !== pane ? 'here' : null;
  };

  const overHost = (e: DragEvent) => {
    const zone = zoneAt(e);
    if (zone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
    setDropHint(zone);
  };

  const dropHost = (e: DragEvent) => {
    const dragId = draggedTabId();
    const zone = zoneAt(e);
    setDropHint(null);
    if (!dragId || !zone) return;
    e.preventDefault();
    moveTab(dragId, { pane: zone === 'right' ? 1 : pane });
  };

  return (
    <section
      className={`editor-pane ${split && state.focusedPane === pane ? 'focused' : ''}`}
      onMouseDownCapture={() => setFocusedPane(pane)}
    >
      <TabBar pane={pane} />
      <Breadcrumb tab={active} />
      <div
        className="editor-host"
        onDragOver={overHost}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropHint(null);
        }}
        onDrop={dropHost}
      >
        {!active && <div className="pane-message muted">탭을 이쪽으로 끌어오세요.</div>}
        {active?.kind === 'table' && <TableEditor key={active.id} tab={active} />}
        {active?.kind === 'sql' && <SqlEditor key={active.id} tab={active} />}
        {active?.kind === 'history' && <HistoryTab key={active.id} tab={active} />}
        {active?.kind === 'tx' && <TxTab key={active.id} tab={active} />}
        {dropHint && <div className={`split-hint ${dropHint}`} />}
      </div>
    </section>
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
        <li>탭 드래그 — 순서 바꾸기 · 오른쪽으로 끌면 화면 분할</li>
      </ul>
    </div>
  );
}
