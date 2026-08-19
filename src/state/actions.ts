import type { ConnectionConfig, DatabaseMeta, SchemaMeta, TableMeta } from '../types';
import {
  getState, setState, setNode, setExpanded, setSession, setSearch, notify,
  closeTabsOfConnection, type TreeItem,
} from './store';

const api = () => {
  if (!window.api) throw new Error('데스크톱 브리지를 사용할 수 없습니다. Electron 앱으로 실행하세요.');
  return window.api;
};

export const nodeId = {
  connection: (c: string) => `conn:${c}`,
  database: (c: string, d: string) => `db:${c}:${d}`,
  schema: (c: string, d: string, s: string) => `schema:${c}:${d}:${s}`,
  table: (c: string, d: string, s: string, t: string) => `table:${c}:${d}:${s}:${t}`,
};

// ---- 접속 -------------------------------------------------------------------

/** 저장해 둔 설정을 읽어 화면 상태에 반영한다. */
export async function loadSettings(): Promise<void> {
  try {
    const s = await api().settings.get();
    setState({ splitOnBlankLine: !!s.splitOnBlankLine });
  } catch (e) {
    notify('error', message(e));
  }
}

/** 문장 구분 방식을 바꾸고 설정 파일에도 남긴다. */
export async function setSplitOnBlankLine(value: boolean): Promise<void> {
  setState({ splitOnBlankLine: value });
  try {
    await api().settings.set({ splitOnBlankLine: value });
  } catch (e) {
    notify('error', message(e));
  }
}

export async function loadConnections(): Promise<void> {
  try {
    setState({ connections: await api().connections.list() });
  } catch (e) {
    notify('error', message(e));
  }
}

export async function saveConnection(conn: Partial<ConnectionConfig>): Promise<ConnectionConfig | null> {
  try {
    const saved = await api().connections.save(conn);
    await loadConnections();
    return saved;
  } catch (e) {
    notify('error', message(e));
    return null;
  }
}

export async function deleteConnection(id: string): Promise<void> {
  try {
    await disconnect(id);
    await api().connections.remove(id);
    await loadConnections();
  } catch (e) {
    notify('error', message(e));
  }
}

export async function connect(conn: ConnectionConfig, password?: string): Promise<boolean> {
  // 빈 문자열은 "비밀번호 없음"이라는 유효한 입력이므로 미입력(undefined)과 구분한다.
  if (!conn.hasSavedPassword && password === undefined) {
    setState({ dialog: { kind: 'password', connection: conn } });
    return false;
  }
  const root = nodeId.connection(conn.id);
  setNode(root, { loading: true, error: null });
  try {
    const status = await api().connections.connect(conn.id, password);
    setSession(conn.id, status);
    setNode(root, { loading: false, error: null, children: null });
    setExpanded(root, true);
    await loadChildren({ id: root, type: 'connection', label: conn.name, connectionId: conn.id });
    notify('success', `${conn.name} 에 접속했습니다.`);
    return true;
  } catch (e) {
    setNode(root, { loading: false, error: message(e) });
    notify('error', `접속 실패: ${message(e)}`);
    return false;
  }
}

export async function disconnect(id: string): Promise<void> {
  const session = getState().sessions[id];
  if (session?.txActive) {
    const ok = window.confirm('커밋되지 않은 트랜잭션이 있습니다. 롤백하고 접속을 끊을까요?');
    if (!ok) return;
  }
  try {
    await api().connections.disconnect(id);
  } catch (e) {
    notify('error', message(e));
  }
  closeTabsOfConnection(id);
  setState((s) => {
    const sessions = { ...s.sessions };
    delete sessions[id];
    const nodes = { ...s.nodes };
    const expanded = { ...s.expanded };
    for (const key of Object.keys(nodes)) if (key.includes(`:${id}:`) || key === nodeId.connection(id)) delete nodes[key];
    for (const key of Object.keys(expanded)) if (key.includes(`:${id}:`) || key === nodeId.connection(id)) delete expanded[key];
    return { sessions, nodes, expanded };
  });
}

// ---- 트리 -------------------------------------------------------------------

export async function toggleNode(item: TreeItem): Promise<void> {
  const s = getState();
  const isOpen = !!s.expanded[item.id];
  setExpanded(item.id, !isOpen);
  if (!isOpen && !s.nodes[item.id]?.children) await loadChildren(item);
}

export async function refreshNode(item: TreeItem): Promise<void> {
  setNode(item.id, { children: null });
  await loadChildren(item);
}

export async function loadChildren(item: TreeItem): Promise<void> {
  const connId = item.connectionId;
  setNode(item.id, { loading: true, error: null });
  try {
    let children: TreeItem[] = [];

    if (item.type === 'connection') {
      const dbs: DatabaseMeta[] = await api().meta.get(connId, 'databases');
      children = dbs.map((d) => ({
        id: nodeId.database(connId, d.name),
        type: 'database' as const,
        label: d.name,
        connectionId: connId,
        database: d.name,
        detail: d.charset ?? undefined,
      }));
    } else if (item.type === 'database') {
      const session = getState().sessions[connId];
      const db = item.database!;
      if (session?.hasSchemaLevel) {
        // PostgreSQL 은 접속이 데이터베이스 단위이므로 다른 DB 를 펼치면 재접속한다.
        if (session.currentDatabase !== db) await switchDatabase(connId, db);
        const schemas: SchemaMeta[] = await api().meta.get(connId, 'schemas');
        children = schemas.map((x) => ({
          id: nodeId.schema(connId, db, x.name),
          type: 'schema' as const,
          label: x.name,
          connectionId: connId,
          database: db,
          schema: x.name,
        }));
      } else {
        children = await loadTables(connId, db, db);
      }
    } else if (item.type === 'schema') {
      children = await loadTables(connId, item.database!, item.schema!);
    }

    setNode(item.id, { loading: false, error: null, children });
  } catch (e) {
    setNode(item.id, { loading: false, error: message(e), children: [] });
  }
}

