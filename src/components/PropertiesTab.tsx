import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import DdlPreviewDialog from './DdlPreviewDialog';
import { getTabScratch, setTabScratch, notify, sessionOf, getState, openSqlTab } from '../state/store';
import { message } from '../state/actions';
import type {
  CheckMeta, ColumnChangeSpec, ColumnSpec, ForeignKeyMeta, IndexMeta, KeyMeta,
  ReferenceMeta, TableColumn, TableGrant, TableMeta, TablePrivileges, TableTab,
} from '../types';

type Section = 'columns' | 'keys' | 'foreignKeys' | 'references' | 'indexes' | 'privileges' | 'ddl';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'columns', label: '컬럼' },
  { key: 'keys', label: '키' },
  { key: 'foreignKeys', label: '외래키' },
  { key: 'references', label: '참조' },
  { key: 'indexes', label: '인덱스' },
  { key: 'privileges', label: '권한' },
  { key: 'ddl', label: 'DDL' },
];

function fmtBytes(n: number): string {
  if (!n) return '0';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

/**
 * react-codemirror 는 basicSetup/extensions 의 identity 가 바뀌면 에디터를 전부
 * 다시 구성한다 (검색 패널 같은 확장 상태가 사라진다). 항상 같은 객체를 넘긴다.
 */
const BASIC_SETUP = { foldGutter: true, highlightActiveLine: true, autocompletion: true };

/** 행의 값 중 하나라도 검색어를 담고 있는지 (대소문자 무시) */
function rowMatch(q: string, values: unknown[]): boolean {
  if (!q) return true;
  return values.some((v) => String(v ?? '').toLowerCase().includes(q));
}

interface Loaded {
  columns: TableColumn[];
  keys: KeyMeta[];
  checks: CheckMeta[];
  foreignKeys: ForeignKeyMeta[];
  references: ReferenceMeta[];
  indexes: IndexMeta[];
  privileges: TablePrivileges;
  ddl: string;
  /** 테이블 자체 정보 (엔진·행 추정·크기·주석 등) */
  info: TableMeta | null;
}

export default function PropertiesTab({ tab }: { tab: TableTab }) {
  const [section, setSection] = useState<Section>(() => getTabScratch(tab.id, 'propSection', 'columns' as Section));
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState('');
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTabScratch(tab.id, 'propSection', section); }, [tab.id, section]);

  // ⌘/Ctrl+F 로 이 표 안 찾기. DDL 은 편집기가 자체 검색(⌘F)을 가지고 있어 건드리지 않는다.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey) return;
      if (e.defaultPrevented) return; // DDL 편집기(CodeMirror)가 이미 받았다
      const s = getState();
      if (s.focusedPane !== (tab.pane === 1 ? 1 : 0)) return; // 다른 화면이 포커스면 그쪽 몫
      e.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => findRef.current?.select());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tab.pane]);

  const closeFind = () => { setFindOpen(false); setFind(''); };

  // 검색어로 각 표의 행을 거른다.
  const q = findOpen ? find.trim().toLowerCase() : '';
  const view = useMemo<Loaded | null>(() => {
    if (!data || !q) return data;
    return {
      ...data,
      columns: data.columns.filter((c) => rowMatch(q, [c.name, c.dataType, c.defaultValue, c.comment])),
      keys: data.keys.filter((k) => rowMatch(q, [k.name, k.type, k.columns.join(',')])),
      checks: data.checks.filter((c) => rowMatch(q, [c.name, c.expression])),
      foreignKeys: data.foreignKeys.filter((f) => rowMatch(q, [f.name, f.columns.join(','), f.referencedSchema, f.referencedTable, f.referencedColumns.join(',')])),
      references: data.references.filter((r) => rowMatch(q, [r.name, r.sourceSchema, r.sourceTable, r.columns.join(','), r.referencedColumns.join(',')])),
      indexes: data.indexes.filter((i) => rowMatch(q, [i.name, i.type, i.columns.join(',')])),
      privileges: {
        ...data.privileges,
        grants: data.privileges.grants.filter((g) => rowMatch(q, [g.grantee, g.privilege])),
      },
    };
  }, [data, q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const args = { schema: tab.schema, table: tab.table };
    try {
      const [columns, keys, checks, foreignKeys, references, indexes, privileges, ddl, tables] = await Promise.all([
        window.api.meta.get(tab.connectionId, 'columns', args),
        window.api.meta.get(tab.connectionId, 'keys', args),
        window.api.meta.get(tab.connectionId, 'checks', args),
        window.api.meta.get(tab.connectionId, 'foreignKeys', args),
        window.api.meta.get(tab.connectionId, 'references', args),
        window.api.meta.get(tab.connectionId, 'indexes', args),
        window.api.meta.get(tab.connectionId, 'privileges', args),
        window.api.meta.get(tab.connectionId, 'ddl', { ...args, kind: tab.objectKind }),
        window.api.meta.get(tab.connectionId, 'tables', { schema: tab.schema }),
      ]);
      const info = (tables as TableMeta[]).find((t) => t.name === tab.table) ?? null;
      setData({ columns, keys, checks, foreignKeys, references, indexes, privileges, ddl, info });
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.schema, tab.table, tab.objectKind]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('dbstudio:refresh', handler);
    return () => window.removeEventListener('dbstudio:refresh', handler);
  }, [load]);

  return (
    <div className="props">
      {data?.info && <TableInfoBar tab={tab} info={data.info} owner={data.privileges.owner} />}
      <div className="props-tabs">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`chip ${section === s.key ? 'active' : ''}`}
            onClick={() => setSection(s.key)}
          >
            {s.label}
          </button>
        ))}
        <div className="spacer" />
        <button className="btn small" onClick={() => void load()} disabled={loading}>새로 고침</button>
      </div>

      {findOpen && section !== 'ddl' && data && (
        <div className="props-find">
          <span className="icon icon-search" aria-hidden />
          <input
            ref={findRef}
            className="input"
            placeholder="이 표에서 찾기… (이름·타입·주석)"
            value={find}
            autoFocus
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeFind(); }}
          />
          {q && view && (
            <span className="hint">
              {section === 'privileges' ? view.privileges.grants.length
                : section === 'keys' ? view.keys.length + view.checks.length
                : view[section].length}
              {' / '}
              {section === 'privileges' ? data.privileges.grants.length
                : section === 'keys' ? data.keys.length + data.checks.length
                : data[section].length}
            </span>
          )}
          <button className="icon-btn" aria-label="찾기 닫기" onClick={closeFind}>×</button>
        </div>
      )}

      {loading && <div className="pane-message">불러오는 중…</div>}
      {error && <div className="pane-message error">{error}</div>}

      {view && !loading && (
        <div className="props-body">
          {section === 'columns' && <ColumnsPanel tab={tab} rows={view.columns} allRows={data!.columns} onChanged={load} />}
          {section === 'keys' && (
            <KeysPanel tab={tab} keys={view.keys} checks={view.checks} allKeys={data!.keys} columns={data!.columns} onChanged={load} />
          )}
          {section === 'foreignKeys' && (
            <ForeignKeysPanel tab={tab} rows={view.foreignKeys} columns={data!.columns} onChanged={load} />
          )}
          {section === 'references' && <ReferencesTable rows={view.references} />}
          {section === 'indexes' && (
            <IndexesPanel tab={tab} rows={view.indexes} keys={data!.keys} foreignKeys={data!.foreignKeys} onChanged={load} />
          )}
          {section === 'privileges' && <PrivilegesTable data={view.privileges} />}
          {section === 'ddl' && <DdlPanel tab={tab} ddl={view.ddl} onChanged={load} />}
        </div>
      )}
    </div>
  );
}

