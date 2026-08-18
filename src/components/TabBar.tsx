import { useAppState, setActiveTab, closeTab, connectionOf } from '../state/store';
import type { Tab } from '../types';

export default function TabBar() {
  const state = useAppState();
  if (state.tabs.length === 0) return null;

  return (
    <div className="tab-bar" role="tablist">
      {state.tabs.map((tab) => (
        <TabButton key={tab.id} tab={tab} active={tab.id === state.activeTabId} connName={connectionOf(tab.connectionId, state)?.name ?? ''} />
      ))}
    </div>
  );
}

const TAB_ICON: Record<Tab['kind'], string> = { table: 'table', sql: 'sql', history: 'history', tx: 'tx' };

const TAB_SUB: Partial<Record<Tab['kind'], string>> = { history: '전체', tx: '트랜잭션' };

function TabButton({ tab, active, connName }: { tab: Tab; active: boolean; connName: string }) {
  const label = tab.kind === 'table' ? tab.table : tab.title;
  const sub = tab.kind === 'table' ? `${tab.schema}` : (TAB_SUB[tab.kind] ?? connName);

  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab ${active ? 'active' : ''} ${tab.kind}`}
      onMouseDown={(e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(tab.id); return; }
        setActiveTab(tab.id);
      }}
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
