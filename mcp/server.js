#!/usr/bin/env node
'use strict';

/**
 * DB Studio MCP 서버.
 *
 * DB Studio 의 드라이버·메타데이터 조회 로직을 그대로 재사용해, Claude Code 같은
 * MCP 클라이언트가 데이터베이스를 살펴볼 수 있게 한다.
 *
 * 안전 원칙
 *  - 접속은 기본이 조회 전용이다. 설정에서 readOnly: false 로 명시해야 쓰기가 열린다.
 *  - 조회 전용 접속에서는 SELECT 계열만 통과시키고, 여러 문장을 한 번에 보내지 못한다.
 *  - 결과 행 수에 상한이 있다 (설정 maxRows, 기본 200).
 *  - 쓰기가 열린 접속도 수동 커밋이 기본이라 commit 을 부르기 전에는 확정되지 않는다.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const db = require('../electron/db');
const { splitStatements, statementInfo } = require('../electron/db/sqlparse');
const config = require('./config');

// 설정이 잘못됐을 때 스택 트레이스 대신 무엇을 고쳐야 하는지만 보여준다.
let cfg;
try {
  cfg = config.load();
} catch (e) {
  process.stderr.write(`\n${e && e.message ? e.message : String(e)}\n\n`);
  process.exit(1);
}

const byName = new Map(cfg.connections.map((c) => [c.name, c]));
const opened = new Set();

// ---- 도우미 -------------------------------------------------------------------

function connection(name) {
  const c = byName.get(name);
  if (!c) {
    throw new Error(`'${name}' 접속이 설정에 없습니다. 사용 가능: ${[...byName.keys()].join(', ')}`);
  }
  return c;
}

/** 필요할 때 접속을 열고 재사용한다. */
async function ensureOpen(name) {
  const c = connection(name);
  if (!opened.has(name)) {
    await db.connect(c);
    opened.add(name);
  }
  return c;
}

/** 조회 전용 접속에서 실행해도 되는 문장인지 검사한다. */
function assertReadOnly(conn, sql) {
  if (!conn.readOnly) return;
  const statements = splitStatements(sql);
  if (statements.length > 1) {
    throw new Error('조회 전용 접속에서는 한 번에 한 문장만 실행할 수 있습니다.');
  }
  if (statements.length === 0) throw new Error('실행할 문장이 없습니다.');
  const { kind, verb } = statementInfo(statements[0].text);
  if (kind !== 'read') {
    throw new Error(
      `'${conn.name}' 은 조회 전용 접속입니다. ${verb || '이'} 문장은 실행할 수 없습니다.\n`
      + '쓰기가 필요하면 설정 파일에서 이 접속에 "readOnly": false 를 넣으세요.',
    );
  }
}

/** 표 형태 결과를 사람이 읽기 좋은 텍스트로 만든다. */
function renderRows(columns, rows) {
  if (columns.length === 0) return '(결과 없음)';
  const header = columns.map((c) => c.name);
  const body = rows.map((r) => r.map((v) => (v === null ? 'NULL' : String(v))));
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length), 0));
  const line = (cells) => cells.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  return [
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
  ].join('\n');
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** 도구 처리 중 오류를 MCP 오류 응답으로 바꾼다. */
function guard(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  };
}

// ---- 서버 ---------------------------------------------------------------------

const server = new McpServer(
  { name: 'dbstudio', version: require('../package.json').version },
  { instructions:
      'DB Studio 가 관리하는 데이터베이스를 살펴보는 도구입니다. '
      + '먼저 list_connections 로 어떤 접속이 있는지 확인하고, list_tables / describe_table 로 구조를 파악한 뒤 query 로 조회하세요. '
      + '접속은 기본이 조회 전용이라 SELECT 계열만 실행됩니다.' },
);

