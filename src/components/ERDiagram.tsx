import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { getTabScratch, setTabScratch } from '../state/store';
import { message } from '../state/actions';
import type { ForeignKeyMeta, ReferenceMeta, TableColumn, TableTab } from '../types';

interface Entity {
  key: string;
  schema: string;
  table: string;
  columns: TableColumn[];
  center: boolean;
}

interface Relation {
  from: string;   // 자식(외래키를 가진 쪽)
  to: string;     // 부모(참조 대상)
  label: string;
}

interface Box { x: number; y: number }

const BOX_WIDTH = 220;
const HEADER_H = 26;
const ROW_H = 19;
const MAX_ROWS = 12;
const MAX_RELATED = 12;

export default function ERDiagram({ tab }: { tab: TableTab }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [positions, setPositions] = useState<Record<string, Box>>(() => getTabScratch(tab.id, 'erPos', {}));
  const [scale, setScale] = useState<number>(() => getTabScratch(tab.id, 'erScale', 1));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{ key: string; dx: number; dy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => { setTabScratch(tab.id, 'erPos', positions); }, [tab.id, positions]);
  useEffect(() => { setTabScratch(tab.id, 'erScale', scale); }, [tab.id, scale]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const centerKey = `${tab.schema}.${tab.table}`;
      const [columns, fks, refs] = await Promise.all([
        window.api.meta.get(tab.connectionId, 'columns', { schema: tab.schema, table: tab.table }),
        window.api.meta.get(tab.connectionId, 'foreignKeys', { schema: tab.schema, table: tab.table }),
        window.api.meta.get(tab.connectionId, 'references', { schema: tab.schema, table: tab.table }),
      ]) as [TableColumn[], ForeignKeyMeta[], ReferenceMeta[]];

      const related = new Map<string, { schema: string; table: string }>();
      const rels: Relation[] = [];

      for (const f of fks.slice(0, MAX_RELATED)) {
        const key = `${f.referencedSchema}.${f.referencedTable}`;
        related.set(key, { schema: f.referencedSchema, table: f.referencedTable });
        rels.push({ from: centerKey, to: key, label: f.columns.join(', ') });
      }
      for (const r of refs.slice(0, MAX_RELATED)) {
        const key = `${r.sourceSchema}.${r.sourceTable}`;
        if (key === centerKey) continue;
        related.set(key, { schema: r.sourceSchema, table: r.sourceTable });
        rels.push({ from: key, to: centerKey, label: r.columns.join(', ') });
      }

      const relatedColumns = await Promise.all(
        [...related.values()].map(async (t) => {
          try {
            return await window.api.meta.get(tab.connectionId, 'columns', { schema: t.schema, table: t.table }) as TableColumn[];
          } catch {
            return [] as TableColumn[];
          }
        }),
      );

      const list: Entity[] = [
        { key: centerKey, schema: tab.schema, table: tab.table, columns, center: true },
        ...[...related.values()].map((t, i) => ({
          key: `${t.schema}.${t.table}`,
          schema: t.schema,
          table: t.table,
          columns: relatedColumns[i],
          center: false,
        })),
      ];

      setEntities(list);
      setRelations(rels);
      setPositions((prev) => withLayout(prev, list, centerKey));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.schema, tab.table]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('dbstudio:refresh', handler);
    return () => window.removeEventListener('dbstudio:refresh', handler);
  }, [load]);

  const onMouseDown = (key: string) => (e: ReactMouseEvent) => {
    const pt = toSvgPoint(svgRef.current, e.clientX, e.clientY, scale);
    const pos = positions[key] ?? { x: 0, y: 0 };
    dragRef.current = { key, dx: pt.x - pos.x, dy: pt.y - pos.y };
    e.preventDefault();
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pt = toSvgPoint(svgRef.current, e.clientX, e.clientY, scale);
      setPositions((p) => ({ ...p, [drag.key]: { x: pt.x - drag.dx, y: pt.y - drag.dy } }));
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [scale]);

  const sized = entities.map((e) => ({
    entity: e,
    pos: positions[e.key] ?? { x: 0, y: 0 },
    height: HEADER_H + Math.min(e.columns.length, MAX_ROWS) * ROW_H + (e.columns.length > MAX_ROWS ? ROW_H : 0),
  }));
  const width = Math.max(900, ...sized.map((s) => s.pos.x + BOX_WIDTH + 60));
  const height = Math.max(600, ...sized.map((s) => s.pos.y + s.height + 60));

  return (
    <div className="er">
      <div className="er-toolbar">
        <button className="btn small" onClick={() => setScale((s) => Math.min(2, +(s + 0.1).toFixed(2)))}>확대</button>
        <button className="btn small" onClick={() => setScale((s) => Math.max(0.4, +(s - 0.1).toFixed(2)))}>축소</button>
        <button className="btn small" onClick={() => setScale(1)}>100%</button>
        <button
          className="btn small"
          onClick={() => setPositions(withLayout({}, entities, `${tab.schema}.${tab.table}`))}
        >
          배치 초기화
        </button>
        <div className="spacer" />
        <span className="hint">{Math.round(scale * 100)}% · 박스를 끌어 옮길 수 있습니다</span>
      </div>

      {loading && <div className="pane-message">관계도를 그리는 중…</div>}
      {error && <div className="pane-message error">{error}</div>}
      {!loading && !error && relations.length === 0 && (
        <div className="pane-message muted">이 테이블과 연결된 외래키 관계가 없습니다.</div>
      )}

      {!loading && !error && (
        <div className="er-canvas">
          <svg ref={svgRef} width={width * scale} height={height * scale} viewBox={`0 0 ${width} ${height}`}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="er-arrow" />
              </marker>
              {/* 긴 컬럼명·타입이 박스를 넘지 않도록 엔티티별로 잘라낸다 */}
              {sized.map(({ entity, height: h }, i) => (
                <clipPath key={entity.key} id={`er-clip-${i}`}>
                  <rect width={BOX_WIDTH - 6} height={h} />
                </clipPath>
              ))}
            </defs>

            {relations.map((r, i) => {
              const a = sized.find((s) => s.entity.key === r.from);
              const b = sized.find((s) => s.entity.key === r.to);
              if (!a || !b) return null;
              const from = { x: a.pos.x + BOX_WIDTH / 2, y: a.pos.y + a.height / 2 };
              const to = { x: b.pos.x + BOX_WIDTH / 2, y: b.pos.y + b.height / 2 };
              const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
              return (
                <g key={i} className="er-rel">
                  <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#arrow)" />
                  <text x={mid.x} y={mid.y - 4} textAnchor="middle">{r.label}</text>
                </g>
              );
            })}

            {sized.map(({ entity, pos, height: h }, i) => (
              <g
                key={entity.key}
                className={`er-box ${entity.center ? 'center' : ''}`}
                transform={`translate(${pos.x}, ${pos.y})`}
                onMouseDown={onMouseDown(entity.key)}
              >
                <rect width={BOX_WIDTH} height={h} rx="6" />
                <rect width={BOX_WIDTH} height={HEADER_H} rx="6" className="er-header" />
                <text x={10} y={HEADER_H - 8} className="er-title">{entity.table}</text>
                <g clipPath={`url(#er-clip-${i})`}>
                  {entity.columns.slice(0, MAX_ROWS).map((c, idx) => (
                    <text key={c.name} x={10} y={HEADER_H + ROW_H * idx + 14} className={`er-col ${c.primaryKey ? 'pk' : ''}`}>
                      {c.primaryKey ? '🔑 ' : ''}{c.name}
                      <tspan className="er-type" dx="6">{c.dataType}</tspan>
                    </text>
                  ))}
                  {entity.columns.length > MAX_ROWS && (
                    <text x={10} y={HEADER_H + ROW_H * MAX_ROWS + 14} className="er-col dim">
                      … 외 {entity.columns.length - MAX_ROWS}개
                    </text>
                  )}
                </g>
              </g>
            ))}
          </svg>
        </div>
      )}
    </div>
  );
}

/** 중심 테이블을 가운데 두고 나머지를 좌우로 배치한다. 이미 옮긴 박스는 그대로 둔다. */
function withLayout(prev: Record<string, Box>, entities: Entity[], centerKey: string): Record<string, Box> {
  const next: Record<string, Box> = {};
  const others = entities.filter((e) => e.key !== centerKey);
  const half = Math.ceil(others.length / 2);
  next[centerKey] = prev[centerKey] ?? { x: 420, y: 60 };
  others.forEach((e, i) => {
    const col = i < half ? 0 : 2;
    const row = i < half ? i : i - half;
    next[e.key] = prev[e.key] ?? { x: 60 + col * 380, y: 60 + row * 240 };
  });
  return next;
}

function toSvgPoint(svg: SVGSVGElement | null, clientX: number, clientY: number, scale: number) {
  if (!svg) return { x: 0, y: 0 };
  const rect = svg.getBoundingClientRect();
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}
