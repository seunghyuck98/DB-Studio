export interface Statement {
  text: string;
  start: number;
  end: number;
}

/**
 * SQL 스크립트를 개별 문장으로 나눈다.
 * 메인 프로세스의 electron/db/sqlparse.js 와 같은 규칙을 쓰며,
 * 렌더러에서는 "커서 위치의 문장 실행"을 위해 문장 범위가 필요하다.
 */
export function splitStatements(script: string): Statement[] {
  const out: Statement[] = [];
  let i = 0;
  let stmtStart = 0;
  const len = script.length;

  const push = (endExclusive: number) => {
    const raw = script.slice(stmtStart, endExclusive);
    if (raw.trim()) out.push({ text: raw.trim(), start: stmtStart, end: endExclusive });
  };

  while (i < len) {
    const c = script[i];
    const next = script[i + 1];

    if ((c === '-' && next === '-') || c === '#') {
      while (i < len && script[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < len && !(script[i] === '*' && script[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < len) {
        if (script[i] === '\\' && quote !== '`') { i += 2; continue; }
        if (script[i] === quote) {
          if (script[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(i));
      if (m) {
        const tag = m[0];
        const close = script.indexOf(tag, i + tag.length);
        i = close === -1 ? len : close + tag.length;
        continue;
      }
    }
    if (c === ';') {
      push(i);
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
  push(len);
  return out;
}

/** 커서를 포함하는 문장을 찾는다. */
export function statementAt(script: string, caret: number): Statement | null {
  const stmts = splitStatements(script);
  if (!stmts.length) return null;
  for (const s of stmts) if (caret >= s.start && caret <= s.end) return s;
  return stmts[stmts.length - 1];
}
