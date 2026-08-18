import { useMemo, useState } from 'react';
import { normalizePlan, type PlanNode } from '../lib/plan';
import type { ExplainResult } from '../types';

export default function PlanView({ plan }: { plan: ExplainResult }) {
  const [view, setView] = useState<'tree' | 'text' | 'json'>('tree');
  const tree = useMemo(() => normalizePlan(plan.dialect, plan.json), [plan]);

  return (
    <div className="plan-pane">
      <div className="plan-head">
        <button className={`chip ${view === 'tree' ? 'active' : ''}`} disabled={!tree} onClick={() => setView('tree')}>트리</button>
        <button className={`chip ${view === 'text' ? 'active' : ''}`} disabled={!plan.text} onClick={() => setView('text')}>원본</button>
        <button className={`chip ${view === 'json' ? 'active' : ''}`} disabled={!plan.json} onClick={() => setView('json')}>JSON</button>
        <div className="spacer" />
        <span className="hint">
          {plan.analyzed ? '실제 실행(ANALYZE) 기준' : '예상 비용 기준'}
        </span>
      </div>

      <div className="plan-body">
        {view === 'tree' && (tree
          ? <ul className="plan-tree"><PlanRow node={tree} depth={0} /></ul>
          : <div className="pane-message muted">트리로 표시할 수 있는 계획이 없습니다. 원본 탭을 확인하세요.</div>)}
        {view === 'text' && <pre className="code-block">{plan.text}</pre>}
        {view === 'json' && <pre className="code-block">{JSON.stringify(plan.json, null, 2)}</pre>}
      </div>
    </div>
  );
}

function PlanRow({ node, depth }: { node: PlanNode; depth: number }) {
  return (
    <li className="plan-node">
      <div className="plan-line" style={{ paddingLeft: depth * 18 + 8 }}>
        <span className="plan-bar" style={{ width: `${Math.round(node.weight * 100)}%` }} aria-hidden />
        <span className="plan-label">{node.label}</span>
        {node.metrics.map((m) => (
          <span key={m.key} className={`plan-metric ${m.warn ? 'warn' : ''}`}>
            <b>{m.key}</b> {m.value}
          </span>
        ))}
      </div>
      {node.detail && (
        <div className="plan-detail" style={{ paddingLeft: depth * 18 + 24 }}>{node.detail}</div>
      )}
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c, i) => <PlanRow key={i} node={c} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}
