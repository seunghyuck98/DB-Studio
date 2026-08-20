import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import { EditorView, keymap } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import ResultGrid from './ResultGrid';
import PlanView from './PlanView';
import {
  getTabScratch, setTabScratch, setSession, notify, sessionOf, connectionOf, getState, useAppState, activeTab,
  openTableTab,
} from '../state/store';
import { setSplitOnBlankLine, message, connect } from '../state/actions';
import { scheduleWorkspaceSave } from '../state/workspace';
import { statementAt } from '../lib/sqlparse';
import { tableLink, type LinkPart } from '../lib/tablelink';
import type { ExplainResult, SqlTab, StatementResult } from '../types';

export default function SqlEditor({ tab }: { tab: SqlTab }) {
  const state = useAppState();
  const { splitOnBlankLine } = state;
  const [text, setText] = useState<string>(() => getTabScratch(tab.id, 'sql', ''));
  const [results, setResults] = useState<StatementResult[]>(() => getTabScratch(tab.id, 'results', [] as StatementResult[]));
  const [plan, setPlan] = useState<ExplainResult | null>(() => getTabScratch(tab.id, 'plan', null));
  const [activeResult, setActiveResult] = useState(0);
  const [running, setRunning] = useState(false);
  const [analyze, setAnalyze] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const runRef = useRef<(whole: boolean) => void>(() => {});
  const explainRef = useRef<() => void>(() => {});
  const linkRef = useRef<(parts: LinkPart[]) => void>(() => {});

  // 편집기와 결과의 높이 비율 (탭마다 기억한다)
  const rootRef = useRef<HTMLDivElement>(null);
  const [editorRatio, setEditorRatio] = useState<number>(() => getTabScratch(tab.id, 'editorRatio', 45));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    setTabScratch(tab.id, 'editorRatio', editorRatio);
    scheduleWorkspaceSave();
  }, [tab.id, editorRatio]);

  const startDrag = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) => {
      const ratio = ((ev.clientY - box.top) / box.height) * 100;
      setEditorRatio(Math.min(85, Math.max(15, ratio)));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  // 본문은 파일에도 남긴다 (앱을 다시 켜면 그대로 이어서 쓸 수 있게).
  useEffect(() => {
    setTabScratch(tab.id, 'sql', text);
    scheduleWorkspaceSave();
  }, [tab.id, text]);
  useEffect(() => { setTabScratch(tab.id, 'results', results); }, [tab.id, results]);
  useEffect(() => { setTabScratch(tab.id, 'plan', plan); }, [tab.id, plan]);

  const session = sessionOf(tab.connectionId, state);
  const conn = connectionOf(tab.connectionId, state);
  const offline = !session?.connected;
  const dialect = session?.kind === 'postgres' ? PostgreSQL : MySQL;

  /** 실행 대상 SQL: 선택 영역 > 커서 위치 문장 > 전체 스크립트 */
  const targetSql = useCallback((whole: boolean): string => {
    const view = viewRef.current;
    const doc = view ? view.state.doc.toString() : text;
    if (whole || !view) return doc;
    const sel = view.state.selection.main;
    if (!sel.empty) return doc.slice(sel.from, sel.to);
    return statementAt(doc, sel.head, { blankLine: splitOnBlankLine })?.text ?? '';
  }, [text, splitOnBlankLine]);

  const run = useCallback(async (whole: boolean) => {
    const toRun = targetSql(whole);
    if (!toRun.trim()) return;

    setRunning(true);
    try {
      const res = await window.api.sql.execute(tab.connectionId, toRun, {
        maxRows: 5000, stopOnError: true, splitOnBlankLine,
      });
      setResults(res.results);
      setPlan(null);
      setActiveResult(0);
      setSession(tab.connectionId, res.status);
      const failed = res.results.find((r) => !r.ok);
      if (failed) notify('error', failed.error ?? '실행 중 오류가 발생했습니다.');
    } catch (e) {
      notify('error', message(e));
    } finally {
      setRunning(false);
    }
  }, [tab.connectionId, targetSql, splitOnBlankLine]);

  const explain = useCallback(async () => {
    const toRun = targetSql(false);
    if (!toRun.trim()) return;
    setRunning(true);
    try {
      const res = await window.api.sql.explain(tab.connectionId, toRun, { analyze, splitOnBlankLine });
      setPlan(res);
      setResults([]);
      setSession(tab.connectionId, res.status);
    } catch (e) {
      notify('error', `실행 계획 실패: ${message(e)}`);
    } finally {
      setRunning(false);
    }
  }, [tab.connectionId, targetSql, analyze, splitOnBlankLine]);

  /**
   * ⌘/Ctrl + 클릭한 `스키마.테이블` 을 연다.
   * PostgreSQL 은 따옴표 없는 식별자를 소문자로 접으므로 여기서도 그렇게 맞추고,
   * 실제로 있는 테이블인지 메타데이터로 확인한 뒤 연다 — 아무 단어나 눌러
   * 깨진 탭이 열리는 것보다 안내가 낫다.
   */
  const openLinkedTable = useCallback(async (parts: LinkPart[]) => {
    const s2 = getState();
    const ses = sessionOf(tab.connectionId, s2);
    if (!ses?.connected) {
      notify('info', '접속이 열려 있지 않아 테이블을 열 수 없습니다.');
      return;
    }
    const pg = !!ses.hasSchemaLevel;
    const name = (p: LinkPart) => (pg && !p.quoted ? p.name.toLowerCase() : p.name);

    let database: string;
    let schema: string;
    let table: string;
    if (pg) {
      // 스키마.테이블 (셋이면 앞은 데이터베이스 — 같은 접속 안에서만 연다)
      const tail = parts.slice(-3);
      if (tail.length === 3) [database, schema, table] = [name(tail[0]), name(tail[1]), name(tail[2])];
      else if (tail.length === 2) [database, schema, table] = [tab.database || ses.currentDatabase || '', name(tail[0]), name(tail[1])];
      else [database, schema, table] = [tab.database || ses.currentDatabase || '', tab.schema || ses.currentSchema || '', name(tail[0])];
    } else {
      // MySQL 은 데이터베이스가 곧 스키마다: 디비.테이블
      const tail = parts.slice(-2);
      if (tail.length === 2) { database = name(tail[0]); schema = database; table = name(tail[1]); }
      else { database = tab.database || ses.currentDatabase || ''; schema = database; table = name(tail[0]); }
    }
    if (!schema || !table) return;

    try {
      const tables: { name: string; kind: string }[] = await window.api.meta.get(tab.connectionId, 'tables', { schema });
      const found = tables.find((t) => t.name === table)
        ?? tables.find((t) => t.name.toLowerCase() === table.toLowerCase());
      if (!found) {
        notify('info', `${schema}.${table} — 테이블을 찾을 수 없습니다.`);
        return;
      }
      openTableTab({
        connectionId: tab.connectionId,
        database,
        schema,
        table: found.name,
        objectKind: found.kind === 'view' ? 'view' : 'table',
      });
    } catch (e) {
      notify('error', message(e));
    }
  }, [tab.connectionId, tab.database, tab.schema]);

  runRef.current = (whole: boolean) => { void run(whole); };
  explainRef.current = () => { void explain(); };
  linkRef.current = (parts: LinkPart[]) => { void openLinkedTable(parts); };

  // 메뉴의 '실행 계획' 명령 처리
  useEffect(() => {
    const handler = () => { if (activeTab(getState())?.id === tab.id) explainRef.current(); };
    window.addEventListener('dbstudio:explain', handler);
    return () => window.removeEventListener('dbstudio:explain', handler);
  }, [tab.id]);

  // 단축키는 CodeMirror 기본 키맵보다 우선하도록 최상위 우선순위로 등록한다.
  const extensions = useMemo<Extension[]>(() => [
    sql({ dialect, upperCaseKeywords: true }),
    EditorView.lineWrapping,
    tableLink((parts) => linkRef.current(parts)),
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', preventDefault: true, run: () => { runRef.current(false); return true; } },
      { key: 'Mod-Shift-Enter', preventDefault: true, run: () => { runRef.current(true); return true; } },
      { key: 'Mod-Shift-e', preventDefault: true, run: () => { explainRef.current(); return true; } },
    ])),
  ], [dialect]);

  const current = results[activeResult];

  return (
    <div className="sql-editor" ref={rootRef}>
      <div className="sql-toolbar">
        <button className="btn small primary" disabled={running || offline} onClick={() => void run(false)} title="⌘/Ctrl + Enter">
          ▶ 실행
        </button>
        <button className="btn small" disabled={running || offline} onClick={() => void run(true)} title="⌘/Ctrl + ⇧ + Enter">
          ▶▶ 스크립트 실행
        </button>
        <button className="btn small" disabled={running || offline} onClick={() => void explain()} title="⌘/Ctrl + ⇧ + E">
          실행 계획
        </button>
        <label className="check small" title="켜면 쿼리를 실제로 실행해 실측값을 보여줍니다">
          <input type="checkbox" checked={analyze} onChange={(e) => setAnalyze(e.target.checked)} />
          ANALYZE
        </label>
        <button className="btn small" onClick={() => { setResults([]); setPlan(null); setActiveResult(0); }} disabled={!results.length && !plan}>
          결과 지우기
        </button>
        <div className="toolbar-sep" />
        <span className="toolbar-label">구분</span>
        <select
          className="select small"
          value={splitOnBlankLine ? 'blank' : 'semicolon'}
          onChange={(e) => void setSplitOnBlankLine(e.target.value === 'blank')}
          title="여러 문장을 무엇으로 나눌지. 빈 줄: 세미콜론 대신 빈 줄로만 나눈다"
        >
          <option value="semicolon">세미콜론</option>
          <option value="blank">빈 줄</option>
        </select>
        <div className="spacer" />
        <span className="hint">{tab.database}{session?.hasSchemaLevel && tab.schema ? ` · ${tab.schema}` : ''}</span>
      </div>

      {offline && (
        <div className="sql-offline">
          {conn ? (
            <>
              <b>{conn.name}</b> 에 접속되어 있지 않습니다. 작성한 내용은 그대로 남아 있습니다.
              <button className="btn small" onClick={() => void connect(conn)}>접속</button>
            </>
          ) : (
            <>이 편집기가 쓰던 접속을 찾을 수 없습니다. 작성한 내용은 그대로 남아 있습니다.</>
          )}
        </div>
      )}

      <div className="sql-body" style={{ flexBasis: `${editorRatio}%` }}>
        <CodeMirror
          value={text}
          height="100%"
          theme="dark"
          extensions={extensions}
          onChange={setText}
          onCreateEditor={(view) => { viewRef.current = view; }}
          basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }}
        />
      </div>

      <div
        className={`sql-splitter ${dragging ? 'dragging' : ''}`}
        title="끌어서 편집기 높이 조절"
        onMouseDown={startDrag}
      />

      <div className="sql-results" style={{ flexBasis: `${100 - editorRatio}%` }}>
        {results.length > 1 && (
          <div className="result-tabs">
            {results.map((r, i) => (
              <button
                key={i}
                className={`chip ${i === activeResult ? 'active' : ''} ${r.ok ? '' : 'error'}`}
                onClick={() => setActiveResult(i)}
                title={r.sql}
              >
                결과 {i + 1}
              </button>
            ))}
          </div>
        )}
        {plan && <PlanView plan={plan} />}
        {!plan && !current && (
          <div className="pane-message muted">SQL 을 입력하고 ⌘/Ctrl + Enter 로 실행하세요.</div>
        )}
        {current && !current.ok && (
          <div className="pane-message error">
            <div className="err-title">실행 오류</div>
            <pre className="code-block">{current.error}</pre>
            <pre className="code-block dim">{current.sql}</pre>
          </div>
        )}
        {current && current.ok && current.columns.length > 0 && (
          <ResultGrid result={current} exportSource={{ connectionId: tab.connectionId, name: tab.title }} />
        )}
        {current && current.ok && current.columns.length === 0 && (
          <div className="pane-message">
            {current.affectedRows ?? 0}개 행이 변경되었습니다. ({current.elapsed}ms)
            {!session?.autoCommit && <span className="hint"> · 확정하려면 커밋하세요.</span>}
          </div>
        )}
      </div>
    </div>
  );
}
