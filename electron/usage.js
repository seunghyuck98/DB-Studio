'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Claude 토큰 사용량 집계.
 *
 * Anthropic 은 사용량 조회 API 를 구독 계정에 열어 주지 않으므로,
 * Claude Code 가 로컬에 남기는 대화 기록(~/.claude/projects/** /*.jsonl)의
 * usage 필드를 읽어 합산한다 (ccusage 와 같은 접근).
 * 워크플로·서브에이전트 기록도 같은 형식이라 함께 집계된다.
 *
 * 파일이 크고 계속 자라므로 파일마다 읽은 위치(offset)를 기억해 새 줄만 파싱하고,
 * 결과는 시간(hour) 단위 버킷으로 접어 둔다. 최근 8일보다 오래된 파일은 건너뛴다.
 */

const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 파일별 증분 파싱 상태: path → { size, offset, carry, buckets: Map, seen: Set } */
const fileCache = new Map();

function claudeProjectsDir() {
  return process.env.DBSTUDIO_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');
}

/** 최근에 바뀐 .jsonl 파일을 모두 찾는다 (서브 폴더 포함). */
function listTranscripts() {
  const out = [];
  const cutoff = Date.now() - SCAN_MAX_AGE_MS;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.mtimeMs < cutoff) continue;
      out.push({ path: p, size: st.size });
    }
  };
  walk(claudeProjectsDir(), 0);
  return out;
}

function emptyTotals() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

/** 원본 usage 객체(input_tokens …)를 버킷 합계에 더한다. */
function addUsage(t, u) {
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheCreate += u.cache_creation_input_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
}

/** 이미 접힌 합계(input …) 하나를 다른 합계에 더한다. */
function mergeTotals(t, o) {
  t.input += o.input;
  t.output += o.output;
  t.cacheCreate += o.cacheCreate;
  t.cacheRead += o.cacheRead;
}

/** 파일의 새 부분만 읽어 시간 버킷에 접는다. */
function updateFile(file) {
  let cache = fileCache.get(file.path);
  if (!cache || file.size < cache.size) {
    cache = { size: 0, offset: 0, carry: '', buckets: new Map(), seen: new Set() };
    fileCache.set(file.path, cache);
  }
  if (file.size === cache.size) return cache.buckets;

  let fd;
  try { fd = fs.openSync(file.path, 'r'); } catch (_) { return cache.buckets; }
  try {
    const CHUNK = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = cache.offset;
    let carry = cache.carry;
    while (pos < file.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, file.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) parseLine(line, cache);
    }
    cache.offset = pos;
    cache.size = file.size;
    cache.carry = carry;
  } catch (_) {
    /* 읽다 실패하면 다음 갱신 때 다시 시도한다 */
  } finally {
    fs.closeSync(fd);
  }
  return cache.buckets;
}

function parseLine(line, cache) {
  if (!line.includes('"usage"')) return;
  let d;
  try { d = JSON.parse(line); } catch (_) { return; }
  const msg = d && d.message;
  const u = msg && msg.usage;
  if (!u || typeof u !== 'object') return;
  // 이어지는 세션·요약 등에 같은 메시지가 중복 기록될 수 있어 메시지 id 로 걸러 낸다.
  const key = msg.id ? `${msg.id}:${d.requestId || ''}` : null;
  if (key) {
    if (cache.seen.has(key)) return;
    cache.seen.add(key);
  }
  const ts = Date.parse(d.timestamp || '');
  if (!Number.isFinite(ts)) return;
  const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
  const model = String((msg.model || '')).toLowerCase();
  const bucketKey = `${hour}|${model}`;
  let b = cache.buckets.get(bucketKey);
  if (!b) {
    b = { hour, model, totals: emptyTotals() };
    cache.buckets.set(bucketKey, b);
  }
  addUsage(b.totals, u);
}

function sum(t) {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}

/**
 * 요약: 최근 5시간 / 최근 7일(Fable) / 최근 7일(전체).
 * 시간 버킷 단위라 창 경계는 1시간 오차가 있을 수 있다 — 한도 감시 용도로는 충분하다.
 */
function summary() {
  const now = Date.now();
  const files = listTranscripts();
  const fiveHour = emptyTotals();
  const weekFable = emptyTotals();
  const weekAll = emptyTotals();

  for (const f of files) {
    const buckets = updateFile(f);
    for (const b of buckets.values()) {
      if (now - b.hour > WINDOW_7D_MS) continue;
      mergeTotals(weekAll, b.totals);
      if (b.model.includes('fable')) mergeTotals(weekFable, b.totals);
      if (now - b.hour <= WINDOW_5H_MS) mergeTotals(fiveHour, b.totals);
    }
  }

  // 오래된 파일의 캐시는 버려 메모리를 잡아먹지 않게 한다.
  const live = new Set(files.map((f) => f.path));
  for (const key of fileCache.keys()) {
    if (!live.has(key)) fileCache.delete(key);
  }

  return {
    updatedAt: now,
    files: files.length,
    fiveHour: { ...fiveHour, total: sum(fiveHour) },
    weekFable: { ...weekFable, total: sum(weekFable) },
    weekAll: { ...weekAll, total: sum(weekAll) },
  };
}

module.exports = { summary };
