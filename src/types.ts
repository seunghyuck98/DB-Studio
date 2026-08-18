export type DbKind = 'mysql' | 'mariadb' | 'postgres';

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  autoCommit: boolean;
  savePassword?: boolean;
  hasSavedPassword?: boolean;
  password?: string;
  color?: string | null;
}

export interface SessionStatus {
  connected: boolean;
  kind?: DbKind;
  hasSchemaLevel?: boolean;
  autoCommit?: boolean;
  txActive?: boolean;
  /** 트랜잭션에서 실행한 전체 문장 수 (조회 포함) */
  txStatements?: number;
  /** 커밋 대상이 되는 변경 문장 수 */
  txChanges?: number;
  currentSchema?: string | null;
  currentDatabase?: string | null;
  serverVersion?: string | null;
}

export interface ColumnMeta {
  name: string;
  type: string;
  table: string | null;
  schema: string | null;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: unknown[][];
  rowCount: number;
  affectedRows: number | null;
  elapsed: number;
  truncated?: boolean;
  sql?: string;
}

export interface StatementResult extends QueryResult {
  sql: string;
  ok: boolean;
  error?: string;
}

export interface DatabaseMeta {
  name: string;
  charset?: string;
  collation?: string;
  current?: boolean;
}

export interface SchemaMeta {
  name: string;
}

export interface TableMeta {
  name: string;
  kind: 'table' | 'view';
  engine: string | null;
  rowsEstimate: number | null;
  sizeBytes: number;
  comment: string;
  collation: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TableColumn {
  position: number;
  name: string;
  dataType: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  primaryKey: boolean;
  comment: string;
  collation: string | null;
}

export interface KeyMeta {
  name: string;
  type: string;
  columns: string[];
}

export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
}

export interface ReferenceMeta {
  name: string;
  sourceSchema: string;
  sourceTable: string;
  columns: string[];
  referencedColumns: string[];
}

export interface IndexMeta {
  name: string;
  unique: boolean;
  type: string;
  columns: string[];
  comment: string;
}

export interface ExplainResult {
  dialect: 'mysql' | 'postgres';
  analyzed: boolean;
  json: unknown;
  text: string | null;
  sql: string;
  status: SessionStatus;
}

export interface HistoryEntry {
  id: number;
  at: string;
  connectionId: string;
  connectionName: string | null;
  kind: DbKind | null;
  database: string | null;
  schema: string | null;
  sql: string;
  ms: number | null;
  rows: number | null;
  affected: number | null;
  ok: boolean;
  error: string | null;
  source: string;
}

/** 객체 검색에서 무엇을 뒤질지 */
export interface SearchScopes {
  names: boolean;
  columns: boolean;
  comments: boolean;
  source: boolean;
}

export type SearchHitKind = 'table' | 'view' | 'column' | 'routine' | 'trigger';
export type SearchMatchedIn = 'name' | 'column' | 'comment' | 'source';

export interface SearchHit {
  kind: SearchHitKind;
  schema: string;
  table: string | null;
  name: string;
  matchedIn: SearchMatchedIn;
  detail: string | null;
  /** 정의 스크립트에서 검색어 주변만 잘라낸 부분 */
  snippet: string | null;
  objectKind: 'table' | 'view';
}

export interface SearchResult {
  term: string;
  schemas: string[];
  hits: SearchHit[];
  truncated: boolean;
}

/** 진행 중인 트랜잭션에서 실행한 변경 문장 하나 */
export interface TxEntry {
  seq: number;
  at: string;
  sql: string;
  verb: string;
  affected: number | null;
  source: string;
  schema: string | null;
  /** 구조를 바꾸는 문장인지 */
  ddl: boolean;
  /** 롤백으로 되돌릴 수 있는지 */
  rollbackable: boolean;
  /** 이 문장이 앞선 변경까지 암묵적으로 커밋시켰는지 (MySQL·MariaDB 의 DDL) */
  implicitCommit: boolean;
}

export interface PendingTx {
  status: SessionStatus;
  entries: TxEntry[];
  totalAffected: number;
}

export interface TxFinishResult {
  status: SessionStatus;
  entries: TxEntry[];
  applied: boolean;
}

export type ExportFormat = 'csv' | 'tsv' | 'xlsx';

export interface ExportResult {
  canceled: boolean;
  filePath?: string;
  name?: string;
  rows?: number;
  truncated?: boolean;
}

