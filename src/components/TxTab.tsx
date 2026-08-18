import { useCallback, useEffect, useState } from 'react';
import TxChanges, { summarize } from './TxChanges';
import { useAppState, sessionOf, connectionOf, notify } from '../state/store';
import { commit, rollback, message } from '../state/actions';
import type { PendingTx, TxTab as TxTabType } from '../types';

/** 진행 중인 트랜잭션에서 아직 확정하지 않은 변경 문장들을 보여 준다. */
export default function TxTab({ tab }: { tab: TxTabType }) {
  const state = useAppState();
  const session = sessionOf(tab.connectionId, state);
  const conn = connectionOf(tab.connectionId, state);
  const [pending, setPending] = useState<PendingTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPending(await window.api.tx.pending(tab.connectionId));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId]);

  useEffect(() => { void load(); }, [load]);

  // 커밋·롤백이나 새 문장 실행으로 상태가 바뀌면 목록을 다시 읽는다.
  useEffect(() => { void load(); }, [load, session?.txChanges, session?.txActive]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('dbstudio:refresh', handler);
    return () => window.removeEventListener('dbstudio:refresh', handler);
  }, [load]);

  const entries = pending?.entries ?? [];
  const txActive = !!session?.txActive;

  return (
    <div className="tx-tab">
      <div className="tx-toolbar">
        <span className={`tx-state ${txActive ? 'on' : 'off'}`}>
          {txActive ? '트랜잭션 진행 중' : '열려 있는 트랜잭션 없음'}
        </span>
        {conn && <span className="hint">{conn.name}</span>}
        <div className="spacer" />
        <button className="btn small" onClick={() => void load()} disabled={loading}>새로 고침</button>
        <button
          className="btn small"
          disabled={!entries.length}
          onClick={() => {
            void navigator.clipboard.writeText(entries.map((e) => e.sql.replace(/;\s*$/, '') + ';').join('\n'));
            notify('info', 'SQL 을 복사했습니다.');
          }}
        >
          SQL 복사
        </button>
        <button
          className="btn small btn-commit"
          disabled={!txActive}
          onClick={() => void commit(tab.connectionId)}
        >
          커밋
        </button>
        <button
          className="btn small btn-rollback"
          disabled={!txActive}
          onClick={() => void rollback(tab.connectionId)}
        >
          롤백
        </button>
      </div>

      {entries.length > 0 && (
        <div className="tx-summary">{summarize(entries)}</div>
      )}

      {error && <div className="pane-message error">{error}</div>}

      <div className="grid-scroll">
        {!error && <TxChanges entries={entries} />}
      </div>

      {!txActive && !entries.length && !error && (
        <p className="hint tx-note">
          수동 커밋 모드에서 문장을 실행하면 트랜잭션이 열리고, 확정하지 않은 변경이 여기 쌓입니다.
        </p>
      )}
    </div>
  );
}
