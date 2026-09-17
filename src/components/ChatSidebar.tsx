import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useAppState, notify } from '../state/store';
import { setChatWidth, persistChatWidth } from '../state/actions';
import {
  useChatState, activeConversation, newConversation, activateConversation, closeConversation,
  sendPrompt, stopConversation, loadAgentInfo, applySqlToEditor, type ChatMessage, type Conversation,
} from '../state/chat';

/**
 * 우측 Claude 대화 사이드바.
 * 자연어로 데이터베이스를 조회·분석하고 쿼리를 짜 준다. DB 접근은 emr-db MCP 로만 한다.
 * 대화는 여러 개를 탭으로 나눠 두고, 상태는 state/chat.ts 에 있다
 * (사이드바를 닫아도 남고, electron/agent.js 가 실제 에이전트 루프를 돌린다).
 */
export default function ChatSidebar({ onClose }: { onClose: () => void }) {
  const { chatWidth } = useAppState();
  const chat = useChatState();
  const conv = activeConversation(chat);
  const [dragging, setDragging] = useState(false);
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadAgentInfo(); }, []);

  useEffect(() => {
    // 새 내용이 붙으면 항상 맨 아래로.
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [conv?.messages]);

  const send = () => {
    const prompt = input.trim();
    if (!prompt || conv?.running) return;
    setInput('');
    sendPrompt(prompt, conv?.id ?? null);
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

  const agent = chat.agent;
  const running = !!conv?.running;

  return (
    <aside className="chat-sidebar" style={{ flexBasis: chatWidth, width: chatWidth }}>
      <div
        className={`chat-splitter ${dragging ? 'dragging' : ''}`}
        title="끌어서 폭 조절"
        onMouseDown={startResize}
      />
      <div className="chat-head">
        <b>Claude · DB 도우미</b>
        {agent && !agent.hasEmrDb && <span className="chat-warn" title="emr-db MCP 설정을 찾지 못했습니다">설정 없음</span>}
        {agent && agent.hasEmrDb && !agent.emrComplete && !conv?.mcpDown && (
          <span
            className="chat-warn"
            title={`emr-db 설정(${agent.emrSource ?? ''})에 MYSQL_HOST 등 접속 정보가 없습니다. 래퍼 스크립트가 다른 이름으로 넘기면 첫 쿼리에서 연결이 끊길 수 있습니다.`}
          >
            설정 확인 필요
          </span>
        )}
        {agent && agent.hasEmrDb && conv?.mcpDown && <span className="chat-warn" title="emr-db MCP 서버에 연결하지 못했습니다">DB 연결 실패</span>}
        <div className="spacer" />
        <button className="btn small" title="새 대화" onClick={() => newConversation()}>＋ 새 대화</button>
        <button className="icon-btn" aria-label="닫기" onClick={onClose}>×</button>
      </div>

      {chat.conversations.length > 0 && (
        <div className="chat-tabs" role="tablist">
          {chat.conversations.map((c) => (
            <ConversationTab key={c.id} conv={c} active={c.id === chat.activeId} />
          ))}
        </div>
      )}

      <div className="chat-body" ref={bodyRef}>
        {(!conv || conv.messages.length === 0) && (
          <div className="chat-hint">
            <p>자연어로 데이터베이스를 물어보세요.</p>
            <ul>
              <li>"주문 테이블 구조 보여줘"</li>
              <li>"지난달 도시별 매출 상위 5개"</li>
              <li>"이 쿼리 왜 느린지 실행 계획 봐줘"</li>
            </ul>
            <p className="muted">
              쿼리는 실행 계획을 확인해 최적으로 작성하고, 쿼리와 계획을 함께 돌려줍니다.
              데이터를 바꾸는 쿼리는 실행하지 않고 제안만 합니다.
              SQL 편집기에서 쿼리를 선택해 우클릭하면 그 쿼리로 바로 질문할 수 있습니다.
            </p>
          </div>
        )}
        {conv?.messages.map((m, i) => (
          <MessageView
            key={i}
            msg={m}
            conv={conv}
            streaming={running && i === conv.messages.length - 1}
          />
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
          <button className="btn small" onClick={() => conv && stopConversation(conv.id)}>중지</button>
        ) : (
          <button className="btn small primary" onClick={send} disabled={!input.trim()}>보내기</button>
        )}
      </div>
    </aside>
  );
}

function ConversationTab({ conv, active }: { conv: Conversation; active: boolean }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`chat-tab ${active ? 'active' : ''} ${conv.running ? 'running' : ''}`}
      title={conv.title}
      onClick={() => activateConversation(conv.id)}
      onAuxClick={(e) => { if (e.button === 1) closeConversation(conv.id); }}
    >
      <span className="chat-tab-title">{conv.title}</span>
      <button
        className="chat-tab-close"
        aria-label="대화 닫기"
        title="대화 닫기"
        onClick={(e) => { e.stopPropagation(); closeConversation(conv.id); }}
      >
        ×
      </button>
    </div>
  );
}

