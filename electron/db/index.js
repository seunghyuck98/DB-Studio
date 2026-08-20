'use strict';

const { MySqlDriver } = require('./mysql');
const { PostgresDriver } = require('./postgres');
const { splitStatements, statementInfo } = require('./sqlparse');
const { snippet } = require('./searchutil');
const history = require('../history');

const DRIVERS = {
  mysql: MySqlDriver,
  mariadb: MySqlDriver,
  postgres: PostgresDriver,
};

/** 열려 있는 세션들. connectionId -> Session */
const sessions = new Map();

/**
 * 유휴 연결이 끊기는 것을 막는 주기. 방화벽·로드밸런서가 흔히 10분 안팎에서 끊으므로
 * 그보다 넉넉히 짧게 잡는다. TCP keepalive 와 별개로 애플리케이션 레벨에서도 찔러 본다.
 */
const HEARTBEAT_MS = 3 * 60 * 1000;

/** 연결 자체가 끊어진 오류인지 (문법 오류 같은 것과 구분한다) */
function isConnectionError(e) {
  if (!e) return false;
  if (e.fatal === true) return true;
  const code = String(e.code || '');
  if ([
    'PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED',
    'ENOTFOUND', 'EHOSTUNREACH', 'ER_SERVER_SHUTDOWN', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'PROTOCOL_ENQUEUE_AFTER_QUIT', 'CONNECTION_ENDED',
    // PostgreSQL SQLSTATE
    '08000', '08003', '08006', '08001', '08004', '57P01', '57P02', '57P03',
  ].includes(code)) return true;
  const msg = String(e.message || '').toLowerCase();
  return /connection terminated|connection closed|server closed the connection|socket hang up|client has encountered a connection error|cannot enqueue|not queryable|connection lost/.test(msg);
}

class Session {
  constructor(config) {
    const Driver = DRIVERS[config.kind];
    if (!Driver) throw new Error(`지원하지 않는 데이터베이스 종류입니다: ${config.kind}`);
    this.config = config;
    this.driver = new Driver(config);
    this.autoCommit = config.autoCommit !== false;
    this.txActive = false;
    this.txStatements = 0;
    /** 진행 중인 트랜잭션에서 실행한 변경 문장 목록 */
    this.txLog = [];
    this.txSeq = 0;
    this.currentSchema = null;
    this.info = null;
    /** 문장 실행 중인지 (하트비트가 끼어들지 않게) */
    this.busy = false;
    this.heartbeat = null;
  }

  /** 커밋 대상이 되는 변경 문장 수 */
  get txChanges() {
    return this.txLog.length;
  }

  clearTx() {
    this.txActive = false;
    this.txStatements = 0;
    this.txLog = [];
    this.txSeq = 0;
  }

  /**
   * 트랜잭션 안에서 실행한 변경 문장을 기록한다.
   * 조회·세션 설정 문장은 커밋할 것이 없으므로 남기지 않는다.
   */
  async noteTx(sql, affected, source) {
    if (!this.txActive) return;
    const { kind, verb, ddl } = statementInfo(sql);
    if (kind !== 'write') return;

    // MySQL·MariaDB 는 DDL 을 만나면 그 앞까지의 변경도 함께 암묵적으로 커밋한다.
    // 따라서 DDL 이후에는 앞선 문장들도 더 이상 롤백 대상이 아니다.
    const implicitCommit = ddl && this.kind !== 'postgres';
    if (implicitCommit) {
      for (const e of this.txLog) e.rollbackable = false;
    }

    this.txSeq += 1;
    this.txLog.push({
      seq: this.txSeq,
      at: new Date().toISOString(),
      sql: String(sql).slice(0, 4000),
      verb,
      affected: affected == null ? null : Number(affected),
      source: source || 'sql',
      schema: this.currentSchema,
      ddl: !!ddl,
      rollbackable: !implicitCommit,
      /** 이 문장이 앞선 변경까지 암묵적으로 커밋시켰는지 */
      implicitCommit,
    });

    if (implicitCommit) {
      // 서버가 이미 커밋했고 새 트랜잭션을 열어 주지 않으므로,
      // 이후 문장이 자동 커밋으로 새어 나가지 않게 여기서 다시 시작한다.
      await this.driver.begin();
    }
  }

