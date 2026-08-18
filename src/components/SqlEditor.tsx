import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import { EditorView, keymap } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import ResultGrid from './ResultGrid';
import PlanView from './PlanView';
import { getTabScratch, setTabScratch, setSession, notify, sessionOf, getState } from '../state/store';
import { message } from '../state/actions';
import { statementAt } from '../lib/sqlparse';
import type { ExplainResult, SqlTab, StatementResult } from '../types';

export default function SqlEditor({ tab }: { tab: SqlTab }) {
  const [text, setText] = useState<string>(() => getTabScratch(tab.id, 'sql', ''));
  const [results, setResults] = useState<StatementResult[]>(() => getTabScratch(tab.id, 'results', [] as StatementResult[]));
  const [plan, setPlan] = useState<ExplainResult | null>(() => getTabScratch(tab.id, 'plan', null));
  const [activeResult, setActiveResult] = useState(0);
  const [running, setRunning] = useState(false);
  const [analyze, setAnalyze] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const runRef = useRef<(whole: boolean) => void>(() => {});
  const explainRef = useRef<() => void>(() => {});

  useEffect(() => { setTabScratch(tab.id, 'sql', text); }, [tab.id, text]);
  useEffect(() => { setTabScratch(tab.id, 'results', results); }, [tab.id, results]);
  useEffect(() => { setTabScratch(tab.id, 'plan', plan); }, [tab.id, plan]);

  const session = sessionOf(tab.connectionId, getState());
  const dialect = session?.kind === 'postgres' ? PostgreSQL : MySQL;

  /** 실행 대상 SQL: 선택 영역 > 커서 위치 문장 > 전체 스크립트 */
  const targetSql = useCallback((whole: boolean): string => {
    const view = viewRef.current;
    const doc = view ? view.state.doc.toString() : text;
    if (whole || !view) return doc;
    const sel = view.state.selection.main;
    if (!sel.empty) return doc.slice(sel.from, sel.to);
    return statementAt(doc, sel.head)?.text ?? '';
  }, [text]);

  const run = useCallback(async (whole: boolean) => {
    const toRun = targetSql(whole);
    if (!toRun.trim()) return;

    setRunning(true);
    try {
      const res = await window.api.sql.execute(tab.connectionId, toRun, { maxRows: 5000, stopOnError: true });
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
  }, [tab.connectionId, targetSql]);

  const explain = useCallback(async () => {
    const toRun = targetSql(false);
    if (!toRun.trim()) return;
    setRunning(true);
    try {
      const res = await window.api.sql.explain(tab.connectionId, toRun, { analyze });
      setPlan(res);
      setResults([]);
      setSession(tab.connectionId, res.status);
    } catch (e) {
      notify('error', `실행 계획 실패: ${message(e)}`);
    } finally {
      setRunning(false);
    }
  }, [tab.connectionId, targetSql, analyze]);

  runRef.current = (whole: boolean) => { void run(whole); };
  explainRef.current = () => { void explain(); };

  // 메뉴의 '실행 계획' 명령 처리
  useEffect(() => {
    const handler = () => { if (getState().activeTabId === tab.id) explainRef.current(); };
    window.addEventListener('dbstudio:explain', handler);
    return () => window.removeEventListener('dbstudio:explain', handler);
  }, [tab.id]);

  // 단축키는 CodeMirror 기본 키맵보다 우선하도록 최상위 우선순위로 등록한다.
  const extensions = useMemo<Extension[]>(() => [
    sql({ dialect, upperCaseKeywords: true }),
    EditorView.lineWrapping,
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', preventDefault: true, run: () => { runRef.current(false); return true; } },
      { key: 'Mod-Shift-Enter', preventDefault: true, run: () => { runRef.current(true); return true; } },
      { key: 'Mod-Shift-e', preventDefault: true, run: () => { explainRef.current(); return true; } },
    ])),
  ], [dialect]);

  const current = results[activeResult];

  return (
    <div className="sql-editor">
      <div className="sql-toolbar">
        <button className="btn small primary" disabled={running} onClick={() => void run(false)} title="⌘/Ctrl + Enter">
          ▶ 실행
        </button>
        <button className="btn small" disabled={running} onClick={() => void run(true)} title="⌘/Ctrl + ⇧ + Enter">
          ▶▶ 스크립트 실행
        </button>
        <button className="btn small" disabled={running} onClick={() => void explain()} title="⌘/Ctrl + ⇧ + E">
          실행 계획
        </button>
        <label className="check small" title="켜면 쿼리를 실제로 실행해 실측값을 보여줍니다">
          <input type="checkbox" checked={analyze} onChange={(e) => setAnalyze(e.target.checked)} />
          ANALYZE
        </label>
        <button className="btn small" onClick={() => { setResults([]); setPlan(null); setActiveResult(0); }} disabled={!results.length && !plan}>
          결과 지우기
        </button>
        <div className="spacer" />
        <span className="hint">{tab.database}{session?.hasSchemaLevel && tab.schema ? ` · ${tab.schema}` : ''}</span>
      </div>

      <div className="sql-body">
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

      <div className="sql-results">
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
