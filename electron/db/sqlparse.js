'use strict';

/** 주석과 앞쪽 공백을 걷어낸 문장 앞부분 */
function strippedHead(sql) {
  return String(sql)
    .replace(/^(?:\s|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '')
    .toLowerCase();
}

/**
 * SQL 스크립트를 개별 문장으로 분리한다.
 * 문자열 리터럴, 식별자 인용부호, 라인/블록 주석, PostgreSQL 달러 인용($$ ... $$)을
 * 인식하므로 그 안에 있는 세미콜론이나 빈 줄은 구분자로 취급하지 않는다.
 *
 * @param {string} script
 * @param {{ blankLine?: boolean }} [opts] blankLine 을 켜면 세미콜론 대신 빈 줄로만 나눈다.
 *   (문장 끝의 세미콜론은 문장의 일부로 남는다 — 한 문장을 그대로 보내는 데는 문제가 없다)
 * @returns {{ text: string, start: number, end: number }[]}
 */
function splitStatements(script, opts = {}) {
  const blankLine = !!opts.blankLine;
  const out = [];
  let i = 0;
  let stmtStart = 0;
  const len = script.length;

  const push = (endExclusive) => {
    const raw = script.slice(stmtStart, endExclusive);
    if (!raw.trim()) return;
    // 주석과 공백만 남은 조각은 실행 대상이 아니다.
    // (그대로 보내면 MySQL 은 "Query was empty" 로 실패한다)
    if (!strippedHead(raw)) return;
    out.push({ text: raw.trim(), start: stmtStart, end: endExclusive });
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
    // 문장 구분자 — 빈 줄 모드에서는 세미콜론으로 나누지 않는다.
    // 여러 줄짜리 문장을 세미콜론 없이 쓰고 빈 줄로만 구분하고 싶을 때를 위한 모드라서,
    // 두 구분자를 섞으면 "빈 줄 기준" 이라는 약속이 깨진다.
    if (c === ';' && !blankLine) {
      push(i);
      i++;
      stmtStart = i;
      continue;
    }

    // 빈 줄 구분자 (문자열·주석 안이 아닌 곳에서만 여기까지 온다)
    if (blankLine && c === '\n') {
      let j = i + 1;
      while (j < len && (script[j] === ' ' || script[j] === '\t' || script[j] === '\r')) j++;
      if (j >= len || script[j] === '\n') {
        push(i);
        // 이어지는 빈 줄들을 건너뛰고 다음 문장의 첫 글자에서 시작한다.
        i = j;
        while (i < len && /\s/.test(script[i])) i++;
        stmtStart = i;
        continue;
      }
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
 * @param {{ blankLine?: boolean }} [opts]
 */
function statementAt(script, caret, opts = {}) {
  const stmts = splitStatements(script, opts);
  if (stmts.length === 0) return null;
  for (const s of stmts) {
    if (caret >= s.start && caret <= s.end) return s;
  }
  return stmts[stmts.length - 1];
}

/** 결과셋을 돌려주는 문장인지 대략 판별한다. */
function returnsRows(sql) {
  return /^(select|show|desc|describe|explain|with|table|values|pragma)\b/.test(strippedHead(sql).slice(0, 20));
}

const WRITE_VERBS = /^(insert|update|delete|replace|merge|truncate|create|alter|drop|rename|comment|grant|revoke|call|do|copy|import)\b/;

/** 구조를 바꾸는 문장. MySQL·MariaDB 에서는 롤백이 되지 않는다. */
const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE']);

/**
 * 문장을 종류별로 나눈다.
 * - write : 데이터나 구조를 바꾸는 문장 (커밋 대상)
 * - read  : 조회만 하는 문장
 * - other : SET, USE 처럼 세션 설정을 바꾸는 문장
 * @returns {{ kind: 'read'|'write'|'other', verb: string, ddl: boolean }}
 */
function statementInfo(sql) {
  const head = strippedHead(sql);
  const verb = (/^([a-z]+)/.exec(head) || [, ''])[1].toUpperCase();
  const ddl = DDL_VERBS.has(verb);

  // PostgreSQL 은 WITH ... UPDATE 처럼 CTE 로 시작하는 변경 문장을 허용한다.
  if (/^with\b/.test(head)) {
    return {
      kind: /\b(insert|update|delete|merge)\b/.test(head) ? 'write' : 'read',
      verb: verb || 'WITH',
      ddl: false,
    };
  }
  if (WRITE_VERBS.test(head)) return { kind: 'write', verb, ddl };
  if (returnsRows(sql)) return { kind: 'read', verb, ddl: false };
  return { kind: 'other', verb, ddl };
}

module.exports = { splitStatements, statementAt, returnsRows, statementInfo };
