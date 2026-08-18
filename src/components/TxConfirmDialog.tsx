import { useEffect, useState } from 'react';
import TxChanges, { summarize, unrollbackable } from './TxChanges';
import { setState, connectionOf, getState, notify } from '../state/store';
import { finishTx, message } from '../state/actions';
import type { PendingTx } from '../types';

interface Props {
  connectionId: string;
  action: 'commit' | 'rollback';
}

/** 커밋·롤백 전에 무엇이 확정·취소되는지 보여 주고 한 번 더 확인받는다. */
export default function TxConfirmDialog({ connectionId, action }: Props) {
  const [pending, setPending] = useState<PendingTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conn = connectionOf(connectionId, getState());
  const isCommit = action === 'commit';

  useEffect(() => {
    let cancelled = false;
    window.api.tx.pending(connectionId)
      .then((p) => { if (!cancelled) setPending(p); })
      .catch((e) => { if (!cancelled) setError(message(e)); });
    return () => { cancelled = true; };
  }, [connectionId]);

  const close = () => setState({ dialog: null });

  const run = async () => {
    setBusy(true);
    const ok = await finishTx(connectionId, action);
    setBusy(false);
    if (ok) close();
  };

  const entries = pending?.entries ?? [];
  const stuck = unrollbackable(entries);
  const ddlVerbs = [...new Set(entries.filter((e) => e.implicitCommit).map((e) => e.verb))];

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{isCommit ? '커밋' : '롤백'} 확인</h3>
        <p className="modal-desc">
          {conn ? <b>{conn.name}</b> : null}{conn ? ' — ' : ''}
          {isCommit
            ? '아래 변경 사항이 데이터베이스에 확정됩니다.'
            : '아래 변경 사항이 모두 취소되고 트랜잭션 시작 시점으로 되돌아갑니다.'}
        </p>

        {error && <div className="test-result error">{error}</div>}
        {!pending && !error && <div className="pane-message">변경 내역을 읽는 중…</div>}

        {pending && (
          <>
            <div className={`tx-summary ${isCommit ? 'commit' : 'rollback'}`}>
              {entries.length > 0 ? summarize(entries) : '기록된 변경 문장이 없습니다.'}
            </div>
            {!isCommit && stuck.length > 0 && (
              <div className="tx-warn">
                이 데이터베이스는 <b>DDL 을 실행하면 그 앞의 변경까지 함께 확정</b>합니다.
                {ddlVerbs.length > 0 && ` 목록의 ${ddlVerbs.join(', ')} 때문에 `}
                아래 <b>{stuck.length}건</b>은 롤백해도 되돌아가지 않습니다.
              </div>
            )}
            <div className="scroll-box tx-scroll">
              <TxChanges entries={entries} />
            </div>
            {entries.length === 0 && (
              <p className="hint">
                조회만 실행해 트랜잭션이 열린 상태입니다. {isCommit ? '커밋' : '롤백'}해도 데이터는 바뀌지 않습니다.
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          <button
            className="btn"
            disabled={!entries.length}
            onClick={() => {
              void navigator.clipboard.writeText(entries.map((e) => e.sql.replace(/;\s*$/, '') + ';').join('\n'));
              notify('info', 'SQL 을 복사했습니다.');
            }}
          >
            SQL 복사
          </button>
          <div className="spacer" />
          <button className="btn" onClick={close} disabled={busy}>취소</button>
          <button
            className={`btn ${isCommit ? 'primary' : 'danger'}`}
            onClick={() => void run()}
            disabled={busy || !pending}
            autoFocus
          >
            {busy ? '처리 중…' : (isCommit ? '커밋' : '롤백')}
          </button>
        </div>
      </div>
    </div>
  );
}
