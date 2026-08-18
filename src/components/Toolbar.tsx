import { useEffect, useState } from 'react';
import { useAppState, connectionOf, sessionOf, activeTab, openSqlTab, setState, notify, sqlTabs } from '../state/store';
import { commit, rollback, setAutoCommit, switchSchema, switchDatabase, message } from '../state/actions';
import { openHistoryTab } from './HistoryTab';
import type { DatabaseMeta, SchemaMeta } from '../types';

interface Props {
  connectionId: string | null;
}

export default function Toolbar({ connectionId }: Props) {
  const state = useAppState();
  const session = sessionOf(connectionId, state);
  const conn = connectionOf(connectionId, state);
  const connected = !!session?.connected;
  const tab = activeTab(state);

  const sqlEditorCount = sqlTabs(state).length;

  const [databases, setDatabases] = useState<DatabaseMeta[]>([]);
  const [schemas, setSchemas] = useState<SchemaMeta[]>([]);

  // 접속 또는 현재 데이터베이스가 바뀌면 드롭다운 목록을 다시 읽는다.
  useEffect(() => {
    let cancelled = false;
    if (!connectionId || !connected) {
      setDatabases([]);
      setSchemas([]);
      return;
    }
    (async () => {
      try {
        const dbs = await window.api.meta.get(connectionId, 'databases');
        if (!cancelled) setDatabases(dbs);
        if (session?.hasSchemaLevel) {
          const sc = await window.api.meta.get(connectionId, 'schemas');
          if (!cancelled) setSchemas(sc);
        } else if (!cancelled) {
          setSchemas([]);
        }
      } catch (e) {
        if (!cancelled) notify('error', message(e));
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId, connected, session?.currentDatabase, session?.hasSchemaLevel]);

  const autoCommit = session?.autoCommit ?? true;
  const txActive = !!session?.txActive;
  // 커밋 버튼에는 조회를 제외한 실제 변경 문장 수를 보여 준다.
  const pending = session?.txChanges ?? 0;

  const onDatabaseChange = async (value: string) => {
    if (!connectionId) return;
    try {
      await switchDatabase(connectionId, value);
    } catch (e) {
      notify('error', message(e));
    }
  };

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <button
          className="btn"
          title="새 접속 (⌘⇧N)"
          onClick={() => setState({ dialog: { kind: 'connection', connection: null } })}
        >
          + 접속
        </button>
        <button
          className="btn"
          disabled={!connected}
          title="새 SQL 편집기 (⌘N)"
          onClick={() => {
            if (!connectionId || !session) return;
            openSqlTab(
              connectionId,
              session.currentDatabase ?? '',
              tab && 'schema' in tab ? tab.schema : (session.currentSchema ?? ''),
            );
          }}
        >
          SQL 편집기
        </button>
        <button
          className="btn"
          title="열려 있는 SQL 편집기 목록 (⌘⇧L)"
          onClick={() => setState((s) => ({ sqlListOpen: !s.sqlListOpen }))}
        >
          목록{sqlEditorCount > 0 ? ` (${sqlEditorCount})` : ''}
        </button>
        <button className="btn" title="쿼리 히스토리 (⌘⇧H)" onClick={openHistoryTab}>
          히스토리
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <span className="toolbar-label">연결</span>
        <span className={`conn-chip ${connected ? 'on' : 'off'}`}>
          {conn ? conn.name : '없음'}
        </span>
      </div>

      <div className="toolbar-group">
        <span className="toolbar-label">DB</span>
        <select
          className="select"
          disabled={!connected || databases.length === 0}
          value={session?.currentDatabase ?? ''}
          onChange={(e) => void onDatabaseChange(e.target.value)}
        >
          {databases.length === 0 && <option value="">-</option>}
          {databases.map((d) => (
            <option key={d.name} value={d.name}>{d.name}</option>
          ))}
        </select>
      </div>

      {session?.hasSchemaLevel && (
        <div className="toolbar-group">
          <span className="toolbar-label">스키마</span>
          <select
            className="select"
            disabled={!connected || schemas.length === 0}
            value={session?.currentSchema ?? ''}
            onChange={(e) => connectionId && void switchSchema(connectionId, e.target.value)}
          >
            {schemas.length === 0 && <option value="">-</option>}
            {schemas.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <select
          className="select"
          disabled={!connected}
          value={autoCommit ? 'auto' : 'manual'}
          onChange={(e) => connectionId && void setAutoCommit(connectionId, e.target.value === 'auto')}
          title="커밋 모드"
        >
          <option value="auto">자동 커밋</option>
          <option value="manual">수동 커밋</option>
        </select>
        <button
          className="btn btn-commit"
          disabled={!connected || autoCommit || !txActive}
          title="커밋 (⌘⌥C)"
          onClick={() => connectionId && void commit(connectionId)}
        >
          커밋{pending > 0 ? ` (${pending})` : ''}
        </button>
        <button
          className="btn btn-rollback"
          disabled={!connected || autoCommit || !txActive}
          title="롤백 (⌘⌥R)"
          onClick={() => connectionId && void rollback(connectionId)}
        >
          롤백
        </button>
        {txActive && <span className="tx-dot" title="트랜잭션 진행 중" />}
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        <button
          className="btn"
          title="새로 고침 (F5)"
          onClick={() => window.dispatchEvent(new CustomEvent('dbstudio:refresh'))}
        >
          새로 고침
        </button>
      </div>
    </header>
  );
}
