/**
 * 쿼리 속 스키마가 붙지 않은 테이블 이름 앞에 스키마를 붙인다 — `FROM t` → `FROM s.t`.
 *
 * 완전한 파서가 아니라 휴리스틱이다: FROM / JOIN / INTO / UPDATE / … TABLE 뒤에 오는 식별자와
 * FROM 목록의 쉼표 뒤 식별자만 본다. 이미 `a.b` 인 것, 서브쿼리 `(`, WITH 로 만든 CTE 이름,
 * DUAL 같은 예약어, 함수 호출, 문자열·주석 안은 건드리지 않는다. Claude 답변의 쿼리를 편집기에
 * 넣을 때 현재 선택된 스키마로 한정하는 용도라, 애매하면 그대로 두는 쪽을 택한다.
 */

export type Dialect = 'mysql' | 'postgres';

interface Token {
  type: 'word' | 'quoted' | 'punct';
  text: string;
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_-￿]/;
const IDENT_PART = /[\w$-￿]/;

/** 문자열·주석은 토큰에서 빼고, 식별자·기호만 위치와 함께 뽑는다. */
function tokenize(sql: string, dialect: Dialect): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    // 주석
    if (ch === '-' && sql[i + 1] === '-') { i = skipLine(sql, i); continue; }
    if (ch === '#' && dialect === 'mysql') { i = skipLine(sql, i); continue; }
    if (ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    // 문자열 (MySQL 은 "..." 도 문자열, PG 는 식별자)
    if (ch === '\'' || (ch === '"' && dialect === 'mysql')) { i = skipQuoted(sql, i, ch); continue; }
    // 따옴표 식별자
    if (ch === '`' || (ch === '"' && dialect === 'postgres')) {
      const e = skipQuoted(sql, i, ch);
      out.push({ type: 'quoted', text: sql.slice(i, e), start: i, end: e });
      i = e;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let e = i + 1;
      while (e < n && IDENT_PART.test(sql[e])) e += 1;
      out.push({ type: 'word', text: sql.slice(i, e), start: i, end: e });
      i = e;
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    out.push({ type: 'punct', text: ch, start: i, end: i + 1 });
    i += 1;
  }
  return out;
}

function skipLine(sql: string, i: number): number {
  const e = sql.indexOf('\n', i);
  return e < 0 ? sql.length : e + 1;
}

function skipQuoted(sql: string, i: number, q: string): number {
  let e = i + 1;
  while (e < sql.length) {
    if (sql[e] === '\\' && q === '\'') { e += 2; continue; }
    if (sql[e] === q) {
      if (sql[e + 1] === q) { e += 2; continue; } // '' 같은 두 번 쓰기 이스케이프
      return e + 1;
    }
    e += 1;
  }
  return sql.length;
}

/** 이 뒤에 오는 식별자는 테이블이다 */
const TABLE_INTRO = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);
/** FROM 목록이 여기서 끝난다 (쉼표 뒤 식별자를 더 이상 테이블로 보지 않는다) */
const LIST_END = new Set([
  'WHERE', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT',
  'SET', 'VALUES', 'SELECT', 'WINDOW', 'FETCH', 'FOR', 'RETURNING', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'INTO', 'WITH',
]);
/** 테이블 자리에 와도 테이블이 아닌 단어 */
const NOT_TABLE = new Set([
  'SELECT', 'DUAL', 'LATERAL', 'ONLY', 'VALUES', 'UNNEST', 'TABLE',
]);
/** CREATE TABLE IF NOT EXISTS t 처럼 TABLE 과 이름 사이에 끼는 단어 */
const TABLE_MODIFIERS = new Set([
  'IF', 'NOT', 'EXISTS', 'TEMPORARY', 'TEMP', 'UNLOGGED', 'IGNORE', 'DELAYED', 'LOW_PRIORITY', 'HIGH_PRIORITY', 'ONLY',
]);

function closeParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k += 1) {
    if (tokens[k].text === '(') depth += 1;
    else if (tokens[k].text === ')') { depth -= 1; if (depth === 0) return k; }
  }
  return tokens.length - 1;
}