server.registerTool('list_connections', {
  title: '접속 목록',
  description: '설정에 등록된 데이터베이스 접속을 보여준다. 조회 전용 여부도 함께 알려준다.',
  annotations: { readOnlyHint: true },
}, guard(async () => {
  const lines = cfg.connections.map((c) => {
    const port = c.port ? `:${c.port}` : '';
    return `${c.name}  [${c.kind}]  ${c.user}@${c.host}${port}`
      + `${c.database ? ` / ${c.database}` : ''}  ${c.readOnly ? '조회 전용' : '쓰기 가능'}`;
  });
  return text(`설정 파일: ${cfg.file}\n결과 행 상한: ${cfg.maxRows}\n\n${lines.join('\n')}`);
}));

server.registerTool('list_schemas', {
  title: '스키마 목록',
  description: '접속의 데이터베이스와 스키마 목록. MySQL 은 데이터베이스가 곧 스키마다.',
  inputSchema: { connection: z.string().describe('list_connections 에 나온 접속 이름') },
  annotations: { readOnlyHint: true },
}, guard(async ({ connection: name }) => {
  await ensureOpen(name);
  const status = db.status(name);
  const databases = await db.meta(name, 'databases');
  let out = `데이터베이스: ${databases.map((d) => d.name).join(', ')}`;
  if (status.hasSchemaLevel) {
    const schemas = await db.meta(name, 'schemas');
    out += `\n현재 DB(${status.currentDatabase}) 의 스키마: ${schemas.map((s) => s.name).join(', ')}`;
  }
  return text(out);
}));

server.registerTool('list_tables', {
  title: '테이블 목록',
  description: '스키마 안의 테이블과 뷰 목록. 주석과 대략적인 행 수도 함께 보여준다.',
  inputSchema: {
    connection: z.string().describe('접속 이름'),
    schema: z.string().optional().describe('스키마 이름 (MySQL 은 데이터베이스 이름). 생략하면 현재 스키마'),
  },
  annotations: { readOnlyHint: true },
}, guard(async ({ connection: name, schema }) => {
  await ensureOpen(name);
  const target = schema || db.status(name).currentSchema;
  if (!target) throw new Error('스키마를 알 수 없습니다. schema 를 지정하세요.');
  const tables = await db.meta(name, 'tables', { schema: target });
  if (tables.length === 0) return text(`${target} 에 테이블이 없습니다.`);
  const lines = tables.map((t) => {
    const rows = t.rowsEstimate == null ? '' : `  ~${t.rowsEstimate.toLocaleString()}행`;
    return `${t.kind === 'view' ? '[뷰]  ' : '[테이블]'} ${t.name}${rows}${t.comment ? `  — ${t.comment}` : ''}`;
  });
  return text(`${target} (${tables.length}개)\n\n${lines.join('\n')}`);
}));

