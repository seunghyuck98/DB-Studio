import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ExportButton from './ExportButton';
import { getTabScratch, setTabScratch, notify, setSession, getState } from '../state/store';
import { message } from '../state/actions';
import type { QueryResult, TableColumn, TableTab } from '../types';

interface OrderBy { column: string; direction: 'asc' | 'desc' }

const PAGE_SIZES = [100, 200, 500, 1000];

export default function DataTab({ tab }: { tab: TableTab }) {
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [limit, setLimit] = useState<number>(() => getTabScratch(tab.id, 'limit', 200));
  const [offset, setOffset] = useState<number>(() => getTabScratch(tab.id, 'offset', 0));
  const [filter, setFilter] = useState<string>(() => getTabScratch(tab.id, 'filter', ''));
  const [appliedFilter, setAppliedFilter] = useState<string>(() => getTabScratch(tab.id, 'filter', ''));
  const [orderBy, setOrderBy] = useState<OrderBy | null>(() => getTabScratch(tab.id, 'orderBy', null));
  const [total, setTotal] = useState<number | null>(null);

  // 편집 상태: 원본 행은 그대로 두고 변경분만 따로 모은다.
  const [edits, setEdits] = useState<Record<number, Record<number, unknown>>>({});
  const [deleted, setDeleted] = useState<Record<number, true>>({});
  const [inserts, setInserts] = useState<Record<string, unknown>[]>([]);
  const [editing, setEditing] = useState<{ row: number; col: number; insert: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setTabScratch(tab.id, 'limit', limit); }, [tab.id, limit]);
  useEffect(() => { setTabScratch(tab.id, 'offset', offset); }, [tab.id, offset]);
  useEffect(() => { setTabScratch(tab.id, 'filter', appliedFilter); }, [tab.id, appliedFilter]);
  useEffect(() => { setTabScratch(tab.id, 'orderBy', orderBy); }, [tab.id, orderBy]);

  const pkColumns = useMemo(() => columns.filter((c) => c.primaryKey).map((c) => c.name), [columns]);
  const editable = tab.objectKind === 'table' && pkColumns.length > 0;
  const dirty = Object.keys(edits).length > 0 || Object.keys(deleted).length > 0 || inserts.length > 0;

  const resetEdits = useCallback(() => {
    setEdits({});
    setDeleted({});
    setInserts([]);
    setEditing(null);
  }, []);

  const load = useCallback(async (nextOffset = offset, nextFilter = appliedFilter, nextOrder = orderBy) => {
    setLoading(true);
    setError(null);
    try {
      const cols: TableColumn[] = await window.api.meta.get(tab.connectionId, 'columns', {
        schema: tab.schema, table: tab.table,
      });
      setColumns(cols);
      const r = await window.api.data.select(tab.connectionId, {
        schema: tab.schema,
        table: tab.table,
        limit,
        offset: nextOffset,
        filter: nextFilter,
        orderBy: nextOrder,
      });
      setResult(r);
      resetEdits();
      syncStatus(tab.connectionId);
    } catch (e) {
      setError(message(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.schema, tab.table, limit, offset, appliedFilter, orderBy, resetEdits]);

  useEffect(() => { void load(offset, appliedFilter, orderBy); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.id, limit, offset, appliedFilter, orderBy]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('dbstudio:refresh', handler);
    return () => window.removeEventListener('dbstudio:refresh', handler);
  }, [load]);

  const applyFilter = () => {
    if (dirty && !window.confirm('저장하지 않은 변경 사항이 있습니다. 버리고 다시 조회할까요?')) return;
    setOffset(0);
    setAppliedFilter(filter);
  };

  const toggleSort = (name: string) => {
    setOffset(0);
    setOrderBy((prev) => {
      if (!prev || prev.column !== name) return { column: name, direction: 'asc' };
      if (prev.direction === 'asc') return { column: name, direction: 'desc' };
      return null;
    });
  };

  const countRows = async () => {
    try {
      setTotal(await window.api.data.count(tab.connectionId, {
        schema: tab.schema, table: tab.table, filter: appliedFilter,
      }));
      syncStatus(tab.connectionId);
    } catch (e) {
      notify('error', message(e));
    }
  };

  const save = async () => {
    if (!result) return;
    setSaving(true);
    try {
      const colNames = result.columns.map((c) => c.name);
      const keyOf = (rowIdx: number) => {
        const key: Record<string, unknown> = {};
        for (const pk of pkColumns) {
          const i = colNames.indexOf(pk);
          if (i < 0) throw new Error(`기본키 컬럼 ${pk} 이(가) 조회 결과에 없습니다.`);
          key[pk] = result.rows[rowIdx][i];
        }
        return key;
      };

      const updates = Object.entries(edits)
        .filter(([rowIdx]) => !deleted[Number(rowIdx)])
        .map(([rowIdx, cells]) => ({
          key: keyOf(Number(rowIdx)),
          changes: Object.fromEntries(
            Object.entries(cells).map(([colIdx, value]) => [colNames[Number(colIdx)], value]),
          ),
        }));

      const changes = {
        updates,
        inserts: inserts
          .map((values) => ({ values: stripEmpty(values) }))
          .filter((i) => Object.keys(i.values).length > 0),
        deletes: Object.keys(deleted).map((rowIdx) => ({ key: keyOf(Number(rowIdx)) })),
      };

      const res = await window.api.data.apply(tab.connectionId, {
        schema: tab.schema, table: tab.table, changes,
      });
      setSession(tab.connectionId, res.status);
      notify('success', res.status.autoCommit
        ? `${res.executed.length}개 문장을 적용하고 커밋했습니다.`
        : `${res.executed.length}개 문장을 적용했습니다. 확정하려면 커밋하세요.`);
      await load();
    } catch (e) {
      notify('error', `저장 실패: ${message(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const setCell = (rowIdx: number, colIdx: number, raw: string, isNull: boolean) => {
    const col = columns.find((c) => c.name === result?.columns[colIdx]?.name);
    const value = isNull ? null : coerce(raw, col);
    setEdits((prev) => ({ ...prev, [rowIdx]: { ...prev[rowIdx], [colIdx]: value } }));
  };

  const setInsertCell = (insertIdx: number, colName: string, raw: string, isNull: boolean) => {
    const col = columns.find((c) => c.name === colName);
    const value = isNull ? null : coerce(raw, col);
    setInserts((prev) => prev.map((r, i) => (i === insertIdx ? { ...r, [colName]: value } : r)));
  };

  const cols = result?.columns ?? [];
  const rowCount = result?.rows.length ?? 0;
  const pageEnd = offset + rowCount;

  return (
    <div className="data-tab">
      <div className="data-toolbar">
        <input
          className="input filter"
          placeholder="필터 (WHERE 절, 예: status = 'A' AND id > 100)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(); }}
        />
        <button className="btn small" onClick={applyFilter}>적용</button>
        {appliedFilter && (
          <button className="btn small" onClick={() => { setFilter(''); setAppliedFilter(''); setOffset(0); }}>해제</button>
        )}
        <div className="spacer" />
        <button className="btn small" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>‹ 이전</button>
        <span className="page-info">
          {rowCount === 0 ? '0' : `${offset + 1}–${pageEnd}`}
          {total !== null ? ` / ${total.toLocaleString()}` : ''}
        </span>
        <button className="btn small" disabled={rowCount < limit || loading} onClick={() => setOffset(offset + limit)}>다음 ›</button>
        <select className="select small" value={limit} onChange={(e) => { setOffset(0); setLimit(Number(e.target.value)); }}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}행</option>)}
        </select>
        <button className="btn small" onClick={() => void countRows()}>행 수 세기</button>
        <ExportButton
          defaultName={`${tab.schema}.${tab.table}`}
          current={result ? { columns: result.columns, rows: result.rows } : null}
          full={{
            connectionId: tab.connectionId,
            req: { schema: tab.schema, table: tab.table, filter: appliedFilter, orderBy },
          }}
        />
        <button className="btn small" onClick={() => void load()} disabled={loading}>새로 고침</button>
      </div>

      <div className="data-toolbar second">
        {editable ? (
          <>
            <button className="btn small" onClick={() => setInserts((p) => [...p, {}])}>+ 행 추가</button>
            <button
              className="btn small"
              disabled={!editing || editing.insert}
              onClick={() => editing && setDeleted((p) => ({ ...p, [editing.row]: true }))}
            >
              − 행 삭제 표시
            </button>
            <button className="btn small" disabled={!dirty} onClick={resetEdits}>변경 취소</button>
            <button className="btn small primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? '저장 중…' : '변경 저장'}
            </button>
            <span className="hint">셀을 더블클릭해 편집 · 빈 값 저장 시 NULL</span>
          </>
        ) : (
          <span className="hint">
            {tab.objectKind === 'view' ? '뷰는 편집할 수 없습니다.' : '기본키가 없어 이 테이블은 편집할 수 없습니다.'}
          </span>
        )}
        <div className="spacer" />
        {result && <span className="hint">{result.elapsed}ms</span>}
      </div>

      {loading && <div className="pane-message">조회 중…</div>}
      {error && <div className="pane-message error">{error}</div>}

      {result && !loading && (
        <div className="grid-scroll">
          <table className="data-grid">
            <thead>
              <tr>
                <th className="rownum" />
                {cols.map((c) => {
                  const meta = columns.find((m) => m.name === c.name);
                  return (
                    <th
                      key={c.name}
                      onClick={() => toggleSort(c.name)}
                      title={`${c.name} : ${meta?.dataType ?? c.type}`}
                      className={meta?.primaryKey ? 'pk' : ''}
                    >
                      <span className="col-name">{c.name}</span>
                      <span className="col-type">{meta?.dataType ?? c.type}</span>
                      {orderBy?.column === c.name && <span className="sort">{orderBy.direction === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIdx) => (
                <tr key={rowIdx} className={deleted[rowIdx] ? 'deleted' : ''}>
                  <td className="rownum">{offset + rowIdx + 1}</td>
                  {row.map((value, colIdx) => {
                    const edited = edits[rowIdx] && colIdx in edits[rowIdx];
                    const shown = edited ? edits[rowIdx][colIdx] : value;
                    const isEditing = editing?.row === rowIdx && editing?.col === colIdx && !editing.insert;
                    return (
                      <Cell
                        key={colIdx}
                        value={shown}
                        edited={!!edited}
                        editable={editable && !deleted[rowIdx]}
                        editing={isEditing}
                        onSelect={() => setEditing({ row: rowIdx, col: colIdx, insert: false })}
                        onStartEdit={() => setEditing({ row: rowIdx, col: colIdx, insert: false })}
                        onCommit={(raw, isNull) => { setCell(rowIdx, colIdx, raw, isNull); setEditing(null); }}
                        onCancel={() => setEditing(null)}
                      />
                    );
                  })}
                </tr>
              ))}
              {inserts.map((values, insertIdx) => (
                <tr key={`new-${insertIdx}`} className="inserted">
                  <td className="rownum">
                    <button
                      className="icon-btn"
                      title="이 행 제거"
                      onClick={() => setInserts((p) => p.filter((_, i) => i !== insertIdx))}
                    >×</button>
                  </td>
                  {cols.map((c, colIdx) => {
                    const isEditing = editing?.row === insertIdx && editing?.col === colIdx && editing.insert;
                    return (
                      <Cell
                        key={c.name}
                        value={c.name in values ? values[c.name] : undefined}
                        edited={c.name in values}
                        editable
                        editing={isEditing}
                        onSelect={() => setEditing({ row: insertIdx, col: colIdx, insert: true })}
                        onStartEdit={() => setEditing({ row: insertIdx, col: colIdx, insert: true })}
                        onCommit={(raw, isNull) => { setInsertCell(insertIdx, c.name, raw, isNull); setEditing(null); }}
                        onCancel={() => setEditing(null)}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {rowCount === 0 && inserts.length === 0 && <div className="pane-message muted">표시할 행이 없습니다.</div>}
        </div>
      )}
    </div>
  );
}

interface CellProps {
  value: unknown;
  edited: boolean;
  editable: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCommit: (raw: string, isNull: boolean) => void;
  onCancel: () => void;
}

function Cell({ value, edited, editable, editing, onSelect, onStartEdit, onCommit, onCancel }: CellProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (editing) {
      setDraft(value === null || value === undefined ? '' : String(value));
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing, value]);

  if (editing) {
    return (
      <td className="editing">
        <input
          ref={inputRef}
          className="cell-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommit(draft, draft === '')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onCommit(draft, draft === ''); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          }}
        />
      </td>
    );
  }

  const isNull = value === null;
  const isUnset = value === undefined;
  return (
    <td
      className={`${edited ? 'edited' : ''} ${isNull ? 'null' : ''}`}
      onClick={onSelect}
      onDoubleClick={() => editable && onStartEdit()}
      title={isNull ? 'NULL' : String(value ?? '')}
    >
      {isNull ? '[NULL]' : isUnset ? '' : String(value)}
    </td>
  );
}

/** 입력 문자열을 컬럼 타입에 맞춰 변환한다. */
function coerce(raw: string, col?: TableColumn): unknown {
  if (!col) return raw;
  const t = col.dataType.toLowerCase();
  if (/^(int|bigint|smallint|tinyint|mediumint|integer|serial|bigserial|numeric|decimal|real|double|float)/.test(t)) {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (/^(bool)/.test(t)) {
    const v = raw.trim().toLowerCase();
    if (['true', 't', '1', 'y', 'yes'].includes(v)) return true;
    if (['false', 'f', '0', 'n', 'no'].includes(v)) return false;
    return raw;
  }
  return raw;
}

function stripEmpty(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/** 데이터 조회로 트랜잭션이 열렸을 수 있으므로 세션 상태를 갱신한다. */
function syncStatus(connectionId: string) {
  window.api.connections.status(connectionId).then((s) => {
    if (getState().sessions[connectionId]) setSession(connectionId, s);
  }).catch(() => { /* 상태 갱신 실패는 무시한다 */ });
}
