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
  /** 왼쪽(0) 화면의 활성 탭 */
  activeTabId: string | null;
  /** 오른쪽(1) 화면의 활성 탭. 분할이 없으면 null */
  splitActiveTabId: string | null;
  /** 마지막으로 만진 화면. 새 탭·툴바·상태 표시줄이 이쪽을 따라간다 */
  focusedPane: 0 | 1;
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
  splitActiveTabId: null,
  focusedPane: 0,
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
  // 바뀐 게 없으면 알리지 않는다. 빈 패치로도 새 객체를 만들면 모든 구독자가
  // 다시 그려지고, 그 리렌더가 CodeMirror 재구성 같은 부작용을 일으킨다.
  if (Object.keys(next).length === 0) return;
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

/** 탭이 속한 화면 (0=왼쪽, 1=오른쪽) */
export function paneOf(tab: Tab): 0 | 1 {
  return tab.pane === 1 ? 1 : 0;
}

/** 한 화면에 속한 탭들 (렌더링 순서 = 전체 배열 순서) */
export function paneTabs(s: AppState, pane: 0 | 1): Tab[] {
  return s.tabs.filter((t) => paneOf(t) === pane);
}

/** 화면 분할 중인지 */
export function isSplit(s: AppState = state): boolean {
  return s.tabs.some((t) => paneOf(t) === 1);
}

export function paneActiveId(s: AppState, pane: 0 | 1): string | null {
  return pane === 1 ? s.splitActiveTabId : s.activeTabId;
}

/** 포커스된 화면의 활성 탭. 그 화면이 비어 있으면 반대쪽을 본다. */
export function activeTab(s: AppState = state): Tab | null {
  const find = (id: string | null) => s.tabs.find((t) => t.id === id) ?? null;
  return find(paneActiveId(s, s.focusedPane)) ?? find(paneActiveId(s, s.focusedPane === 1 ? 0 : 1));
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

/** 탭을 활성으로 만드는 상태 조각. 탭이 속한 화면의 활성만 바꾸고 그쪽에 포커스를 준다. */
function activatePatch(tab: Tab): Partial<AppState> {
  return paneOf(tab) === 1
    ? { splitActiveTabId: tab.id, focusedPane: 1 }
    : { activeTabId: tab.id, focusedPane: 0 };
}

/** 새 탭을 포커스된 화면에 넣고 활성으로 만든다. */
export function pushTab(tab: Tab): void {
  setState((s) => {
    const withPane = { ...tab, pane: s.focusedPane } as Tab;
    return { tabs: [...s.tabs, withPane], ...activatePatch(withPane) };
  });
  workspaceChanged();
}

export function openTableTab(tab: Omit<TableTab, 'id' | 'kind' | 'activeSection'> & { activeSection?: TableTab['activeSection'] }): void {
  const id = tableTabId(tab.connectionId, tab.database, tab.schema, tab.table);
  const found = state.tabs.find((t) => t.id === id);
  if (found) {
    setState(() => activatePatch(found));
    return;
  }
  pushTab({ id, kind: 'table', activeSection: tab.activeSection ?? 'data', ...tab });
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
  pushTab(tab);
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
      pane: e.pane === 1 ? 1 : 0,
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
    const leftFresh = fresh.filter((t) => paneOf(t) === 0);
    const rightFresh = fresh.filter((t) => paneOf(t) === 1);
    const wanted = activeId ? tabs.find((t) => t.id === activeId) ?? null : null;
    return {
      tabs,
      activeTabId: s.activeTabId
        ?? (wanted && paneOf(wanted) === 0 ? wanted.id : null)
        ?? leftFresh[0]?.id ?? null,
      splitActiveTabId: s.splitActiveTabId
        ?? (wanted && paneOf(wanted) === 1 ? wanted.id : null)
        ?? rightFresh[0]?.id ?? null,
    };
  });
}

