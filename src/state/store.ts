import { useSyncExternalStore } from 'react';
import type {
  ConnectionConfig, SessionStatus, Tab, TableTab, SqlTab, HistoryTab, TxTab,
  SearchScopes, SearchResult, SavedSqlEditor,
} from '../types';

export type TreeItemType = 'connection' | 'database' | 'schema' | 'table' | 'view';

export interface TreeItem {
  id: string;
  type: TreeItemType;
  label: string;
  connectionId: string;
  database?: string;
  schema?: string;
  table?: string;
  detail?: string;
}

export interface TreeNodeState {
  loading: boolean;
  error: string | null;
  children: TreeItem[] | null;
}

export interface Toast {
  kind: 'info' | 'error' | 'success';
  message: string;
  at: number;
}

/** 사이드바 객체 검색 상태 */
export interface SearchState {
  scopes: SearchScopes;
  /** 현재 스키마만 볼지, 접속의 모든 스키마를 볼지 */
  allSchemas: boolean;
  running: boolean;
  result: SearchResult | null;
  error: string | null;
}

export interface AppState {
  connections: ConnectionConfig[];
  sessions: Record<string, SessionStatus>;
  expanded: Record<string, boolean>;
  nodes: Record<string, TreeNodeState>;
  tabs: Tab[];
  activeTabId: string | null;
  treeFilter: string;
  search: SearchState;
  toast: Toast | null;
  /** SQL 편집기 목록 패널 표시 여부 */
  sqlListOpen: boolean;
  /** 빈 줄도 문장 구분자로 볼지 (설정 파일에 저장된다) */
  splitOnBlankLine: boolean;
  dialog:
    | { kind: 'connection'; connection: ConnectionConfig | null }
    | { kind: 'password'; connection: ConnectionConfig }
    | { kind: 'txConfirm'; connectionId: string; action: 'commit' | 'rollback' }
    | null;
}

