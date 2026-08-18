'use strict';

const { MySqlDriver } = require('./mysql');
const { PostgresDriver } = require('./postgres');
const { splitStatements } = require('./sqlparse');
const history = require('../history');

const DRIVERS = {
  mysql: MySqlDriver,
  mariadb: MySqlDriver,
  postgres: PostgresDriver,
};

/** 열려 있는 세션들. connectionId -> Session */
const sessions = new Map();

class Session {
  constructor(config) {
    const Driver = DRIVERS[config.kind];
    if (!Driver) throw new Error(`지원하지 않는 데이터베이스 종류입니다: ${config.kind}`);
    this.config = config;
    this.driver = new Driver(config);
    this.autoCommit = config.autoCommit !== false;
    this.txActive = false;
    this.txStatements = 0;
    this.currentSchema = null;
    this.info = null;
  }

  get kind() { return this.config.kind; }

  placeholder(i) { return this.kind === 'postgres' ? `$${i}` : '?'; }

  async open() {
    this.info = await this.driver.connect();
    this.currentSchema = this.info.currentSchema || this.config.database || null;
    return this.status();
  }

  async close() {
    if (this.txActive) {
      try { await this.driver.rollback(); } catch (_) { /* 연결이 끊겨도 세션은 정리한다 */ }
      this.txActive = false;
    }
    await this.driver.close();
  }

  status() {
    return {
      connected: true,
      kind: this.kind,
      hasSchemaLevel: this.driver.hasSchemaLevel,
      autoCommit: this.autoCommit,
      txActive: this.txActive,
      txStatements: this.txStatements,
      currentSchema: this.currentSchema,
      currentDatabase: this.driver.currentDatabase || this.currentSchema,
      serverVersion: this.info ? this.info.version : null,
    };
  }

  /** 수동 커밋 모드에서 첫 문장 실행 직전에 트랜잭션을 연다. */
  async ensureTx() {
    if (!this.autoCommit && !this.txActive) {
      await this.driver.begin();
      this.txActive = true;
      this.txStatements = 0;
    }
  }

  async setAutoCommit(value) {
    if (value === this.autoCommit) return this.status();
    if (value && this.txActive) {
      // 자동 커밋으로 전환할 때는 열려 있던 트랜잭션을 커밋한다 (DBeaver 와 동일).
      await this.driver.commit();
      this.txActive = false;
      this.txStatements = 0;
    }
    this.autoCommit = value;
    return this.status();
  }

  async commit() {
    if (!this.txActive) return this.status();
    await this.driver.commit();
    this.txActive = false;
    this.txStatements = 0;
    return this.status();
  }

  async rollback() {
    if (!this.txActive) return this.status();
    await this.driver.rollback();
    this.txActive = false;
    this.txStatements = 0;
    return this.status();
  }

  /**
   * 한 문장을 실행한다. 자동 커밋 모드가 아니면 트랜잭션 안에서 실행된다.
   * 실행 결과는 쿼리 히스토리에 남는다.
   */
  async exec(sql, params = [], source = 'sql') {
    await this.ensureTx();
    const started = Date.now();
    try {
      const r = await this.driver.query(sql, params);
      if (this.txActive) this.txStatements++;
      this.log(sql, Date.now() - started, source, { rows: r.rowCount, affected: r.affectedRows, ok: true });
      return r;
    } catch (e) {
      this.log(sql, Date.now() - started, source, { ok: false, error: e.message });
      throw e;
    }
  }

  log(sql, ms, source, extra) {
    history.record({
      connectionId: this.config.id,
      connectionName: this.config.name,
      kind: this.kind,
      database: this.driver.currentDatabase || this.currentSchema,
      schema: this.currentSchema,
      sql,
      ms,
      source,
      ...extra,
    });
  }

  /** 자동 커밋 모드에서도 여러 문장을 하나의 트랜잭션으로 묶어 실행한다. */
  async execAtomic(fn) {
    if (this.autoCommit) {
      await this.driver.begin();
      try {
        const r = await fn();
        await this.driver.commit();
        return r;
      } catch (e) {
        try { await this.driver.rollback(); } catch (_) { /* 롤백 실패는 원래 오류로 덮지 않는다 */ }
        throw e;
      }
    }
    await this.ensureTx();
    return fn();
  }
}

