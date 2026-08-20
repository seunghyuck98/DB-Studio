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

/**
 * 막대 길이의 기준.
 * PostgreSQL 은 비용을 주지만 MariaDB 10.x 는 비용을 아예 주지 않는다.
 * 그래서 노드마다 후보를 모아 두고, 트리 전체에서 쓸 수 있는 기준 하나를 골라 쓴다.
 */
interface Weights { cost?: number; timeMs?: number; rows?: number }

interface Building extends Omit<PlanNode, 'children'> {
  raw: Weights;
  children: Building[];
}

/** 드라이버가 돌려준 실행 계획 JSON 을 공통 트리로 바꾼다. */
export function normalizePlan(dialect: string, json: unknown): PlanNode | null {
  if (!json) return null;
  const root = dialect === 'postgres' ? fromPostgres(json) : fromMySql(json);
  if (!root) return null;
  return finish(root, pickBasis(root));
}

// ---- PostgreSQL --------------------------------------------------------------

function fromPostgres(json: unknown): Building | null {
  const first = Array.isArray(json) ? (json[0] as Json) : (json as Json);
  const plan = first?.Plan ?? first;
  if (!plan) return null;
  return pgNode(plan as Json);
}

function pgNode(p: Json): Building {
  const target = p['Relation Name'] ?? p['Index Name'] ?? p['CTE Name'] ?? p['Subplan Name'] ?? null;
  const metrics: PlanNode['metrics'] = [];

  if (p['Total Cost'] != null) metrics.push({ key: 'cost', value: fmt(p['Startup Cost'], 2) + '..' + fmt(p['Total Cost'], 2) });
  if (p['Plan Rows'] != null) metrics.push({ key: 'rows', value: fmt(p['Plan Rows']) });
  if (p['Actual Total Time'] != null) metrics.push({ key: 'time', value: `${fmt(p['Actual Total Time'], 3)}ms` });
  if (p['Actual Rows'] != null) {
    // 예상 행 수와 실제 행 수가 10배 이상 어긋나면 통계가 낡았을 가능성이 크다.
    const act = Number(p['Actual Rows']) || 0;
    metrics.push({ key: 'actual', value: fmt(act), warn: offBy10(p['Plan Rows'], act) });
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
    weight: 0,
    raw: {
      cost: num(p['Total Cost']),
      timeMs: num(p['Actual Total Time']),
      rows: num(p['Actual Rows']) ?? num(p['Plan Rows']),
    },
    children: Array.isArray(p.Plans) ? p.Plans.map((c: Json) => pgNode(c)) : [],
  };
}

// ---- MySQL / MariaDB ---------------------------------------------------------

/**
 * MySQL 과 MariaDB 의 계획 JSON 은 노드 종류마다 키 이름이 다르고, 버전마다 새 키가 생긴다.
 * 그래서 아는 키만 골라 읽지 않고 객체를 전부 훑는다 — 이름을 모르는 키는 키 그대로 보여 주더라도
 * 트리에서 사라지지는 않게 한다. (예전에는 MariaDB 의 materialized·filesort 를 몰라서
 * 파생 테이블 안쪽 계획이 통째로 빠졌다.)
 */
function fromMySql(json: unknown): Building | null {
  const root = json as Json;
  if (!root || typeof root !== 'object') return null;
  const block = root.query_block ?? root;
  return myContainer('query_block', block);
}

/** 트리에 노드로 만들지 않는 키 — 값 자체가 지표나 부속 정보인 것들. */
const MY_SKIP = new Set([
  'cost_info', 'possible_keys', 'used_key_parts', 'used_columns', 'ref', 'key_parts',
  'r_engine_stats', 'r_index_condition', 'r_icp_filtered', 'partitions',
]);

