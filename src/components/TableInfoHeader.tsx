import { useEffect, useState } from 'react';
import type { TableMeta, TablePrivileges, TableTab } from '../types';

function fmtBytes(n: number): string {
  if (!n) return '0';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

/**
 * 테이블 탭 상단(섹션 탭 우측)에 항상 보이는 요약 정보.
 * Properties 뿐 아니라 Data·관계도 섹션에서도 그대로 보인다.
 */
export default function TableInfoHeader({ tab }: { tab: TableTab }) {
  const [info, setInfo] = useState<TableMeta | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [tables, privileges] = await Promise.all([
          window.api.meta.get(tab.connectionId, 'tables', { schema: tab.schema }) as Promise<TableMeta[]>,
          window.api.meta.get(tab.connectionId, 'privileges', { schema: tab.schema, table: tab.table }) as Promise<TablePrivileges>,
        ]);
        if (cancelled) return;
        setInfo(tables.find((t) => t.name === tab.table) ?? null);
        setOwner(privileges.owner);
      } catch (_) {
        /* 정보 영역은 부가 표시라 실패해도 탭 동작을 막지 않는다 */
      }
    })();
    const handler = () => {
      // F5 로 새로 고치면 정보도 다시 읽는다.
      window.api.meta.get(tab.connectionId, 'tables', { schema: tab.schema })
        .then((tables: TableMeta[]) => { if (!cancelled) setInfo(tables.find((t) => t.name === tab.table) ?? null); })
        .catch(() => { /* 무시 */ });
    };
    window.addEventListener('dbstudio:refresh', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('dbstudio:refresh', handler);
    };
  }, [tab.connectionId, tab.schema, tab.table]);

  if (!info) return null;

  const items: { label: string; value: string }[] = [];
  if (owner) items.push({ label: '소유자', value: owner });
  if (info.engine) items.push({ label: '엔진', value: info.engine });
  if (info.rowsEstimate != null) items.push({ label: '행', value: info.rowsEstimate.toLocaleString() });
  if (info.sizeBytes) items.push({ label: '크기', value: fmtBytes(info.sizeBytes) });
  if (info.collation) items.push({ label: '정렬', value: info.collation });

  const tooltip = [
    `${tab.schema}.${tab.table} (${info.kind === 'view' ? '뷰' : '테이블'})`,
    info.comment ? `주석: ${info.comment}` : null,
    info.createdAt ? `생성: ${fmtDate(info.createdAt)}` : null,
    info.updatedAt ? `변경: ${fmtDate(info.updatedAt)}` : null,
  ].filter(Boolean).join('\n');

  return (
    <div className="table-info-head" title={tooltip}>
      {info.comment && <span className="props-info-comment">{info.comment}</span>}
      {items.map((it) => (
        <span key={it.label} className="props-info-item">
          <span className="props-info-label">{it.label}</span>
          <span className="mono">{it.value}</span>
        </span>
      ))}
    </div>
  );
}
