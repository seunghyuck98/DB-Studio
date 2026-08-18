import { useEffect, useRef, useState } from 'react';
import {
  useAppState, setState, setActiveTab, closeTab, closeTabs, updateTab,
  sqlTabs, connectionOf, getTabScratch, openSqlTab, activeConnectionId, sessionOf,
} from '../state/store';
import type { SqlTab } from '../types';

/**
 * 열려 있는 SQL 편집기 목록.
 * 탭이 많아지면 탭 막대만으로는 찾기 어려우므로, 내용 미리보기와 함께 목록으로 보여 주고
 * 여기서 바로 이동·이름 변경·삭제를 할 수 있게 한다.
 */
export default function SqlEditorList() {
  const state = useAppState();
  const boxRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const tabs = sqlTabs(state);
  const connId = activeConnectionId(state);
  const session = sessionOf(connId, state);

  const close = () => setState({ sqlListOpen: false });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const commitRename = (id: string) => {
    const name = draft.trim();
    if (name) updateTab(id, { title: name });
    setRenaming(null);
  };

  const removeOne = (tab: SqlTab) => {
    const body = getTabScratch(tab.id, 'sql', '');
    if (body.trim() && !window.confirm(`'${tab.title}' 의 내용이 사라집니다. 삭제할까요?`)) return;
    closeTab(tab.id);
  };

  const removeAll = () => {
    const withBody = tabs.filter((t) => getTabScratch(t.id, 'sql', '').trim()).length;
    const msg = withBody > 0
      ? `SQL 편집기 ${tabs.length}개를 모두 닫습니다. 그중 ${withBody}개에 작성한 내용이 있습니다. 계속할까요?`
      : `SQL 편집기 ${tabs.length}개를 모두 닫을까요?`;
    if (!window.confirm(msg)) return;
    closeTabs(tabs.map((t) => t.id));
    close();
  };

  return (
    <div className="sqllist-backdrop">
      <div className="sqllist" ref={boxRef}>
        <div className="sqllist-head">
          <b>SQL 편집기</b>
          <span className="hint">{tabs.length}개</span>
          <div className="spacer" />
          <button
            className="btn small"
            disabled={!session?.connected}
            title={session?.connected ? '' : '접속을 먼저 열어야 합니다'}
            onClick={() => {
              if (!connId || !session) return;
              openSqlTab(connId, session.currentDatabase ?? '', session.currentSchema ?? '');
              close();
            }}
          >
            + 새 편집기
          </button>
          <button className="btn small" disabled={!tabs.length} onClick={removeAll}>모두 닫기</button>
          <button className="icon-btn" onClick={close} aria-label="닫기">×</button>
        </div>

        {tabs.length === 0 ? (
          <p className="tree-empty">열려 있는 SQL 편집기가 없습니다.</p>
        ) : (
          <div className="sqllist-body">
            {tabs.map((tab) => {
              const body = getTabScratch<string>(tab.id, 'sql', '');
              const preview = body.replace(/\s+/g, ' ').trim();
              const conn = connectionOf(tab.connectionId, state);
              const active = tab.id === state.activeTabId;
              return (
                <div
                  key={tab.id}
                  className={`sqllist-item ${active ? 'active' : ''}`}
                  onClick={() => { setActiveTab(tab.id); close(); }}
                  onDoubleClick={() => { setRenaming(tab.id); setDraft(tab.title); }}
                >
                  <div className="sqllist-item-head">
                    <span className="icon icon-sql" aria-hidden />
                    {renaming === tab.id ? (
                      <input
                        className="input cell"
                        value={draft}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(tab.id)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') commitRename(tab.id);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                    ) : (
                      <span className="sqllist-title">{tab.title}</span>
                    )}
                    {preview && <span className="sqllist-badge">작성됨</span>}
                    <button
                      className="icon-btn"
                      title="이름 변경"
                      onClick={(e) => { e.stopPropagation(); setRenaming(tab.id); setDraft(tab.title); }}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn danger"
                      title="삭제"
                      onClick={(e) => { e.stopPropagation(); removeOne(tab); }}
                    >
                      ×
                    </button>
                  </div>
                  <div className="sqllist-meta">
                    {conn?.name ?? ''}{tab.database ? ` · ${tab.database}` : ''}{tab.schema ? `.${tab.schema}` : ''}
                  </div>
                  <div className="sqllist-preview">{preview || '(빈 편집기)'}</div>
                </div>
              );
            })}
          </div>
        )}

        <div className="sqllist-foot hint">
          클릭 — 이동 · 더블클릭 — 이름 변경 · × — 삭제
        </div>
      </div>
    </div>
  );
}