function MessageView({ msg, conv, streaming }: { msg: ChatMessage; conv: Conversation; streaming: boolean }) {
  return (
    <div className={`chat-msg ${msg.role} ${msg.error ? 'error' : ''}`}>
      {msg.tools && msg.tools.length > 0 && (
        <div className="chat-tools">
          {msg.tools.map((t, j) => (
            <div key={j} className="chat-tool" title={t.input}>
              <span className="chat-tool-name">{t.name.replace(/^mcp__emr-db__/, '')}</span>
              {t.input && <code className="chat-tool-sql">{t.input}</code>}
            </div>
          ))}
        </div>
      )}
      {msg.text && (msg.role === 'assistant'
        ? <AssistantText text={msg.text} conv={conv} />
        : <div className="chat-text">{msg.text}</div>)}
      {msg.role === 'assistant' && streaming && !msg.text && (
        <div className="chat-typing"><span /><span /><span /></div>
      )}
    </div>
  );
}

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; code: string; open: boolean };

/**
 * ``` 펜스로 둘러싸인 코드를 본문에서 떼어 낸다.
 * 스트리밍 중에는 닫는 펜스가 아직 안 왔을 수 있어, 그때는 나머지 전부를 코드로 본다.
 */
function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let code: { lang: string; lines: string[] } | null = null;
  const flushText = () => {
    const t = buf.join('\n');
    if (t.trim()) out.push({ kind: 'text', text: t.replace(/^\n+|\n+$/g, '') });
    buf = [];
  };
  for (const line of lines) {
    if (code) {
      if (/^\s*```\s*$/.test(line)) {
        out.push({ kind: 'code', lang: code.lang, code: code.lines.join('\n'), open: false });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const m = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (m) {
      flushText();
      code = { lang: m[1].toLowerCase(), lines: [] };
    } else {
      buf.push(line);
    }
  }
  if (code) out.push({ kind: 'code', lang: code.lang, code: code.lines.join('\n'), open: true });
  else flushText();
  return out;
}

const SQL_LANGS = new Set(['', 'sql', 'mysql', 'mariadb', 'postgres', 'postgresql', 'pgsql', 'plsql']);

function AssistantText({ text, conv }: { text: string; conv: Conversation }) {
  const segments = splitSegments(text);
  return (
    <div className="chat-text">
      {segments.map((seg, i) => (
        seg.kind === 'text'
          ? <div key={i} className="chat-para">{seg.text}</div>
          : <CodeBlock key={i} lang={seg.lang} code={seg.code} open={seg.open} conv={conv} />
      ))}
    </div>
  );
}

/** 답변 속 쿼리 블록 — 복사하거나 새 SQL 편집기로 바로 보낸다. */
function CodeBlock({ lang, code, open, conv }: { lang: string; code: string; open: boolean; conv: Conversation }) {
  const isSql = SQL_LANGS.has(lang);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      notify('success', '쿼리를 복사했습니다.');
    } catch (e) {
      notify('error', `복사하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const apply = () => {
    const how = applySqlToEditor(code, conv);
    if (how === 'appended') notify('success', '열려 있는 SQL 편집기 끝에 쿼리를 이어 붙였습니다.');
    else if (how === 'opened') notify('success', '새 SQL 편집기에 쿼리를 넣었습니다.');
  };
  return (
    <div className={`chat-code ${open ? 'open' : ''}`}>
      <div className="chat-code-head">
        <span className="chat-code-lang">{isSql ? 'SQL' : lang.toUpperCase()}</span>
        <div className="spacer" />
        <button className="btn tiny" onClick={() => void copy()} disabled={open} title="클립보드로 복사">복사</button>
        {isSql && (
          <button
            className="btn tiny primary"
            onClick={apply}
            disabled={open}
            title="열려 있는 SQL 편집기 끝에 이어 붙입니다. 없으면 현재 접속·스키마로 새 편집기를 열어 넣습니다"
          >
            즉시 적용
          </button>
        )}
      </div>
      <pre className="chat-code-body">{code}</pre>
    </div>
  );
}