// ---- 세션 관리 --------------------------------------------------------------

async function connect(config) {
  await disconnect(config.id);
  const s = new Session(config);
  await s.open();
  sessions.set(config.id, s);
  return s.status();
}

async function disconnect(id) {
  const s = sessions.get(id);
  if (!s) return { connected: false };
  sessions.delete(id);
  await s.close();
  return { connected: false };
}

function get(id) {
  const s = sessions.get(id);
  if (!s) throw new Error('연결이 열려 있지 않습니다. 먼저 접속하세요.');
  return s;
}

function status(id) {
  const s = sessions.get(id);
  return s ? s.status() : { connected: false };
}

function listOpen() {
  return [...sessions.keys()];
}

async function testConnection(config) {
  const Driver = DRIVERS[config.kind];
  if (!Driver) throw new Error(`지원하지 않는 데이터베이스 종류입니다: ${config.kind}`);
  const d = new Driver(config);
  try {
    const info = await d.connect();
    return { ok: true, version: info.version };
  } finally {
    await d.close();
  }
}

// ---- 메타데이터 -------------------------------------------------------------

async function meta(id, action, args = {}) {
  const s = get(id);
  const d = s.driver;
  switch (action) {
    case 'databases': return d.listDatabases();
    case 'schemas': return d.listSchemas();
    case 'tables': return d.listTables(args.schema);
    case 'columns': return d.listColumns(args.schema, args.table);
    case 'keys': return d.listKeys(args.schema, args.table);
    case 'foreignKeys': return d.listForeignKeys(args.schema, args.table);
    case 'references': return d.listReferences(args.schema, args.table);
    case 'indexes': return d.listIndexes(args.schema, args.table);
    case 'ddl': return d.getDDL(args.schema, args.table, args.kind);
    default: throw new Error(`알 수 없는 메타데이터 요청: ${action}`);
  }
}

async function setSchema(id, schema) {
  const s = get(id);
  await s.driver.setCurrentSchema(schema);
  s.currentSchema = schema;
  return s.status();
}

async function setDatabase(id, database) {
  const s = get(id);
  if (typeof s.driver.setCurrentDatabase !== 'function') {
    return setSchema(id, database);
  }
  if (s.txActive) throw new Error('열려 있는 트랜잭션이 있습니다. 데이터베이스를 바꾸기 전에 커밋하거나 롤백하세요.');
  await s.driver.setCurrentDatabase(database);
  s.currentSchema = database === s.driver.currentDatabase ? s.info.currentSchema : s.currentSchema;
  return s.status();
}

// ---- 데이터 조회 ------------------------------------------------------------

