import { useState } from 'react';
import { notify, setSession } from '../state/store';
import { message } from '../state/actions';

interface Props {
  connectionId: string;
  title: string;
  statements: string[];
  autoCommit: boolean;
  /** DDL 이 트랜잭션 안에서 되돌려지는 DB 인지 (PostgreSQL 은 true) */
  transactionalDdl: boolean;
  onClose: () => void;
  onApplied: () => void;
}

/** 생성된 DDL 을 먼저 보여주고, 확인을 받은 뒤에만 실행한다. */
export default function DdlPreviewDialog({ connectionId, title, statements, autoCommit, transactionalDdl, onClose, onApplied }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sql = statements.join('\n');

  const execute = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.ddl.execute(connectionId, statements);
      setSession(connectionId, res.status);
      notify('success', autoCommit
        ? `${res.executed.length}개 DDL 문을 실행했습니다.`
        : `${res.executed.length}개 DDL 문을 실행했습니다. 확정하려면 커밋하세요.`);
      onApplied();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="modal-desc">
          아래 문장이 순서대로 실행됩니다.
          {transactionalDdl
            ? ' 하나라도 실패하면 전체가 되돌아갑니다.'
            : ' 이 데이터베이스는 DDL 을 즉시 확정하므로, 중간에 실패하면 앞서 실행된 문장은 그대로 남습니다.'}
          {!autoCommit && transactionalDdl && ' 수동 커밋 모드이므로 실행 후 커밋해야 확정됩니다.'}
        </p>
        <pre className="code-block scroll-box">{sql}</pre>
        {error && <div className="test-result error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={() => void navigator.clipboard.writeText(sql)}>SQL 복사</button>
          <div className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>취소</button>
          <button className="btn primary" onClick={() => void execute()} disabled={busy || !statements.length}>
            {busy ? '실행 중…' : '실행'}
          </button>
        </div>
      </div>
    </div>
  );
}