function Empty({ what }: { what: string }) {
  return <div className="pane-message muted">{what}이(가) 없습니다.</div>;
}

// ---- 컬럼 (조회 + 편집) -------------------------------------------------------

interface DraftColumn extends ColumnSpec {
  key: string;
  original: ColumnSpec | null;
  dropped: boolean;
}

function toSpec(c: TableColumn): ColumnSpec {
  return {
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    defaultValue: c.defaultValue,
    comment: c.comment,
    autoIncrement: c.autoIncrement,
  };
}

function ColumnsPanel({ tab, rows, allRows, onChanged }: {
  tab: TableTab;
  /** 화면에 보여줄 (찾기로 걸러진) 행 */
  rows: TableColumn[];
  /** 편집을 시작할 때 쓰는 전체 행 — 걸러진 목록으로 편집하면 안 보이는 컬럼을 놓친다 */
  allRows: TableColumn[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<DraftColumn[]>([]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const session = sessionOf(tab.connectionId, getState());
  const editable = tab.objectKind === 'table';

  const startEdit = () => {
    setDrafts(allRows.map((c, i) => ({ ...toSpec(c), key: `c${i}`, original: toSpec(c), dropped: false })));
    setEditing(true);
  };

  const cancel = () => { setEditing(false); setDrafts([]); };

  const patch = (key: string, p: Partial<DraftColumn>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...p } : d)));

  const spec = useMemo<ColumnChangeSpec>(() => {
    const adds: ColumnSpec[] = [];
    const modifies: { original: ColumnSpec; next: ColumnSpec }[] = [];
    const drops: { name: string }[] = [];
    for (const d of drafts) {
      const next: ColumnSpec = {
        name: d.name.trim(),
        dataType: d.dataType.trim(),
        nullable: d.nullable,
        defaultValue: d.defaultValue,
        comment: d.comment,
        autoIncrement: d.autoIncrement,
      };
      if (!d.original) {
        if (!d.dropped && next.name && next.dataType) adds.push(next);
        continue;
      }
      if (d.dropped) { drops.push({ name: d.original.name }); continue; }
      if (JSON.stringify(next) !== JSON.stringify(d.original)) modifies.push({ original: d.original, next });
    }
    return { adds, modifies, drops };
  }, [drafts]);

  const changeCount = spec.adds.length + spec.modifies.length + spec.drops.length;

  const showPreview = async () => {
    setBusy(true);
    try {
      const statements = await window.api.ddl.preview(tab.connectionId, {
        schema: tab.schema, table: tab.table, spec,
      });
      if (!statements.length) { notify('info', '변경된 내용이 없습니다.'); return; }
      setPreview(statements);
    } catch (e) {
      notify('error', message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!rows.length && !editing) return <Empty what="컬럼" />;

  return (
    <div className="columns-panel">
      <div className="panel-toolbar">
        {!editing ? (
          <button className="btn small" disabled={!editable} onClick={startEdit}>
            {editable ? '컬럼 편집' : '뷰는 편집할 수 없습니다'}
          </button>
        ) : (
          <>
            <button
              className="btn small"
              onClick={() => setDrafts((p) => [...p, {
                key: `new${p.length}${Date.now()}`, original: null, dropped: false,
                name: '', dataType: session?.kind === 'postgres' ? 'text' : 'varchar(50)',
                nullable: true, defaultValue: null, comment: '',
              }])}
            >
              + 컬럼 추가
            </button>
            <button className="btn small" onClick={cancel}>취소</button>
            <button className="btn small primary" disabled={!changeCount || busy} onClick={() => void showPreview()}>
              변경 SQL 보기{changeCount ? ` (${changeCount})` : ''}
            </button>
            <span className="hint">기본값은 SQL 식 그대로 입력합니다. 예: <code>'A'</code>, <code>0</code>, <code>now()</code></span>
          </>
        )}
      </div>

      <div className="grid-scroll">
        <table className="meta-table">
          <thead>
            <tr>
              <th>#</th><th>이름</th><th>데이터 타입</th><th>NULL</th><th>기본값</th>
              <th>키</th><th>자동증가</th><th>주석</th>{editing && <th />}
            </tr>
          </thead>
          <tbody>
            {!editing && rows.map((c) => (
              <tr key={c.name}>
                <td className="num">{c.position}</td>
                <td className="mono strong">{c.name}</td>
                <td className="mono">{c.dataType}</td>
                <td>{c.nullable ? 'YES' : 'NO'}</td>
                <td className="mono">{c.defaultValue ?? ''}</td>
                <td>{c.primaryKey ? 'PK' : ''}</td>
                <td>{c.autoIncrement ? '✓' : ''}</td>
                <td>{c.comment}</td>
              </tr>
            ))}
            {editing && drafts.map((d, i) => (
              <tr key={d.key} className={d.dropped ? 'deleted' : (!d.original ? 'inserted' : '')}>
                <td className="num">{i + 1}</td>
                <td><input className="input cell" value={d.name} disabled={d.dropped} onChange={(e) => patch(d.key, { name: e.target.value })} /></td>
                <td><input className="input cell" value={d.dataType} disabled={d.dropped} onChange={(e) => patch(d.key, { dataType: e.target.value })} /></td>
                <td className="center">
                  <input type="checkbox" checked={d.nullable} disabled={d.dropped} onChange={(e) => patch(d.key, { nullable: e.target.checked })} />
                </td>
                <td>
                  <input
                    className="input cell"
                    value={d.defaultValue ?? ''}
                    disabled={d.dropped}
                    onChange={(e) => patch(d.key, { defaultValue: e.target.value === '' ? null : e.target.value })}
                  />
                </td>
                <td>{allRows.find((c) => c.name === d.original?.name)?.primaryKey ? 'PK' : ''}</td>
                <td>{d.autoIncrement ? '✓' : ''}</td>
                <td><input className="input cell" value={d.comment} disabled={d.dropped} onChange={(e) => patch(d.key, { comment: e.target.value })} /></td>
                <td className="center">
                  {d.original ? (
                    <button className="icon-btn" title={d.dropped ? '삭제 취소' : '삭제 표시'} onClick={() => patch(d.key, { dropped: !d.dropped })}>
                      {d.dropped ? '↩' : '−'}
                    </button>
                  ) : (
                    <button className="icon-btn" title="행 제거" onClick={() => setDrafts((p) => p.filter((x) => x.key !== d.key))}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview && (
        <DdlPreviewDialog
          connectionId={tab.connectionId}
          title={`${tab.schema}.${tab.table} 컬럼 변경`}
          statements={preview}
          autoCommit={session?.autoCommit ?? true}
          transactionalDdl={session?.kind === 'postgres'}
          onClose={() => setPreview(null)}
          onApplied={() => { cancel(); onChanged(); }}
        />
      )}
    </div>
  );
}

// ---- DDL (조회 + 편집) --------------------------------------------------------

function DdlPanel({ tab, ddl, onChanged }: { tab: TableTab; ddl: string; onChanged: () => void }) {
  const [text, setText] = useState(ddl);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const session = sessionOf(tab.connectionId, getState());
  const dialect = session?.kind === 'postgres' ? PostgreSQL : MySQL;
  // identity 가 흔들리면 리렌더마다 에디터가 재구성돼 ⌘F 패널이 닫힌다.
  const extensions = useMemo(() => [sqlLang({ dialect, upperCaseKeywords: true })], [dialect]);
  const dirty = text !== ddl;

  useEffect(() => { setText(ddl); }, [ddl]);

  return (
    <div className="ddl-panel">
      <div className="panel-toolbar">
        <button
          className="btn small"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? '복사됨' : 'DDL 복사'}
        </button>
        <button
          className="btn small"
          onClick={() => openSqlTab(tab.connectionId, tab.database, tab.schema, text)}
        >
          SQL 편집기로 보내기
        </button>
        <button className="btn small" disabled={!dirty} onClick={() => setText(ddl)}>되돌리기</button>
        <button className="btn small primary" disabled={!dirty} onClick={() => setPreview([text])}>실행</button>
        <div className="spacer" />
        <span className="hint">
          {dirty ? '수정한 DDL 을 그대로 실행합니다. ALTER 문으로 바꿔 쓰는 편이 안전합니다.' : '내용을 고치면 실행할 수 있습니다.'}
        </span>
      </div>
      <div className="ddl-editor">
        <CodeMirror
          value={text}
          height="100%"
          theme="dark"
          extensions={extensions}
          onChange={setText}
          basicSetup={BASIC_SETUP}
        />
      </div>

      {preview && (
        <DdlPreviewDialog
          connectionId={tab.connectionId}
          title={`${tab.schema}.${tab.table} DDL 실행`}
          statements={preview}
          autoCommit={session?.autoCommit ?? true}
          transactionalDdl={session?.kind === 'postgres'}
          onClose={() => setPreview(null)}
          onApplied={onChanged}
        />
      )}
    </div>
  );
}

// ---- 테이블 정보 ----------------------------------------------------------------

/** 섹션 칩 위에 항상 보이는 테이블 요약 정보. */
function TableInfoBar({ tab, info, owner }: { tab: TableTab; info: TableMeta; owner: string | null }) {
  const items: { label: string; value: string }[] = [];
  items.push({ label: '종류', value: info.kind === 'view' ? '뷰' : '테이블' });
  if (owner) items.push({ label: '소유자', value: owner });
  if (info.engine) items.push({ label: '엔진', value: info.engine });
  if (info.rowsEstimate != null) items.push({ label: '행 (추정)', value: info.rowsEstimate.toLocaleString() });
  if (info.sizeBytes) items.push({ label: '크기', value: fmtBytes(info.sizeBytes) });
  if (info.collation) items.push({ label: '정렬 규칙', value: info.collation });
  if (info.createdAt) items.push({ label: '생성', value: fmtDate(info.createdAt) });
  if (info.updatedAt) items.push({ label: '변경', value: fmtDate(info.updatedAt) });

  return (
    <div className="props-info">
      <div className="props-info-title">
        <span className={`icon icon-${info.kind === 'view' ? 'view' : 'table'}`} aria-hidden />
        <b className="mono">{tab.schema}.{tab.table}</b>
        {info.comment && <span className="props-info-comment" title={info.comment}>{info.comment}</span>}
      </div>
      <div className="props-info-items">
        {items.map((it) => (
          <span key={it.label} className="props-info-item">
            <span className="props-info-label">{it.label}</span>
            <span className="mono">{it.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- 권한 -----------------------------------------------------------------------

function PrivilegesTable({ data }: { data: TablePrivileges }) {
  // 계정·범위별로 권한을 한 줄로 모은다.
  const grouped = new Map<string, { grantee: string; scope: TableGrant['scope']; privileges: string[] }>();
  for (const g of data.grants) {
    const key = `${g.grantee}\u0000${g.scope}`;
    const row = grouped.get(key) ?? { grantee: g.grantee, scope: g.scope, privileges: [] };
    row.privileges.push(g.privilege + (g.grantable ? ' *' : ''));
    grouped.set(key, row);
  }
  const rows = [...grouped.values()];

  if (!rows.length && !data.owner) {
    return (
      <div className="pane-message muted">
        권한 정보가 없습니다. 현재 계정이 볼 수 있는 부여 내역이 없거나,
        서버가 권한 표 조회를 허용하지 않는 설정입니다.
      </div>
    );
  }

  return (
    <div>
      <table className="meta-table">
        <thead><tr><th>대상</th><th>범위</th><th>권한</th></tr></thead>
        <tbody>
          {data.owner && (
            <tr>
              <td className="mono strong">{data.owner}</td>
              <td>소유자</td>
              <td className="mono">ALL (테이블 소유자)</td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.grantee}-${r.scope}`}>
              <td className="mono strong">{r.grantee}</td>
              <td>{r.scope === 'table' ? '테이블' : '스키마 전체'}</td>
              <td className="mono">{r.privileges.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint" style={{ padding: '6px 8px' }}>
        * — 다른 계정에 권한을 줄 수 있음 (WITH GRANT OPTION).
        현재 계정이 볼 수 있는 부여 내역만 보입니다.
      </p>
    </div>
  );
}

// ---- 읽기 전용 표 --------------------------------------------------------------

/**
 * 클릭 순서대로 컬럼을 고르는 선택기.
 * 복합 키·인덱스에서는 컬럼 순서가 의미를 가지므로 체크 순서를 그대로 쓴다.
 */
function ColumnPicker({ columns, value, onChange }: {
  columns: string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="col-picker">
      {columns.map((name) => {
        const order = value.indexOf(name);
        return (
          <label key={name} className={`col-pick ${order >= 0 ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={order >= 0}
              onChange={() => onChange(order >= 0 ? value.filter((v) => v !== name) : [...value, name])}
            />
            {order >= 0 && value.length > 1 && <span className="pick-order">{order + 1}</span>}
            <span className="mono">{name}</span>
          </label>
        );
      })}
    </div>
  );
}

/** DDL 미리보기를 띄우는 공통 도우미 — 생성은 메인 프로세스 드라이버가 한다. */
function useDdlPreview(tab: TableTab, onChanged: () => void) {
  const [preview, setPreview] = useState<{ title: string; statements: string[] } | null>(null);
  const session = sessionOf(tab.connectionId, getState());

  const build = async (title: string, kind: 'index' | 'constraint', spec: Record<string, unknown>) => {
    try {
      const statements = await window.api.ddl.build(tab.connectionId, kind, {
        schema: tab.schema, table: tab.table, spec,
      });
      setPreview({ title, statements });
    } catch (e) {
      notify('error', message(e));
    }
  };

  const dialog = preview ? (
    <DdlPreviewDialog
      connectionId={tab.connectionId}
      title={preview.title}
      statements={preview.statements}
      autoCommit={session?.autoCommit ?? true}
      transactionalDdl={session?.kind === 'postgres'}
      onClose={() => setPreview(null)}
      onApplied={onChanged}
    />
  ) : null;

  return { build, dialog };
}

// ---- 키 (기본키·유니크·CHECK 제약) ------------------------------------------------

type KeyForm =
  | { kind: 'PRIMARY KEY'; columns: string[] }
  | { kind: 'UNIQUE'; name: string; columns: string[] }
  | { kind: 'CHECK'; name: string; expression: string };

function KeysPanel({ tab, keys, checks, allKeys, columns, onChanged }: {
  tab: TableTab;
  /** 화면에 보여줄 (찾기로 걸러진) 행 */
  keys: KeyMeta[];
  checks: CheckMeta[];
  /** 걸러지지 않은 전체 키 — 기본키 존재 여부는 이걸로 판단해야 한다 */
  allKeys: KeyMeta[];
  columns: TableColumn[];
  onChanged: () => void;
}) {
  const [form, setForm] = useState<KeyForm | null>(null);
  const { build, dialog } = useDdlPreview(tab, () => { setForm(null); onChanged(); });
  const session = sessionOf(tab.connectionId, getState());
  const editable = tab.objectKind === 'table';
  const hasPk = allKeys.some((k) => k.type === 'PRIMARY KEY');
  const colNames = columns.map((c) => c.name);

  const dropKey = (k: KeyMeta) => {
    // MySQL 계열: 자동 증가 컬럼이 기본키에 있으면 PK 만 지울 수 없다 (에러 1075).
    if (k.type === 'PRIMARY KEY' && session?.kind !== 'postgres') {
      const ai = columns.filter((c) => c.primaryKey && c.autoIncrement).map((c) => c.name);
      if (ai.length) {
        notify('error', `자동 증가 컬럼(${ai.join(', ')})이 기본키에 있어 기본키만 지울 수 없습니다. 컬럼 편집에서 자동 증가를 먼저 제거하세요.`);
        return;
      }
    }
    void build(`${tab.schema}.${tab.table} — ${k.type === 'PRIMARY KEY' ? '기본키' : '유니크'} 삭제`, 'constraint',
      { action: 'drop', kind: k.type, name: k.name });
  };

  const submit = () => {
    if (!form) return;
    if (form.kind === 'PRIMARY KEY') {
      if (!form.columns.length) { notify('info', '컬럼을 골라 주세요.'); return; }
      void build(`${tab.schema}.${tab.table} — 기본키 추가`, 'constraint',
        { action: 'add', kind: 'PRIMARY KEY', columns: form.columns });
    } else if (form.kind === 'UNIQUE') {
      if (!form.name.trim() || !form.columns.length) { notify('info', '이름과 컬럼을 채워 주세요.'); return; }
      void build(`${tab.schema}.${tab.table} — 유니크 제약 추가`, 'constraint',
        { action: 'add', kind: 'UNIQUE', name: form.name.trim(), columns: form.columns });
    } else {
      if (!form.name.trim() || !form.expression.trim()) { notify('info', '이름과 조건식을 채워 주세요.'); return; }
      void build(`${tab.schema}.${tab.table} — CHECK 제약 추가`, 'constraint',
        { action: 'add', kind: 'CHECK', name: form.name.trim(), expression: form.expression.trim() });
    }
  };

  return (
    <div>
      {editable && (
        <div className="panel-toolbar">
          <button
            className="btn small"
            disabled={hasPk}
            title={hasPk ? '기본키가 이미 있습니다' : ''}
            onClick={() => setForm({ kind: 'PRIMARY KEY', columns: [] })}
          >
            + 기본키
          </button>
          <button className="btn small" onClick={() => setForm({ kind: 'UNIQUE', name: `uq_${tab.table}`, columns: [] })}>
            + 유니크
          </button>
          <button className="btn small" onClick={() => setForm({ kind: 'CHECK', name: `ck_${tab.table}`, expression: '' })}>
            + CHECK
          </button>
        </div>
      )}

      {form && (
        <div className="ddl-form">
          <b>{form.kind === 'PRIMARY KEY' ? '기본키 추가' : form.kind === 'UNIQUE' ? '유니크 제약 추가' : 'CHECK 제약 추가'}</b>
          {form.kind !== 'PRIMARY KEY' && (
            <label>이름 <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          )}
          {form.kind === 'CHECK' ? (
            <label>조건식 <input
              className="input wide mono"
              placeholder={"예: status IN ('A', 'B')"}
              value={form.expression}
              onChange={(e) => setForm({ ...form, expression: e.target.value })}
            /></label>
          ) : (
            <ColumnPicker columns={colNames} value={form.columns} onChange={(v) => setForm({ ...form, columns: v })} />
          )}
          <div className="ddl-form-actions">
            <button className="btn small" onClick={() => setForm(null)}>취소</button>
            <button className="btn small primary" onClick={submit}>변경 SQL 보기</button>
          </div>
        </div>
      )}

      {keys.length + checks.length === 0 ? <Empty what="키" /> : (
        <table className="meta-table">
          <thead><tr><th>이름</th><th>종류</th><th>컬럼 / 조건식</th>{editable && <th />}</tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={`k-${k.name}`}>
                <td className="mono strong">{k.name}</td>
                <td>{k.type}</td>
                <td className="mono">{k.columns.join(', ')}</td>
                {editable && (
                  <td className="center">
                    <button className="icon-btn danger" title="삭제" onClick={() => dropKey(k)}>−</button>
                  </td>
                )}
              </tr>
            ))}
            {checks.map((c) => (
              <tr key={`c-${c.name}`}>
                <td className="mono strong">{c.name}</td>
                <td>CHECK</td>
                <td className="mono">{c.expression}</td>
                {editable && (
                  <td className="center">
                    <button
                      className="icon-btn danger"
                      title="삭제"
                      onClick={() => void build(`${tab.schema}.${tab.table} — CHECK 제약 삭제`, 'constraint',
                        { action: 'drop', kind: 'CHECK', name: c.name })}
                    >−</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog}
    </div>
  );
}

// ---- 외래키 -----------------------------------------------------------------------

interface FkForm {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string;
  onUpdate: string;
  onDelete: string;
}

function ForeignKeysPanel({ tab, rows, columns, onChanged }: {
  tab: TableTab;
  rows: ForeignKeyMeta[];
  columns: TableColumn[];
  onChanged: () => void;
}) {
  const [form, setForm] = useState<FkForm | null>(null);
  const { build, dialog } = useDdlPreview(tab, () => { setForm(null); onChanged(); });
  const session = sessionOf(tab.connectionId, getState());
  const editable = tab.objectKind === 'table';
  const pg = session?.kind === 'postgres';
  // InnoDB 는 SET DEFAULT 를 거부하므로 PG 에서만 보여 준다.
  const actions = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', ...(pg ? ['SET DEFAULT'] : [])];

  const submit = () => {
    if (!form) return;
    const refColumns = form.refColumns.split(',').map((v) => v.trim()).filter(Boolean);
    if (!form.name.trim() || !form.columns.length || !form.refTable.trim() || !refColumns.length) {
      notify('info', '이름·컬럼·참조 대상을 채워 주세요.');
      return;
    }
    if (refColumns.length !== form.columns.length) {
      notify('info', '컬럼 수와 참조 컬럼 수가 같아야 합니다.');
      return;
    }
    void build(`${tab.schema}.${tab.table} — 외래키 추가`, 'constraint', {
      action: 'add',
      kind: 'FOREIGN KEY',
      name: form.name.trim(),
      columns: form.columns,
      refSchema: form.refSchema.trim() || tab.schema,
      refTable: form.refTable.trim(),
      refColumns,
      onUpdate: form.onUpdate || null,
      onDelete: form.onDelete || null,
    });
  };

  return (
    <div>
      {editable && (
        <div className="panel-toolbar">
          <button
            className="btn small"
            onClick={() => setForm({
              name: `fk_${tab.table}`, columns: [], refSchema: tab.schema, refTable: '', refColumns: '',
              onUpdate: '', onDelete: '',
            })}
          >
            + 외래키
          </button>
          {pg && <span className="hint">PostgreSQL 은 외래키 컬럼에 인덱스를 자동으로 만들지 않습니다 — 필요하면 인덱스 탭에서 함께 만드세요.</span>}
        </div>
      )}

      {form && (
        <div className="ddl-form">
          <b>외래키 추가</b>
          <label>이름 <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <span className="hint">이 테이블의 컬럼:</span>
          <ColumnPicker columns={columns.map((c) => c.name)} value={form.columns} onChange={(v) => setForm({ ...form, columns: v })} />
          <div className="ddl-form-row">
            <label>참조 스키마 <input className="input" value={form.refSchema} onChange={(e) => setForm({ ...form, refSchema: e.target.value })} /></label>
            <label>참조 테이블 <input className="input" value={form.refTable} onChange={(e) => setForm({ ...form, refTable: e.target.value })} /></label>
            <label>참조 컬럼 <input className="input" placeholder="쉼표로 구분" value={form.refColumns} onChange={(e) => setForm({ ...form, refColumns: e.target.value })} /></label>
          </div>
          <div className="ddl-form-row">
            <label>ON UPDATE
              <select className="select small" value={form.onUpdate} onChange={(e) => setForm({ ...form, onUpdate: e.target.value })}>
                <option value="">(기본)</option>
                {actions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label>ON DELETE
              <select className="select small" value={form.onDelete} onChange={(e) => setForm({ ...form, onDelete: e.target.value })}>
                <option value="">(기본)</option>
                {actions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          </div>
          <div className="ddl-form-actions">
            <button className="btn small" onClick={() => setForm(null)}>취소</button>
            <button className="btn small primary" onClick={submit}>변경 SQL 보기</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? <Empty what="외래키" /> : (
        <table className="meta-table">
          <thead><tr><th>이름</th><th>컬럼</th><th>참조 대상</th><th>ON UPDATE</th><th>ON DELETE</th>{editable && <th />}</tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.name}>
                <td className="mono strong">{f.name}</td>
                <td className="mono">{f.columns.join(', ')}</td>
                <td className="mono">{f.referencedSchema}.{f.referencedTable} ({f.referencedColumns.join(', ')})</td>
                <td>{f.onUpdate ?? ''}</td>
                <td>{f.onDelete ?? ''}</td>
                {editable && (
                  <td className="center">
                    <button
                      className="icon-btn danger"
                      title="삭제"
                      onClick={() => void build(`${tab.schema}.${tab.table} — 외래키 삭제`, 'constraint',
                        { action: 'drop', kind: 'FOREIGN KEY', name: f.name })}
                    >−</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog}
    </div>
  );
}

function ReferencesTable({ rows }: { rows: ReferenceMeta[] }) {
  if (!rows.length) return <Empty what="이 테이블을 참조하는 외래키" />;
  return (
    <table className="meta-table">
      <thead><tr><th>이름</th><th>참조하는 테이블</th><th>컬럼</th><th>대상 컬럼</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.sourceSchema}.${r.sourceTable}.${r.name}`}>
            <td className="mono strong">{r.name}</td>
            <td className="mono">{r.sourceSchema}.{r.sourceTable}</td>
            <td className="mono">{r.columns.join(', ')}</td>
            <td className="mono">{r.referencedColumns.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface IndexForm {
  name: string;
  unique: boolean;
  columns: string[];
  method: string;
}

function IndexesPanel({ tab, rows, keys, foreignKeys, onChanged }: {
  tab: TableTab;
  rows: IndexMeta[];
  keys: KeyMeta[];
  foreignKeys: ForeignKeyMeta[];
  onChanged: () => void;
}) {
  const [form, setForm] = useState<IndexForm | null>(null);
  const [cols, setCols] = useState<string[]>([]);
  const { build, dialog } = useDdlPreview(tab, () => { setForm(null); onChanged(); });
  const session = sessionOf(tab.connectionId, getState());
  const editable = tab.objectKind === 'table';
  const pg = session?.kind === 'postgres';
  // 제약이 소유한 인덱스는 인덱스로 못 지운다 — 키 탭에서 제약을 지워야 한다.
  const ownedByKey = new Set(keys.map((k) => k.name));
  // MySQL 은 FK 가 쓰는 인덱스 삭제를 거부한다(에러 1553). 이름이 겹치는 것만 확실히 알 수 있어
  // 막지는 않고 경고만 한다 — 다른 인덱스가 FK 를 대신 받쳐 주면 삭제가 되기도 한다.
  const fkNames = new Set(foreignKeys.map((f) => f.name));

  // 컬럼 목록은 폼을 열 때 한 번 읽는다 (인덱스 탭은 컬럼 메타가 없어서).
  const openForm = async () => {
    try {
      const list: TableColumn[] = await window.api.meta.get(tab.connectionId, 'columns', {
        schema: tab.schema, table: tab.table,
      });
      setCols(list.map((c) => c.name));
      setForm({ name: `idx_${tab.table}`, unique: false, columns: [], method: 'btree' });
    } catch (e) {
      notify('error', message(e));
    }
  };

  const submit = () => {
    if (!form) return;
    if (!form.name.trim() || !form.columns.length) { notify('info', '이름과 컬럼을 채워 주세요.'); return; }
    void build(`${tab.schema}.${tab.table} — 인덱스 생성`, 'index', {
      action: 'create',
      name: form.name.trim(),
      unique: form.unique,
      columns: form.columns,
      ...(pg ? { method: form.method } : {}),
    });
  };

  return (
    <div>
      {editable && (
        <div className="panel-toolbar">
          <button className="btn small" onClick={() => void openForm()}>+ 인덱스</button>
        </div>
      )}

      {form && (
        <div className="ddl-form">
          <b>인덱스 생성</b>
          <div className="ddl-form-row">
            <label>이름 <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="check small">
              <input type="checkbox" checked={form.unique} onChange={(e) => setForm({ ...form, unique: e.target.checked })} />
              UNIQUE
            </label>
            {pg && (
              <label>방식
                <select className="select small" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                  {['btree', 'hash', 'gin', 'gist', 'brin'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
            )}
          </div>
          <ColumnPicker columns={cols} value={form.columns} onChange={(v) => setForm({ ...form, columns: v })} />
          <div className="ddl-form-actions">
            <button className="btn small" onClick={() => setForm(null)}>취소</button>
            <button className="btn small primary" onClick={submit}>변경 SQL 보기</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? <Empty what="인덱스" /> : (
        <table className="meta-table">
          <thead><tr><th>이름</th><th>고유</th><th>방식</th><th>컬럼</th>{editable && <th />}</tr></thead>
          <tbody>
            {rows.map((i) => {
              const owned = ownedByKey.has(i.name) || i.name === 'PRIMARY';
              return (
                <tr key={i.name}>
                  <td className="mono strong">{i.name}</td>
                  <td>{i.unique ? '✓' : ''}</td>
                  <td>{i.type}</td>
                  <td className="mono">{i.columns.join(', ')}</td>
                  {editable && (
                    <td className="center">
                      <button
                        className="icon-btn danger"
                        title={owned
                          ? '제약이 소유한 인덱스 — 키 탭에서 제약을 삭제하세요'
                          : fkNames.has(i.name)
                            ? '외래키가 쓰는 인덱스라 삭제가 거부될 수 있습니다'
                            : '삭제'}
                        disabled={owned}
                        onClick={() => void build(`${tab.schema}.${tab.table} — 인덱스 삭제`, 'index',
                          { action: 'drop', name: i.name })}
                      >−</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {dialog}
    </div>
  );
}
