export interface PlanNode {
  label: string;
  detail: string | null;
  /** 화면에 뱃지로 보여줄 지표들 */
  metrics: { key: string; value: string; warn?: boolean }[];
  /** 상대 비용 (0~1). 막대 길이 계산에 쓴다. */
  weight: number;
  children: PlanNode[];
}

type Json = Record<string, any>;

/** 드라이버가 돌려준 실행 계획 JSON 을 공통 트리로 바꾼다. */
export function normalizePlan(dialect: string, json: unknown): PlanNode | null {
  if (!json) return null;
  const root = dialect === 'postgres' ? fromPostgres(json) : fromMySql(json);
  if (root) applyWeights(root, maxCost(root));
  return root;
}

// ---- PostgreSQL --------------------------------------------------------------

function fromPostgres(json: unknown): PlanNode | null {
  const first = Array.isArray(json) ? (json[0] as Json) : (json as Json);
  const plan = first?.Plan ?? first;
  if (!plan) return null;
  return pgNode(plan as Json);
}

function pgNode(p: Json): PlanNode {
  const target = p['Relation Name'] ?? p['Index Name'] ?? p['CTE Name'] ?? p['Subplan Name'] ?? null;
  const metrics: PlanNode['metrics'] = [];

  if (p['Total Cost'] != null) metrics.push({ key: 'cost', value: fmt(p['Startup Cost'], 2) + '..' + fmt(p['Total Cost'], 2) });
  if (p['Plan Rows'] != null) metrics.push({ key: 'rows', value: fmt(p['Plan Rows']) });
  if (p['Actual Total Time'] != null) metrics.push({ key: 'time', value: `${fmt(p['Actual Total Time'], 3)}ms` });
  if (p['Actual Rows'] != null) {
    // 예상 행 수와 실제 행 수가 10배 이상 어긋나면 통계가 낡았을 가능성이 크다.
    const est = Number(p['Plan Rows']) || 0;
    const act = Number(p['Actual Rows']) || 0;
    const off = est > 0 && act > 0 && (act / est > 10 || est / act > 10);
    metrics.push({ key: 'actual', value: fmt(act), warn: off });
  }
  if (p['Rows Removed by Filter'] != null && Number(p['Rows Removed by Filter']) > 0) {
    metrics.push({ key: 'filtered out', value: fmt(p['Rows Removed by Filter']) });
  }

  const detailParts = [p['Filter'], p['Index Cond'], p['Hash Cond'], p['Join Filter'], p['Recheck Cond'], p['Sort Key']]
    .filter(Boolean)
    .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)));

  return {
    label: String(p['Node Type'] ?? 'Plan') + (target ? ` · ${target}` : ''),
    detail: detailParts.length ? detailParts.join(' / ') : null,
    metrics,
    weight: Number(p['Total Cost']) || 0,
    children: Array.isArray(p.Plans) ? p.Plans.map((c: Json) => pgNode(c)) : [],
  };
}

// ---- MySQL / MariaDB ---------------------------------------------------------

function fromMySql(json: unknown): PlanNode | null {
  const root = json as Json;
  const block = root?.query_block ?? root;
  if (!block) return null;
  return { label: '쿼리 블록', detail: null, metrics: blockMetrics(block), weight: 0, children: myChildren(block) };
}

function blockMetrics(block: Json): PlanNode['metrics'] {
  const m: PlanNode['metrics'] = [];
  const cost = block.cost_info?.query_cost ?? block.query_cost;
  if (cost != null) m.push({ key: 'cost', value: fmt(cost, 2) });
  if (block.select_id != null) m.push({ key: 'select', value: String(block.select_id) });
  return m;
}

/**
 * MySQL 의 계획 JSON 은 노드 종류마다 키 이름이 달라서
 * 알려진 키들을 재귀적으로 훑어 트리를 만든다.
 */
