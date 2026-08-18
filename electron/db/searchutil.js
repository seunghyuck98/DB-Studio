'use strict';

/** LIKE 패턴에서 특수문자로 취급되는 글자를 그대로 찾도록 이스케이프한다. */
function likePattern(term) {
  return '%' + String(term).replace(/[\\%_]/g, '\\$&') + '%';
}

/**
 * 정의 본문에서 검색어 주변만 잘라 보여준다.
 * @param {string} text 원본 스크립트
 * @param {string} term 검색어
 * @param {number} pad  앞뒤로 남길 글자 수
 */
function snippet(text, term, pad = 60) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(String(term).toLowerCase());
  if (at < 0) return flat.slice(0, pad * 2) + (flat.length > pad * 2 ? '…' : '');
  const from = Math.max(0, at - pad);
  const to = Math.min(flat.length, at + term.length + pad);
  return (from > 0 ? '…' : '') + flat.slice(from, to) + (to < flat.length ? '…' : '');
}

module.exports = { likePattern, snippet };
