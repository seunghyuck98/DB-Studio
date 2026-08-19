import { useState, type MouseEvent } from 'react';
import ContextMenu, { type MenuState } from './ContextMenu';
import {
  useAppState, setActiveTab, closeTab, closeOtherTabs, closeTabsToRight, closeAllTabs,
  connectionOf, getTabScratch, getState,
} from '../state/store';
import type { Tab } from '../types';

const TAB_ICON: Record<Tab['kind'], string> = { table: 'table', sql: 'sql', history: 'history', tx: 'tx' };

const TAB_SUB: Partial<Record<Tab['kind'], string>> = { history: '전체', tx: '트랜잭션' };

export default function TabBar() {
  const state = useAppState();
  const [menu, setMenu] = useState<MenuState | null>(null);

  if (state.tabs.length === 0) return null;

  const openMenu = (e: MouseEvent, tab: Tab) => {
    e.preventDefault();
    const idx = state.tabs.findIndex((t) => t.id === tab.id);
    const rightCount = state.tabs.length - idx - 1;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: '닫기', action: () => confirmThen([tab.id], () => closeTab(tab.id)) },
        {
          label: `오른쪽 탭 닫기${rightCount ? ` (${rightCount})` : ''}`,
          disabled: rightCount === 0,
          action: () => confirmThen(state.tabs.slice(idx + 1).map((t) => t.id), () => closeTabsToRight(tab.id)),
        },
        {
          label: '다른 탭 모두 닫기',
          disabled: state.tabs.length <= 1,
          action: () => confirmThen(state.tabs.filter((t) => t.id !== tab.id).map((t) => t.id), () => closeOtherTabs(tab.id)),
          separated: true,
        },
        {
          label: `탭 모두 닫기 (${state.tabs.length})`,
          danger: true,
          action: () => confirmThen(state.tabs.map((t) => t.id), closeAllTabs),
        },
      ],
    });
  };

  return (
    <>
      <div className="tab-bar" role="tablist">
        {state.tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === state.activeTabId}
            connName={connectionOf(tab.connectionId, state)?.name ?? ''}
            onContextMenu={openMenu}
          />
        ))}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

/**
 * 작성한 내용이 있는 SQL 편집기가 닫히려 하면 한 번 확인한다.
 * 편집기 내용은 저장되지 않으므로 여러 개를 한꺼번에 닫을 때 특히 중요하다.
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

function TabButton({ tab, active, connName, onContextMenu }: {
  tab: Tab;
  active: boolean;
  connName: string;
  onContextMenu: (e: MouseEvent, tab: Tab) => void;
}) {
  const label = tab.kind === 'table' ? tab.table : tab.title;
  const sub = tab.kind === 'table' ? `${tab.schema}` : (TAB_SUB[tab.kind] ?? connName);

  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab ${active ? 'active' : ''} ${tab.kind}`}
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
