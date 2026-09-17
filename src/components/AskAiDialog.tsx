import { useEffect, useRef, useState } from 'react';
import { askAboutSql, describeContext, type SqlContext } from '../state/chat';

interface Props {
  sql: string;
  context: SqlContext | null;
  onClose: () => void;
}

/**
 * SQL 편집기 우클릭 → "AI 에게 질문하기".
 * 선택한 쿼리를 보여 주고 질문을 받아, 새 Claude 대화에 쿼리와 질문을 정리해 보낸다.
 */
export default function AskAiDialog({ sql, context, onClose }: Props) {
  const [question, setQuestion] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const submit = () => {
    if (!question.trim()) return;
    askAboutSql({ sql, question, context });
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>AI 에게 질문하기</h3>
        <p className="modal-desc">
          {context ? describeContext(context) : '접속이 열려 있지 않아 접속 맥락 없이 질문합니다.'}
        </p>
        <pre className="code-block ask-ai-sql">{sql}</pre>
        <textarea
          ref={ref}
          className="input ask-ai-question"
          rows={3}
          placeholder="이 쿼리에 대해 무엇을 물어볼까요? (예: 왜 느린지 실행 계획 봐줘, 인덱스 제안해줘)"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" disabled={!question.trim()} onClick={submit} title="⌘/Ctrl + Enter">
            질문하기
          </button>
        </div>
      </div>
    </div>
  );
}
