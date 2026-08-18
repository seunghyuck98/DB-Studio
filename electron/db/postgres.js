'use strict';

const { Client } = require('pg');
const { likePattern } = require('./searchutil');

/**
 * PostgreSQL 드라이버.
 * 하나의 클라이언트는 하나의 데이터베이스에 묶이므로, 데이터베이스 전환은 재접속으로 처리한다.
 */
class PostgresDriver {
  static kind = 'postgres';

  constructor(config) {
    this.config = config;
    this.client = null;
    this.hasSchemaLevel = true;
    this.currentDatabase = config.database || 'postgres';
    this.typeNames = new Map();
  }

  async connect() {
    this.client = new Client({
      host: this.config.host,
      port: Number(this.config.port) || 5432,
      user: this.config.user,
      password: this.config.password,
      database: this.currentDatabase,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 15000,
      statement_timeout: 0,
    });
    await this.client.connect();
    await this.loadTypeNames();
    const r = await this.client.query('SELECT version() AS v, current_schema() AS s');
    return { version: r.rows[0].v, currentSchema: r.rows[0].s, currentDatabase: this.currentDatabase };
  }

  async close() {
    if (this.client) {
      try { await this.client.end(); } catch (_) { /* 이미 끊겼으면 무시 */ }
      this.client = null;
    }
  }

  async loadTypeNames() {
    const r = await this.client.query('SELECT oid, typname FROM pg_type');
    this.typeNames = new Map(r.rows.map((x) => [Number(x.oid), x.typname]));
  }

