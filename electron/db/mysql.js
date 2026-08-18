'use strict';

const mysql = require('mysql2/promise');

let TYPE_NAMES = null;
function typeName(code) {
  if (!TYPE_NAMES) {
    TYPE_NAMES = {};
    try {
      const { Types } = require('mysql2');
      for (const [name, val] of Object.entries(Types || {})) {
        if (typeof val === 'number' && TYPE_NAMES[val] === undefined) TYPE_NAMES[val] = name;
      }
    } catch (_) {
      /* 상수를 못 읽으면 숫자 코드를 그대로 노출한다 */
    }
  }
  return TYPE_NAMES[code] || String(code);
}

/**
 * MySQL / MariaDB 드라이버.
 * MySQL 에서는 database 와 schema 가 같은 개념이므로 스키마 계층을 따로 두지 않는다.
 */
class MySqlDriver {
  static kind = 'mysql';

  constructor(config) {
    this.config = config;
    this.conn = null;
    this.serverVersion = '';
    /** 트리에서 카탈로그(=데이터베이스) 아래에 스키마 계층이 있는지 */
    this.hasSchemaLevel = false;
  }

  async connect() {
    this.conn = await mysql.createConnection({
      host: this.config.host,
      port: Number(this.config.port) || 3306,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database || undefined,
      connectTimeout: 15000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      ssl: this.config.ssl ? {} : undefined,
    });
    const [rows] = await this.conn.query('SELECT VERSION() AS v, DATABASE() AS db');
    this.serverVersion = rows[0].v;
    return { version: rows[0].v, currentSchema: rows[0].db || null };
  }

  async close() {
    if (this.conn) {
      try { await this.conn.end(); } catch (_) { /* 이미 끊겼으면 무시 */ }
      this.conn = null;
    }
  }