const MY_LABELS: Record<string, string> = {
  query_block: '쿼리 블록',
  ordering_operation: '정렬',
  grouping_operation: '그룹화',
  duplicates_removal: '중복 제거',
  materialized: '구체화',
  materialized_from_subquery: '서브쿼리 구체화',
  union_result: 'UNION 결과',
  attached_subqueries: '연결된 서브쿼리',
  optimized_away_subqueries: '최적화로 제거된 서브쿼리',
  query_specifications: 'UNION 분기',
  read_sorted_file: '정렬된 파일 읽기',
  filesort: '파일 정렬',
  temporary_table: '임시 테이블',
  'block-nl-join': '블록 중첩 루프 조인',
  subqueries: '서브쿼리',
  expression_cache: '식 캐시',
  having_subqueries: 'HAVING 서브쿼리',
  select_list_subqueries: 'SELECT 목록 서브쿼리',
  update_value_subqueries: 'UPDATE 값 서브쿼리',
  insert_from: 'INSERT 원본',
  windowing: '윈도 함수',
  window_functions_computation: '윈도 함수 계산',
  const_condition: '상수 조건',
  outer_ref_condition: '외부 참조 조건',
};

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** 객체 안의 중첩 구조를 모두 자식 노드로 만든다. */
function myWalk(node: Json): Building[] {
  const out: Building[] = [];
  if (!isObj(node)) return out;

  for (const [key, value] of Object.entries(node)) {
    if (value == null || MY_SKIP.has(key)) continue;

    if (key === 'table' && isObj(value)) {
      out.push(myTable(value));
      continue;
    }
    if (key === 'nested_loop' && Array.isArray(value)) {
      // 조인은 순서대로 늘어놓는다. 감싸는 노드를 두면 깊이만 깊어진다.
      for (const item of value) out.push(...myWalk(item));
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) if (isObj(item)) out.push(myContainer(key, item));
      continue;
    }
    if (isObj(value)) out.push(myContainer(key, value));
  }
  return out;
}

/** 이름 있는 중첩 블록 하나를 노드로 만든다. */
function myContainer(key: string, value: Json): Building {
  // query_specifications 의 각 원소처럼 한 겹 더 감싸인 경우를 벗겨 낸다.
  const block = key !== 'query_block' && isObj(value.query_block) ? value.query_block : value;
  const metrics: PlanNode['metrics'] = [];
  const cost = block.cost_info?.query_cost ?? block.query_cost;
  if (cost != null) metrics.push({ key: 'cost', value: fmt(cost, 2) });
  if (block.select_id != null) metrics.push({ key: 'select', value: String(block.select_id) });
  pushTimeMetrics(metrics, block);
  if (block.r_output_rows != null) metrics.push({ key: 'actual', value: fmt(block.r_output_rows) });
  else if (block.r_rows != null) metrics.push({ key: 'actual', value: fmt(block.r_rows) });

  const detail = [
    block.operation ? String(block.operation) : null,
    block.table_name ? `table=${block.table_name}` : null,
    block.sort_key ? `sort=${block.sort_key}` : null,
    block.r_sort_mode ? `mode=${block.r_sort_mode}` : null,
    block.r_used_priority_queue === true ? 'priority queue' : null,
    block.join_type ? `join=${block.join_type}` : null,
    block.message ? String(block.message) : null,
  ].filter(Boolean).join(' / ');

  return {
    label: MY_LABELS[key] ?? key,
    detail: detail || null,
    metrics,
    weight: 0,
    raw: {
      cost: num(cost),
      timeMs: num(block.r_total_time_ms),
      rows: num(block.r_output_rows) ?? num(block.r_rows),
    },
    children: myWalk(block),
  };
}