  quote(ident) {
    return '"' + String(ident).replace(/"/g, '""') + '"';
  }

  qualify(schema, table) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table);
  }

  async query(sql, params = []) {
    const started = Date.now();
    const res = await this.client.query({ text: sql, values: params, rowMode: 'array' });
    const elapsed = Date.now() - started;
    const fields = res.fields || [];
    const isSelect = fields.length > 0;
    return {
      columns: fields.map((f) => ({
        name: f.name,
        type: this.typeNames.get(Number(f.dataTypeID)) || String(f.dataTypeID),
        table: null,
        schema: null,
      })),
      rows: isSelect ? res.rows.map(normalizeRow) : [],
      rowCount: isSelect ? res.rows.length : 0,
      affectedRows: isSelect ? null : (res.rowCount || 0),
      elapsed,
    };
  }

  async rows(sql, params = []) {
    const res = await this.client.query(sql, params);
    return res.rows;
  }

  // ---- 트랜잭션 -------------------------------------------------------------
  async begin() { await this.client.query('BEGIN'); }
  async commit() { await this.client.query('COMMIT'); }
  async rollback() { await this.client.query('ROLLBACK'); }

  // ---- 메타데이터 -----------------------------------------------------------
  async listDatabases() {
    const r = await this.rows(
      `SELECT datname AS name, pg_encoding_to_char(encoding) AS charset, datcollate AS collation
         FROM pg_database
        WHERE datistemplate = false
        ORDER BY datname`,
    );
    return r.map((x) => ({
      name: x.name,
      charset: x.charset,
      collation: x.collation,
      current: x.name === this.currentDatabase,
    }));
  }

  /** 데이터베이스 전환은 재접속이 필요하다. */
  async setCurrentDatabase(database) {
    await this.close();
    this.currentDatabase = database;
    await this.connect();
    return database;
  }

  async listSchemas() {
    const r = await this.rows(
      `SELECT nspname AS name
         FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
        ORDER BY nspname`,
    );
    return r.map((x) => ({ name: x.name }));
  }

  async setCurrentSchema(schema) {
    await this.client.query(`SET search_path TO ${this.quote(schema)}, public`);
    return schema;
  }

  async listTables(schema) {
    const r = await this.rows(
      `SELECT c.relname AS name,
              CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS kind,
              c.reltuples AS rows_est,
              pg_total_relation_size(c.oid) AS size_bytes,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')
        ORDER BY kind, c.relname`,
      [schema],
    );
    return r.map((x) => ({
      name: x.name,
      kind: x.kind,
      engine: null,
      rowsEstimate: x.rows_est == null ? null : Math.max(0, Math.round(Number(x.rows_est))),
      sizeBytes: Number(x.size_bytes) || 0,
      comment: x.comment || '',
      collation: null,
      createdAt: null,
      updatedAt: null,
    }));
  }

  async listColumns(schema, table) {
    const r = await this.rows(
      `SELECT a.attnum AS pos, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS full_type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS def,
              a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%' AS auto_inc,
              col_description(a.attrelid, a.attnum) AS comment,
              co.collname AS collation,
              EXISTS (
                SELECT 1 FROM pg_index i
                 WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)
              ) AS is_pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_collation co ON co.oid = a.attcollation
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table],
    );
    return r.map((x) => ({
      position: Number(x.pos),
      name: x.name,
      dataType: x.full_type,
      length: null,
      precision: null,
      scale: null,
      nullable: x.nullable,
      defaultValue: x.def,
      autoIncrement: !!x.auto_inc,
      primaryKey: !!x.is_pk,
      comment: x.comment || '',
      collation: x.collation,
    }));
  }

  async listKeys(schema, table) {
    const r = await this.rows(
      `SELECT con.conname AS name,
              CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS type,
              a.attname AS col, k.ord AS pos
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('p','u')
        ORDER BY con.conname, k.ord`,
      [schema, table],
    );
    const map = new Map();
    for (const x of r) {
      if (!map.has(x.name)) map.set(x.name, { name: x.name, type: x.type, columns: [] });
      map.get(x.name).columns.push(x.col);
    }
    return [...map.values()];
  }

  async listForeignKeys(schema, table) {
    const r = await this.rows(
      `SELECT con.conname AS name,
              a.attname AS col, k.ord AS pos,
              rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_col,
              con.confupdtype AS upd, con.confdeltype AS del
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord) ON rk.ord = k.ord
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = rk.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f'
        ORDER BY con.conname, k.ord`,
      [schema, table],
    );
    const map = new Map();
    for (const x of r) {
      if (!map.has(x.name)) {
        map.set(x.name, {
          name: x.name,
          columns: [],
          referencedSchema: x.ref_schema,
          referencedTable: x.ref_table,
          referencedColumns: [],
          onUpdate: FK_ACTION[x.upd] || null,
          onDelete: FK_ACTION[x.del] || null,
        });
      }
      const fk = map.get(x.name);
      fk.columns.push(x.col);
      fk.referencedColumns.push(x.ref_col);
    }
    return [...map.values()];
  }

  async listReferences(schema, table) {
    const r = await this.rows(
      `SELECT con.conname AS name, n.nspname AS src_schema, c.relname AS src_table,
              a.attname AS src_col, ra.attname AS ref_col, k.ord AS pos
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord) ON rk.ord = k.ord
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = rk.attnum
        WHERE con.contype = 'f' AND rn.nspname = $1 AND rc.relname = $2
        ORDER BY c.relname, con.conname, k.ord`,
      [schema, table],
    );
    const map = new Map();
    for (const x of r) {
      const key = `${x.src_schema}.${x.src_table}.${x.name}`;
      if (!map.has(key)) {
        map.set(key, {
          name: x.name, sourceSchema: x.src_schema, sourceTable: x.src_table,
          columns: [], referencedColumns: [],
        });
      }
      map.get(key).columns.push(x.src_col);
      map.get(key).referencedColumns.push(x.ref_col);
    }
    return [...map.values()];
  }

  async listIndexes(schema, table) {
    const r = await this.rows(
      `SELECT i.relname AS name, ix.indisunique AS uniq, am.amname AS type,
              pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class c ON c.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_am am ON am.oid = i.relam
        WHERE n.nspname = $1 AND c.relname = $2
        ORDER BY i.relname`,
      [schema, table],
    );
    return r.map((x) => ({
      name: x.name,
      unique: !!x.uniq,
      type: x.type,
      columns: parseIndexColumns(x.def),
      comment: '',
    }));
  }

  async getDDL(schema, table, kind) {
    if (kind === 'view') {
      const r = await this.rows(
        `SELECT pg_get_viewdef(c.oid, true) AS def
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      );
      const def = r[0] ? r[0].def : '';
      return `CREATE OR REPLACE VIEW ${this.qualify(schema, table)} AS\n${def}`;
    }
    // PostgreSQL 은 CREATE TABLE 문을 돌려주는 내장 함수가 없어 메타데이터로 재구성한다.
    const [cols, keys, fks, idxs] = await Promise.all([
      this.listColumns(schema, table),
      this.listKeys(schema, table),
      this.listForeignKeys(schema, table),
      this.listIndexes(schema, table),
    ]);
    const lines = cols.map((c) => {
      let s = `\t${this.quote(c.name)} ${c.dataType}`;
      if (!c.nullable) s += ' NOT NULL';
      if (c.defaultValue) s += ` DEFAULT ${c.defaultValue}`;
      return s;
    });
    for (const k of keys) {
      lines.push(`\tCONSTRAINT ${this.quote(k.name)} ${k.type} (${k.columns.map((c) => this.quote(c)).join(', ')})`);
    }
    for (const f of fks) {
      let s = `\tCONSTRAINT ${this.quote(f.name)} FOREIGN KEY (${f.columns.map((c) => this.quote(c)).join(', ')})`
        + ` REFERENCES ${this.qualify(f.referencedSchema, f.referencedTable)}`
        + ` (${f.referencedColumns.map((c) => this.quote(c)).join(', ')})`;
      if (f.onUpdate && f.onUpdate !== 'NO ACTION') s += ` ON UPDATE ${f.onUpdate}`;
      if (f.onDelete && f.onDelete !== 'NO ACTION') s += ` ON DELETE ${f.onDelete}`;
      lines.push(s);
    }
    let ddl = `CREATE TABLE ${this.qualify(schema, table)} (\n${lines.join(',\n')}\n);`;
    const extraIdx = idxs.filter((i) => !keys.some((k) => k.name === i.name));
    if (extraIdx.length) {
      ddl += '\n\n' + extraIdx
        .map((i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${this.quote(i.name)} ON ${this.qualify(schema, table)} (${i.columns.join(', ')});`)
        .join('\n');
    }
    const comments = cols.filter((c) => c.comment);
    if (comments.length) {
      ddl += '\n\n' + comments
        .map((c) => `COMMENT ON COLUMN ${this.qualify(schema, table)}.${this.quote(c.name)} IS ${literal(c.comment)};`)
        .join('\n');
    }
    return ddl;
  }

  // ---- 객체 검색 -------------------------------------------------------------

  /**
   * 이름·컬럼·주석·정의 스크립트에서 검색어를 찾는다.
   * @param {string} term
   * @param {{schemas:string[], scopes:{names?:boolean,columns?:boolean,comments?:boolean,source?:boolean}, limit?:number}} opts
   */
  async searchObjects(term, opts) {
    const like = likePattern(term);
    const schemas = opts.schemas;
    const scopes = opts.scopes || {};
    const limit = Number(opts.limit) || 200;
    const hits = [];

    if (scopes.names) {
      const r = await this.rows(
        `SELECT n.nspname AS s, c.relname AS n,
                CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS t
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','v','m','f')
            AND c.relname ILIKE $2
          ORDER BY n.nspname, c.relname LIMIT ${limit}`,
        [schemas, like],
      );
      for (const x of r) hits.push({ kind: x.t, schema: x.s, table: x.n, name: x.n, matchedIn: 'name' });
    }

    if (scopes.columns) {
      const r = await this.rows(
        `SELECT n.nspname AS s, c.relname AS n, a.attname AS col,
                format_type(a.atttypid, a.atttypmod) AS ct,
                CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS t
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','v','m','f')
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE $2
          ORDER BY n.nspname, c.relname, a.attnum LIMIT ${limit}`,
        [schemas, like],
      );
      for (const x of r) {
        hits.push({ kind: 'column', schema: x.s, table: x.n, name: x.col, matchedIn: 'column', detail: x.ct, objectKind: x.t });
      }
    }

    if (scopes.comments) {
      const tableComments = await this.rows(
        `SELECT n.nspname AS s, c.relname AS n, obj_description(c.oid, 'pg_class') AS cm,
                CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS t
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','v','m','f')
            AND obj_description(c.oid, 'pg_class') ILIKE $2
          ORDER BY n.nspname, c.relname LIMIT ${limit}`,
        [schemas, like],
      );
      for (const x of tableComments) {
        hits.push({ kind: x.t, schema: x.s, table: x.n, name: x.n, matchedIn: 'comment', text: x.cm });
      }
      const columnComments = await this.rows(
        `SELECT n.nspname AS s, c.relname AS n, a.attname AS col,
                col_description(a.attrelid, a.attnum) AS cm
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND col_description(a.attrelid, a.attnum) ILIKE $2
          ORDER BY n.nspname, c.relname, a.attnum LIMIT ${limit}`,
        [schemas, like],
      );
      for (const x of columnComments) {
        hits.push({ kind: 'column', schema: x.s, table: x.n, name: x.col, matchedIn: 'comment', text: x.cm });
      }
    }

    if (scopes.source) {
      const views = await this.rows(
        `SELECT n.nspname AS s, c.relname AS n, pg_get_viewdef(c.oid, true) AS d
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind IN ('v','m')
            AND pg_get_viewdef(c.oid, true) ILIKE $2
          ORDER BY n.nspname, c.relname LIMIT ${limit}`,
        [schemas, like],
      );
      for (const x of views) hits.push({ kind: 'view', schema: x.s, table: x.n, name: x.n, matchedIn: 'source', text: x.d });

      const routines = await this.rows(
        `SELECT n.nspname AS s, p.proname AS n, p.prosrc AS d,
                CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS t
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = ANY($1) AND p.prosrc ILIKE $2
          ORDER BY n.nspname, p.proname LIMIT ${limit}`,
        [schemas, like],
      );
      for (const x of routines) hits.push({ kind: 'routine', schema: x.s, name: x.n, matchedIn: 'source', detail: x.t, text: x.d });

      const triggers = await this.rows(
        `SELECT n.nspname AS s, t.tgname AS n, c.relname AS tb, pg_get_triggerdef(t.oid) AS d
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND n.nspname = ANY($1)
            AND pg_get_triggerdef(t.oid) ILIKE $2
          ORDER BY n.nspname, t.tgname LIMIT ${limit}`,
        [schemas, like],
      );
      for (const x of triggers) hits.push({ kind: 'trigger', schema: x.s, table: x.tb, name: x.n, matchedIn: 'source', text: x.d });
    }

    return hits;
  }

  // ---- 실행 계획 -------------------------------------------------------------

  async explain(sql, { analyze = false } = {}) {
    const opts = analyze ? '(ANALYZE, BUFFERS, FORMAT JSON)' : '(FORMAT JSON)';
    const textOpts = analyze ? '(ANALYZE, BUFFERS)' : '';
    const jsonRows = await this.rows(`EXPLAIN ${opts} ${sql}`);
    const textRows = await this.rows(`EXPLAIN ${textOpts} ${sql}`);
    const raw = jsonRows[0] ? jsonRows[0]['QUERY PLAN'] : null;
    return {
      dialect: 'postgres',
      analyzed: analyze,
      json: typeof raw === 'string' ? safeParse(raw) : raw,
      text: textRows.map((r) => r['QUERY PLAN']).join('\n'),
    };
  }

  // ---- DDL 생성 --------------------------------------------------------------

  /** 컬럼 편집 내용을 ALTER TABLE 문 목록으로 바꾼다. */
  buildColumnDDL(schema, table, spec) {
    const target = this.qualify(schema, table);
    const out = [];

    for (const d of spec.drops || []) {
      out.push(`ALTER TABLE ${target} DROP COLUMN ${this.quote(d.name)};`);
    }

    for (const m of spec.modifies || []) {
      const before = m.original;
      const next = m.next;
      // PostgreSQL 은 속성마다 개별 문장이 필요하다.
      if (next.name !== before.name) {
        out.push(`ALTER TABLE ${target} RENAME COLUMN ${this.quote(before.name)} TO ${this.quote(next.name)};`);
      }
      const col = this.quote(next.name);
      if (next.dataType !== before.dataType) {
        out.push(`ALTER TABLE ${target} ALTER COLUMN ${col} TYPE ${next.dataType} USING ${col}::${next.dataType};`);
      }
      if (next.nullable !== before.nullable) {
        out.push(`ALTER TABLE ${target} ALTER COLUMN ${col} ${next.nullable ? 'DROP' : 'SET'} NOT NULL;`);
      }
      const beforeDefault = before.defaultValue ?? '';
      const nextDefault = next.defaultValue ?? '';
      if (nextDefault !== beforeDefault) {
        out.push(nextDefault
          ? `ALTER TABLE ${target} ALTER COLUMN ${col} SET DEFAULT ${nextDefault};`
          : `ALTER TABLE ${target} ALTER COLUMN ${col} DROP DEFAULT;`);
      }
      if ((next.comment || '') !== (before.comment || '')) {
        out.push(`COMMENT ON COLUMN ${target}.${col} IS ${next.comment ? literal(next.comment) : 'NULL'};`);
      }
    }

    for (const a of spec.adds || []) {
      let s = `ALTER TABLE ${target} ADD COLUMN ${this.quote(a.name)} ${a.dataType}`;
      if (!a.nullable) s += ' NOT NULL';
      if (a.defaultValue) s += ` DEFAULT ${a.defaultValue}`;
      out.push(s + ';');
      if (a.comment) {
        out.push(`COMMENT ON COLUMN ${target}.${this.quote(a.name)} IS ${literal(a.comment)};`);
      }
    }

    if (spec.tableComment !== undefined && spec.tableComment !== null) {
      out.push(`COMMENT ON TABLE ${target} IS ${spec.tableComment ? literal(spec.tableComment) : 'NULL'};`);
    }
    return out;
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

const FK_ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

function literal(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function parseIndexColumns(def) {
  const m = /\(([^)]*)\)\s*$/.exec(def) || /\(([\s\S]*)\)/.exec(def);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim());
}

/** pg 는 배열/객체 타입을 그대로 돌려주므로 그리드에서 다룰 수 있도록 정규화한다. */
function normalizeRow(row) {
  return row.map((v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
    if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
}

module.exports = { PostgresDriver };
