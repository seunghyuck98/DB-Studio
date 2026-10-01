import { useAppState, connectionOf, sessionOf } from '../state/store';
import { copyText } from '../lib/clipboard';
import type { Tab } from '../types';

/**
 * 현재 열려 있는 객체의 위치를 "접속 > DB > 스키마 > 테이블" 형태로 보여준다.
 * MySQL 처럼 스키마 계층이 없는 DB 에서는 스키마 구간을 생략한다.
 *
 * 각 조각은 **더블클릭하면 그 이름이 복사된다** — 앱 전체가 텍스트 선택을 막아 두어
 * 테이블 이름을 끌어서 복사할 수 없기 때문이다.
 */
export default function Breadcrumb({ tab }: { tab: Tab | null }) {
  const state = useAppState();
  if (!tab) return null;

  // 히스토리·변경 내역·대화 히스토리 탭은 특정 객체에 묶이지 않으므로 제목만 보여준다.
  if (tab.kind === 'history' || tab.kind === 'tx' || tab.kind === 'chatHistory') {
    const icon = tab.kind === 'tx' ? 'tx' : tab.kind === 'chatHistory' ? 'chat' : 'history';
    return (
      <nav className="breadcrumb" aria-label="현재 위치">
        <span
          className="crumb copyable"
          title={`${tab.title} — 더블클릭하면 복사합니다`}
          onDoubleClick={() => void copyText(tab.title, '복사')}
        >
          <span className={`icon icon-${icon}`} aria-hidden />
          <span className="crumb-label">{tab.title}</span>
        </span>
      </nav>
    );
  }

  const conn = connectionOf(tab.connectionId, state);
  const session = sessionOf(tab.connectionId, state);
  const hasSchemaLevel = !!session?.hasSchemaLevel;

  const parts: { label: string; kind: string }[] = [];
  if (conn) parts.push({ label: conn.name, kind: 'connection' });
  if (tab.database) parts.push({ label: tab.database, kind: 'database' });
  if (hasSchemaLevel && tab.schema) parts.push({ label: tab.schema, kind: 'schema' });
  if (tab.kind === 'table') {
    parts.push({ label: tab.table, kind: tab.objectKind });
  } else if (tab.kind === 'schema') {
    // 스키마 목록 탭은 위 조각(…› 스키마)까지가 위치 그 자체라 더 붙일 것이 없다.
    // (MySQL 은 데이터베이스 조각이 곧 스키마다)
  } else {
    parts.push({ label: tab.title, kind: 'sql' });
  }

  return (
    <nav className="breadcrumb" aria-label="현재 위치">
      {parts.map((p, i) => (
        <span key={i} className="crumb">
          {i > 0 && <span className="crumb-sep">›</span>}
          <span
            className="crumb-name copyable"
            title={`${p.label} — 더블클릭하면 복사합니다`}
            onDoubleClick={() => void copyText(p.label, '복사')}
          >
            <span className={`icon icon-${p.kind}`} aria-hidden />
            <span className="crumb-label">{p.label}</span>
          </span>
        </span>
      ))}
    </nav>
  );
}