/** 테이블 데이터 페이지 조회. filter 는 사용자가 입력한 WHERE 절 조각이다. */
async function selectData(id, { schema, table, limit = 200, offset = 0, orderBy = null, filter = '' }) {
  const s = get(id);
  const d = s.driver;
  const where = filter && filter.trim() ? ` WHERE ${filter.trim()}` : '';
  const order = orderBy && orderBy.column
    ? ` ORDER BY ${d.quote(orderBy.column)} ${orderBy.direction === 'desc' ? 'DESC' : 'ASC'}`
    : '';
  const sql = `SELECT * FROM ${d.qualify(schema, table)}${where}${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
  const result = await s.exec(sql, [], 'data');
  return { ...result, sql };
}

/**
 * 페이지 제한 없이 전체 결과를 읽어 내보내기에 쓴다.
 * 테이블 대상이면 LIMIT 을 직접 붙이고, 사용자가 준 SQL 은 그대로 실행한 뒤 행 수만 자른다.
 */
async function fetchForExport(id, { schema, table, filter = '', orderBy = null, sql = null, maxRows = 1000000 }) {
  const s = get(id);
  const d = s.driver;
  const cap = Number(maxRows) || 1000000;

  if (sql) {
    const r = await s.exec(sql.trim().replace(/;\s*$/, ''), [], 'export');
    return { columns: r.columns, rows: r.rows.slice(0, cap), truncated: r.rows.length > cap };
  }

  const where = filter && filter.trim() ? ` WHERE ${filter.trim()}` : '';
  const order = orderBy && orderBy.column
    ? ` ORDER BY ${d.quote(orderBy.column)} ${orderBy.direction === 'desc' ? 'DESC' : 'ASC'}`
    : '';
  const text = `SELECT * FROM ${d.qualify(schema, table)}${where}${order} LIMIT ${cap}`;
  const r = await s.exec(text, [], 'export');
  return { columns: r.columns, rows: r.rows, truncated: r.rows.length >= cap };
}

async function countData(id, { schema, table, filter = '' }) {
  const s = get(id);
  const d = s.driver;
  const where = filter && filter.trim() ? ` WHERE ${filter.trim()}` : '';
  const r = await s.exec(`SELECT COUNT(*) FROM ${d.qualify(schema, table)}${where}`, [], 'data');
  const v = r.rows[0] ? r.rows[0][0] : 0;
  return Number(v);
}

/**
 * 그리드에서 편집한 내용을 SQL 로 변환해 적용한다.
 * @param {{updates:{key:object,changes:object}[], inserts:{values:object}[], deletes:{key:object}[]}} changes
 */
async function applyChanges(id, { schema, table, changes }) {
  const s = get(id);
  const d = s.driver;
  const target = d.qualify(schema, table);
  const executed = [];

  // execAtomic 안에서는 트랜잭션을 직접 다루므로 exec 를 쓰지 않고 실행·기록만 한다.
  const run = async (sql, params) => {
    const started = Date.now();
    try {
      const r = await d.query(sql, params);
      s.log(sql, Date.now() - started, 'edit', { affected: r.affectedRows, ok: true });
      return r;
    } catch (e) {
      s.log(sql, Date.now() - started, 'edit', { ok: false, error: e.message });
      throw e;
    }
  };

  await s.execAtomic(async () => {
    for (const u of changes.updates || []) {
      const setCols = Object.keys(u.changes);
      if (!setCols.length) continue;
      const keyCols = Object.keys(u.key);
      if (!keyCols.length) throw new Error('기본키가 없어 행을 수정할 수 없습니다.');
      const params = [];
      let n = 0;
      const setSql = setCols.map((c) => { params.push(u.changes[c]); return `${d.quote(c)} = ${s.placeholder(++n)}`; }).join(', ');
      const whereSql = keyCols.map((c) => {
        if (u.key[c] === null) return `${d.quote(c)} IS NULL`;
        params.push(u.key[c]);
        return `${d.quote(c)} = ${s.placeholder(++n)}`;
      }).join(' AND ');
      const sql = `UPDATE ${target} SET ${setSql} WHERE ${whereSql}`;
      const r = await run(sql, params);
      executed.push({ sql, affected: r.affectedRows });
    }

    for (const ins of changes.inserts || []) {
      const cols = Object.keys(ins.values).filter((c) => ins.values[c] !== undefined);
      if (!cols.length) continue;
      const params = cols.map((c) => ins.values[c]);
      const sql = `INSERT INTO ${target} (${cols.map((c) => d.quote(c)).join(', ')})`
        + ` VALUES (${cols.map((_, i) => s.placeholder(i + 1)).join(', ')})`;
      const r = await run(sql, params);
      executed.push({ sql, affected: r.affectedRows });
    }

    for (const del of changes.deletes || []) {
      const keyCols = Object.keys(del.key);
      if (!keyCols.length) throw new Error('기본키가 없어 행을 삭제할 수 없습니다.');
      const params = [];
      let n = 0;
      const whereSql = keyCols.map((c) => {
        if (del.key[c] === null) return `${d.quote(c)} IS NULL`;
        params.push(del.key[c]);
        return `${d.quote(c)} = ${s.placeholder(++n)}`;
      }).join(' AND ');
      const sql = `DELETE FROM ${target} WHERE ${whereSql}`;
      const r = await run(sql, params);
      executed.push({ sql, affected: r.affectedRows });
    }
  });

  if (s.txActive) s.txStatements += executed.length;
  return { executed, status: s.status() };
}

// ---- SQL 실행 ---------------------------------------------------------------

/**
 * SQL 스크립트를 실행한다. 문장별 결과를 순서대로 돌려준다.
 * @param {string} sql
 * @param {{ stopOnError?: boolean, maxRows?: number }} opts
 */
async function executeScript(id, sql, opts = {}) {
  const s = get(id);
  const stopOnError = opts.stopOnError !== false;
  const statements = splitStatements(sql);
  const results = [];

  for (const stmt of statements) {
    const started = Date.now();
    try {
      const r = await s.exec(stmt.text);
      if (opts.maxRows && r.rows.length > opts.maxRows) {
        r.rows = r.rows.slice(0, opts.maxRows);
        r.truncated = true;
      }
      results.push({ sql: stmt.text, ok: true, ...r });
    } catch (e) {
      results.push({
        sql: stmt.text,
        ok: false,
        error: e.message,
        code: e.code || null,
        columns: [], rows: [], rowCount: 0, affectedRows: null,
        elapsed: Date.now() - started,
      });
      if (stopOnError) break;
    }
  }
  return { results, status: s.status() };
}

// ---- 실행 계획 ---------------------------------------------------------------

/** 문장의 실행 계획을 가져온다. analyze 를 켜면 쿼리가 실제로 실행된다. */
async function explain(id, sql, opts = {}) {
  const s = get(id);
  const stmt = splitStatements(sql)[0];
  if (!stmt) throw new Error('실행 계획을 볼 문장이 없습니다.');
  await s.ensureTx();
  const started = Date.now();
  try {
    const plan = await s.driver.explain(stmt.text, opts);
    s.log(`EXPLAIN${opts.analyze ? ' ANALYZE' : ''} ${stmt.text}`, Date.now() - started, 'explain', { ok: true });
    return { ...plan, sql: stmt.text, status: s.status() };
  } catch (e) {
    s.log(`EXPLAIN ${stmt.text}`, Date.now() - started, 'explain', { ok: false, error: e.message });
    throw e;
  }
}

// ---- DDL -------------------------------------------------------------------

/** 컬럼 편집 내용을 SQL 로 바꿔 미리 보여준다 (실행하지 않는다). */
function previewColumnDDL(id, { schema, table, spec }) {
  const s = get(id);
  if (typeof s.driver.buildColumnDDL !== 'function') {
    throw new Error('이 드라이버는 컬럼 편집을 지원하지 않습니다.');
  }
  return s.driver.buildColumnDDL(schema, table, spec);
}

/**
 * DDL 문장들을 순서대로 실행한다.
 * 자동 커밋 모드에서는 하나라도 실패하면 전체가 되돌아간다.
 */
async function executeDDL(id, statements) {
  const s = get(id);
  const list = (Array.isArray(statements) ? statements : splitStatements(String(statements)).map((x) => x.text))
    .map((x) => String(x).trim().replace(/;\s*$/, ''))
    .filter(Boolean);
  if (!list.length) throw new Error('실행할 DDL 이 없습니다.');

  const executed = [];
  await s.execAtomic(async () => {
    for (const sql of list) {
      const started = Date.now();
      try {
        const r = await s.driver.query(sql);
        s.log(sql, Date.now() - started, 'ddl', { affected: r.affectedRows, ok: true });
        executed.push({ sql, affected: r.affectedRows });
      } catch (e) {
        s.log(sql, Date.now() - started, 'ddl', { ok: false, error: e.message });
        throw new Error(`${e.message}\n\n실패한 문장: ${sql}`);
      }
    }
  });
  if (s.txActive) s.txStatements += executed.length;
  return { executed, status: s.status() };
}

module.exports = {
  connect, disconnect, status, listOpen, testConnection,
  meta, setSchema, setDatabase,
  selectData, countData, applyChanges, fetchForExport,
  executeScript, explain, previewColumnDDL, executeDDL,
  setAutoCommit: async (id, v) => get(id).setAutoCommit(v),
  commit: async (id) => get(id).commit(),
  rollback: async (id) => get(id).rollback(),
  closeAll: async () => { for (const id of [...sessions.keys()]) await disconnect(id); },
};
