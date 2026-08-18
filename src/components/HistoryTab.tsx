import { useCallback, useEffect, useState } from 'react';
import ExportButton from './ExportButton';
import { getState, notify, openSqlTab, sessionOf, setState } from '../state/store';
import { message } from '../state/actions';
import type { HistoryEntry, HistoryTab as HistoryTabType } from '../types';

const SOURCE_LABELS: Record<string, string> = {
  sql: 'SQL 편집기',
  data: '데이터 조회',
  edit: '데이터 편집',
  ddl: 'DDL',
  explain: '실행 계획',
  export: '내보내기',
};

export default function HistoryTab({ tab }: { tab: HistoryTabType }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [onlyThisConnection, setOnlyThisConnection] = useState(false);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.api.history.list({
        search,
        onlyErrors,
        connectionId: onlyThisConnection && tab.connectionId ? tab.connectionId : undefined,
        limit: 500,
      });
      setEntries(res.entries);
      setTotal(res.total);
    } catch (e) {
      notify('error', message(e));
    } finally {
      setLoading(false);
    }
  }, [search, onlyErrors, onlyThisConnection, tab.connectionId]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('dbstudio:refresh', handler);
    return () => window.removeEventListener('dbstudio:refresh', handler);
  }, [load]);

  const openInEditor = (entry: HistoryEntry) => {
    const state = getState();
    const session = sessionOf(entry.connectionId, state);
    if (!session?.connected) {
      notify('error', '이 문장을 실행했던 접속이 열려 있지 않습니다. 먼저 접속하세요.');
      return;
    }
    openSqlTab(entry.connectionId, session.currentDatabase ?? '', session.currentSchema ?? '', entry.sql);
  };

  const clearAll = async () => {
    if (!window.confirm(`쿼리 히스토리 ${total.toLocaleString()}건을 모두 지울까요?`)) return;
    await window.api.history.clear();
    setSelected(null);
    void load();
  };

  return (
    <div className="history-tab">
      <div className="history-toolbar">
        <input
          className="input"
          placeholder="SQL 내용 검색…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
          오류만
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyThisConnection}
            disabled={!tab.connectionId}
            onChange={(e) => setOnlyThisConnection(e.target.checked)}
          />
          현재 접속만
        </label>
        <div className="spacer" />
        <span className="hint">{total.toLocaleString()}건</span>
        <ExportButton
          defaultName="query-history"
          current={{
            columns: [{ name: '시각' }, { name: '접속' }, { name: 'DB' }, { name: '출처' }, { name: '소요(ms)' }, { name: '행' }, { name: '상태' }, { name: 'SQL' }],
            rows: entries.map((e) => [
              formatTime(e.at), e.connectionName ?? '', e.database ?? '', SOURCE_LABELS[e.source] ?? e.source,
              e.ms, e.rows ?? e.affected ?? '', e.ok ? '성공' : '실패', e.sql,
            ]),
          }}
        />
        <button className="btn small" onClick={() => void load()} disabled={loading}>새로 고침</button>
        <button className="btn small" onClick={() => void clearAll()}>모두 지우기</button>
      </div>

      <div className="history-body">
        <div className="grid-scroll history-list">
          <table className="meta-table">
            <thead>
              <tr>
                <th>시각</th><th>접속</th><th>DB</th><th>출처</th>
                <th>소요</th><th>행</th><th>SQL</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className={`${e.ok ? '' : 'row-error'} ${selected?.id === e.id ? 'row-selected' : ''}`}
                  onClick={() => setSelected(e)}
                  onDoubleClick={() => openInEditor(e)}
                >
                  <td className="nowrap">{formatTime(e.at)}</td>
                  <td className="nowrap">{e.connectionName ?? ''}</td>
                  <td className="nowrap">{e.database ?? ''}</td>
                  <td className="nowrap">{SOURCE_LABELS[e.source] ?? e.source}</td>
                  <td className="num">{e.ms == null ? '' : `${e.ms}ms`}</td>
                  <td className="num">{e.rows ?? e.affected ?? ''}</td>
                  <td className="mono sql-cell">{oneLine(e.sql)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && !loading && (
            <div className="pane-message muted">기록이 없습니다.</div>
          )}
        </div>

        {selected && (
          <div className="history-detail">
            <div className="history-detail-head">
              <span className="hint">
                {formatTime(selected.at)} · {selected.connectionName ?? ''}
                {selected.database ? ` · ${selected.database}` : ''}
                {selected.ms != null ? ` · ${selected.ms}ms` : ''}
              </span>
              <div className="spacer" />
              <button className="btn small" onClick={() => void navigator.clipboard.writeText(selected.sql)}>복사</button>
              <button className="btn small primary" onClick={() => openInEditor(selected)}>편집기에서 열기</button>
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="닫기">×</button>
            </div>
            <pre className="code-block">{selected.sql}</pre>
            {!selected.ok && selected.error && <pre className="code-block error-text">{selected.error}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}

export function openHistoryTab(): void {
  const state = getState();
  const existing = state.tabs.find((t) => t.kind === 'history');
  if (existing) {
    setState({ activeTabId: existing.id });
    return;
  }
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  const tab: HistoryTabType = {
    id: 'history',
    kind: 'history',
    connectionId: active?.connectionId ?? '',
    database: active && 'database' in active ? active.database : '',
    schema: active && 'schema' in active ? active.schema : '',
    title: '쿼리 히스토리',
  };
  setState({ tabs: [...state.tabs, tab], activeTabId: tab.id });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 300);
}