const initialState: AppState = {
  connections: [],
  sessions: {},
  expanded: {},
  nodes: {},
  tabs: [],
  activeTabId: null,
  treeFilter: '',
  search: {
    // 기본은 넓게 찾는다. 좁히고 싶을 때만 범위를 끈다.
    scopes: { names: true, columns: true, comments: true, source: true },
    allSchemas: true,
    running: false,
    result: null,
    error: null,
  },
  toast: null,
  sqlListOpen: false,
  splitOnBlankLine: false,
  dialog: null,
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ---- 파생 헬퍼 --------------------------------------------------------------

export function activeTab(s: AppState = state): Tab | null {
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
}

export function activeConnectionId(s: AppState = state): string | null {
  const t = activeTab(s);
  // 히스토리 탭처럼 특정 접속에 묶이지 않은 탭도 있으므로 빈 값이면 다음 후보로 넘어간다.
  if (t?.connectionId) return t.connectionId;
  const open = Object.keys(s.sessions).filter((id) => s.sessions[id]?.connected);
  return open.length === 1 ? open[0] : null;
}

export function sessionOf(connectionId: string | null, s: AppState = state): SessionStatus | null {
  return connectionId ? (s.sessions[connectionId] ?? null) : null;
}

export function connectionOf(connectionId: string | null, s: AppState = state): ConnectionConfig | null {
  return s.connections.find((c) => c.id === connectionId) ?? null;
}

// ---- 액션 -------------------------------------------------------------------

export function notify(kind: Toast['kind'], message: string): void {
  setState({ toast: { kind, message, at: Date.now() } });
}

export function clearToast(): void {
  setState({ toast: null });
}

export function setNode(id: string, patch: Partial<TreeNodeState>): void {
  setState((s) => {
    const base: TreeNodeState = s.nodes[id] ?? { loading: false, error: null, children: null };
    return { nodes: { ...s.nodes, [id]: { ...base, ...patch } } };
  });
}

export function setExpanded(id: string, value: boolean): void {
  setState((s) => ({ expanded: { ...s.expanded, [id]: value } }));
}

export function setSession(connectionId: string, status: SessionStatus): void {
  setState((s) => ({ sessions: { ...s.sessions, [connectionId]: status } }));
}

export function setSearch(patch: Partial<SearchState>): void {
  setState((s) => ({ search: { ...s.search, ...patch } }));
}

export function clearSearchResult(): void {
  setSearch({ result: null, error: null });
}

// ---- 저장 알림 ---------------------------------------------------------------
// SQL 편집기 목록이 바뀌면 파일에 남겨야 한다. store 가 workspace 를 직접 부르면
// 순환 import 가 되므로, 저장 담당이 여기에 자기를 등록한다.

let workspaceListener: (() => void) | null = null;

export function setWorkspaceListener(fn: (() => void) | null): void {
  workspaceListener = fn;
}

/** SQL 편집기 구성(목록·제목·활성 탭)이 바뀌었음을 알린다. */
export function workspaceChanged(): void {
  if (workspaceListener) workspaceListener();
}

export function tableTabId(connectionId: string, database: string, schema: string, table: string): string {
  return `table:${connectionId}:${database}:${schema}:${table}`;
}

export function openTableTab(tab: Omit<TableTab, 'id' | 'kind' | 'activeSection'> & { activeSection?: TableTab['activeSection'] }): void {
  const id = tableTabId(tab.connectionId, tab.database, tab.schema, tab.table);
  setState((s) => {
    const found = s.tabs.find((t) => t.id === id);
    if (found) return { activeTabId: id };
    const next: TableTab = { id, kind: 'table', activeSection: tab.activeSection ?? 'data', ...tab };
    return { tabs: [...s.tabs, next], activeTabId: id };
  });
}

let sqlSeq = 0;

/**
 * 새 SQL 편집기 탭을 연다.
 * initialSql 은 탭이 그려지기 전에 미리 넣어 둔다. 탭을 만든 직후 이벤트로 보내면
 * 편집기가 아직 붙기 전이라 놓칠 수 있다.
 */
export function openSqlTab(connectionId: string, database: string, schema: string, initialSql?: string): void {
  sqlSeq += 1;
  const id = `sql:${connectionId}:${sqlSeq}`;
  const tab: SqlTab = { id, kind: 'sql', connectionId, database, schema, title: `SQL ${sqlSeq}` };
  if (initialSql) setTabScratch(id, 'sql', initialSql);
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
  workspaceChanged();
}

/**
 * 저장해 둔 SQL 편집기를 되살린다.
 * 접속이 아직 열려 있지 않아도 탭은 그대로 뜨고, 내용은 남아 있다.
 */
export function restoreSqlTabs(editors: SavedSqlEditor[], activeId: string | null): void {
  const restored: SqlTab[] = [];
  for (const e of editors) {
    if (!e.id) continue;
    restored.push({
      id: e.id,
      kind: 'sql',
      connectionId: e.connectionId,
      database: e.database,
      schema: e.schema,
      title: e.title,
    });
    setTabScratch(e.id, 'sql', e.sql ?? '');
    if (typeof e.editorRatio === 'number') setTabScratch(e.id, 'editorRatio', e.editorRatio);
    // 새로 만드는 탭 번호가 되살린 것과 겹치지 않게 올려 둔다.
    const n = Number(/:(\d+)$/.exec(e.id)?.[1]);
    if (Number.isFinite(n)) sqlSeq = Math.max(sqlSeq, n);
  }
  if (!restored.length) return;
  setState((s) => {
    const fresh = restored.filter((t) => !s.tabs.some((x) => x.id === t.id));
    const tabs = [...s.tabs, ...fresh];
    const wanted = activeId && tabs.some((t) => t.id === activeId) ? activeId : null;
    return { tabs, activeTabId: s.activeTabId ?? wanted ?? fresh[0]?.id ?? null };
  });
}

/** 접속별 변경 내역 탭을 열거나 이미 열려 있으면 그 탭으로 이동한다. */
export function openTxTab(connectionId: string): void {
  const id = `tx:${connectionId}`;
  setState((s) => {
    if (s.tabs.some((t) => t.id === id)) return { activeTabId: id };
    const session = s.sessions[connectionId];
    const conn = s.connections.find((c) => c.id === connectionId);
    const tab: TxTab = {
      id,
      kind: 'tx',
      connectionId,
      database: session?.currentDatabase ?? '',
      schema: session?.currentSchema ?? '',
      title: `변경 내역${conn ? ` · ${conn.name}` : ''}`,
    };
    return { tabs: [...s.tabs, tab], activeTabId: id };
  });
}

/** 열려 있는 SQL 편집기 목록 (목록 패널에서 쓴다) */
export function sqlTabs(s: AppState = state): SqlTab[] {
  return s.tabs.filter((t): t is SqlTab => t.kind === 'sql');
}

export function closeTabs(ids: string[]): void {
  ids.forEach(closeTab);
}

/** 이 탭만 남기고 모두 닫는다. */
export function closeOtherTabs(keepId: string): void {
  closeTabs(state.tabs.filter((t) => t.id !== keepId).map((t) => t.id));
}

/** 이 탭보다 오른쪽에 있는 탭을 닫는다. */
export function closeTabsToRight(fromId: string): void {
  const idx = state.tabs.findIndex((t) => t.id === fromId);
  if (idx < 0) return;
  closeTabs(state.tabs.slice(idx + 1).map((t) => t.id));
}

export function closeAllTabs(): void {
  closeTabs(state.tabs.map((t) => t.id));
}

export function closeTab(id: string): void {
  setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return {};
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeTabId = s.activeTabId;
    if (s.activeTabId === id) {
      const neighbour = tabs[idx] ?? tabs[idx - 1] ?? null;
      activeTabId = neighbour ? neighbour.id : null;
    }
    return { tabs, activeTabId };
  });
  disposeTabState(id);
  workspaceChanged();
}

