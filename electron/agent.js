'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * DB Studio 안의 Claude 대화 사이드바를 뒤에서 돌린다.
 *
 * @anthropic-ai/claude-agent-sdk 로 에이전트 루프를 돌리고, 데이터베이스 접근은
 * emr-db MCP 서버로만 하게 한다. SDK 는 ESM 전용이라 동적 import 로 불러온다.
 * 응답은 스트리밍으로 렌더러에 이벤트로 흘려보낸다.
 */

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

/** 스킬 문서를 시스템 프롬프트에 실어 에이전트 행동을 고정한다. */
function skillText() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'skills', 'db-studio', 'SKILL.md'), 'utf8')
      .replace(/^---[\s\S]*?---\n/, ''); // 프런트매터 제거
  } catch (_) {
    return '너는 DB Studio 안의 데이터베이스 전문가다. emr-db MCP 로만 DB 에 접근하고, 쿼리는 실행 계획을 확인해 최적으로 작성하며 쿼리와 실행 계획을 함께 답한다.';
  }
}

/**
 * emr-db MCP 서버 설정을 사용자 MCP 설정 파일에서 읽어 온다.
 * 자격증명은 그 서버(run.sh) 안에 있어 여기서 값을 다루지 않는다.
 */
function emrDbServer() {
  const custom = process.env.DBSTUDIO_MCP_JSON;
  const candidates = [
    custom,
    path.join(os.homedir(), '.genaidews', 'mcp.json'),
    path.join(os.homedir(), '.claude.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const found = findEmrDb(parsed);
      if (found) return found;
    } catch (_) { /* 다음 후보 */ }
  }
  return null;
}

function findEmrDb(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    for (const [name, spec] of Object.entries(obj.mcpServers)) {
      if (/emr[-_]?db|db[-_]?emr/i.test(name) && spec && spec.command) {
        return { command: spec.command, args: spec.args || [], env: spec.env };
      }
    }
  }
  for (const v of Object.values(obj)) {
    const r = findEmrDb(v);
    if (r) return r;
  }
  return null;
}

/** SDK 가 실행할 claude 실행 파일 경로를 찾는다 (Node 18+ 필요). */
function claudeExecutable() {
  if (process.env.DBSTUDIO_CLAUDE_BIN) return process.env.DBSTUDIO_CLAUDE_BIN;
  const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvm)
      .filter((v) => parseInt(String(v).replace(/^v/, ''), 10) >= 18)
      .sort((a, b) => parseInt(b.replace(/^v/, ''), 10) - parseInt(a.replace(/^v/, ''), 10));
    for (const v of versions) {
      const p = path.join(nvm, v, 'bin', 'claude');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* nvm 이 없으면 PATH 에 맡긴다 */ }
  return 'claude';
}

/**
 * MCP 로 나가는 SQL 이 순수 조회인지 검사한다.
 * 여러 문장·주석을 걷어내고 첫 키워드가 조회 계열인지 본다. 하나라도 쓰기면 막는다.
 */
function isReadOnlySql(sql) {
  if (typeof sql !== 'string') return false;
  // 라인·블록 주석 제거
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  if (!clean) return false;
  // 세미콜론으로 나눈 각 문장이 모두 조회여야 한다 (문장 삽입 공격 차단)
  const parts = clean.split(';').map((p) => p.trim()).filter(Boolean);
  const READ = /^(select|with|explain|show|describe|desc|analyze\s+select|table|values)\b/i;
  const WRITE = /\b(insert|update|delete|merge|replace|truncate|create|alter|drop|rename|grant|revoke|call|do|set|copy|vacuum|reindex|comment|lock|begin|start|commit|rollback|savepoint|prepare|execute)\b/i;
  for (const part of parts) {
    if (!READ.test(part)) return false;
    // EXPLAIN 뒤에 쓰기가 오면(EXPLAIN UPDATE …) 막는다.
    const afterExplain = part.replace(/^explain(\s+analyze)?(\s+\([^)]*\))?/i, '').trim();
    if (WRITE.test(afterExplain) && !/^select|^with|^show|^table|^values/i.test(afterExplain)) return false;
  }
  return true;
}

/** 진행 중인 대화들: id → { abort, sessionId } */
const runs = new Map();

/** 상태 확인용 — 사이드바가 뜰 때 준비 여부를 보여 준다. */
function status() {
  return {
    hasEmrDb: !!emrDbServer(),
    claudeBin: claudeExecutable(),
  };
}