/** 접속별 변경 내역 탭을 열거나 이미 열려 있으면 그 탭으로 이동한다. */
export function openTxTab(connectionId: string): void {
  const id = `tx:${connectionId}`;
  const found = state.tabs.find((t) => t.id === id);
  if (found) {
    setState(() => activatePatch(found));
    return;
  }
  const session = state.sessions[connectionId];
  const conn = state.connections.find((c) => c.id === connectionId);
  pushTab({
    id,
    kind: 'tx',
    connectionId,
    database: session?.currentDatabase ?? '',
    schema: session?.currentSchema ?? '',
    title: `변경 내역${conn ? ` · ${conn.name}` : ''}`,
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

/** 같은 화면에서 이 탭보다 오른쪽에 있는 탭을 닫는다. */
export function closeTabsToRight(fromId: string): void {
  const from = state.tabs.find((t) => t.id === fromId);
  if (!from) return;
  const inPane = paneTabs(state, paneOf(from));
  const idx = inPane.findIndex((t) => t.id === fromId);
  closeTabs(inPane.slice(idx + 1).map((t) => t.id));
}

export function closeAllTabs(): void {
  closeTabs(state.tabs.map((t) => t.id));
}

export function closeTab(id: string): void {
  setState((s) => {
    const closing = s.tabs.find((t) => t.id === id);
    if (!closing) return {};
    const pane = paneOf(closing);
    const before = paneTabs(s, pane);
    const idxInPane = before.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);

    const patch: Partial<AppState> = { tabs };
    if (paneActiveId(s, pane) === id) {
      const rest = before.filter((t) => t.id !== id);
      const neighbour = rest[idxInPane] ?? rest[idxInPane - 1] ?? null;
      if (pane === 1) patch.splitActiveTabId = neighbour?.id ?? null;
      else patch.activeTabId = neighbour?.id ?? null;
    }
    // 오른쪽 화면이 비면 분할을 접는다.
    if (!tabs.some((t) => paneOf(t) === 1)) {
      patch.splitActiveTabId = null;
      patch.focusedPane = 0;
    }
    return patch;
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
  setState((s) => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return {};
    return activatePatch(tab);
  });
  workspaceChanged();
}

export function setFocusedPane(pane: 0 | 1): void {
  setState((s) => (s.focusedPane === pane ? {} : { focusedPane: pane }));
}

/**
 * 탭을 다른 위치·화면으로 옮긴다 (드래그로 순서 바꾸기 / 화면 분할).
 * beforeId 앞에 끼워 넣고, 없으면 그 화면의 맨 뒤로 보낸다.
 * 옮긴 탭은 도착한 화면에서 활성이 된다.
 */
export function moveTab(dragId: string, target: { pane: 0 | 1; beforeId?: string | null }): void {
  setState((s) => {
    const dragged = s.tabs.find((t) => t.id === dragId);
    if (!dragged) return {};
    if (target.beforeId === dragId) return {};
    const fromPane = paneOf(dragged);
    const moved = { ...dragged, pane: target.pane } as Tab;

    const tabs = s.tabs.filter((t) => t.id !== dragId);
    const at = target.beforeId ? tabs.findIndex((t) => t.id === target.beforeId) : -1;
    if (at >= 0) tabs.splice(at, 0, moved);
    else tabs.push(moved);

    const patch: Partial<AppState> = { tabs, ...activatePatch(moved) };
    // 원래 화면에서 활성이었다면 그 화면의 활성을 남은 탭으로 넘긴다.
    if (fromPane !== target.pane && paneActiveId(s, fromPane) === dragId) {
      const rest = tabs.filter((t) => paneOf(t) === fromPane);
      if (fromPane === 1) patch.splitActiveTabId = rest[0]?.id ?? null;
      else patch.activeTabId = rest[0]?.id ?? null;
    }
    // 오른쪽 화면이 비면 분할을 접는다.
    if (!tabs.some((t) => paneOf(t) === 1)) {
      patch.splitActiveTabId = null;
      if (patch.focusedPane === 1) patch.focusedPane = 0;
    }
    return patch;
  });
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
