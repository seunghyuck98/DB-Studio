'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_ENTRIES = 5000;
const MAX_SQL_LENGTH = 20000;
const FLUSH_DELAY_MS = 1500;

let entries = null;
let seq = 0;
let flushTimer = null;

function filePath() {
  return path.join(app.getPath('userData'), 'query-history.json');
}

function load() {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    entries = Array.isArray(parsed) ? parsed.slice(-MAX_ENTRIES) : [];
  } catch (_) {
    entries = [];
  }
  seq = entries.reduce((max, e) => Math.max(max, e.id || 0), 0);
  return entries;
}

/** 실행마다 디스크에 쓰면 느려지므로 잠시 모았다가 한 번에 저장한다. */
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function flush() {
  if (!entries) return;
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(entries), 'utf8');
  } catch (_) {
    /* 히스토리 저장 실패는 조회를 막지 않는다 */
  }
}

/**
 * 실행한 문장을 기록한다.
 * @param {{connectionId:string, connectionName?:string, kind?:string, database?:string,
 *          schema?:string, sql:string, ms:number, rows?:number|null,
 *          affected?:number|null, ok:boolean, error?:string|null, source?:string}} entry
 */
function record(entry) {
  const list = load();
  seq += 1;
  list.push({
    id: seq,
    at: new Date().toISOString(),
    connectionId: entry.connectionId,
    connectionName: entry.connectionName || null,
    kind: entry.kind || null,
    database: entry.database || null,
    schema: entry.schema || null,
    sql: String(entry.sql || '').slice(0, MAX_SQL_LENGTH),
    ms: entry.ms ?? null,
    rows: entry.rows ?? null,
    affected: entry.affected ?? null,
    ok: entry.ok !== false,
    error: entry.error || null,
    source: entry.source || 'sql',
  });
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  scheduleFlush();
}

/**
 * 최신순으로 조회한다.
 * @param {{search?:string, connectionId?:string, onlyErrors?:boolean, limit?:number, offset?:number}} q
 */
function list(q = {}) {
  const all = load();
  const search = (q.search || '').trim().toLowerCase();
  const filtered = all.filter((e) => {
    if (q.connectionId && e.connectionId !== q.connectionId) return false;
    if (q.onlyErrors && e.ok) return false;
    if (search && !e.sql.toLowerCase().includes(search)) return false;
    return true;
  });
  const limit = q.limit ?? 300;
  const offset = q.offset ?? 0;
  const page = filtered.slice(Math.max(0, filtered.length - offset - limit), filtered.length - offset).reverse();
  return { total: filtered.length, entries: page };
}

function clear() {
  entries = [];
  seq = 0;
  flush();
  return true;
}

module.exports = { record, list, clear, flush };
