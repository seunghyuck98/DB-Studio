import { useEffect, useRef, useState, type MouseEvent } from 'react';
import SearchResults from './SearchResults';
import ContextMenu, { type MenuState } from './ContextMenu';
import {
  useAppState, setState, setSearch, clearSearchResult, openTableTab, openSqlTab,
  activeConnectionId, sessionOf,
  type TreeItem, type AppState,
} from '../state/store';
import { connect, disconnect, reconnect, deleteConnection, toggleNode, refreshNode, runSearch, nodeId } from '../state/actions';
import type { ConnectionConfig, SearchScopes } from '../types';

const SCOPE_LABELS: { key: keyof SearchScopes; label: string; hint: string }[] = [
  { key: 'names', label: '이름', hint: '테이블·뷰 이름' },
  { key: 'columns', label: '컬럼명', hint: '컬럼 이름' },
  { key: 'comments', label: '주석', hint: '테이블·컬럼 주석' },
  { key: 'source', label: '스크립트', hint: '뷰·함수·프로시저·트리거 정의' },
];

export default function Sidebar() {
  const state = useAppState();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scopeOpen) return;
    const close = (e: globalThis.MouseEvent) => {
      if (!scopeRef.current?.contains(e.target as Node)) setScopeOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [scopeOpen]);

  const filter = state.treeFilter.trim().toLowerCase();
  const { scopes, allSchemas, running, result, error } = state.search;
  const connId = activeConnectionId(state);
  const session = sessionOf(connId, state);

  // 타이핑은 트리 이름 필터, Enter 는 항상 DB 전체 검색이다.
  const submit = () => {
    const term = state.treeFilter.trim();
    if (term.length < 2) {
      setSearch({ error: '검색어를 2글자 이상 입력하세요.', result: null });
      return;
    }
    if (!connId) {
      setSearch({ error: '접속을 먼저 열어야 검색할 수 있습니다.', result: null });
      return;
    }
    void runSearch(connId, term);
  };

  const toggleScope = (key: keyof SearchScopes) => {
    const next = { ...scopes, [key]: !scopes[key] };
    // 하나도 선택하지 않으면 검색할 대상이 없으므로 이름은 항상 남긴다.
    if (!Object.values(next).some(Boolean)) next.names = true;
    setSearch({ scopes: next, result: null, error: null });
  };

  const activeScopes = SCOPE_LABELS.filter((s) => scopes[s.key]).map((s) => s.label).join('·');
  // 기본은 전체 검색이다. 하나라도 껐으면 좁혀진 상태로 표시한다.
  const narrowed = !allSchemas || SCOPE_LABELS.some((s) => !scopes[s.key]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <input
          className="input search"
          placeholder="이름 필터 · Enter 로 전체 검색…" 
          value={state.treeFilter}
          onChange={(e) => {
            setState({ treeFilter: e.target.value });
            if (result) clearSearchResult();
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <div className="scope-box" ref={scopeRef}>
          <button
            className={`btn small scope-btn ${narrowed ? 'on' : ''}`}
            title={narrowed ? `검색 범위가 좁혀져 있습니다: ${activeScopes}` : '검색 범위: 전체'}
            onClick={() => setScopeOpen((v) => !v)}
          >
            범위 ▾
          </button>
          {scopeOpen && (
            <div className="scope-menu">
              <div className="scope-group">검색 대상</div>
              {SCOPE_LABELS.map((s) => (
                <label key={s.key} className="scope-row" title={s.hint}>
                  <input type="checkbox" checked={scopes[s.key]} onChange={() => toggleScope(s.key)} />
                  <span>{s.label}</span>
                  <em>{s.hint}</em>
                </label>
              ))}
              <div className="scope-group">범위</div>
              <label className="scope-row">
                <input
                  type="checkbox"
                  checked={allSchemas}
                  onChange={(e) => setSearch({ allSchemas: e.target.checked, result: null })}
                />
                <span>{session?.hasSchemaLevel ? '모든 스키마' : '모든 데이터베이스'}</span>
                <em>기본. 끄면 현재 {session?.hasSchemaLevel ? '스키마' : 'DB'}만</em>
              </label>
              <div className="scope-foot">
                타이핑하면 트리에서 이름을 걸러 내고, <b>Enter</b> 를 누르면 위 범위로 DB 에 직접 질의합니다.
              </div>
            </div>
          )}
        </div>
        {(filter || result) && (
          <button
            className="icon-btn"
            title="검색 지우기"
            onClick={() => { setState({ treeFilter: '' }); clearSearchResult(); }}
          >
            ×
          </button>
        )}
      </div>

      {running && <div className="pane-message">검색 중…</div>}
      {error && <div className="pane-message error">{error}</div>}

      {result && !running ? (
        <SearchResults
          connectionId={connId!}
          database={session?.currentDatabase ?? ''}
          result={result}
        />
      ) : (
        <div className="tree" role="tree">
          {state.connections.length === 0 && (
            <p className="tree-empty">등록된 접속이 없습니다.<br />상단의 <b>+ 접속</b> 버튼으로 추가하세요.</p>
          )}
          {state.connections.map((c) => (
            <ConnectionRow key={c.id} conn={c} state={state} filter={filter} onMenu={setMenu} />
          ))}
        </div>
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

interface RowProps {
  state: AppState;
  filter: string;
  onMenu: (m: MenuState) => void;
}

function ConnectionRow({ conn, state, filter, onMenu }: RowProps & { conn: ConnectionConfig }) {
  const id = nodeId.connection(conn.id);
  const session = state.sessions[conn.id];
  const connected = !!session?.connected;
  const expanded = !!state.expanded[id];
  const item: TreeItem = { id, type: 'connection', label: conn.name, connectionId: conn.id };

  const contextMenu = (e: MouseEvent) => {
    e.preventDefault();
    onMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        connected
          ? { label: '접속 끊기', action: () => void disconnect(conn.id) }
          : { label: '접속', action: () => void connect(conn) },
        {
          label: session?.stale ? '재연결 (연결 끊김)' : '재연결',
          disabled: !connected,
          action: () => void reconnect(conn.id),
        },
        { label: '새로 고침', disabled: !connected, action: () => void refreshNode(item) },
        {
          label: 'SQL 편집기 열기',
          disabled: !connected,
          action: () => openSqlTab(conn.id, session?.currentDatabase ?? '', session?.currentSchema ?? ''),
        },
        { label: '접속 설정 편집…', action: () => setState({ dialog: { kind: 'connection', connection: conn } }) },
        {
          label: '삭제',
          danger: true,
          action: () => {
            if (window.confirm(`'${conn.name}' 접속을 삭제할까요?`)) void deleteConnection(conn.id);
          },
        },
      ],
    });
  };

  return (
    <div className="tree-branch">
      <div
        className={`tree-row depth-0 ${connected ? '' : 'muted'}`}
        onContextMenu={contextMenu}
        onDoubleClick={() => (connected ? void toggleNode(item) : void connect(conn))}
      >
        <Twisty
          visible={connected}
          open={expanded}
          onClick={() => void toggleNode(item)}
        />
        <span className={`dot ${connected ? (session?.stale ? 'stale' : 'on') : 'off'}`} />
        <span className="tree-label">{conn.name}</span>
        <span className="tree-detail">{session?.stale ? '연결 끊김' : conn.kind}</span>
      </div>
      {connected && expanded && (
        <ChildList nodeKey={id} state={state} filter={filter} onMenu={onMenu} depth={1} />
      )}
    </div>
  );
}

function ChildList({ nodeKey, state, filter, onMenu, depth }: RowProps & { nodeKey: string; depth: number }) {
  const node = state.nodes[nodeKey];
  if (!node) return null;
  if (node.loading) return <div className={`tree-row depth-${depth} loading`}>불러오는 중…</div>;
  if (node.error) return <div className={`tree-row depth-${depth} error`} title={node.error}>{node.error}</div>;
  if (!node.children) return null;

  const visible = filter ? filterChildren(node.children, state, filter) : node.children;

  if (visible.length === 0) {
    return <div className={`tree-row depth-${depth} muted`}>{filter ? '검색 결과 없음' : '항목 없음'}</div>;
  }

  return (
    <>
      {visible.map((child) => (
        <ItemRow key={child.id} item={child} state={state} filter={filter} onMenu={onMenu} depth={depth} />
      ))}
    </>
  );
}

function isLeaf(item: TreeItem): boolean {
  return item.type === 'table' || item.type === 'view';
}

/** 자기 이름이 맞거나, 이미 읽어 둔 하위 항목 중에 맞는 게 있는지 */
function matchesLoaded(item: TreeItem, state: AppState, filter: string): boolean {
  if (item.label.toLowerCase().includes(filter)) return true;
  if (isLeaf(item)) return false;
  const node = state.nodes[item.id];
  if (!node || !node.children) return false;
  return node.children.some((c) => matchesLoaded(c, state, filter));
}

/** 아직 펼치지 않아 안에 무엇이 있는지 모르는 컨테이너 */
function isUnloadedContainer(item: TreeItem, state: AppState): boolean {
  return !isLeaf(item) && !state.nodes[item.id]?.children;
}

/**
 * 이름 필터로 남길 항목을 고른다.
 * 맞는 게 하나도 없으면, 아직 펼치지 않은 컨테이너는 남겨 둬서 안으로 들어가 볼 수 있게 한다.
 * (펼치지 않은 곳까지 한 번에 뒤지려면 '범위' 검색을 쓴다.)
 */
function filterChildren(children: TreeItem[], state: AppState, filter: string): TreeItem[] {
  const matched = children.filter((c) => matchesLoaded(c, state, filter));
  if (matched.length > 0) return matched;
  return children.filter((c) => isUnloadedContainer(c, state));
}

function ItemRow({ item, state, filter, onMenu, depth }: RowProps & { item: TreeItem; depth: number }) {
  const expanded = !!state.expanded[item.id];
  const leaf = isLeaf(item);

  const open = () => {
    if (!leaf) { void toggleNode(item); return; }
    openTableTab({
      connectionId: item.connectionId,
      database: item.database!,
      schema: item.schema!,
      table: item.table!,
      objectKind: item.type === 'view' ? 'view' : 'table',
    });
  };

  const contextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const items: MenuState['items'] = [];
    if (leaf) {
      items.push({ label: '데이터 열기', action: () => openTable(item, 'data') });
      items.push({ label: '속성 열기', action: () => openTable(item, 'properties') });
      items.push({ label: '관계도 열기', action: () => openTable(item, 'er') });
      items.push({
        label: 'SELECT 문 생성',
        action: () => openSqlTab(
          item.connectionId, item.database!, item.schema!,
          `SELECT * FROM ${item.schema}.${item.table};`,
        ),
      });
    } else {
      items.push({ label: '새로 고침', action: () => void refreshNode(item) });
      if (item.type === 'schema' || item.type === 'database') {
        items.push({
          label: 'SQL 편집기 열기',
          action: () => openSqlTab(item.connectionId, item.database!, item.schema ?? item.database!),
        });
      }
    }
    onMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div className="tree-branch">
      <div
        className={`tree-row depth-${depth} type-${item.type}`}
        onDoubleClick={open}
        onContextMenu={contextMenu}
      >
        <Twisty visible={!leaf} open={expanded} onClick={() => void toggleNode(item)} />
        <span className={`icon icon-${item.type}`} aria-hidden />
        <span className="tree-label">{item.label}</span>
        {item.detail && <span className="tree-detail">{item.detail}</span>}
      </div>
      {!leaf && expanded && (
        <ChildList nodeKey={item.id} state={state} filter={filter} onMenu={onMenu} depth={depth + 1} />
      )}
    </div>
  );
}

function openTable(item: TreeItem, section: 'properties' | 'data' | 'er') {
  openTableTab({
    connectionId: item.connectionId,
    database: item.database!,
    schema: item.schema!,
    table: item.table!,
    objectKind: item.type === 'view' ? 'view' : 'table',
    activeSection: section,
  });
}

function Twisty({ visible, open, onClick }: { visible: boolean; open: boolean; onClick: () => void }) {
  if (!visible) return <span className="twisty placeholder" />;
  return (
    <button
      className={`twisty ${open ? 'open' : ''}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      tabIndex={-1}
      aria-label={open ? '접기' : '펼치기'}
    />
  );
}