function bare(ident: string): string {
  return /^[`"]/.test(ident) ? ident.slice(1, -1) : ident;
}

function upper(t: Token | undefined): string {
  return t && t.type === 'word' ? t.text.toUpperCase() : '';
}

/** WITH a AS (...), b(c) AS (...) 의 a, b */
function cteNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    if (upper(tokens[i]) !== 'WITH') continue;
    let j = i + 1;
    if (upper(tokens[j]) === 'RECURSIVE') j += 1;
    for (;;) {
      const name = tokens[j];
      if (!name || (name.type !== 'word' && name.type !== 'quoted')) break;
      names.add(bare(name.text).toLowerCase());
      j += 1;
      if (tokens[j]?.text === '(') j = closeParen(tokens, j) + 1; // 컬럼 목록
      if (upper(tokens[j]) !== 'AS') break;
      j += 1;
      while (/^(NOT|MATERIALIZED)$/.test(upper(tokens[j]))) j += 1; // PG
      if (tokens[j]?.text !== '(') break;
      j = closeParen(tokens, j) + 1;
      if (tokens[j]?.text !== ',') break;
      j += 1;
    }
  }
  return names;
}

function quoteIfNeeded(schema: string, dialect: Dialect): string {
  if (/^[A-Za-z_][\w$]*$/.test(schema)) return schema;
  const q = dialect === 'mysql' ? '`' : '"';
  return q + schema.split(q).join(q + q) + q;
}

/**
 * @returns 스키마를 붙인 SQL. 붙일 곳이 없으면 원문 그대로.
 */
export function qualifySql(sql: string, schema: string, dialect: Dialect): string {
  const s = schema.trim();
  if (!s) return sql;
  const tokens = tokenize(sql, dialect);
  const ctes = cteNames(tokens);
  const prefix = quoteIfNeeded(s, dialect) + '.';
  const inserts = new Set<number>();

  /**
   * @param fromList FROM/JOIN 자리인지. 거기서 `f(...)` 는 테이블 함수 호출이지만,
   *   INSERT INTO t (cols) / CREATE TABLE t (...) 의 `(` 는 컬럼 목록이라 테이블이 맞다.
   */
  const isTableIdent = (i: number, fromList: boolean): boolean => {
    const t = tokens[i];
    if (!t || (t.type !== 'word' && t.type !== 'quoted')) return false;
    if (t.type === 'word' && (NOT_TABLE.has(t.text.toUpperCase()) || TABLE_MODIFIERS.has(t.text.toUpperCase()))) return false;
    if (tokens[i + 1]?.text === '.') return false; // 이미 a.b
    if (fromList && tokens[i + 1]?.text === '(' && t.type === 'word') return false; // 함수 호출 f(...)
    if (ctes.has(bare(t.text).toLowerCase())) return false;
    return true;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const kw = upper(tokens[i]);
    if (!TABLE_INTRO.has(kw)) continue;
    let j = i + 1;
    while (TABLE_MODIFIERS.has(upper(tokens[j]))) j += 1;
    if (isTableIdent(j, kw === 'FROM' || kw === 'JOIN')) inserts.add(tokens[j].start);
    // FROM a, b, c — 쉼표로 이어진 목록 (FROM/UPDATE 만)
    if (kw !== 'FROM' && kw !== 'UPDATE') continue;
    let k = j + 1;
    while (k < tokens.length) {
      const tk = tokens[k];
      if (LIST_END.has(upper(tk))) break;
      if (tk.text === '(') { k = closeParen(tokens, k) + 1; continue; }
      if (tk.text === ';' || tk.text === ')') break;
      if (tk.text === ',') {
        if (isTableIdent(k + 1, true)) inserts.add(tokens[k + 1].start);
        k += 2;
        continue;
      }
      k += 1;
    }
  }

  if (!inserts.size) return sql;
  let out = sql;
  for (const pos of [...inserts].sort((a, b) => b - a)) {
    out = out.slice(0, pos) + prefix + out.slice(pos);
  }
  return out;
}
