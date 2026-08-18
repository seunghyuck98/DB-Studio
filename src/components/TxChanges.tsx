import type { TxEntry } from '../types';

const SOURCE_LABELS: Record<string, string> = {
  sql: 'SQL 편집기',
  edit: '데이터 편집',
  ddl: 'DDL',
  data: '데이터 조회',
};

/** 커밋 확인창과 변경 내역 탭이 함께 쓰는 표. */
export default function TxChanges({ entries, compact }: { entries: TxEntry[]; compact?: boolean }) {
  if (entries.length === 0) {
    return <div className="pane-message muted">확정할 변경 사항이 없습니다.</div>;
  }
  return (
    <table className="meta-table tx-table">
      <thead>
        <tr>
          <th>#</th><th>종류</th><th>영향 행</th><th>출처</th>
          {!compact && <th>시각</th>}
          <th>SQL</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.seq} className={e.rollbackable ? '' : 'not-rollbackable'}>
            <td className="num">{e.seq}</td>
            <td>
              <span className={`verb-badge v-${e.verb.toLowerCase()}`}>{e.verb}</span>
              {!e.rollbackable && <span className="badge-note" title="이 DB 에서는 DDL 이 즉시 확정되어 롤백되지 않습니다">확정됨</span>}
            </td>
            <td className="num">{e.affected == null ? '' : e.affected.toLocaleString()}</td>
            <td className="nowrap">{SOURCE_LABELS[e.source] ?? e.source}</td>
            {!compact && <td className="nowrap">{formatTime(e.at)}</td>}
            <td className="mono tx-sql" title={e.sql}>{oneLine(e.sql)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 롤백해도 되돌아가지 않는 문장 (MySQL·MariaDB 의 DDL) */
export function unrollbackable(entries: TxEntry[]): TxEntry[] {
  return entries.filter((e) => !e.rollbackable);
}

/** 문장 수와 영향 행 수를 한 줄로 요약한다. */
export function summarize(entries: TxEntry[]): string {
  const rows = entries.reduce((sum, e) => sum + (e.affected || 0), 0);
  const byVerb = new Map<string, number>();
  for (const e of entries) byVerb.set(e.verb, (byVerb.get(e.verb) ?? 0) + 1);
  const parts = [...byVerb.entries()].map(([v, n]) => `${v} ${n}`);
  return `문장 ${entries.length}건 (${parts.join(', ')}) · 영향 행 ${rows.toLocaleString()}개`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 300);
}
