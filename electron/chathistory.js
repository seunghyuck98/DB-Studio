'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Claude 대화 히스토리 — 쿼리 히스토리(history.js)와 같은 방식으로 userData 에 JSON 으로 남긴다.
 * 대화 하나가 한 항목이고, 렌더러가 발화·응답이 끝날 때마다 upsert 한다.
 *
 * 사이드바에 **열려 있는 대화**도 여기서 같이 기억한다 (`open` / `openOrder`).
 * SQL 편집기와 마찬가지로, 탭을 직접 닫지 않는 한 앱을 껐다 켜도 그대로 돌아온다.
 *
 * 자격증명은 대화에 들어올 일이 없지만(스킬이 출력 금지), 접속 맥락은 id·이름만 남긴다.
 */

let app = null;
try {
  ({ app } = require('electron'));
} catch (_) {
  /* Electron 이 아닌 실행 환경 */
}

const VERSION = 2;
const MAX_CONVERSATIONS = 500;
const MAX_OPEN = 30;
const MAX_MESSAGES = 400;
const MAX_TEXT = 200 * 1024;
const MAX_TOOL_INPUT = 2000;
const FLUSH_DELAY_MS = 1500;

/** { version, activeId, conversations: [] } */
let store = null;
let flushTimer = null;
let openSeq = 0;

function filePath() {
  if (process.env.DBSTUDIO_WORKSPACE_DIR) return path.join(process.env.DBSTUDIO_WORKSPACE_DIR, 'chat-history.json');
  return app ? path.join(app.getPath('userData'), 'chat-history.json') : null;
}

function empty() {
  return { version: VERSION, activeId: null, conversations: [] };
}

function valid(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && Array.isArray(c.messages);
}

/** 예전 파일은 대화 배열 그대로였다. 그 모양도 읽어 준다. */
function load() {
  if (store) return store;
  const file = filePath();
  if (!file) { store = empty(); return store; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
      store = { version: VERSION, activeId: null, conversations: parsed.filter(valid) };
    } else {
      store = {
        version: VERSION,
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations.filter(valid) : [],
      };
    }
  } catch (_) {
    store = empty();
  }
  openSeq = store.conversations.reduce((max, c) => Math.max(max, Number(c.openOrder) || 0), 0);
  return store;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** 임시 파일에 쓰고 바꿔 끼워, 도중에 죽어도 기존 파일이 깨지지 않게 한다. */
function flush() {
  if (!store) return;
  const file = filePath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) {
    /* 히스토리 저장 실패는 대화를 막지 않는다 */
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 렌더러가 보낸 값을 그대로 믿지 않고 저장할 모양으로 다시 만든다. */
function sanitize(raw, prev) {
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
  // 저장하는 대화는 사이드바에 떠 있는 것이다. 이미 아는 대화면 지금 열림 상태를 그대로 둔다.
  const open = typeof raw.open === 'boolean' ? raw.open : (prev ? prev.open !== false : true);
  return {
    id,
    title: str(raw.title, 200) || '대화',
    createdAt,
    updatedAt: Math.max(createdAt, Number(raw.updatedAt) || now),
    sessionId: str(raw.sessionId, 200) || null,
    context: ctx,
    open,
    openOrder: Number(prev && prev.openOrder) || (open ? (openSeq += 1) : 0),
    messages,
  };
}

/** 같은 id 가 있으면 바꿔 끼우고, 없으면 붙인다. 오래된 것부터 잘라 상한을 지킨다. */
function save(raw) {
  const s = load();
  const idx = s.conversations.findIndex((c) => c.id === (raw && raw.id));
  const conv = sanitize(raw, idx >= 0 ? s.conversations[idx] : null);
  if (!conv) return false;
  if (idx >= 0) s.conversations[idx] = conv;
  else s.conversations.push(conv);
  if (s.conversations.length > MAX_CONVERSATIONS) {
    // 열려 있는 대화는 남기고, 닫힌 것 중 오래된 것부터 버린다.
    const closed = s.conversations.filter((c) => !c.open).sort((a, b) => a.updatedAt - b.updatedAt);
    const drop = new Set(closed.slice(0, s.conversations.length - MAX_CONVERSATIONS).map((c) => c.id));
    s.conversations = s.conversations.filter((c) => !drop.has(c.id));
  }
  scheduleFlush();
  return true;
}

/** 사이드바에서 대화를 열거나 닫을 때. 닫아도 히스토리에는 남는다. */
function setOpen(id, open) {
  const s = load();
  const conv = s.conversations.find((c) => c.id === id);
  if (!conv) return false;
  conv.open = !!open;
  if (open) conv.openOrder = (openSeq += 1);
  if (!open && s.activeId === id) s.activeId = null;
  scheduleFlush();
  return true;
}

function setActive(id) {
  const s = load();
  s.activeId = typeof id === 'string' && id ? id : null;
  scheduleFlush();
  return true;
}

/** 다음 실행 때 사이드바를 되살릴 재료 — 열려 있던 대화 전체와 활성 대화. */
function openTabs() {
  const s = load();
  const conversations = s.conversations
    .filter((c) => c.open)
    .sort((a, b) => (Number(a.openOrder) || 0) - (Number(b.openOrder) || 0))
    .slice(-MAX_OPEN);
  const activeId = conversations.some((c) => c.id === s.activeId) ? s.activeId : null;
  return { activeId, conversations };
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
    open: !!c.open,
  };
}

/**
 * 최근 것부터 요약만 돌려준다. 검색은 제목·본문 전체를 본다.
 * @param {{search?:string, limit?:number}} q
 */
function list(q = {}) {
  const search = (q.search || '').trim().toLowerCase();
  const filtered = load().conversations.filter((c) => {
    if (!search) return true;
    if (c.title.toLowerCase().includes(search)) return true;
    return c.messages.some((m) => m.text.toLowerCase().includes(search));
  });
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = q.limit ?? 300;
  return { total: filtered.length, entries: filtered.slice(0, limit).map(summary) };
}

function get(id) {
  return load().conversations.find((c) => c.id === id) || null;
}

function remove(id) {
  const s = load();
  const idx = s.conversations.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  s.conversations.splice(idx, 1);
  if (s.activeId === id) s.activeId = null;
  scheduleFlush();
  return true;
}

function clear() {
  store = empty();
  openSeq = 0;
  flush();
  return true;
}

module.exports = { save, list, get, remove, clear, flush, sanitize, setOpen, setActive, openTabs };
