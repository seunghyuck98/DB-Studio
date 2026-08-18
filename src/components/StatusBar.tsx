import { useAppState, sessionOf, connectionOf, activeTab } from '../state/store';

export default function StatusBar({ connectionId }: { connectionId: string | null }) {
  const state = useAppState();
  const session = sessionOf(connectionId, state);
  const conn = connectionOf(connectionId, state);
  const tab = activeTab(state);

  if (!session?.connected) {
    return <footer className="status-bar"><span className="muted">접속되어 있지 않습니다.</span></footer>;
  }

  return (
    <footer className="status-bar">
      <span>{conn?.name}</span>
      <span className="sep">|</span>
      <span>{conn?.user}@{conn?.host}:{conn?.port}</span>
      <span className="sep">|</span>
      <span>{session.currentDatabase}{session.hasSchemaLevel && session.currentSchema ? `.${session.currentSchema}` : ''}</span>
      <span className="sep">|</span>
      <span className={session.autoCommit ? '' : 'warn'}>
        {session.autoCommit ? '자동 커밋' : `수동 커밋${session.txActive ? ` · 트랜잭션 진행 중 (${session.txStatements}건)` : ''}`}
      </span>
      <div className="spacer" />
      {tab?.kind === 'table' && <span className="muted">{tab.schema}.{tab.table}</span>}
      <span className="sep">|</span>
      <span className="muted" title={session.serverVersion ?? ''}>
        {(session.serverVersion ?? '').split(' ').slice(0, 2).join(' ')}
      </span>
    </footer>
  );
}