function myTable(t: Json): Building {
  const metrics: PlanNode['metrics'] = [];
  const cost = t.cost_info?.prefix_cost ?? t.cost_info?.read_cost;
  if (cost != null) metrics.push({ key: 'cost', value: fmt(cost, 2) });

  // MySQL 은 rows_examined_per_scan, MariaDB 는 rows 로 준다.
  const est = t.rows_examined_per_scan ?? t.rows;
  if (est != null) metrics.push({ key: 'rows', value: fmt(est) });
  if (t.rows_produced_per_join != null) metrics.push({ key: 'produced', value: fmt(t.rows_produced_per_join) });
  if (t.r_loops != null && Number(t.r_loops) > 1) metrics.push({ key: 'loops', value: fmt(t.r_loops) });
  if (t.filtered != null) metrics.push({ key: 'filtered', value: `${fmt(t.filtered, 1)}%` });
  if (t.r_filtered != null) {
    // 예상 선택도와 실제가 크게 다르면 조건이 늦게 걸러지고 있다는 뜻이다.
    const ratio = Number(t.filtered) > 0 ? Number(t.r_filtered) / Number(t.filtered) : 1;
    metrics.push({ key: 'actual filtered', value: `${fmt(t.r_filtered, 1)}%`, warn: ratio <= 0.5 });
  }
  if (t.r_rows != null) metrics.push({ key: 'actual', value: fmt(t.r_rows, 2), warn: offBy10(est, t.r_rows) });
  pushTimeMetrics(metrics, t);

  // 인덱스를 타지 못하는 접근 방식은 눈에 띄게 표시한다.
  const access = String(t.access_type ?? '');
  if (access) metrics.push({ key: 'access', value: access, warn: access === 'ALL' || access === 'index' });

  const detail = [
    t.key ? `key=${t.key}` : (t.possible_keys ? `possible=${[].concat(t.possible_keys).join(',')}` : null),
    t.key_length ? `len=${t.key_length}` : null,
    t.used_key_parts ? `parts=${[].concat(t.used_key_parts).join(',')}` : null,
    t.ref ? `ref=${[].concat(t.ref).join(',')}` : null,
    t.index_condition ? `index_cond=${t.index_condition}` : null,
    t.attached_condition ? `cond=${t.attached_condition}` : null,
    t.using_filesort ? 'filesort' : null,
    t.using_temporary_table ? 'temporary' : null,
    t.using_index === true ? 'using index' : null,
  ].filter(Boolean).join(' / ');

  const timeMs = sum(t.r_total_time_ms, t.r_table_time_ms, t.r_other_time_ms);
  return {
    label: `테이블 · ${t.table_name ?? '?'}`,
    detail: detail || null,
    metrics,
    weight: 0,
    raw: {
      cost: num(cost),
      timeMs,
      // 실제로 읽은 행 수 = 한 번에 읽은 행 × 반복 횟수
      rows: mul(num(t.r_rows) ?? num(est), num(t.r_loops) ?? 1),
    },
    children: myWalk(t),
  };
}

/** MariaDB 의 ANALYZE 시간 지표를 붙인다. */
function pushTimeMetrics(metrics: PlanNode['metrics'], node: Json): void {
  const ms = node.r_total_time_ms ?? sum(node.r_table_time_ms, node.r_other_time_ms);
  if (ms != null) metrics.push({ key: 'time', value: `${fmt(ms, 3)}ms` });
}

// ---- 공통 --------------------------------------------------------------------

/**
 * 트리 전체에서 쓸 막대 기준을 고른다.
 * 비용이 있으면 비용, 없으면 실측 시간, 그것도 없으면 읽은 행 수를 쓴다.
 * 노드마다 다른 기준을 섞으면 막대 길이를 비교할 수 없으므로 하나로 통일한다.
 */
function pickBasis(root: Building): keyof Weights {
  let hasCost = false;
  let hasTime = false;
  const visit = (n: Building) => {
    if (n.raw.cost != null) hasCost = true;
    if (n.raw.timeMs != null) hasTime = true;
    n.children.forEach(visit);
  };
  visit(root);
  return hasCost ? 'cost' : (hasTime ? 'timeMs' : 'rows');
}

function finish(node: Building, basis: keyof Weights): PlanNode {
  const max = maxOf(node, basis);
  const apply = (n: Building): PlanNode => ({
    label: n.label,
    detail: n.detail,
    metrics: n.metrics,
    weight: max > 0 ? Math.min(1, (n.raw[basis] ?? 0) / max) : 0,
    children: n.children.map(apply),
  });
  return apply(node);
}

function maxOf(node: Building, basis: keyof Weights): number {
  return Math.max(node.raw[basis] ?? 0, ...node.children.map((c) => maxOf(c, basis)), 0);
}

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function sum(...values: unknown[]): number | undefined {
  const nums = values.map(num).filter((n): n is number => n != null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : undefined;
}

function mul(a: number | undefined, b: number | undefined): number | undefined {
  return a == null ? undefined : a * (b ?? 1);
}

/** 예상과 실제가 10배 이상 어긋나는지 */
function offBy10(estimate: unknown, actual: unknown): boolean {
  const e = num(estimate);
  const a = num(actual);
  if (!e || !a || e <= 0 || a <= 0) return false;
  return a / e > 10 || e / a > 10;
}

function fmt(v: unknown, digits = 0): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v ?? '');
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
}
