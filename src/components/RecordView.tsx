import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface RecordColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
}

interface Props {
  columns: RecordColumn[];
  /** 현재 행의 값들. columns 와 같은 순서. */
  values: unknown[];
  /** 화면에 보여줄 행 번호 (1부터) */
  rowNumber: number;
  totalRows: number;
  onPrev: () => void;
  onNext: () => void;
  onExitRecordMode: () => void;
  /** 편집 가능한 컬럼 인덱스 판단 (없으면 읽기 전용) */
  editable?: boolean;
  /** 이 행에서 이미 고쳐진 컬럼 인덱스들 */
  editedColumns?: Set<number>;
  onCommit?: (colIdx: number, raw: string, isNull: boolean) => void;
  /** 새로 추가한 행이라 아직 값이 없는 컬럼 표시용 */
  unsetColumns?: Set<number>;
}

/**
 * 한 행을 세로로 펼쳐 보여준다 (DBeaver 의 Record 모드).
 * 컬럼이 많아 가로 스크롤이 길어질 때 값 확인·수정이 훨씬 편하다.
 */
export default function RecordView({
  columns, values, rowNumber, totalRows,
  onPrev, onNext, onExitRecordMode,
  editable = false, editedColumns, onCommit, unsetColumns,
}: Props) {
  const [editingCol, setEditingCol] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setEditingCol(null); }, [rowNumber]);

  useEffect(() => {
    if (editingCol === null) return;
    const v = values[editingCol];
    setDraft(v === null || v === undefined ? '' : String(v));
    window.setTimeout(() => inputRef.current?.select(), 0);
  }, [editingCol, values]);

  const commit = () => {
    if (editingCol !== null && onCommit) onCommit(editingCol, draft, draft === '');
    setEditingCol(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editingCol !== null) return;
    if (e.key === 'Tab') { e.preventDefault(); onExitRecordMode(); return; }
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); onNext(); }
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); onPrev(); }
  };

  return (
    <div className="record-view" ref={boxRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="record-head">
        <button className="btn small" disabled={rowNumber <= 1} onClick={onPrev}>‹ 이전 행</button>
        <span className="page-info">{rowNumber} / {totalRows}</span>
        <button className="btn small" disabled={rowNumber >= totalRows} onClick={onNext}>다음 행 ›</button>
        <div className="spacer" />
        <span className="hint">Tab — 그리드로 돌아가기 · ↑↓ 행 이동</span>
        <button className="btn small" onClick={onExitRecordMode}>그리드</button>
      </div>

      <div className="grid-scroll">
        <table className="record-table">
          <thead>
            <tr><th className="rec-name">컬럼</th><th className="rec-type">타입</th><th>값</th></tr>
          </thead>
          <tbody>
            {columns.map((c, i) => {
              const value = values[i];
              const isNull = value === null;
              const isUnset = value === undefined || unsetColumns?.has(i);
              const edited = editedColumns?.has(i);
              return (
                <tr key={`${c.name}-${i}`} className={edited ? 'edited-row' : ''}>
                  <td className={`rec-name mono ${c.primaryKey ? 'pk' : ''}`}>
                    {c.primaryKey && <span className="pk-mark" title="기본키">PK</span>}
                    {c.name}
                  </td>
                  <td className="rec-type mono">{c.type}</td>
                  {editingCol === i ? (
                    <td className="editing">
                      <input
                        ref={inputRef}
                        className="cell-input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commit(); }
                          if (e.key === 'Escape') { e.preventDefault(); setEditingCol(null); }
                        }}
                      />
                    </td>
                  ) : (
                    <td
                      className={`rec-value mono ${isNull ? 'null' : ''} ${edited ? 'edited' : ''}`}
                      onDoubleClick={() => editable && setEditingCol(i)}
                      title={isNull ? 'NULL' : String(value ?? '')}
                    >
                      {isNull ? '[NULL]' : isUnset ? '' : String(value)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
