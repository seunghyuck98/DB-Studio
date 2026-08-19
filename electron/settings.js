'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** 화면에서 바꾼 설정을 다음 실행까지 남긴다. */
const DEFAULTS = {
  /** 빈 줄도 문장 구분자로 볼지 */
  splitOnBlankLine: false,
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
  } catch (_) {
    cache = { ...DEFAULTS };
  }
  return { ...cache };
}

function set(patch) {
  const next = { ...get() };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch && key in patch) next[key] = patch[key];
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
