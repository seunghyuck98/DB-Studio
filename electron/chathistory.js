'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Claude 대화 히스토리 — 쿼리 히스토리(history.js)와 같은 방식으로 userData 에 JSON 으로 남긴다.
 * 대화 하나가 한 항목이고, 렌더러가 발화·응답이 끝날 때마다 upsert 한다.
 * 자격증명은 대화에 들어올 일이 없지만(스킬이 출력 금지), 접속 맥락은 id·이름만 남긴다.
 */

let app = null;
try {
  ({ app } = require('electron'));
} catch (_) {
  /* Electron 이 아닌 실행 환경 */
}

const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES = 400;
const MAX_TEXT = 200 * 1024;
const MAX_TOOL_INPUT = 2000;
const FLUSH_DELAY_MS = 1500;

let items = null;
let flushTimer = null;

function filePath() {
  if (process.env.DBSTUDIO_WORKSPACE_DIR) return path.join(process.env.DBSTUDIO_WORKSPACE_DIR, 'chat-history.json');
  return app ? path.join(app.getPath('userData'), 'chat-history.json') : null;
}

function load() {
  if (items) return items;
  const file = filePath();
  if (!file) { items = []; return items; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    items = Array.isArray(parsed) ? parsed.filter((c) => c && typeof c.id === 'string') : [];
  } catch (_) {
    items = [];
  }
  return items;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** 임시 파일에 쓰고 바꿔 끼워, 도중에 죽어도 기존 파일이 깨지지 않게 한다. */
function flush() {
  if (!items) return;
  const file = filePath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) {
    /* 히스토리 저장 실패는 대화를 막지 않는다 */
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 렌더러가 보낸 값을 그대로 믿지 않고 저장할 모양으로 다시 만든다. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 100);
  if (!id) return null;
  const list = Array.isArray(raw.messages) ? raw.messages.slice(-MAX_MESSAGES) : [];
  const messages = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const msg = { role, text: str(m.text, MAX_TEXT) };
    if (Array.isArray(m.tools) && m.tools.length) {
      msg.tools = m.tools
        .filter((t) => t && typeof t.name === 'string')
        .slice(0, 100)
        .map((t) => ({ name: str(t.name, 200), input: str(t.input, MAX_TOOL_INPUT) }));
    }
    if (m.error) msg.error = true;
    messages.push(msg);
  }
  if (!messages.length) return null;
  const ctx = raw.context && typeof raw.context === 'object'
    ? { connectionId: str(raw.context.connectionId, 200), database: str(raw.context.database, 200), schema: str(raw.context.schema, 200) }
    : null;
  const now = Date.now();
  const createdAt = Number(raw.createdAt) || now;
  return {
    id,
    title: str(raw.title, 200) || '대화',
    createdAt,
    updatedAt: Math.max(createdAt, Number(raw.updatedAt) || now),
    sessionId: str(raw.sessionId, 200) || null,
    context: ctx,
    messages,
  };
}

/** 같은 id 가 있으면 바꿔 끼우고, 없으면 붙인다. 오래된 것부터 잘라 상한을 지킨다. */
function save(raw) {
  const conv = sanitize(raw);
  if (!conv) return false;
  const list = load();
  const idx = list.findIndex((c) => c.id === conv.id);
  if (idx >= 0) list[idx] = conv;
  else list.push(conv);
  if (list.length > MAX_CONVERSATIONS) {
    list.sort((a, b) => a.updatedAt - b.updatedAt);
    list.splice(0, list.length - MAX_CONVERSATIONS);
  }
  scheduleFlush();
  return true;
}

function summary(c) {
  const firstUser = c.messages.find((m) => m.role === 'user');
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
    preview: (firstUser ? firstUser.text : '').replace(/\s+/g, ' ').trim().slice(0, 200),
    context: c.context,
  };
}

/**
 * 최근 것부터 요약만 돌려준다. 검색은 제목·본문 전체를 본다.
 * @param {{search?:string, limit?:number}} q
 */
function list(q = {}) {
  const search = (q.search || '').trim().toLowerCase();
  const filtered = load().filter((c) => {
    if (!search) return true;
    if (c.title.toLowerCase().includes(search)) return true;
    return c.messages.some((m) => m.text.toLowerCase().includes(search));
  });
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = q.limit ?? 300;
  return { total: filtered.length, entries: filtered.slice(0, limit).map(summary) };
}

function get(id) {
  return load().find((c) => c.id === id) || null;
}

function remove(id) {
  const list = load();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  scheduleFlush();
  return true;
}

function clear() {
  items = [];
  flush();
  return true;
}

module.exports = { save, list, get, remove, clear, flush, sanitize };