  quote(ident) {
    return '`' + String(ident).replace(/`/g, '``') + '`';
  }

  qualify(schema, table) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table);
  }

  /** 결과를 { columns, rows(배열형), rowCount, affectedRows } 로 정규화해 반환한다. */
  async query(sql, params = []) {
    const started = Date.now();
    const [result, fields] = await this.conn.query({ sql, values: params, rowsAsArray: true });
    const elapsed = Date.now() - started;

    if (Array.isArray(fields) && fields.length) {
      return {
        columns: fields.map((f) => ({
          name: f.name,
          type: typeName(f.columnType),
          table: f.table || null,
          schema: f.schema || f.db || null,
        })),
        rows: result,
        rowCount: result.length,
        affectedRows: null,
        elapsed,
      };
    }
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: result && typeof result.affectedRows === 'number' ? result.affectedRows : 0,
      elapsed,
    };
  }

  /** 값을 객체 배열로 받는 내부 조회용 헬퍼. */
  async rows(sql, params = []) {
    const [r] = await this.conn.query(sql, params);
    return r;
  }

  // ---- 트랜잭션 -------------------------------------------------------------
  async begin() { await this.conn.query('START TRANSACTION'); }
  async commit() { await this.conn.query('COMMIT'); }
  async rollback() { await this.conn.query('ROLLBACK'); }

  // ---- 메타데이터 -----------------------------------------------------------
  async listDatabases() {
    const r = await this.rows(
      `SELECT schema_name AS name, default_character_set_name AS charset, default_collation_name AS collation
         FROM information_schema.schemata
        ORDER BY schema_name`,
    );
    return r.map((x) => ({ name: x.name, charset: x.charset, collation: x.collation }));
  }

  async listSchemas() {
    // MySQL 은 database == schema
    return this.listDatabases();
  }

  async setCurrentSchema(schema) {
    await this.conn.query(`USE ${this.quote(schema)}`);
    return schema;
  }

  async listTables(schema) {
    const r = await this.rows(
      `SELECT table_name AS name, table_type AS type, engine, table_rows AS rows_est,
              data_length, index_length, table_comment AS comment, create_time, update_time,
              table_collation AS collation
         FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY table_type, table_name`,
      [schema],
    );
    return r.map((x) => ({
      name: x.name,
      kind: x.type === 'VIEW' ? 'view' : 'table',
      engine: x.engine,
      rowsEstimate: x.rows_est == null ? null : Number(x.rows_est),
      sizeBytes: (Number(x.data_length) || 0) + (Number(x.index_length) || 0),
      // MySQL 은 뷰의 table_comment 에 'VIEW' 를 채워 넣으므로 주석으로 취급하지 않는다.
      comment: x.type === 'VIEW' && x.comment === 'VIEW' ? '' : (x.comment || ''),
      collation: x.collation,
      createdAt: x.create_time,
      updatedAt: x.update_time,
    }));
  }

  async listColumns(schema, table) {
    const r = await this.rows(
      `SELECT ordinal_position AS pos, column_name AS name, column_type AS full_type,
              data_type AS type, character_maximum_length AS len, numeric_precision AS prec,
              numeric_scale AS scale, is_nullable AS nullable, column_default AS def,
              extra, column_key AS ckey, column_comment AS comment, collation_name AS collation
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [schema, table],
    );
    return r.map((x) => ({
      position: Number(x.pos),
      name: x.name,
      dataType: x.full_type || x.type,
      length: x.len == null ? null : Number(x.len),
      precision: x.prec == null ? null : Number(x.prec),
      scale: x.scale == null ? null : Number(x.scale),
      nullable: x.nullable === 'YES',
      defaultValue: x.def,
      autoIncrement: /auto_increment/i.test(x.extra || ''),
      primaryKey: x.ckey === 'PRI',
      comment: x.comment || '',
      collation: x.collation,
    }));
  }

  async listKeys(schema, table) {
    const r = await this.rows(
      `SELECT tc.constraint_name AS name, tc.constraint_type AS type, kcu.column_name AS col,
              kcu.ordinal_position AS pos
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_schema = tc.constraint_schema
          AND kcu.constraint_name = tc.constraint_name
          AND kcu.table_name = tc.table_name
        WHERE tc.table_schema = ? AND tc.table_name = ?
          AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
        ORDER BY tc.constraint_name, kcu.ordinal_position`,
      [schema, table],
    );
    return groupConstraints(r);
  }

  async listForeignKeys(schema, table) {
    const r = await this.rows(
      `SELECT kcu.constraint_name AS name, kcu.column_name AS col, kcu.ordinal_position AS pos,
              kcu.referenced_table_schema AS ref_schema, kcu.referenced_table_name AS ref_table,
              kcu.referenced_column_name AS ref_col,
              rc.update_rule AS on_update, rc.delete_rule AS on_delete
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_schema = kcu.constraint_schema
          AND rc.constraint_name = kcu.constraint_name
        WHERE kcu.table_schema = ? AND kcu.table_name = ?
        ORDER BY kcu.constraint_name, kcu.ordinal_position`,
      [schema, table],
    );
    return groupForeignKeys(r);
  }

  /** 이 테이블을 참조하는 다른 테이블의 외래키 (DBeaver 의 References). */
  async listReferences(schema, table) {
    const r = await this.rows(
      `SELECT kcu.constraint_name AS name, kcu.table_schema AS src_schema, kcu.table_name AS src_table,
              kcu.column_name AS src_col, kcu.referenced_column_name AS ref_col, kcu.ordinal_position AS pos
         FROM information_schema.key_column_usage kcu
        WHERE kcu.referenced_table_schema = ? AND kcu.referenced_table_name = ?
        ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position`,
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
      const fk = map.get(key);
      fk.columns.push(x.src_col);
      fk.referencedColumns.push(x.ref_col);
    }
    return [...map.values()];
  }

  async listIndexes(schema, table) {
    const r = await this.rows(`SHOW INDEX FROM ${this.qualify(schema, table)}`);
    const map = new Map();
    for (const x of r) {
      const name = x.Key_name;
      if (!map.has(name)) {
        map.set(name, {
          name,
          unique: Number(x.Non_unique) === 0,
          type: x.Index_type,
          columns: [],
          comment: x.Index_comment || '',
        });
      }
      map.get(name).columns.push(x.Column_name + (x.Collation === 'D' ? ' DESC' : ''));
    }
    return [...map.values()];
  }

  async getDDL(schema, table, kind) {
    const r = await this.rows(`SHOW CREATE ${kind === 'view' ? 'VIEW' : 'TABLE'} ${this.qualify(schema, table)}`);
    const row = r[0] || {};
    return row['Create Table'] || row['Create View'] || '';
  }

  // ---- 실행 계획 -------------------------------------------------------------

  get isMariaDb() {
    return /mariadb/i.test((this.serverVersion || ''));
  }

  async explain(sql, { analyze = false } = {}) {
    if (analyze) {
      // MariaDB 는 ANALYZE FORMAT=JSON, MySQL 8 은 EXPLAIN ANALYZE (텍스트) 를 쓴다.
      if (this.isMariaDb) {
        const r = await this.rows(`ANALYZE FORMAT=JSON ${sql}`);
        return { dialect: 'mysql', analyzed: true, json: parseJson(firstValue(r)), text: null };
      }
      const r = await this.rows(`EXPLAIN ANALYZE ${sql}`);
      return { dialect: 'mysql', analyzed: true, json: null, text: String(firstValue(r) ?? '') };
    }
    const [jsonRows, tabular] = await Promise.all([
      this.rows(`EXPLAIN FORMAT=JSON ${sql}`),
      this.rows(`EXPLAIN ${sql}`),
    ]);
    return {
      dialect: 'mysql',
      analyzed: false,
      json: parseJson(firstValue(jsonRows)),
      text: formatTabular(tabular),
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
      // CHANGE COLUMN 하나로 이름·타입·NULL·기본값·주석을 한 번에 바꾼다.
      out.push(`ALTER TABLE ${target} CHANGE COLUMN ${this.quote(m.original.name)} ${this.columnClause(m.next)};`);
    }
    for (const a of spec.adds || []) {
      const after = a.after ? ` AFTER ${this.quote(a.after)}` : '';
      out.push(`ALTER TABLE ${target} ADD COLUMN ${this.columnClause(a)}${after};`);
    }
    if (spec.tableComment !== undefined && spec.tableComment !== null) {
      out.push(`ALTER TABLE ${target} COMMENT = ${literal(spec.tableComment)};`);
    }
    return out;
  }

  columnClause(c) {
    let s = `${this.quote(c.name)} ${c.dataType}`;
    s += c.nullable ? ' NULL' : ' NOT NULL';
    if (c.defaultValue !== null && c.defaultValue !== undefined && c.defaultValue !== '') {
      s += ` DEFAULT ${c.defaultValue}`;
    }
    if (c.autoIncrement) s += ' AUTO_INCREMENT';
    if (c.comment) s += ` COMMENT ${literal(c.comment)}`;
    return s;
  }
}

function literal(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

function firstValue(rows) {
  if (!rows || !rows.length) return null;
  const values = Object.values(rows[0]);
  return values.length ? values[0] : null;
}

function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (_) { return null; }
}

/** EXPLAIN 의 표 형태 결과를 사람이 읽을 수 있는 텍스트로 만든다. */
function formatTabular(rows) {
  if (!rows || !rows.length) return '';
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c] ?? '')))].join('\n');
}

function groupConstraints(rows) {
  const map = new Map();
  for (const x of rows) {
    if (!map.has(x.name)) map.set(x.name, { name: x.name, type: x.type, columns: [] });
    map.get(x.name).columns.push(x.col);
  }
  return [...map.values()];
}

function groupForeignKeys(rows) {
  const map = new Map();
  for (const x of rows) {
    if (!map.has(x.name)) {
      map.set(x.name, {
        name: x.name,
        columns: [],
        referencedSchema: x.ref_schema,
        referencedTable: x.ref_table,
        referencedColumns: [],
        onUpdate: x.on_update,
        onDelete: x.on_delete,
      });
    }
    const fk = map.get(x.name);
    fk.columns.push(x.col);
    fk.referencedColumns.push(x.ref_col);
  }
  return [...map.values()];
}

module.exports = { MySqlDriver };
