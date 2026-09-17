import { notify } from '../state/store';
import { applySqlToEditor, type ChatMessage, type Conversation } from '../state/chat';

/**
 * Claude 대화 메시지 렌더링 — 사이드바와 대화 히스토리 탭이 같이 쓴다.
 * 어시스턴트 답변의 ``` 코드 블록은 따로 그려 복사·즉시 적용 버튼을 단다.
 */
export function MessageView({ msg, conv, streaming }: { msg: ChatMessage; conv: Conversation; streaming: boolean }) {
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
export function splitSegments(text: string): Segment[] {
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

/** 답변 속 쿼리 블록 — 복사하거나 SQL 편집기로 바로 보낸다. */
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
