import { useEffect, useRef, useState } from 'react';
import { notify } from '../state/store';
import { message } from '../state/actions';
import type { ExportFormat, ExportResult } from '../types';

interface FullSource {
  connectionId: string;
  req: {
    schema?: string;
    table?: string;
    filter?: string;
    orderBy?: { column: string; direction: 'asc' | 'desc' } | null;
    sql?: string;
    maxRows?: number;
  };
}

interface Props {
  defaultName: string;
  /** 지금 화면에 떠 있는 결과 */
  current: { columns: { name: string }[]; rows: unknown[][] } | null;
  /** 페이지 제한 없이 다시 조회할 수 있는 경우의 조회 조건 */
  full?: FullSource | null;
  label?: string;
}

const FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'csv', label: 'CSV' },
  { format: 'tsv', label: 'TSV' },
  { format: 'xlsx', label: 'Excel' },
];

export default function ExportButton({ defaultName, current, full, label = '내보내기' }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const report = (res: ExportResult) => {
    if (res.canceled) return;
    const truncated = res.truncated ? ' (행 수 제한에 걸려 일부만 저장했습니다)' : '';
    notify('success', `${res.name} 에 ${(res.rows ?? 0).toLocaleString()}행을 저장했습니다.${truncated}`);
  };

  const run = async (fn: () => Promise<ExportResult>) => {
    setOpen(false);
    setBusy(true);
    try {
      report(await fn());
    } catch (e) {
      notify('error', `내보내기 실패: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportCurrent = (format: ExportFormat) => run(() =>
    window.api.exports.rows({
      columns: current!.columns,
      rows: current!.rows,
      format,
      defaultName,
    }));

  const exportFull = (format: ExportFormat) => run(() =>
    window.api.exports.query(full!.connectionId, { ...full!.req, format, defaultName }));

  const canCurrent = !!current && current.columns.length > 0;

  return (
    <div className="export-box" ref={boxRef}>
      <button className="btn small" disabled={busy || (!canCurrent && !full)} onClick={() => setOpen((v) => !v)}>
        {busy ? '저장 중…' : `${label} ▾`}
      </button>
      {open && (
        <div className="export-menu">
          <div className="export-group">현재 화면 결과</div>
          {FORMATS.map((f) => (
            <button key={`cur-${f.format}`} disabled={!canCurrent} onClick={() => exportCurrent(f.format)}>
              {f.label}
            </button>
          ))}
          {full && (
            <>
              <div className="export-group">전체 결과 (다시 조회)</div>
              {FORMATS.map((f) => (
                <button key={`full-${f.format}`} onClick={() => exportFull(f.format)}>
                  {f.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
