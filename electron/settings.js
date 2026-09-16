'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** 화면에서 바꾼 설정을 다음 실행까지 남긴다. */
const DEFAULTS = {
  /** 빈 줄도 문장 구분자로 볼지 */
  splitOnBlankLine: false,
  /** 좌측 트리 영역 너비 (px) */
  sidebarWidth: 280,
  /** 우측 Claude 대화 사이드바 너비 (px) */
  chatWidth: 380,
  /**
   * 토큰 사용량 % 표시의 기준 한도. Anthropic 이 실제 한도를 공개하지 않으므로
   * 사용자가 조절하는 기준값이다 (기본은 넉넉한 어림값).
   */
  usageLimits: { fiveHour: 50_000_000, weekFable: 1_000_000_000, weekAll: 3_000_000_000 },
};

let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function get() {
  if (cache) return { ...cache };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    // 모르는 키는 버리고 기본값과 합쳐 예전 파일과도 맞물리게 한다.
    cache = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (key in parsed) cache[key] = parsed[key];
    }
    // 중첩 기본값 보강 (예전 설정 파일에 usageLimits 일부만 있어도 채운다)
    cache.usageLimits = { ...DEFAULTS.usageLimits, ...(cache.usageLimits || {}) };
  } catch (_) {
    cache = { ...DEFAULTS };
  }
  return { ...cache };
}

function set(patch) {
  const next = { ...get() };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch && key in patch) {
      // usageLimits 같은 중첩 객체는 통째로 덮지 않고 병합한다.
      if (key === 'usageLimits' && patch[key] && typeof patch[key] === 'object') {
        next[key] = { ...DEFAULTS.usageLimits, ...next[key], ...patch[key] };
      } else {
        next[key] = patch[key];
      }
    }
  }
  cache = next;
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (_) {
    /* 저장에 실패해도 이번 실행 동안에는 적용된다 */
  }
  return { ...next };
}

module.exports = { get, set, DEFAULTS };
