import { useCallback, useEffect, useMemo, useState } from 'react';
import { openTableTab, sessionOf, useAppState } from '../state/store';
import { message } from '../state/actions';
import type { SchemaTab, TableMeta } from '../types';

function fmtBytes(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type SortKey = 'name' | 'kind' | 'rowsEstimate' | 'sizeBytes' | 'comment';

/**
 * 스키마(또는 MySQL 데이터베이스) 하나의 테이블 목록.
 * 트리에서 스키마를 더블클릭하면 우측에 열리고, 행을 더블클릭하면 그 테이블이 열린다.
 */
export default function SchemaListTab({ tab }: { tab: SchemaTab }) {
  const state = useAppState();
  const [rows, setRows] = useState<TableMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const session = sessionOf(tab.connectionId, state);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await window.api.meta.get(tab.connectionId, 'tables', { schema: tab.schema }));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.schema]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('dbstudio:refresh', handler);
    return () => window.removeEventListener('dbstudio:refresh', handler);
  }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? rows.filter((t) => t.name.toLowerCase().includes(q) || (t.comment ?? '').toLowerCase().includes(q))
      : rows;
    const dir = sort.dir;
    return [...filtered].sort((a, b) => {
      const va = a[sort.key] ?? (typeof a[sort.key] === 'number' ? 0 : '');
      const vb = b[sort.key] ?? (typeof b[sort.key] === 'number' ? 0 : '');
      if (typeof va === 'number' || typeof vb === 'number') return (Number(va ?? 0) - Number(vb ?? 0)) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, filter, sort]);

  const clickSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

  const open = (t: TableMeta) => {
    openTableTab({
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
      table: t.name,
      objectKind: t.kind === 'view' ? 'view' : 'table',
    });
  };

  const isMySql = session ? !session.hasSchemaLevel : false;

  return (
    <div className="schema-list">
      <div className="data-toolbar">
        <input
          className="input filter"
          placeholder="이름·주석으로 거르기…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="hint">
          {filter ? `${shown.length} / ${rows.length}개` : `${rows.length}개`}
        </span>
        <div className="spacer" />
        <button className="btn small" onClick={() => void load()} disabled={loading}>새로 고침</button>
      </div>

      {loading && <div className="pane-message">불러오는 중…</div>}
      {error && <div className="pane-message error">{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div className="pane-message muted">이 {isMySql ? '데이터베이스' : '스키마'}에 테이블이 없습니다.</div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="grid-scroll">
          <table className="meta-table hoverable">
            <thead>
              <tr>
                <th onClick={() => clickSort('name')}>이름{arrow('name')}</th>
                <th onClick={() => clickSort('kind')}>종류{arrow('kind')}</th>
                <th>엔진</th>
                <th onClick={() => clickSort('rowsEstimate')} className="num">행 (추정){arrow('rowsEstimate')}</th>
                <th onClick={() => clickSort('sizeBytes')} className="num">크기{arrow('sizeBytes')}</th>
                <th onClick={() => clickSort('comment')}>주석{arrow('comment')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.name} onDoubleClick={() => open(t)} title="더블클릭해 열기">
                  <td className="mono strong">
                    <span className={`icon icon-${t.kind === 'view' ? 'view' : 'table'}`} aria-hidden /> {t.name}
                  </td>
                  <td>{t.kind === 'view' ? '뷰' : '테이블'}</td>
                  <td>{t.engine ?? ''}</td>
                  <td className="num">{t.rowsEstimate != null ? t.rowsEstimate.toLocaleString() : ''}</td>
                  <td className="num">{fmtBytes(t.sizeBytes)}</td>
                  <td className="cell-comment">{t.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
