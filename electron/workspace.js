'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 열려 있는 SQL 편집기를 다음 실행까지 남긴다.
 *
 * 사용자가 직접 쓴 글이라 히스토리보다 조심스럽게 다룬다.
 *  - 임시 파일에 쓰고 rename 해서, 쓰다 죽어도 반쪽짜리 파일이 남지 않게 한다
 *  - 직전 내용을 .bak 으로 한 세대 남겨, 본 파일이 깨져도 되살릴 수 있게 한다
 *
 * Electron 밖(테스트)에서도 불러올 수 있어야 하므로 electron 은 조건부로 읽는다.
 */
let app = null;
try {
  ({ app } = require('electron'));
} catch (_) {
  /* Electron 이 아닌 실행 환경 */
}

const VERSION = 1;
const MAX_EDITORS = 200;
const MAX_SQL_LENGTH = 2 * 1024 * 1024; // 편집기 하나당 2MB
const EMPTY = { version: VERSION, activeId: null, editors: [] };

/** 테스트에서 저장 위치를 바꿔 쓸 수 있게 환경 변수를 먼저 본다. */
function dir() {
  if (process.env.DBSTUDIO_WORKSPACE_DIR) return process.env.DBSTUDIO_WORKSPACE_DIR;
  return app ? app.getPath('userData') : null;
}

function filePath() {
  const base = dir();
  return base ? path.join(base, 'sql-editors.json') : null;
}

function backupPath() {
  const file = filePath();
  return file ? file.replace(/\.json$/, '.bak.json') : null;
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 렌더러가 보낸 값을 그대로 믿지 않고, 저장할 모양으로 다시 만든다. */
function sanitize(snapshot) {
  const list = Array.isArray(snapshot && snapshot.editors) ? snapshot.editors : [];
  const editors = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = str(raw.id, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ratio = Number(raw.editorRatio);
    editors.push({
      id,
      pane: raw.pane === 1 ? 1 : 0,
      title: str(raw.title, 200) || 'SQL',
      connectionId: str(raw.connectionId, 200),
      database: str(raw.database, 200),
      schema: str(raw.schema, 200),
      sql: str(raw.sql, MAX_SQL_LENGTH),
      editorRatio: ratio >= 15 && ratio <= 85 ? Math.round(ratio) : 45,
    });
    if (editors.length >= MAX_EDITORS) break;
  }
  const activeId = str(snapshot && snapshot.activeId, 200);
  return {
    version: VERSION,
    savedAt: new Date().toISOString(),
    activeId: editors.some((e) => e.id === activeId) ? activeId : null,
    editors,
  };
}

function readFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.editors)) throw new Error('모양이 맞지 않습니다');
  return sanitize(parsed);
}

/** 저장해 둔 편집기를 읽는다. 본 파일이 깨졌으면 .bak 을 시도한다. */
function load() {
  const file = filePath();
  if (!file) return { ...EMPTY };
  for (const candidate of [file, backupPath()]) {
    if (!candidate) continue;
    try {
      return readFile(candidate);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      // 깨진 본 파일은 지우지 않고 남겨 둔다. 사용자가 직접 꺼내 볼 수 있어야 한다.
    }
  }
  return { ...EMPTY };
}

function save(snapshot) {
  const data = sanitize(snapshot);
  const file = filePath();
  if (!file) return data;
  const text = JSON.stringify(data, null, 1);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 직전 내용을 한 세대 남긴다.
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, backupPath()); } catch (_) { /* 백업 실패는 저장을 막지 않는다 */ }
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) {
    /* 저장에 실패해도 편집은 계속돼야 한다 */
  }
  return data;
}

module.exports = { load, save, sanitize, MAX_EDITORS, MAX_SQL_LENGTH };
