import { useState } from 'react';
import ExportButton from './ExportButton';
import type { StatementResult } from '../types';

interface Props {
  result: StatementResult;
  /** 페이지 제한 없이 다시 조회해서 내보낼 수 있는 경우의 접속 정보 */
  exportSource?: { connectionId: string; name: string } | null;
}

/** SQL 편집기 실행 결과를 읽기 전용으로 보여주는 그리드. */
export default function ResultGrid({ result, exportSource }: Props) {
  const [copied, setCopied] = useState(false);

  const copyAsTsv = async () => {
    const head = result.columns.map((c) => c.name).join('\t');
    const body = result.rows.map((r) => r.map(cellText).join('\t')).join('\n');
    await navigator.clipboard.writeText(`${head}\n${body}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="result-pane">
      <div className="result-head">
        <span className="hint">
          {result.rowCount.toLocaleString()}행 · {result.elapsed}ms
          {result.truncated && ' · 표시 한도 초과(일부만 표시)'}
        </span>
        <div className="spacer" />
        <button className="btn small" onClick={() => void copyAsTsv()}>{copied ? '복사됨' : '결과 복사'}</button>
        <ExportButton
          defaultName={exportSource?.name ?? 'query-result'}
          current={{ columns: result.columns, rows: result.rows }}
          full={exportSource && result.sql
            ? { connectionId: exportSource.connectionId, req: { sql: result.sql } }
            : null}
        />
      </div>
      <div className="grid-scroll">
        <table className="data-grid">
          <thead>
            <tr>
              <th className="rownum" />
              {result.columns.map((c, i) => (
                <th key={`${c.name}-${i}`} title={`${c.name} : ${c.type}`}>
                  <span className="col-name">{c.name}</span>
                  <span className="col-type">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                <td className="rownum">{i + 1}</td>
                {row.map((v, j) => (
                  <td key={j} className={v === null ? 'null' : ''} title={cellText(v)}>
                    {v === null ? '[NULL]' : cellText(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length === 0 && <div className="pane-message muted">결과가 없습니다.</div>}
      </div>
    </div>
  );
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}