/** 컬럼 편집 내용을 드라이버가 ALTER 문으로 바꿀 때 쓰는 형식. */
export interface ColumnSpec {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string;
  autoIncrement?: boolean;
  after?: string;
}

export interface ColumnChangeSpec {
  adds: ColumnSpec[];
  modifies: { original: ColumnSpec; next: ColumnSpec }[];
  drops: { name: string }[];
  tableComment?: string | null;
}

export type TabKind = 'table' | 'sql' | 'history' | 'tx';

export interface TableTab {
  id: string;
  kind: 'table';
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  objectKind: 'table' | 'view';
  activeSection: 'properties' | 'data' | 'er';
}

export interface SqlTab {
  id: string;
  kind: 'sql';
  connectionId: string;
  database: string;
  schema: string;
  title: string;
}

export interface HistoryTab {
  id: string;
  kind: 'history';
  connectionId: string;
  database: string;
  schema: string;
  title: string;
}

/** 진행 중인 트랜잭션의 변경 내역 탭 (접속별로 하나) */
export interface TxTab {
  id: string;
  kind: 'tx';
  connectionId: string;
  database: string;
  schema: string;
  title: string;
}

export type Tab = TableTab | SqlTab | HistoryTab | TxTab;

declare global {
  interface Window {
    api: {
      connections: {
        list(): Promise<ConnectionConfig[]>;
        save(conn: Partial<ConnectionConfig>): Promise<ConnectionConfig>;
        remove(id: string): Promise<boolean>;
        test(conn: Partial<ConnectionConfig>): Promise<{ ok: boolean; version: string }>;
        connect(id: string, password?: string): Promise<SessionStatus>;
        disconnect(id: string): Promise<SessionStatus>;
        status(id: string): Promise<SessionStatus>;
        encryptionAvailable(): Promise<boolean>;
      };
      meta: {
        get(id: string, action: string, args?: Record<string, unknown>): Promise<any>;
        setSchema(id: string, schema: string): Promise<SessionStatus>;
        setDatabase(id: string, database: string): Promise<SessionStatus>;
        search(id: string, req: {
          term: string; schemas?: string[]; scopes?: Partial<SearchScopes>; limit?: number;
        }): Promise<SearchResult>;
      };
      data: {
        select(id: string, args: Record<string, unknown>): Promise<QueryResult>;
        count(id: string, args: Record<string, unknown>): Promise<number>;
        apply(id: string, args: Record<string, unknown>): Promise<{ executed: { sql: string; affected: number }[]; status: SessionStatus }>;
      };
      sql: {
        execute(id: string, sql: string, opts?: Record<string, unknown>): Promise<{ results: StatementResult[]; status: SessionStatus }>;
        explain(id: string, sql: string, opts?: { analyze?: boolean }): Promise<ExplainResult>;
      };
      ddl: {
        preview(id: string, args: { schema: string; table: string; spec: ColumnChangeSpec }): Promise<string[]>;
        execute(id: string, statements: string[] | string): Promise<{ executed: { sql: string; affected: number }[]; status: SessionStatus }>;
      };
      exports: {
        rows(req: {
          columns: { name: string }[]; rows: unknown[][];
          format: ExportFormat; defaultName: string;
          options?: { delimiter?: string; header?: boolean; nullText?: string; bom?: boolean };
        }): Promise<ExportResult>;
        query(id: string, req: {
          schema?: string; table?: string; filter?: string;
          orderBy?: { column: string; direction: 'asc' | 'desc' } | null;
          sql?: string; maxRows?: number;
          format: ExportFormat; defaultName: string;
          options?: { delimiter?: string; header?: boolean; nullText?: string; bom?: boolean };
        }): Promise<ExportResult>;
      };
      history: {
        list(query?: { search?: string; connectionId?: string; onlyErrors?: boolean; limit?: number; offset?: number }):
          Promise<{ total: number; entries: HistoryEntry[] }>;
        clear(): Promise<boolean>;
      };
      tx: {
        setAutoCommit(id: string, value: boolean): Promise<SessionStatus>;
        pending(id: string): Promise<PendingTx>;
        commit(id: string): Promise<TxFinishResult>;
        rollback(id: string): Promise<TxFinishResult>;
      };
      onMenu(handler: (channel: string) => void): () => void;
      platform: string;
    };
  }
}
