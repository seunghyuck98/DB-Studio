import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useAppState } from '../state/store';
import { setChatWidth, persistChatWidth } from '../state/actions';

interface ToolCall { name: string; input: string }

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolCall[];
  error?: boolean;
}

let runSeq = 0;

/**
 * 우측 Claude 대화 사이드바.
 * 자연어로 데이터베이스를 조회·분석하고 쿼리를 짜 준다. DB 접근은 emr-db MCP 로만 한다.
 * (electron/agent.js 가 실제 에이전트 루프를 돌린다.)
 */
export default function ChatSidebar({ onClose }: { onClose: () => void }) {
  const { chatWidth } = useAppState();
  const [dragging, setDragging] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState<{ hasEmrDb: boolean } | null>(null);
  const sessionRef = useRef<string | undefined>(undefined);
  const runIdRef = useRef<string | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api?.agent?.status().then(setReady).catch(() => setReady({ hasEmrDb: false }));
    return () => { disposeRef.current?.(); };
  }, []);

  useEffect(() => {
    // 새 내용이 붙으면 항상 맨 아래로.
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    const prompt = input.trim();
    if (!prompt || running || !window.api?.agent) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: prompt }, { role: 'assistant', text: '', tools: [] }]);
    setRunning(true);

    runSeq += 1;
    const runId = `chat-${runSeq}`;
    runIdRef.current = runId;

    // 마지막(어시스턴트) 메시지에 스트리밍 내용을 이어 붙인다.
    const patchLast = (fn: (msg: ChatMessage) => ChatMessage) =>
      setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? fn(msg) : msg)));

    disposeRef.current = window.api.agent.ask({ runId, prompt, resume: sessionRef.current }, (ev) => {
      switch (ev.type) {
        case 'session':
          sessionRef.current = ev.sessionId;
          break;
        case 'delta':
          patchLast((msg) => ({ ...msg, text: msg.text + ev.text }));
          break;
        case 'tool':
          if (ev.name && !ev.name.startsWith('ToolSearch')) {
            patchLast((msg) => ({ ...msg, tools: [...(msg.tools ?? []), { name: ev.name, input: ev.input ?? '' }] }));
          }
          break;
        case 'result':
          // 스트리밍 델타가 비어 있었으면(부분 응답 미지원) 최종 텍스트로 채운다.
          if (ev.text) patchLast((msg) => (msg.text ? msg : { ...msg, text: ev.text }));
          if (ev.isError) patchLast((msg) => ({ ...msg, error: true, text: msg.text || '요청을 처리하지 못했습니다.' }));
          break;
        case 'error':
          patchLast((msg) => ({ ...msg, error: true, text: msg.text + (msg.text ? '\n\n' : '') + `⚠ ${ev.message}` }));
          break;
        case 'done':
          setRunning(false);
          runIdRef.current = null;
          disposeRef.current?.();
          disposeRef.current = null;
          break;
        default:
          break;
      }
    });
  };

  const stop = () => {
    if (runIdRef.current) window.api?.agent?.stop(runIdRef.current);
  };

  // 사이드바는 화면 오른쪽 끝에 붙어 있으므로 폭 = (창 너비 - 마우스 X).
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent) => setChatWidth(window.innerWidth - ev.clientX);
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      void persistChatWidth();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const reset = () => {
    stop();
    sessionRef.current = undefined;
    setMessages([]);
  };

  return (
    <aside className="chat-sidebar" style={{ flexBasis: chatWidth, width: chatWidth }}>
      <div
        className={`chat-splitter ${dragging ? 'dragging' : ''}`}
        title="끌어서 폭 조절"
        onMouseDown={startResize}
      />
      <div className="chat-head">
        <b>Claude · DB 도우미</b>
        {ready && !ready.hasEmrDb && <span className="chat-warn" title="emr-db MCP 설정을 찾지 못했습니다">DB 미연결</span>}
        <div className="spacer" />
        <button className="icon-btn" title="새 대화" onClick={reset} disabled={!messages.length}>⟲</button>
        <button className="icon-btn" aria-label="닫기" onClick={onClose}>×</button>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="chat-hint">
            <p>자연어로 데이터베이스를 물어보세요.</p>
            <ul>
              <li>"주문 테이블 구조 보여줘"</li>
              <li>"지난달 도시별 매출 상위 5개"</li>
              <li>"이 쿼리 왜 느린지 실행 계획 봐줘"</li>
            </ul>
            <p className="muted">쿼리는 실행 계획을 확인해 최적으로 작성하고, 쿼리와 계획을 함께 돌려줍니다. 데이터를 바꾸는 쿼리는 실행하지 않고 제안만 합니다.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role} ${m.error ? 'error' : ''}`}>
            {m.tools && m.tools.length > 0 && (
              <div className="chat-tools">
                {m.tools.map((t, j) => (
                  <div key={j} className="chat-tool" title={t.input}>
                    <span className="chat-tool-name">{t.name.replace(/^mcp__emr-db__/, '')}</span>
                    {t.input && <code className="chat-tool-sql">{t.input}</code>}
                  </div>
                ))}
              </div>
            )}
            {m.text && <div className="chat-text">{m.text}</div>}
            {m.role === 'assistant' && running && i === messages.length - 1 && !m.text && (
              <div className="chat-typing"><span /><span /><span /></div>
            )}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          rows={2}
          placeholder="데이터베이스에 대해 물어보세요… (Enter 로 전송, Shift+Enter 줄바꿈)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          disabled={running}
        />
        {running ? (
          <button className="btn small" onClick={stop}>중지</button>
        ) : (
          <button className="btn small primary" onClick={send} disabled={!input.trim()}>보내기</button>
        )}
      </div>
    </aside>
  );
}