  /** 커밋·롤백 확인창과 변경 내역 탭에서 쓰는 현재 트랜잭션 상태 */
  pending() {
    return {
      status: this.status(),
      entries: this.txLog.map((e) => ({ ...e })),
      totalAffected: this.txLog.reduce((sum, e) => sum + (e.affected || 0), 0),
    };
  }

  get kind() { return this.config.kind; }

  placeholder(i) { return this.kind === 'postgres' ? `$${i}` : '?'; }

  async open() {
    this.info = await this.driver.connect();
    this.currentSchema = this.info.currentSchema || this.config.database || null;
    this.startHeartbeat();
    return this.status();
  }

  /**
   * 유휴 상태에서도 주기적으로 연결을 찔러, 방화벽이나 DB 의 유휴 타임아웃으로
   * 조용히 끊기는 것을 막는다. 실행 중일 때는 건너뛴다.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.busy || this.driver.broken) return;
      this.busy = true;
      // 히스토리·트랜잭션 기록을 남기지 않도록 드라이버를 직접 찌른다.
      Promise.resolve(this.driver.ping())
        .catch((e) => { this.driver.broken = true; this.driver.lastError = e; })
        .finally(() => { this.busy = false; });
    }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** 같은 설정으로 연결을 다시 맺는다. 열려 있던 트랜잭션은 사라진다. */
  async reopen() {
    this.stopHeartbeat();
    try { await this.driver.close(); } catch (_) { /* 이미 끊긴 연결 */ }
    const Driver = DRIVERS[this.config.kind];
    const schema = this.currentSchema;
    this.driver = new Driver(this.config);
    this.clearTx();
    this.info = await this.driver.connect();
    this.currentSchema = this.info.currentSchema || this.config.database || null;
    // 보고 있던 스키마를 되살린다.
    if (schema && schema !== this.currentSchema) {
      try {
        await this.driver.setCurrentSchema(schema);
        this.currentSchema = schema;
      } catch (_) { /* 스키마가 없어졌으면 기본값으로 둔다 */ }
    }
    this.startHeartbeat();
    return this.status();
  }

  /**
   * 문장을 실행하기 전에 연결이 살아 있는지 확인한다.
   * 끊겼으면 다시 연결한다. 트랜잭션이 열려 있었다면 그 내용은 사라졌으므로 알려 준다.
   */
  async ensureAlive() {
    if (!this.driver.broken) return;
    const hadTx = this.txActive;
    const pending = this.txChanges;
    await this.reopen();
    if (hadTx) {
      throw new Error(
        '연결이 끊겨 다시 연결했습니다. 열려 있던 트랜잭션은 서버에서 사라졌습니다'
        + `${pending ? ` (확정되지 않은 변경 ${pending}건은 되돌아갔습니다)` : ''}.`
        + ' 다시 실행해 주세요.',
      );
    }
  }

  async close() {
    this.stopHeartbeat();
    if (this.txActive) {
      try { await this.driver.rollback(); } catch (_) { /* 연결이 끊겨도 세션은 정리한다 */ }
      this.clearTx();
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
      txChanges: this.txChanges,
      currentSchema: this.currentSchema,
      currentDatabase: this.driver.currentDatabase || this.currentSchema,
      serverVersion: this.info ? this.info.version : null,
      /** 서버와의 연결이 끊긴 상태인지 (다음 실행 때 자동으로 다시 연결한다) */
      stale: !!this.driver.broken,
    };
  }

  /** 수동 커밋 모드에서 첫 문장 실행 직전에 트랜잭션을 연다. */
  async ensureTx() {
    if (!this.autoCommit && !this.txActive) {
      await this.driver.begin();
      this.clearTx();
      this.txActive = true;
    }
  }

  async setAutoCommit(value) {
    if (value === this.autoCommit) return this.status();
    if (value && this.txActive) {
      // 자동 커밋으로 전환할 때는 열려 있던 트랜잭션을 커밋한다 (DBeaver 와 동일).
      await this.driver.commit();
      this.clearTx();
    }
    this.autoCommit = value;
    return this.status();
  }

