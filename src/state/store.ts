import { useSyncExternalStore } from 'react';
import type {
  ConnectionConfig, SessionStatus, Tab, TableTab, SqlTab, HistoryTab,
  SearchScopes, SearchResult,
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
  dialog: { kind: 'connection'; connection: ConnectionConfig | null } | { kind: 'password'; connection: ConnectionConfig } | null;
}

/** 이름만 찾을 때는 트리에서 바로 거르고, 나머지는 DB 에 물어봐야 한다. */
export function needsServerSearch(scopes: SearchScopes): boolean {
  return scopes.columns || scopes.comments || scopes.source;
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
    scopes: { names: true, columns: false, comments: false, source: false },
    allSchemas: false,
    running: false,
    result: null,
    error: null,
  },
  toast: null,
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
}

export function closeTabsOfConnection(connectionId: string): void {
  const ids = state.tabs.filter((t) => t.connectionId === connectionId).map((t) => t.id);
  ids.forEach(closeTab);
}

export function setActiveTab(id: string): void {
  setState({ activeTabId: id });
}

export function updateTab(id: string, patch: Partial<TableTab> | Partial<SqlTab> | Partial<HistoryTab>): void {
  setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)),
  }));
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
