import { useState, type DragEvent, type MouseEvent } from 'react';
import ContextMenu, { type MenuState } from './ContextMenu';
import {
  useAppState, setActiveTab, closeTab, closeOtherTabs, closeTabsToRight, closeAllTabs,
  connectionOf, getTabScratch, getState, paneTabs, paneActiveId, moveTab, isSplit,
} from '../state/store';
import type { Tab } from '../types';

const TAB_ICON: Record<Tab['kind'], string> = { table: 'table', sql: 'sql', history: 'history', tx: 'tx' };

const TAB_SUB: Partial<Record<Tab['kind'], string>> = { history: '전체', tx: '트랜잭션' };

/**
 * 드래그 중인 탭. dataTransfer 는 drop 전에 내용을 읽을 수 없어서
 * (dragover 에서는 타입만 보인다) 모듈 변수로 함께 들고 다닌다.
 */
let draggingTabId: string | null = null;

export function draggedTabId(): string | null {
  return draggingTabId;
}

export default function TabBar({ pane }: { pane: 0 | 1 }) {
  const state = useAppState();
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 드롭 위치 미리보기: 이 탭 앞에 끼워 넣는다는 표시
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [dropEnd, setDropEnd] = useState(false);

  const tabs = paneTabs(state, pane);
  if (tabs.length === 0) return null;

  const split = isSplit(state);
  const activeId = paneActiveId(state, pane);

  const clearDrop = () => { setDropBefore(null); setDropEnd(false); };

  const openMenu = (e: MouseEvent, tab: Tab) => {
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === tab.id);
    const rightCount = tabs.length - idx - 1;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: '닫기', action: () => confirmThen([tab.id], () => closeTab(tab.id)) },
        {
          label: pane === 0 ? '오른쪽 분할로 이동' : '왼쪽으로 이동',
          action: () => moveTab(tab.id, { pane: pane === 0 ? 1 : 0 }),
          separated: true,
        },
        {
          label: `오른쪽 탭 닫기${rightCount ? ` (${rightCount})` : ''}`,
          disabled: rightCount === 0,
          action: () => confirmThen(tabs.slice(idx + 1).map((t) => t.id), () => closeTabsToRight(tab.id)),
          separated: true,
        },
        {
          label: '다른 탭 모두 닫기',
          disabled: state.tabs.length <= 1,
          action: () => confirmThen(state.tabs.filter((t) => t.id !== tab.id).map((t) => t.id), () => closeOtherTabs(tab.id)),
        },
        {
          label: `탭 모두 닫기 (${state.tabs.length})`,
          danger: true,
          action: () => confirmThen(state.tabs.map((t) => t.id), closeAllTabs),
        },
      ],
    });
  };

  /**
   * 이 탭 위의 좌표가 가리키는 끼워 넣을 위치.
   * 왼쪽 절반이면 그 탭 앞, 오른쪽 절반이면 다음 탭 앞 (없으면 맨 뒤 = null).
   * dragover 의 미리보기와 drop 의 실제 이동이 같은 계산을 쓴다 —
   * 미리보기 상태는 그리기 전일 수 있어 drop 이 상태에 기대면 어긋난다.
   */
  const insertPosAt = (e: DragEvent, tab: Tab, idx: number): string | null => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX < box.left + box.width / 2) return tab.id;
    return tabs[idx + 1]?.id ?? null;
  };

  const overTab = (e: DragEvent, tab: Tab, idx: number) => {
    if (!draggingTabId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const before = insertPosAt(e, tab, idx);
    setDropBefore(before);
    setDropEnd(before === null);
  };

  const dropOnTab = (e: DragEvent, tab: Tab, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggingTabId) moveTab(draggingTabId, { pane, beforeId: insertPosAt(e, tab, idx) });
    draggingTabId = null;
    clearDrop();
  };

  const dropOnBar = (e: DragEvent) => {
    e.preventDefault();
    if (draggingTabId) moveTab(draggingTabId, { pane, beforeId: null });
    draggingTabId = null;
    clearDrop();
  };

  return (
    <>
      <div
        className={`tab-bar ${dropEnd ? 'drop-end' : ''}`}
        role="tablist"
        onDragOver={(e) => {
          if (!draggingTabId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          // 탭이 아닌 빈 공간이면 맨 뒤
          if (e.target === e.currentTarget) { setDropBefore(null); setDropEnd(true); }
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) clearDrop();
        }}
        onDrop={dropOnBar}
      >
        {tabs.map((tab, idx) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            dropBefore={tab.id === dropBefore}
            connName={connectionOf(tab.connectionId, state)?.name ?? ''}
            onContextMenu={openMenu}
            onDragOver={(e) => overTab(e, tab, idx)}
            onDrop={(e) => dropOnTab(e, tab, idx)}
            onDragEnd={() => { draggingTabId = null; clearDrop(); }}
          />
        ))}
        {!split && pane === 0 && tabs.length > 1 && (
          <span className="tab-bar-hint">탭을 오른쪽 화면으로 끌면 분할</span>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

/**
 * 작성한 내용이 있는 SQL 편집기가 닫히려 하면 한 번 확인한다.
 */
function confirmThen(ids: string[], run: () => void): void {
  const tabs = getState().tabs;
  const dirty = ids.filter((id) => {
    const tab = tabs.find((t) => t.id === id);
    return tab?.kind === 'sql' && getTabScratch<string>(id, 'sql', '').trim().length > 0;
  });
  if (dirty.length > 0) {
    const names = tabs.filter((t) => dirty.includes(t.id)).map((t) => (t.kind === 'sql' ? t.title : t.id));
    const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` 외 ${names.length - 5}개` : '');
    if (!window.confirm(`작성한 내용이 있는 SQL 편집기 ${dirty.length}개가 닫힙니다.\n\n${shown}\n\n계속할까요?`)) return;
  }
  run();
}

function TabButton({ tab, active, dropBefore, connName, onContextMenu, onDragOver, onDrop, onDragEnd }: {
  tab: Tab;
  active: boolean;
  dropBefore: boolean;
  connName: string;
  onContextMenu: (e: MouseEvent, tab: Tab) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const label = tab.kind === 'table' ? tab.table : tab.title;
  const sub = tab.kind === 'table' ? `${tab.schema}` : (TAB_SUB[tab.kind] ?? connName);

  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab ${active ? 'active' : ''} ${dropBefore ? 'drop-before' : ''} ${tab.kind}`}
      draggable
      onDragStart={(e) => {
        draggingTabId = tab.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseDown={(e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(tab.id); return; }
        if (e.button === 2) return; // 우클릭은 컨텍스트 메뉴에서 처리
        setActiveTab(tab.id);
      }}
      onContextMenu={(e) => { setActiveTab(tab.id); onContextMenu(e, tab); }}
      title={tab.kind === 'table' ? `${connName} · ${tab.database} · ${tab.schema}.${tab.table}` : tab.title}
    >
      <span className={`icon icon-${TAB_ICON[tab.kind]}`} aria-hidden />
      <span className="tab-label">{label}</span>
      <span className="tab-sub">{sub}</span>
      <button
        className="tab-close"
        aria-label="탭 닫기"
        onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
      >
        ×
      </button>
    </div>
  );
}