/**
 * 한 번의 사용자 발화를 처리하며, 스트리밍 이벤트를 onEvent 로 흘려보낸다.
 * @param {{ runId:string, prompt:string, resume?:string, apiKey?:string }} req
 * @param {(event:object)=>void} onEvent
 */
async function ask(req, onEvent) {
  const { runId, prompt, resume } = req;
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (e) {
    onEvent({ type: 'error', message: `Claude SDK 를 불러오지 못했습니다: ${e.message}` });
    onEvent({ type: 'done' });
    return;
  }

  const emr = emrDbServer();
  const mcpServers = {};
  if (emr) mcpServers['emr-db'] = { type: 'stdio', command: emr.command, args: emr.args, env: emr.env };

  // 구독 로그인이 있으면 API 키가 없어도 된다. 키가 오면 그걸 우선 쓴다.
  const env = { ...process.env };
  if (req.apiKey) env.ANTHROPIC_API_KEY = req.apiKey;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'db-studio/1.0';

  const controller = new AbortController();
  runs.set(runId, { abort: () => controller.abort(), sessionId: resume });

  try {
    const q = sdk.query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
        executable: 'node',
        abortController: controller,
        // 조회 도구는 자동 허용하되, DB 를 바꾸는 SQL 은 canUseTool 에서 막는다.
        permissionMode: 'default',
        canUseTool: async (toolName, input) => {
          if (toolName === 'mcp__emr-db__mysql_query') {
            const sql = input && (input.sql || input.query || input.q);
            if (isReadOnlySql(sql)) return { behavior: 'allow', updatedInput: input };
            return {
              behavior: 'deny',
              message: '이 도구는 조회(SELECT/EXPLAIN)만 실행할 수 있습니다. 데이터를 바꾸는 SQL 은 실행하지 말고, 사용자에게 SQL 을 제안만 하세요.',
            };
          }
          // 그 밖의 (파일·셸 등) 도구는 이 사이드바에서 쓰지 않는다.
          return { behavior: 'allow', updatedInput: input };
        },
        mcpServers,
        // mysql_query 는 일부러 자동 허용 목록에 넣지 않는다 —
        // 넣으면 canUseTool 보다 먼저 통과돼 쓰기 SQL 가드가 무력화된다.
        // 여기 없는 도구는 canUseTool 로 흘러가 SQL 을 검사받는다.
        allowedTools: ['TodoWrite'],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
        settingSources: [], // 사용자 개인 설정·프로젝트 파일을 끌어오지 않는다
        appendSystemPrompt: skillText(),
        includePartialMessages: true,
        maxTurns: 40,
        env,
      },
    });

    for await (const msg of q) {
      if (controller.signal.aborted) break;
      relay(msg, onEvent);
    }
  } catch (e) {
    if (!controller.signal.aborted) onEvent({ type: 'error', message: e.message });
  } finally {
    runs.delete(runId);
    onEvent({ type: 'done' });
  }
}

/** SDK 메시지를 사이드바가 쓰기 쉬운 이벤트로 바꾼다. */
function relay(msg, onEvent) {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') onEvent({ type: 'session', sessionId: msg.session_id });
      break;
    case 'stream_event': {
      // 부분 응답 — 텍스트 델타만 흘려보낸다.
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        onEvent({ type: 'delta', text: ev.delta.text });
      }
      break;
    }
    case 'assistant': {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_use') {
          onEvent({ type: 'tool', name: block.name, input: summarizeToolInput(block.input) });
        }
      }
      break;
    }
    case 'result':
      onEvent({
        type: 'result',
        text: msg.subtype === 'success' ? (msg.result ?? '') : '',
        isError: msg.subtype !== 'success',
        subtype: msg.subtype,
        usage: msg.usage ?? null,
      });
      break;
    default:
      break;
  }
}

/** 도구 입력에서 SQL 한 줄만 뽑아 사이드바에 보여 준다 (너무 길면 자른다). */
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const sql = input.sql || input.query || input.q;
  if (typeof sql === 'string') return sql.replace(/\s+/g, ' ').trim().slice(0, 200);
  return '';
}

function stop(runId) {
  const run = runs.get(runId);
  if (run) run.abort();
  return true;
}

module.exports = { ask, stop, status };
