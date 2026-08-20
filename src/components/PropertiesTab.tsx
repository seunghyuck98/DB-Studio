import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import DdlPreviewDialog from './DdlPreviewDialog';
import { getTabScratch, setTabScratch, notify, sessionOf, getState, openSqlTab } from '../state/store';
import { message } from '../state/actions';
import type {
  ColumnChangeSpec, ColumnSpec, ForeignKeyMeta, IndexMeta, KeyMeta,
  ReferenceMeta, TableColumn, TableTab,
} from '../types';

type Section = 'columns' | 'keys' | 'foreignKeys' | 'references' | 'indexes' | 'ddl';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'columns', label: '컬럼' },
  { key: 'keys', label: '키' },
  { key: 'foreignKeys', label: '외래키' },
  { key: 'references', label: '참조' },
  { key: 'indexes', label: '인덱스' },
  { key: 'ddl', label: 'DDL' },
];

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
  foreignKeys: ForeignKeyMeta[];
  references: ReferenceMeta[];
  indexes: IndexMeta[];
  ddl: string;
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
      foreignKeys: data.foreignKeys.filter((f) => rowMatch(q, [f.name, f.columns.join(','), f.referencedSchema, f.referencedTable, f.referencedColumns.join(',')])),
      references: data.references.filter((r) => rowMatch(q, [r.name, r.sourceSchema, r.sourceTable, r.columns.join(','), r.referencedColumns.join(',')])),
      indexes: data.indexes.filter((i) => rowMatch(q, [i.name, i.type, i.columns.join(',')])),
    };
  }, [data, q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const args = { schema: tab.schema, table: tab.table };
    try {
      const [columns, keys, foreignKeys, references, indexes, ddl] = await Promise.all([
        window.api.meta.get(tab.connectionId, 'columns', args),
        window.api.meta.get(tab.connectionId, 'keys', args),
        window.api.meta.get(tab.connectionId, 'foreignKeys', args),
        window.api.meta.get(tab.connectionId, 'references', args),
        window.api.meta.get(tab.connectionId, 'indexes', args),
        window.api.meta.get(tab.connectionId, 'ddl', { ...args, kind: tab.objectKind }),
      ]);
      setData({ columns, keys, foreignKeys, references, indexes, ddl });
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
            <span className="hint">{view[section].length} / {data[section].length}</span>
          )}
          <button className="icon-btn" aria-label="찾기 닫기" onClick={closeFind}>×</button>
        </div>
      )}

      {loading && <div className="pane-message">불러오는 중…</div>}
      {error && <div className="pane-message error">{error}</div>}

      {view && !loading && (
        <div className="props-body">
          {section === 'columns' && <ColumnsPanel tab={tab} rows={view.columns} allRows={data!.columns} onChanged={load} />}
          {section === 'keys' && <KeysTable rows={view.keys} />}
          {section === 'foreignKeys' && <ForeignKeysTable rows={view.foreignKeys} />}
          {section === 'references' && <ReferencesTable rows={view.references} />}
          {section === 'indexes' && <IndexesTable rows={view.indexes} />}
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

// ---- 읽기 전용 표 --------------------------------------------------------------

function KeysTable({ rows }: { rows: KeyMeta[] }) {
  if (!rows.length) return <Empty what="키" />;
  return (
    <table className="meta-table">
      <thead><tr><th>이름</th><th>종류</th><th>컬럼</th></tr></thead>
      <tbody>
        {rows.map((k) => (
          <tr key={k.name}>
            <td className="mono strong">{k.name}</td>
            <td>{k.type}</td>
            <td className="mono">{k.columns.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ForeignKeysTable({ rows }: { rows: ForeignKeyMeta[] }) {
  if (!rows.length) return <Empty what="외래키" />;
  return (
    <table className="meta-table">
      <thead><tr><th>이름</th><th>컬럼</th><th>참조 대상</th><th>ON UPDATE</th><th>ON DELETE</th></tr></thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.name}>
            <td className="mono strong">{f.name}</td>
            <td className="mono">{f.columns.join(', ')}</td>
            <td className="mono">{f.referencedSchema}.{f.referencedTable} ({f.referencedColumns.join(', ')})</td>
            <td>{f.onUpdate ?? ''}</td>
            <td>{f.onDelete ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
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

function IndexesTable({ rows }: { rows: IndexMeta[] }) {
  if (!rows.length) return <Empty what="인덱스" />;
  return (
    <table className="meta-table">
      <thead><tr><th>이름</th><th>고유</th><th>방식</th><th>컬럼</th></tr></thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i.name}>
            <td className="mono strong">{i.name}</td>
            <td>{i.unique ? '✓' : ''}</td>
            <td>{i.type}</td>
            <td className="mono">{i.columns.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
