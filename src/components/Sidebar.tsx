import { useEffect, useState, type MouseEvent } from 'react';
import {
  useAppState, setState, openTableTab, openSqlTab,
  type TreeItem, type AppState,
} from '../state/store';
import { connect, disconnect, deleteConnection, toggleNode, refreshNode, nodeId } from '../state/actions';
import type { ConnectionConfig } from '../types';

interface MenuState {
  x: number;
  y: number;
  items: { label: string; action: () => void; danger?: boolean; disabled?: boolean }[];
}

export default function Sidebar() {
  const state = useAppState();
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const filter = state.treeFilter.trim().toLowerCase();

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <input
          className="input search"
          placeholder="테이블 검색…"
          value={state.treeFilter}
          onChange={(e) => setState({ treeFilter: e.target.value })}
        />
        {filter && (
          <button className="icon-btn" title="검색 지우기" onClick={() => setState({ treeFilter: '' })}>×</button>
        )}
      </div>

      <div className="tree" role="tree">
        {state.connections.length === 0 && (
          <p className="tree-empty">등록된 접속이 없습니다.<br />상단의 <b>+ 접속</b> 버튼으로 추가하세요.</p>
        )}
        {state.connections.map((c) => (
          <ConnectionRow key={c.id} conn={c} state={state} filter={filter} onMenu={setMenu} />
        ))}
      </div>

      {menu && (
        <ul className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.items.map((it, i) => (
            <li key={i}>
              <button
                className={it.danger ? 'danger' : ''}
                disabled={it.disabled}
                onClick={() => { setMenu(null); it.action(); }}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
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
        <span className={`dot ${connected ? 'on' : 'off'}`} />
        <span className="tree-label">{conn.name}</span>
        <span className="tree-detail">{conn.kind}</span>
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

  const visible = filter
    ? node.children.filter((c) =>
        c.type === 'table' || c.type === 'view'
          ? c.label.toLowerCase().includes(filter)
          : true)
    : node.children;

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

function ItemRow({ item, state, filter, onMenu, depth }: RowProps & { item: TreeItem; depth: number }) {
  const expanded = !!state.expanded[item.id];
  const isLeaf = item.type === 'table' || item.type === 'view';

  const open = () => {
    if (!isLeaf) { void toggleNode(item); return; }
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
    if (isLeaf) {
      items.push({ label: '데이터 열기', action: () => openTable(item, 'data') });
      items.push({ label: '속성 열기', action: () => openTable(item, 'properties') });
      items.push({ label: '관계도 열기', action: () => openTable(item, 'er') });
      items.push({
        label: 'SELECT 문 생성',
        action: () => {
          openSqlTab(item.connectionId, item.database!, item.schema!);
          window.dispatchEvent(new CustomEvent('dbstudio:insert-sql', {
            detail: `SELECT * FROM ${item.schema}.${item.table};`,
          }));
        },
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
        <Twisty visible={!isLeaf} open={expanded} onClick={() => void toggleNode(item)} />
        <span className={`icon icon-${item.type}`} aria-hidden />
        <span className="tree-label">{item.label}</span>
        {item.detail && <span className="tree-detail">{item.detail}</span>}
      </div>
      {!isLeaf && expanded && (
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