/**
 * 접속을 끊을 때 그 접속의 탭을 닫는다.
 * 다만 SQL 편집기는 남긴다 — 사용자가 쓴 글이라 접속 상태와 함께 버릴 것이 아니다.
 * 접속이 없는 동안에는 편집기가 '접속 안 됨' 안내를 띄운다.
 */
export function closeTabsOfConnection(connectionId: string): void {
  const ids = state.tabs
    .filter((t) => t.connectionId === connectionId && t.kind !== 'sql')
    .map((t) => t.id);
  ids.forEach(closeTab);
}

export function setActiveTab(id: string): void {
  setState({ activeTabId: id });
  workspaceChanged();
}

export function updateTab(
  id: string,
  patch: Partial<TableTab> | Partial<SqlTab> | Partial<HistoryTab> | Partial<TxTab>,
): void {
  setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)),
  }));
  workspaceChanged();
}

// ---- 탭별 비반응 상태 --------------------------------------------------------
// SQL 본문이나 그리드 스크롤처럼 자주 바뀌는 값은 전역 리렌더를 유발하지 않도록
// 별도 맵에 보관하고, 탭이 닫힐 때 함께 버린다.

const tabScratch = new Map<string, Record<string, unknown>>();

export function getTabScratch<T>(tabId: string, key: string, fallback: T): T {
  const bag = tabScratch.get(tabId);
  return bag && key in bag ? (bag[key] as T) : fallback;
}

export function setTabScratch(tabId: string, key: string, value: unknown): void {
  const bag = tabScratch.get(tabId) ?? {};
  bag[key] = value;
  tabScratch.set(tabId, bag);
}

function disposeTabState(tabId: string): void {
  tabScratch.delete(tabId);
}