server.registerTool('describe_table', {
  title: '테이블 구조',
  description: '컬럼, 기본키·유니크 키, 외래키, 이 테이블을 참조하는 외래키, 인덱스, DDL 을 한 번에 보여준다.',
  inputSchema: {
    connection: z.string().describe('접속 이름'),
    schema: z.string().describe('스키마 이름 (MySQL 은 데이터베이스 이름)'),
    table: z.string().describe('테이블 또는 뷰 이름'),
    includeDdl: z.boolean().optional().describe('CREATE 문까지 포함할지 (기본 true)'),
  },
  annotations: { readOnlyHint: true },
}, guard(async ({ connection: name, schema, table, includeDdl = true }) => {
  await ensureOpen(name);
  const args = { schema, table };
  const [columns, keys, foreignKeys, references, indexes] = await Promise.all([
    db.meta(name, 'columns', args),
    db.meta(name, 'keys', args),
    db.meta(name, 'foreignKeys', args),
    db.meta(name, 'references', args),
    db.meta(name, 'indexes', args),
  ]);
  if (columns.length === 0) throw new Error(`${schema}.${table} 을 찾을 수 없습니다.`);

  const parts = [`## ${schema}.${table}`, '', '### 컬럼'];
  parts.push(renderRows(
    [{ name: '이름' }, { name: '타입' }, { name: 'NULL' }, { name: '기본값' }, { name: '키' }, { name: '주석' }],
    columns.map((c) => [
      c.name, c.dataType, c.nullable ? 'YES' : 'NO',
      c.defaultValue ?? '', c.primaryKey ? 'PK' : '', c.comment || '',
    ]),
  ));

  if (keys.length) {
    parts.push('', '### 키');
    parts.push(keys.map((k) => `${k.type}  ${k.name} (${k.columns.join(', ')})`).join('\n'));
  }
  if (foreignKeys.length) {
    parts.push('', '### 외래키');
    parts.push(foreignKeys.map((f) =>
      `${f.name}: (${f.columns.join(', ')}) → ${f.referencedSchema}.${f.referencedTable} (${f.referencedColumns.join(', ')})`).join('\n'));
  }
  if (references.length) {
    parts.push('', '### 이 테이블을 참조하는 외래키');
    parts.push(references.map((r) =>
      `${r.sourceSchema}.${r.sourceTable}.${r.columns.join(', ')} → ${r.referencedColumns.join(', ')}`).join('\n'));
  }
  if (indexes.length) {
    parts.push('', '### 인덱스');
    parts.push(indexes.map((i) => `${i.unique ? 'UNIQUE ' : ''}${i.name} (${i.columns.join(', ')})  ${i.type}`).join('\n'));
  }
  if (includeDdl) {
    const tables = await db.meta(name, 'tables', { schema });
    const meta = tables.find((t) => t.name === table);
    const ddl = await db.meta(name, 'ddl', { schema, table, kind: meta ? meta.kind : 'table' });
    parts.push('', '### DDL', '```sql', ddl, '```');
  }
  return text(parts.join('\n'));
}));

server.registerTool('query', {
  title: '조회 실행',
  description:
    '읽기 쿼리를 실행하고 결과를 표로 돌려준다. 조회 전용 접속에서는 SELECT 계열 한 문장만 허용된다. '
    + '결과 행 수에는 상한이 있다.',
  inputSchema: {
    connection: z.string().describe('접속 이름'),
    sql: z.string().describe('실행할 SQL'),
    maxRows: z.number().int().positive().optional().describe(`가져올 최대 행 수 (기본·상한 ${cfg.maxRows})`),
  },
  annotations: { readOnlyHint: true },
}, guard(async ({ connection: name, sql, maxRows }) => {
  const conn = await ensureOpen(name);
  assertReadOnly(conn, sql);
  const limit = Math.min(maxRows || cfg.maxRows, cfg.maxRows);

  const res = await db.executeScript(name, sql, { maxRows: limit, stopOnError: true });
  const out = [];
  for (const r of res.results) {
    if (!r.ok) {
      out.push(`실패: ${r.error}\n${r.sql}`);
      continue;
    }
    if (r.columns.length > 0) {
      // rowCount 는 자르기 전 개수라서 실제로 보여준 행 수를 쓴다.
      const shown = r.rows.length;
      const truncated = r.truncated
        ? `\n(상한 ${limit}행에서 잘림 — 더 있습니다. LIMIT 을 붙이거나 조건을 좁히세요)`
        : '';
      out.push(`${shown}행 · ${r.elapsed}ms\n\n${renderRows(r.columns, r.rows)}${truncated}`);
    } else {
      out.push(`${r.affectedRows ?? 0}개 행이 변경되었습니다 (${r.elapsed}ms). 확정하려면 commit 을 호출하세요.`);
    }
  }
  return text(out.join('\n\n---\n\n'));
}));