async function loadTables(connId: string, database: string, schema: string): Promise<TreeItem[]> {
  const tables: TableMeta[] = await api().meta.get(connId, 'tables', { schema });
  return tables.map((t) => ({
    id: nodeId.table(connId, database, schema, t.name),
    type: t.kind === 'view' ? ('view' as const) : ('table' as const),
    label: t.name,
    connectionId: connId,
    database,
    schema,
    table: t.name,
    detail: t.comment || undefined,
  }));
}

// ---- 스키마 / 데이터베이스 전환 ----------------------------------------------

export async function switchSchema(connectionId: string, schema: string): Promise<void> {
  try {
    setSession(connectionId, await api().meta.setSchema(connectionId, schema));
  } catch (e) {
    notify('error', message(e));
  }
}

export async function switchDatabase(connectionId: string, database: string): Promise<void> {
  const status = await api().meta.setDatabase(connectionId, database);
  setSession(connectionId, status);
  // 재접속으로 다른 데이터베이스의 캐시가 무효해지므로 트리 캐시를 비운다.
  setState((s) => {
    const nodes = { ...s.nodes };
    for (const key of Object.keys(nodes)) {
      if (key.startsWith(`db:${connectionId}:`) && key !== nodeId.database(connectionId, database)) {
        delete nodes[key];
      }
      if (key.startsWith(`schema:${connectionId}:`) && !key.startsWith(`schema:${connectionId}:${database}:`)) {
        delete nodes[key];
      }
    }
    return { nodes };
  });
}

// ---- 객체 검색 ---------------------------------------------------------------

/**
 * 이름·컬럼·주석·정의 스크립트에서 객체를 찾는다.
 * 대상 스키마는 "현재 스키마만" 또는 접속의 모든 스키마 중에서 고른다.
 */
export async function runSearch(connectionId: string, term: string): Promise<void> {
  const s = getState();
  const { scopes, allSchemas } = s.search;
  const session = s.sessions[connectionId];
  if (!session?.connected) {
    setSearch({ error: '접속을 먼저 열어야 검색할 수 있습니다.', result: null });
    return;
  }

  setSearch({ running: true, error: null });
  try {
    let schemas: string[] | undefined;
    if (allSchemas) {
      // MySQL 은 데이터베이스가 곧 스키마라서 목록을 그대로 쓴다.
      const list: { name: string }[] = session.hasSchemaLevel
        ? await api().meta.get(connectionId, 'schemas')
        : await api().meta.get(connectionId, 'databases');
      schemas = list.map((x) => x.name);
    }
    const result = await api().meta.search(connectionId, { term, schemas, scopes });
    setSearch({ running: false, result, error: null });
  } catch (e) {
    setSearch({ running: false, result: null, error: message(e) });
  }
}

// ---- 트랜잭션 ---------------------------------------------------------------

export async function setAutoCommit(connectionId: string, value: boolean): Promise<void> {
  try {
    setSession(connectionId, await api().tx.setAutoCommit(connectionId, value));
    notify('info', value ? '자동 커밋 모드로 전환했습니다.' : '수동 커밋 모드로 전환했습니다.');
  } catch (e) {
    notify('error', message(e));
  }
}

/**
 * 커밋·롤백을 요청한다.
 * 트랜잭션이 열려 있으면 변경 내역을 보여 주는 확인창을 먼저 띄우고,
 * 확정할 것이 없으면 바로 알려 주기만 한다.
 */
export async function requestFinishTx(connectionId: string, action: 'commit' | 'rollback'): Promise<void> {
  const session = getState().sessions[connectionId];
  if (!session?.txActive) {
    notify('info', action === 'commit' ? '커밋할 변경 사항이 없습니다.' : '롤백할 변경 사항이 없습니다.');
    return;
  }
  setState({ dialog: { kind: 'txConfirm', connectionId, action } });
}

/** 확인창에서 확정한 뒤 실제로 커밋·롤백한다. */
export async function finishTx(connectionId: string, action: 'commit' | 'rollback'): Promise<boolean> {
  try {
    const res = action === 'commit'
      ? await api().tx.commit(connectionId)
      : await api().tx.rollback(connectionId);
    setSession(connectionId, res.status);
    const count = res.entries.length;
    const rows = res.entries.reduce((sum, e) => sum + (e.affected || 0), 0);
    if (action === 'commit') {
      notify('success', `커밋했습니다 — 문장 ${count}건, 행 ${rows.toLocaleString()}개.`);
    } else {
      notify('info', `롤백했습니다 — 문장 ${count}건을 되돌렸습니다.`);
    }
    return true;
  } catch (e) {
    notify('error', `${action === 'commit' ? '커밋' : '롤백'} 실패: ${message(e)}`);
    return false;
  }
}

export const commit = (connectionId: string) => requestFinishTx(connectionId, 'commit');
export const rollback = (connectionId: string) => requestFinishTx(connectionId, 'rollback');

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
