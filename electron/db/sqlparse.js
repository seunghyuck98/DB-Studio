'use strict';

/**
 * SQL 스크립트를 개별 문장으로 분리한다.
 * 문자열 리터럴, 식별자 인용부호, 라인/블록 주석, PostgreSQL 달러 인용($$ ... $$)을
 * 인식하므로 그 안에 있는 세미콜론은 구분자로 취급하지 않는다.
 *
 * @param {string} script
 * @returns {{ text: string, start: number, end: number }[]}
 */
function splitStatements(script) {
  const out = [];
  let i = 0;
  let stmtStart = 0;
  const len = script.length;

  const push = (endExclusive) => {
    const raw = script.slice(stmtStart, endExclusive);
    if (raw.trim()) out.push({ text: raw.trim(), start: stmtStart, end: endExclusive });
  };

  while (i < len) {
    const c = script[i];
    const next = script[i + 1];

    // 라인 주석
    if ((c === '-' && next === '-') || c === '#') {
      while (i < len && script[i] !== '\n') i++;
      continue;
    }
    // 블록 주석
    if (c === '/' && next === '*') {
      i += 2;
      while (i < len && !(script[i] === '*' && script[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 문자열 / 식별자 인용
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < len) {
        if (script[i] === '\\' && quote !== '`') { i += 2; continue; }
        if (script[i] === quote) {
          if (script[i + 1] === quote) { i += 2; continue; } // 이스케이프된 인용부호
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // PostgreSQL 달러 인용
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(i));
      if (m) {
        const tag = m[0];
        const close = script.indexOf(tag, i + tag.length);
        i = close === -1 ? len : close + tag.length;
        continue;
      }
    }
    // 문장 구분자
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

/**
 * 커서 위치를 포함하는 문장을 찾는다. 없으면 커서 직전의 마지막 문장을 반환한다.
 * @param {string} script
 * @param {number} caret
 */
function statementAt(script, caret) {
  const stmts = splitStatements(script);
  if (stmts.length === 0) return null;
  for (const s of stmts) {
    if (caret >= s.start && caret <= s.end) return s;
  }
  return stmts[stmts.length - 1];
}

/** 결과셋을 돌려주는 문장인지 대략 판별한다. */
function returnsRows(sql) {
  const head = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '').slice(0, 20).toLowerCase();
  return /^(select|show|desc|describe|explain|with|table|values|pragma)\b/.test(head);
}

module.exports = { splitStatements, statementAt, returnsRows };
