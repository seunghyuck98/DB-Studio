import { useCallback, useEffect, useState } from 'react';
import { getState, notify, setActiveTab, pushTab, connectionOf, useAppState } from '../state/store';
import { message } from '../state/actions';
import { openSavedConversation, CHAT_HISTORY_CHANGED_EVENT, type Conversation } from '../state/chat';
import { MessageView } from './ChatMessages';
import type { ChatHistorySummary, SavedConversation, ChatHistoryTab as ChatHistoryTabType } from '../types';

/**
 * Claude 대화 히스토리 — 쿼리 히스토리와 같은 꼴의 탭.
 * 왼쪽(위) 목록에서 대화를 고르면 아래에 전체 대화가 보이고, '대화 이어가기' 로 사이드바에 다시 연다.
 */
export default function ChatHistoryTab({ tab: _tab }: { tab: ChatHistoryTabType }) {
  const state = useAppState();
  const [entries, setEntries] = useState<ChatHistorySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SavedConversation | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!window.api?.chatHistory) return;
    setLoading(true);
    try {
      const res = await window.api.chatHistory.list({ search, limit: 500 });
      setEntries(res.entries);
      setTotal(res.total);
    } catch (e) {
      notify('error', message(e));
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(t);
  }, [load]);

  // 새 대화가 저장되거나 F5 를 누르면 목록을 다시 읽는다. 보고 있던 대화도 최신으로.
  useEffect(() => {
    const handler = () => {
      void load();
      if (selected) {
        window.api.chatHistory.get(selected.id).then((c) => { if (c) setSelected(c); }).catch(() => {});
      }
    };
    window.addEventListener('dbstudio:refresh', handler);
    window.addEventListener(CHAT_HISTORY_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener('dbstudio:refresh', handler);
      window.removeEventListener(CHAT_HISTORY_CHANGED_EVENT, handler);
    };
  }, [load, selected]);

  const select = async (id: string) => {
    try {
      const conv = await window.api.chatHistory.get(id);
      if (!conv) { notify('info', '이 대화는 이미 지워졌습니다.'); void load(); return; }
      setSelected(conv);
    } catch (e) {
      notify('error', message(e));
    }
  };

  const resume = (conv: SavedConversation) => openSavedConversation(conv);

  const remove = async (conv: SavedConversation) => {
    if (!window.confirm(`"${conv.title}" 대화를 히스토리에서 지울까요?`)) return;
    await window.api.chatHistory.remove(conv.id);
    setSelected(null);
    void load();
  };

  const clearAll = async () => {
    if (!window.confirm(`Claude 대화 ${total.toLocaleString()}개를 모두 지울까요?`)) return;
    await window.api.chatHistory.clear();
    setSelected(null);
    void load();
  };

  const contextLabel = (ctx: ChatHistorySummary['context']) => {
    if (!ctx?.connectionId) return '';
    const conn = connectionOf(ctx.connectionId, state);
    const parts = [conn?.name ?? '(삭제된 접속)'];
    if (ctx.database) parts.push(ctx.database);
    if (ctx.schema && ctx.schema !== ctx.database) parts.push(ctx.schema);
    return parts.join(' · ');
  };

  // MessageView 는 '즉시 적용' 대상 맥락을 위해 Conversation 을 받는다. 저장본을 그 꼴로 맞춘다.
  const asConversation = (c: SavedConversation): Conversation => ({
    id: c.id,
    title: c.title,
    messages: c.messages.map((m) => ({ role: m.role, text: m.text, tools: m.tools ?? [], error: m.error })),
    sessionId: c.sessionId ?? undefined,
    running: false,
    runId: null,
    mcpDown: false,
    context: c.context ?? undefined,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });

  return (
    <div className="history-tab">
      <div className="history-toolbar">
        <input
          className="input"
          placeholder="제목·대화 내용 검색…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="spacer" />
        <span className="hint">{total.toLocaleString()}개</span>
        <button className="btn small" onClick={() => void load()} disabled={loading}>새로 고침</button>
        <button className="btn small" onClick={() => void clearAll()} disabled={!total}>모두 지우기</button>
      </div>

      <div className="history-body">
        <div className="grid-scroll history-list">
          <table className="meta-table">
            <thead>
              <tr>
                <th>마지막 대화</th><th>제목</th><th>메시지</th><th>접속</th><th>첫 질문</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className={selected?.id === e.id ? 'row-selected' : ''}
                  onClick={() => void select(e.id)}
                  onDoubleClick={() => void window.api.chatHistory.get(e.id).then((c) => c && resume(c))}
                >
                  <td className="nowrap">{formatTime(e.updatedAt)}</td>
                  <td className="nowrap">{e.title}</td>
                  <td className="num">{e.messageCount}</td>
                  <td className="nowrap">{contextLabel(e.context)}</td>
                  <td className="sql-cell">{e.preview}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && !loading && (
            <div className="pane-message muted">저장된 대화가 없습니다. Claude 사이드바에서 질문하면 여기에 남습니다.</div>
          )}
        </div>

        {selected && (
          <div className="history-detail chat-history-detail">
            <div className="history-detail-head">
              <b className="chat-history-title">{selected.title}</b>
              <span className="hint">
                {formatTime(selected.createdAt)} 시작 · {selected.messages.length}개 메시지
                {selected.context?.connectionId ? ` · ${contextLabel(selected.context)}` : ''}
              </span>
              <div className="spacer" />
              <button className="btn small" onClick={() => void remove(selected)}>삭제</button>
              <button className="btn small primary" onClick={() => resume(selected)} title="사이드바에 다시 열어 이어서 질문합니다">
                대화 이어가기
              </button>
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="닫기">×</button>
            </div>
            <div className="chat-history-messages">
              {selected.messages.map((m, i) => (
                <MessageView key={i} msg={m} conv={asConversation(selected)} streaming={false} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 대화 히스토리 탭을 연다 (하나만). 이미 있으면 그 탭으로 간다. */
export function openChatHistoryTab(): void {
  const state = getState();
  const existing = state.tabs.find((t) => t.kind === 'chatHistory');
  if (existing) {
    setActiveTab(existing.id);
    return;
  }
  const tab: ChatHistoryTabType = {
    id: 'chat-history',
    kind: 'chatHistory',
    connectionId: '',
    database: '',
    schema: '',
    title: 'Claude 대화 히스토리',
  };
  pushTab(tab);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
