import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/store';
import { setUsageLimits } from '../state/actions';
import type { UsageSummary, UsageTotals } from '../types';

/** 큰 수를 1.2M / 34k 처럼 짧게. */
function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function pct(total: number, limit: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(999, Math.round((total / limit) * 100));
}

function detail(label: string, t: UsageTotals, limit: number): string {
  return `${label} — ${pct(t.total, limit)}%\n`
    + `  합계 ${t.total.toLocaleString()} / 기준 ${limit.toLocaleString()}\n`
    + `  입력 ${t.input.toLocaleString()} · 출력 ${t.output.toLocaleString()}\n`
    + `  캐시 쓰기 ${t.cacheCreate.toLocaleString()} · 캐시 읽기 ${t.cacheRead.toLocaleString()}`;
}

interface Cell { key: 'fiveHour' | 'weekFable' | 'weekAll'; label: string }
const CELLS: Cell[] = [
  { key: 'fiveHour', label: '5시간' },
  { key: 'weekFable', label: '주간 Fable' },
  { key: 'weekAll', label: '주간 전체' },
];

/**
 * 헤더에 Claude 토큰 사용량을 % 로 보여 준다 — 최근 5시간 / 주간 Fable / 주간 전체.
 * Anthropic 이 실제 한도를 공개하지 않으므로, % 는 사용자가 정하는 기준 한도 대비다
 * (배지를 눌러 기준을 바꾼다). 60초마다·창 포커스 때 갱신한다.
 */
export default function UsageBadge() {
  const { usageLimits } = useAppState();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.api?.usage) return;
    let cancelled = false;
    const load = () => {
      window.api.usage.summary()
        .then((s) => { if (!cancelled) { setUsage(s); setError(false); } })
        .catch(() => { if (!cancelled) setError(true); });
    };
    load();
    timer.current = setInterval(load, 60_000);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
      window.removeEventListener('focus', load);
    };
  }, []);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setEditing(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [editing]);

  if (error || !usage) return null;

  const limitOf = (key: Cell['key']) => usageLimits[key];
  const totalsOf = (key: Cell['key']): UsageTotals => usage[key];

  const tip = [
    ...CELLS.map((c) => detail(c.label, totalsOf(c.key), limitOf(c.key))),
    `\n로컬 대화 기록 ${usage.files}개 기준. % 는 아래 기준 한도 대비이며, 배지를 눌러 바꿀 수 있습니다.`,
  ].join('\n');

  return (
    <div className="usage-badge-wrap" ref={boxRef}>
      <button className="usage-badge" title={tip} onClick={() => setEditing((v) => !v)}>
        {CELLS.map((c, i) => {
          const p = pct(totalsOf(c.key).total, limitOf(c.key));
          return (
            <span key={c.key} className="usage-cell-wrap">
              {i > 0 && <span className="usage-sep" />}
              <span className="usage-cell">
                <span className="usage-label">{c.label}</span>
                <span className={`usage-value mono ${p >= 90 ? 'over' : p >= 70 ? 'warn' : ''}`}>{p}%</span>
                <span className="usage-bar"><span style={{ width: `${Math.min(100, p)}%` }} className={p >= 90 ? 'over' : p >= 70 ? 'warn' : ''} /></span>
              </span>
            </span>
          );
        })}
      </button>

      {editing && (
        <LimitEditor
          limits={usageLimits}
          usage={usage}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function LimitEditor({ limits, usage, onClose }: {
  limits: { fiveHour: number; weekFable: number; weekAll: number };
  usage: UsageSummary;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => ({
    fiveHour: String(Math.round(limits.fiveHour / 1e6)),
    weekFable: String(Math.round(limits.weekFable / 1e6)),
    weekAll: String(Math.round(limits.weekAll / 1e6)),
  }));

  const apply = () => {
    void setUsageLimits({
      fiveHour: (Number(draft.fiveHour) || 0) * 1e6,
      weekFable: (Number(draft.weekFable) || 0) * 1e6,
      weekAll: (Number(draft.weekAll) || 0) * 1e6,
    });
    onClose();
  };

  return (
    <div className="usage-editor">
      <div className="usage-editor-title">사용량 % 기준 한도 (단위: 백만 토큰)</div>
      <p className="hint">Anthropic 이 실제 한도를 공개하지 않아, 여기 정한 값 대비로 % 를 계산합니다.</p>
      {CELLS.map((c) => (
        <label key={c.key} className="usage-editor-row">
          <span>{c.label}</span>
          <input
            className="input"
            type="number"
            min={1}
            value={draft[c.key]}
            onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
          />
          <span className="hint">현재 {fmt(usage[c.key].total)}</span>
        </label>
      ))}
      <div className="usage-editor-actions">
        <button className="btn small" onClick={onClose}>취소</button>
        <button className="btn small primary" onClick={apply}>저장</button>
      </div>
    </div>
  );
}