function myChildren(node: Json): PlanNode[] {
  const out: PlanNode[] = [];
  if (!node || typeof node !== 'object') return out;

  if (node.table) out.push(myTable(node.table));
  if (Array.isArray(node.nested_loop)) {
    for (const item of node.nested_loop) {
      if (item?.table) out.push(myTable(item.table));
      else out.push(...myChildren(item));
    }
  }
  for (const key of ['ordering_operation', 'grouping_operation', 'duplicates_removal', 'materialized_from_subquery', 'union_result']) {
    if (node[key]) {
      out.push({
        label: MY_LABELS[key] ?? key,
        detail: null,
        metrics: blockMetrics(node[key]),
        weight: Number(node[key]?.cost_info?.query_cost) || 0,
        children: myChildren(node[key]),
      });
    }
  }
  for (const key of ['attached_subqueries', 'optimized_away_subqueries', 'query_specifications']) {
    if (Array.isArray(node[key])) {
      for (const sub of node[key]) {
        const block = sub.query_block ?? sub;
        out.push({
          label: MY_LABELS[key] ?? key,
          detail: null,
          metrics: blockMetrics(block),
          weight: Number(block?.cost_info?.query_cost) || 0,
          children: myChildren(block),
        });
      }
    }
  }
  return out;
}

const MY_LABELS: Record<string, string> = {
  ordering_operation: '정렬',
  grouping_operation: '그룹화',
  duplicates_removal: '중복 제거',
  materialized_from_subquery: '서브쿼리 구체화',
  union_result: 'UNION 결과',
  attached_subqueries: '연결된 서브쿼리',
  optimized_away_subqueries: '최적화로 제거된 서브쿼리',
  query_specifications: 'UNION 분기',
};

function myTable(t: Json): PlanNode {
  const metrics: PlanNode['metrics'] = [];
  const cost = t.cost_info?.prefix_cost ?? t.cost_info?.read_cost;
  if (cost != null) metrics.push({ key: 'cost', value: fmt(cost, 2) });
  if (t.rows_examined_per_scan != null) metrics.push({ key: 'rows', value: fmt(t.rows_examined_per_scan) });
  if (t.rows_produced_per_join != null) metrics.push({ key: 'produced', value: fmt(t.rows_produced_per_join) });
  if (t.filtered != null) metrics.push({ key: 'filtered', value: `${fmt(t.filtered, 1)}%` });
  if (t.r_rows != null) metrics.push({ key: 'actual', value: fmt(t.r_rows) });

  // 인덱스를 타지 못하는 접근 방식은 눈에 띄게 표시한다.
  const access = String(t.access_type ?? '');
  if (access) metrics.push({ key: 'access', value: access, warn: access === 'ALL' || access === 'index' });

  const detail = [
    t.key ? `key=${t.key}` : (t.possible_keys ? `possible=${[].concat(t.possible_keys).join(',')}` : null),
    t.used_key_parts ? `parts=${[].concat(t.used_key_parts).join(',')}` : null,
    t.attached_condition ? `cond=${t.attached_condition}` : null,
    t.using_filesort ? 'filesort' : null,
    t.using_temporary_table ? 'temporary' : null,
  ].filter(Boolean).join(' / ');

  return {
    label: `테이블 · ${t.table_name ?? '?'}`,
    detail: detail || null,
    metrics,
    weight: Number(cost) || 0,
    children: t.materialized_from_subquery || t.attached_subqueries ? myChildren(t) : [],
  };
}

// ---- 공통 --------------------------------------------------------------------

function maxCost(node: PlanNode): number {
  return Math.max(node.weight, ...node.children.map(maxCost), 0);
}

function applyWeights(node: PlanNode, max: number): void {
  node.weight = max > 0 ? Math.min(1, node.weight / max) : 0;
  node.children.forEach((c) => applyWeights(c, max));
}

function fmt(v: unknown, digits = 0): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v ?? '');
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