  /** 커밋·롤백 결과를 알려주기 위해 정리 전의 변경 내역을 함께 돌려준다. */
  async finishTx(action) {
    if (!this.txActive) return { status: this.status(), entries: [], applied: false };
    const entries = this.txLog.map((e) => ({ ...e }));
    if (action === 'commit') await this.driver.commit();
    else await this.driver.rollback();
    this.clearTx();
    return { status: this.status(), entries, applied: true };
  }

  async commit() { return this.finishTx('commit'); }

  async rollback() { return this.finishTx('rollback'); }

  /**
   * 한 문장을 실행한다. 자동 커밋 모드가 아니면 트랜잭션 안에서 실행된다.
   * 실행 결과는 쿼리 히스토리에 남는다.
   */
  async exec(sql, params = [], source = 'sql') {
    await this.ensureAlive();
    await this.ensureTx();
    const started = Date.now();
    this.busy = true;
    try {
      const r = await this.driver.query(sql, params);
      if (this.txActive) this.txStatements++;
      await this.noteTx(sql, r.affectedRows, source);
      this.log(sql, Date.now() - started, source, { rows: r.rowCount, affected: r.affectedRows, ok: true });
      return r;
    } catch (e) {
      this.log(sql, Date.now() - started, source, { ok: false, error: e.message });

      // 실행 도중 끊긴 경우. 트랜잭션이 없었다면 조용히 다시 연결해 한 번만 재시도한다.
      // 트랜잭션이 있었다면 이미 사라졌으므로 재시도하지 않고 사실대로 알린다.
      if (isConnectionError(e)) {
        this.driver.broken = true;
        const hadTx = this.txActive;
        const pending = this.txChanges;
        try {
          await this.reopen();
        } catch (re) {
          throw new Error(`연결이 끊겼고 다시 연결하지 못했습니다: ${re.message}`);
        }
        if (hadTx) {
          throw new Error(
            '연결이 끊겨 다시 연결했습니다. 열려 있던 트랜잭션은 서버에서 사라졌습니다'
            + `${pending ? ` (확정되지 않은 변경 ${pending}건은 되돌아갔습니다)` : ''}.`
            + ' 다시 실행해 주세요.',
          );
        }
        this.busy = true;
        try {
          const r = await this.driver.query(sql, params);
          this.log(sql, Date.now() - started, source, { rows: r.rowCount, affected: r.affectedRows, ok: true });
          return r;
        } finally {
          this.busy = false;
        }
      }
      throw e;
    } finally {
      this.busy = false;
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

/** 사용자가 트리에서 '재연결' 을 눌렀을 때. 저장된 설정을 그대로 다시 쓴다. */
async function reconnect(id) {
  const s = get(id);
  return s.reopen();
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


/**
 * 드라이버를 직접 쓰는 작업(메타데이터·검색 등)도 끊긴 연결에서 되살아나게 감싼다.
 * exec() 를 거치지 않는 경로가 있어서, 그쪽만 재연결이 안 되던 문제를 막는다.
 * @param {boolean} retry 순수 조회처럼 다시 실행해도 안전한 작업만 true
 */
async function withAlive(id, fn, retry = false) {
  const s = get(id);
  await s.ensureAlive();
  s.busy = true;
  try {
    return await fn(s);
  } catch (e) {
    if (!retry || !isConnectionError(e)) throw e;
    s.driver.broken = true;
    const hadTx = s.txActive;
    const pending = s.txChanges;
    await s.reopen();
    if (hadTx) {
      throw new Error(
        '연결이 끊겨 다시 연결했습니다. 열려 있던 트랜잭션은 서버에서 사라졌습니다'
        + `${pending ? ` (확정되지 않은 변경 ${pending}건은 되돌아갔습니다)` : ''}.`
        + ' 다시 실행해 주세요.',
      );
    }
    return fn(s);
  } finally {
    s.busy = false;
  }
}

// ---- 메타데이터 -------------------------------------------------------------


async function meta(id, action, args = {}) {
  return withAlive(id, (s) => metaOn(s, action, args), true);
}

function metaOn(s, action, args) {
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
  return withAlive(id, async (s) => {
    await s.driver.setCurrentSchema(schema);
    s.currentSchema = schema;
    return s.status();
  });
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
  await s.ensureAlive();
  const d = s.driver;
  const target = d.qualify(schema, table);
  const executed = [];

  // execAtomic 안에서는 트랜잭션을 직접 다루므로 exec 를 쓰지 않고 실행·기록만 한다.
  const run = async (sql, params) => {
    const started = Date.now();
    try {
      const r = await d.query(sql, params);
      await s.noteTx(sql, r.affectedRows, 'edit');
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
  const statements = splitStatements(sql, { blankLine: !!opts.splitOnBlankLine });
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

// ---- 객체 검색 ---------------------------------------------------------------

/**
 * 이름·컬럼·주석·정의 스크립트에서 객체를 찾는다.
 * @param {{term:string, schemas?:string[], scopes?:object, limit?:number}} req
 */
async function searchObjects(id, req) {
  return withAlive(id, (s) => searchOn(s, req), true);
}

async function searchOn(s, req) {
  const term = String(req.term || '').trim();
  if (term.length < 2) throw new Error('검색어를 2글자 이상 입력하세요.');

  const scopes = req.scopes && Object.values(req.scopes).some(Boolean)
    ? req.scopes
    : { names: true };

  // 대상 스키마를 정하지 않았으면 현재 스키마(MySQL 은 현재 데이터베이스)만 본다.
  let schemas = Array.isArray(req.schemas) && req.schemas.length ? req.schemas : null;
  if (!schemas) {
    const current = s.currentSchema || s.driver.currentDatabase;
    schemas = current ? [current] : [];
  }
  if (!schemas.length) throw new Error('검색할 스키마를 정할 수 없습니다.');

  const started = Date.now();
  try {
    const raw = await s.driver.searchObjects(term, { schemas, scopes, limit: req.limit || 200 });
    const hits = raw.map((h) => ({
      kind: h.kind,
      schema: h.schema,
      table: h.table || null,
      name: h.name,
      matchedIn: h.matchedIn,
      detail: h.detail || null,
      // 정의 본문은 통째로 넘기지 않고 검색어 주변만 잘라 보낸다.
      snippet: h.text ? snippet(h.text, term) : null,
      objectKind: h.objectKind || (h.kind === 'view' ? 'view' : 'table'),
    }));
    s.log(`-- 객체 검색: ${term}`, Date.now() - started, 'search', { rows: hits.length, ok: true });
    return { term, schemas, hits, truncated: raw.length >= (req.limit || 200) };
  } catch (e) {
    s.log(`-- 객체 검색: ${term}`, Date.now() - started, 'search', { ok: false, error: e.message });
    throw e;
  }
}

// ---- 실행 계획 ---------------------------------------------------------------

/** 문장의 실행 계획을 가져온다. analyze 를 켜면 쿼리가 실제로 실행된다. */
async function explain(id, sql, opts = {}) {
  const s = get(id);
  await s.ensureAlive();
  const stmt = splitStatements(sql, { blankLine: !!opts.splitOnBlankLine })[0];
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
  await s.ensureAlive();
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
        await s.noteTx(sql, r.affectedRows, 'ddl');
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

/** 진행 중인 트랜잭션의 변경 내역 */
function pendingTx(id) {
  const s = sessions.get(id);
  if (!s) return { status: { connected: false }, entries: [], totalAffected: 0 };
  return s.pending();
}

module.exports = {
  connect, disconnect, reconnect, status, listOpen, testConnection, pendingTx,
  meta, setSchema, setDatabase,
  selectData, countData, applyChanges, fetchForExport,
  searchObjects,
  executeScript, explain, previewColumnDDL, executeDDL,
  setAutoCommit: async (id, v) => get(id).setAutoCommit(v),
  commit: async (id) => get(id).commit(),
  rollback: async (id) => get(id).rollback(),
  closeAll: async () => { for (const id of [...sessions.keys()]) await disconnect(id); },
};
