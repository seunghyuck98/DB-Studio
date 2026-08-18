import { getState, openTableTab, openSqlTab, notify, clearSearchResult, sessionOf } from '../state/store';
import type { SearchHit, SearchResult } from '../types';

const MATCH_LABEL: Record<SearchHit['matchedIn'], string> = {
  name: '이름',
  column: '컬럼',
  comment: '주석',
  source: '정의',
};

const KIND_ICON: Record<SearchHit['kind'], string> = {
  table: 'table',
  view: 'view',
  column: 'column',
  routine: 'routine',
  trigger: 'trigger',
};

export default function SearchResults({
  connectionId, database, result,
}: { connectionId: string; database: string; result: SearchResult }) {
  const open = (hit: SearchHit) => {
    if (hit.kind === 'routine' || hit.kind === 'trigger') {
      openDefinition(connectionId, database, hit);
      return;
    }
    if (!hit.table) return;
    openTableTab({
      connectionId,
      database,
      schema: hit.schema,
      table: hit.table,
      objectKind: hit.objectKind,
      // 컬럼이 걸렸으면 컬럼 목록을 바로 보여주는 편이 낫다.
      activeSection: hit.matchedIn === 'column' ? 'properties' : 'data',
    });
  };

  if (result.hits.length === 0) {
    return (
      <div className="search-results">
        <ResultHead result={result} />
        <p className="tree-empty">
          <b>{result.term}</b> 와(과) 일치하는 객체가 없습니다.<br />
          검색 범위를 넓혀 보세요.
        </p>
      </div>
    );
  }

  return (
    <div className="search-results">
      <ResultHead result={result} />
      <div className="search-list">
        {result.hits.map((hit, i) => (
          <div
            key={`${hit.kind}-${hit.schema}-${hit.table}-${hit.name}-${hit.matchedIn}-${i}`}
            className="search-item"
            onDoubleClick={() => open(hit)}
            title="더블클릭해서 열기"
          >
            <div className="search-item-head">
              <span className={`icon icon-${KIND_ICON[hit.kind]}`} aria-hidden />
              <span className="search-name">{hit.name}</span>
              <span className={`match-badge m-${hit.matchedIn}`}>{MATCH_LABEL[hit.matchedIn]}</span>
            </div>
            <div className="search-path">
              {hit.schema}
              {hit.table && hit.table !== hit.name ? `.${hit.table}` : ''}
              {hit.detail ? ` · ${hit.detail}` : ''}
            </div>
            {hit.snippet && <div className="search-snippet">{hit.snippet}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultHead({ result }: { result: SearchResult }) {
  return (
    <div className="search-head">
      <span className="hint">
        {result.hits.length.toLocaleString()}건
        {result.truncated && ' (상한 도달)'}
        {result.schemas.length > 1 ? ` · 스키마 ${result.schemas.length}개` : ` · ${result.schemas[0] ?? ''}`}
      </span>
      <div className="spacer" />
      <button className="btn small" onClick={clearSearchResult}>트리로</button>
    </div>
  );
}

/** 프로시저·함수·트리거는 정의를 조회하는 SQL 을 편집기에 띄워 준다. */
function openDefinition(connectionId: string, database: string, hit: SearchHit) {
  const session = sessionOf(connectionId, getState());
  if (!session?.connected) {
    notify('error', '접속이 열려 있지 않습니다.');
    return;
  }
  const isPg = session.kind === 'postgres';
  let sql: string;

  if (hit.kind === 'trigger') {
    sql = isPg
      ? `SELECT pg_get_triggerdef(t.oid)\n  FROM pg_trigger t\n  JOIN pg_class c ON c.oid = t.tgrelid\n  JOIN pg_namespace n ON n.oid = c.relnamespace\n WHERE n.nspname = '${esc(hit.schema)}' AND t.tgname = '${esc(hit.name)}';`
      : `SHOW CREATE TRIGGER \`${hit.schema}\`.\`${hit.name}\`;`;
  } else if (isPg) {
    sql = `SELECT pg_get_functiondef(p.oid)\n  FROM pg_proc p\n  JOIN pg_namespace n ON n.oid = p.pronamespace\n WHERE n.nspname = '${esc(hit.schema)}' AND p.proname = '${esc(hit.name)}';`;
  } else {
    const type = (hit.detail || 'PROCEDURE').toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
    sql = `SHOW CREATE ${type} \`${hit.schema}\`.\`${hit.name}\`;`;
  }

  openSqlTab(connectionId, database, hit.schema, sql);
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}
