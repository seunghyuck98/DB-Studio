import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface RecordColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
}

/** 세로 보기에 나란히 놓일 행 하나 */
export interface RecordRowData {
  /** 편집 커밋을 어느 행으로 돌려줄지 식별하는 키 */
  key: string;
  /** 값 열 머리글 (예: "행 12") */
  label: string;
  /** columns 와 같은 순서의 값들 */
  values: unknown[];
  editable?: boolean;
  /** 이 행에서 이미 고쳐진 컬럼 인덱스들 */
  editedColumns?: Set<number>;
  /** 새로 추가한 행이라 아직 값이 없는 컬럼 표시용 */
  unsetColumns?: Set<number>;
}

interface Props {
  columns: RecordColumn[];
  /** 선택된 행들 — 하나면 단일 레코드 보기, 여러 개면 값 열이 나란히 붙는다 */
  rows: RecordRowData[];
  /** 단일 행일 때의 위치 표시·탐색 (여러 행이면 쓰지 않는다) */
  rowNumber?: number;
  totalRows?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onExitRecordMode: () => void;
  onCommit?: (rowKey: string, colIdx: number, raw: string, isNull: boolean) => void;
}

/**
 * 행을 세로로 펼쳐 보여준다 (DBeaver 의 Record 모드).
 * 여러 행을 선택했다면 각 행이 값 열로 나란히 붙어, 행끼리 값을 비교하기 좋다.
 */
export default function RecordView({
  columns, rows, rowNumber, totalRows,
  onPrev, onNext, onExitRecordMode, onCommit,
}: Props) {
  // 편집 중인 칸: 행 키 + 컬럼 인덱스
  const [editing, setEditing] = useState<{ rowKey: string; col: number } | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const single = rows.length === 1;

  useEffect(() => { setEditing(null); }, [rowNumber, rows.length]);

  useEffect(() => {
    if (!editing) return;
    const row = rows.find((r) => r.key === editing.rowKey);
    const v = row?.values[editing.col];
    setDraft(v === null || v === undefined ? '' : String(v));
    window.setTimeout(() => inputRef.current?.select(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    if (editing && onCommit) onCommit(editing.rowKey, editing.col, draft, draft === '');
    setEditing(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return;
    if (e.key === 'Tab') { e.preventDefault(); onExitRecordMode(); return; }
    if (single && onNext && (e.key === 'ArrowDown' || e.key === 'PageDown')) { e.preventDefault(); onNext(); }
    if (single && onPrev && (e.key === 'ArrowUp' || e.key === 'PageUp')) { e.preventDefault(); onPrev(); }
  };

  return (
    <div className="record-view" ref={boxRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="record-head">
        {single && rowNumber != null && totalRows != null ? (
          <>
            <button className="btn small" disabled={rowNumber <= 1 || !onPrev} onClick={onPrev}>‹ 이전 행</button>
            <span className="page-info">{rowNumber} / {totalRows}</span>
            <button className="btn small" disabled={rowNumber >= totalRows || !onNext} onClick={onNext}>다음 행 ›</button>
          </>
        ) : (
          <span className="page-info">{rows.length}개 행 나란히 보기</span>
        )}
        <div className="spacer" />
        <span className="hint">
          {single ? 'Tab — 그리드로 돌아가기 · ↑↓ 행 이동' : 'Tab — 그리드로 돌아가기'}
        </span>
        <button className="btn small" onClick={onExitRecordMode}>그리드</button>
      </div>

      <div className="grid-scroll">
        <table className="record-table">
          <thead>
            <tr>
              <th className="rec-name">컬럼</th>
              <th className="rec-type">타입</th>
              {rows.map((r) => <th key={r.key}>{single ? '값' : r.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => (
              <tr key={`${c.name}-${i}`}>
                <td className={`rec-name mono ${c.primaryKey ? 'pk' : ''}`}>
                  {c.primaryKey && <span className="pk-mark" title="기본키">PK</span>}
                  {c.name}
                </td>
                <td className="rec-type mono">{c.type}</td>
                {rows.map((r) => {
                  const value = r.values[i];
                  const isNull = value === null;
                  const isUnset = value === undefined || r.unsetColumns?.has(i);
                  const edited = r.editedColumns?.has(i);
                  if (editing && editing.rowKey === r.key && editing.col === i) {
                    return (
                      <td key={r.key} className="editing">
                        <input
                          ref={inputRef}
                          className="cell-input"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commit(); }
                            if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                          }}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={r.key}
                      className={`rec-value mono ${isNull ? 'null' : ''} ${edited ? 'edited' : ''}`}
                      onDoubleClick={() => r.editable && setEditing({ rowKey: r.key, col: i })}
                      title={isNull ? 'NULL' : String(value ?? '')}
                    >
                      {isNull ? '[NULL]' : isUnset ? '' : String(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