server.registerTool('search_objects', {
  title: '객체 검색',
  description:
    '이름·컬럼명·주석·정의 스크립트에서 검색어를 찾는다. 어느 테이블에 어떤 컬럼이 있는지 모를 때 쓴다.',
  inputSchema: {
    connection: z.string().describe('접속 이름'),
    term: z.string().min(2).describe('검색어 (2글자 이상)'),
    schemas: z.array(z.string()).optional().describe('대상 스키마. 생략하면 현재 스키마만'),
    names: z.boolean().optional().describe('테이블·뷰 이름 검색 (기본 true)'),
    columns: z.boolean().optional().describe('컬럼 이름 검색'),
    comments: z.boolean().optional().describe('테이블·컬럼 주석 검색'),
    source: z.boolean().optional().describe('뷰·함수·프로시저·트리거 정의 검색'),
  },
  annotations: { readOnlyHint: true },
}, guard(async ({ connection: name, term, schemas, names, columns, comments, source }) => {
  await ensureOpen(name);
  const scopes = { names: names !== false, columns: !!columns, comments: !!comments, source: !!source };
  const res = await db.searchObjects(name, { term, schemas, scopes });
  if (res.hits.length === 0) return text(`'${term}' 와 일치하는 객체가 없습니다. (스키마: ${res.schemas.join(', ')})`);
  const lines = res.hits.map((h) => {
    const where = h.table && h.table !== h.name ? `${h.schema}.${h.table}` : h.schema;
    return `[${h.matchedIn}] ${h.kind} ${where} :: ${h.name}`
      + (h.snippet ? `\n    ${h.snippet}` : '');
  });
  return text(`${res.hits.length}건${res.truncated ? ' (상한 도달)' : ''}\n\n${lines.join('\n')}`);
}));

server.registerTool('explain', {
  title: '실행 계획',
  description: '쿼리의 실행 계획을 가져온다. 느린 쿼리의 원인을 볼 때 쓴다. 쿼리를 실제로 실행하지는 않는다.',
  inputSchema: {
    connection: z.string().describe('접속 이름'),
    sql: z.string().describe('계획을 볼 SQL'),
  },
  annotations: { readOnlyHint: true },
}, guard(async ({ connection: name, sql }) => {
  const conn = await ensureOpen(name);
  assertReadOnly(conn, sql);
  const plan = await db.explain(name, sql, { analyze: false });
  const body = plan.text || JSON.stringify(plan.json, null, 2);
  return text(`${plan.dialect} 실행 계획 (예상 비용 기준)\n\n${body}`);
}));

server.registerTool('commit', {
  title: '커밋 / 롤백',
  description:
    '쓰기가 열린 접속에서 열려 있는 트랜잭션을 확정하거나 되돌린다. '
    + '무엇이 확정되는지 목록으로 함께 돌려준다.',
  inputSchema: {
    connection: z.string().describe('접속 이름'),
    action: z.enum(['commit', 'rollback']).describe('확정할지 되돌릴지'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, guard(async ({ connection: name, action }) => {
  const conn = connection(name);
  if (conn.readOnly) throw new Error(`'${name}' 은 조회 전용 접속이라 확정할 변경이 없습니다.`);
  if (!opened.has(name)) throw new Error(`'${name}' 접속이 열려 있지 않습니다.`);
  const res = action === 'commit' ? await db.commit(name) : await db.rollback(name);
  if (!res.applied) return text('열려 있는 트랜잭션이 없습니다.');
  const lines = res.entries.map((e) => `${e.seq}. ${e.verb} (영향 ${e.affected ?? '?'}행) ${e.sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  return text(`${action === 'commit' ? '커밋' : '롤백'} 완료 — ${res.entries.length}건\n\n${lines.join('\n')}`);
}));

// ---- 시작 / 종료 --------------------------------------------------------------

async function shutdown() {
  try { await db.closeAll(); } catch (_) { /* 종료 중 오류는 무시 */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  // stdout 은 MCP 프로토콜 전용이다. 로그는 반드시 stderr 로 보낸다.
  process.stderr.write(
    `dbstudio MCP 서버 시작 — 설정 ${cfg.file}, 접속 ${cfg.connections.length}개\n`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`시작 실패: ${e && e.message ? e.message : String(e)}\n`);
  process.exit(1);
});
