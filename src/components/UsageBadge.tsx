import { useEffect, useRef, useState } from 'react';
import type { UsageSummary } from '../types';

/** 큰 수를 1.2M / 34k 처럼 짧게. */
function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function detail(label: string, t: UsageSummary['fiveHour']): string {
  return `${label}\n`
    + `  합계 ${t.total.toLocaleString()}\n`
    + `  입력 ${t.input.toLocaleString()} · 출력 ${t.output.toLocaleString()}\n`
    + `  캐시 쓰기 ${t.cacheCreate.toLocaleString()} · 캐시 읽기 ${t.cacheRead.toLocaleString()}`;
}

/**
 * 헤더에 Claude 토큰 사용량을 보여 준다 — 최근 5시간 / 주간 Fable / 주간 전체.
 * 로컬 대화 기록을 읽어 집계하며, 60초마다 그리고 창이 포커스를 얻을 때 갱신한다.
 */
export default function UsageBadge() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  if (error || !usage) return null;

  const tip = [
    detail('최근 5시간', usage.fiveHour),
    detail('주간 · Fable', usage.weekFable),
    detail('주간 · 전체', usage.weekAll),
    `\n로컬 대화 기록 ${usage.files}개 기준. 캐시 읽기는 저렴하게 과금됩니다.`,
  ].join('\n');

  return (
    <div className="usage-badge" title={tip}>
      <span className="icon icon-token" aria-hidden />
      <span className="usage-cell">
        <span className="usage-label">5시간</span>
        <span className="usage-value mono">{fmt(usage.fiveHour.total)}</span>
      </span>
      <span className="usage-sep" />
      <span className="usage-cell">
        <span className="usage-label">주간 Fable</span>
        <span className="usage-value mono">{fmt(usage.weekFable.total)}</span>
      </span>
      <span className="usage-sep" />
      <span className="usage-cell">
        <span className="usage-label">주간 전체</span>
        <span className="usage-value mono">{fmt(usage.weekAll.total)}</span>
      </span>
    </div>
  );
}
