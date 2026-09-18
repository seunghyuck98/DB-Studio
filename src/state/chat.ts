import { useSyncExternalStore } from 'react';
import {
  getState, setState, notify, activeConnectionId, activeTab, sessionOf, connectionOf, openSqlTab,
  sqlTabs, paneActiveId, setActiveTab, getTabScratch, setTabScratch,
} from './store';
import { scheduleWorkspaceSave } from './workspace';
import { qualifySql } from '../lib/sqlqualify';
import type { AgentEvent, SavedConversation } from '../types';

/** 히스토리 탭이 듣는 이벤트 — 저장된 대화가 바뀌었으니 목록을 다시 읽으라는 신호 */
export const CHAT_HISTORY_CHANGED_EVENT = 'dbstudio:chat-history-changed';

/**
 * Claude 대화 상태. 사이드바 컴포넌트 밖(모듈)에 두는 이유:
 * - 사이드바를 닫았다 열어도 대화가 남아야 하고,
 * - 스트리밍 중에 사이드바를 닫아도 응답은 끝까지 받아 둬야 하며,
 * - SQL 편집기(우클릭 → AI 질문)처럼 사이드바 밖에서도 새 대화를 열어야 하기 때문이다.
 */

export interface ToolCall { name: string; input: string }

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolCall[];
  error?: boolean;
}

/** 대화가 어느 접속·스키마 맥락에서 시작됐는지 — '즉시 적용' 의 대체 대상 */
export interface SqlContext {
  connectionId: string;
  database: string;
  schema: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** 에이전트 세션 id. 두 번째 발화부터 이걸로 이어 가야 이전 턴을 기억한다 */
  sessionId?: string;
  running: boolean;
  runId: string | null;
  mcpDown: boolean;
  context?: SqlContext;
  createdAt: number;
  updatedAt: number;
}

export interface AgentInfo {
  hasEmrDb: boolean;
  emrSource: string | null;
  emrComplete: boolean;
}

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  agent: AgentInfo | null;
}

let state: ChatState = { conversations: [], activeId: null, agent: null };
const listeners = new Set<() => void>();
/** 진행 중인 스트림의 IPC 구독 해제 함수 (대화 id → disposer) */
const disposers = new Map<string, () => void>();
let convSeq = 0;
let runSeq = 0;

function emit(next: ChatState): void {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getChatState(): ChatState {
  return state;
}

export function useChatState(): ChatState {
  return useSyncExternalStore(subscribe, getChatState, getChatState);
}

export function activeConversation(s: ChatState = state): Conversation | null {
  return s.conversations.find((c) => c.id === s.activeId) ?? null;
}

function patchConversation(id: string, fn: (c: Conversation) => Conversation): void {
  if (!state.conversations.some((c) => c.id === id)) return;
  emit({ ...state, conversations: state.conversations.map((c) => (c.id === id ? fn(c) : c)) });
}

/** 마지막(어시스턴트) 메시지에 스트리밍 내용을 이어 붙인다. */
function patchLastMessage(id: string, fn: (m: ChatMessage) => ChatMessage): void {
  patchConversation(id, (c) => ({
    ...c,
    messages: c.messages.map((m, i) => (i === c.messages.length - 1 ? fn(m) : m)),
  }));
}

/** 발화 앞머리를 탭 제목으로 쓴다. */
function titleFrom(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length > 22 ? `${line.slice(0, 22)}…` : line || '새 대화';
}

/** 에이전트 준비 상태를 한 번 읽어 둔다 (자격증명 값은 오지 않는다). */
export async function loadAgentInfo(): Promise<void> {
  if (state.agent || !window.api?.agent) return;
  try {
    const s = await window.api.agent.status();
    emit({ ...state, agent: { hasEmrDb: s.hasEmrDb, emrSource: s.emrSource, emrComplete: s.emrComplete } });
  } catch (_) {
    emit({ ...state, agent: { hasEmrDb: false, emrSource: null, emrComplete: false } });
  }
}

/** 새 대화를 만들고 활성화한다. id 는 재시작 뒤 되살린 대화와 겹치지 않게 시각을 섞는다. */
export function newConversation(opts: { title?: string; context?: SqlContext } = {}): string {
  convSeq += 1;
  const now = Date.now();
  const id = `conv-${now.toString(36)}-${convSeq}`;
  const conv: Conversation = {
    id,
    title: opts.title ?? '새 대화',
    messages: [],
    running: false,
    runId: null,
    mcpDown: false,
    context: opts.context,
    createdAt: now,
    updatedAt: now,
  };
  emit({ ...state, conversations: [...state.conversations, conv], activeId: id });
  return id;
}

/** 대화를 히스토리 파일에 남긴다 (발화 직후·응답 완료 때). 빈 대화는 남기지 않는다. */
function persist(id: string): void {
  const c = state.conversations.find((x) => x.id === id);
  if (!c || !c.messages.length || !window.api?.chatHistory) return;
  const saved: SavedConversation = {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sessionId: c.sessionId ?? null,
    context: c.context ?? null,
    messages: c.messages.map((m) => ({
      role: m.role, text: m.text, ...(m.tools?.length ? { tools: m.tools } : {}), ...(m.error ? { error: true } : {}),
    })),
  };
  window.api.chatHistory.save(saved)
    .then(() => window.dispatchEvent(new CustomEvent(CHAT_HISTORY_CHANGED_EVENT)))
    .catch(() => { /* 저장 실패로 대화를 막지 않는다 */ });
}

/**
 * 히스토리에서 고른 대화를 사이드바에 다시 연다. 이미 열려 있으면 그 탭으로 간다.
 * 세션 id 도 같이 되살려, 이어서 물으면 이전 맥락을 기억한다(에이전트 세션 파일이 남아 있는 한).
 */
export function openSavedConversation(saved: SavedConversation): void {
  const existing = state.conversations.find((c) => c.id === saved.id);
  if (!existing) {
    const conv: Conversation = {
      id: saved.id,
      title: saved.title,
      messages: saved.messages.map((m) => ({ role: m.role, text: m.text, tools: m.tools ?? [], error: m.error })),
      sessionId: saved.sessionId ?? undefined,
      running: false,
      runId: null,
      mcpDown: false,
      context: saved.context ?? undefined,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
    emit({ ...state, conversations: [...state.conversations, conv], activeId: conv.id });
  } else {
    emit({ ...state, activeId: saved.id });
  }
  setState({ chatOpen: true });
}

export function activateConversation(id: string): void {
  if (state.activeId === id || !state.conversations.some((c) => c.id === id)) return;
  emit({ ...state, activeId: id });
}

/** 대화를 닫는다. 진행 중이면 응답을 끊고, 옆 탭을 활성화한다. */
export function closeConversation(id: string): void {
  const idx = state.conversations.findIndex((c) => c.id === id);
  if (idx < 0) return;
  stopConversation(id);
  disposers.get(id)?.();
  disposers.delete(id);
  const rest = state.conversations.filter((c) => c.id !== id);
  let activeId = state.activeId;
  if (activeId === id) activeId = (rest[idx] ?? rest[idx - 1])?.id ?? null;
  emit({ ...state, conversations: rest, activeId });
}

export function stopConversation(id: string): void {
  const conv = state.conversations.find((c) => c.id === id);
  if (conv?.runId) window.api?.agent?.stop(conv.runId);
}

/** 활성 대화에 발화를 보낸다. 대화가 없으면 새로 만든다. */
export function sendPrompt(prompt: string, convId: string | null = state.activeId): void {
  const text = prompt.trim();
  if (!text || !window.api?.agent) return;
  const id = convId && state.conversations.some((c) => c.id === convId) ? convId : newConversation();
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv || conv.running) return;

  runSeq += 1;
  const runId = `${id}:${runSeq}`;
  patchConversation(id, (c) => ({
    ...c,
    title: c.messages.length === 0 && c.title === '새 대화' ? titleFrom(text) : c.title,
    messages: [...c.messages, { role: 'user', text }, { role: 'assistant', text: '', tools: [] }],
    running: true,
    runId,
    updatedAt: Date.now(),
  }));
  persist(id);

  const dispose = window.api.agent.ask({ runId, prompt: text, resume: conv.sessionId }, (ev: AgentEvent) => {
    switch (ev.type) {
      case 'session':
        patchConversation(id, (c) => ({ ...c, sessionId: ev.sessionId }));
        break;
      case 'delta':
        patchLastMessage(id, (m) => ({ ...m, text: m.text + ev.text }));
        break;
      case 'tool':
        // DB 도구(MCP)만 보여 준다. ToolSearch 나 내부 도구 호출은 답에 필요한 정보가 아니다.
        if (ev.name && ev.name.startsWith('mcp__')) {
          patchLastMessage(id, (m) => ({ ...m, tools: [...(m.tools ?? []), { name: ev.name, input: ev.input ?? '' }] }));
        }
        break;
      case 'mcp': {
        const down = ev.emrStatus !== 'connected';
        patchConversation(id, (c) => ({ ...c, mcpDown: down }));
        if (down) {
          const src = state.agent?.emrSource ? ` (${state.agent.emrSource})` : '';
          patchLastMessage(id, (m) => ({
            ...m,
            error: true,
            text: `⚠ emr-db MCP 서버에 연결하지 못했습니다 (상태: ${ev.emrStatus}). `
              + `데이터베이스 직접 조회가 불가능합니다. VPN 연결과 emr-db MCP 설정${src}의 `
              + 'MYSQL_HOST/PORT/USER/PASS/DB 값을 확인하세요.',
          }));
        }
        break;
      }
      case 'result':
        // 스트리밍 델타가 비어 있었으면(부분 응답 미지원) 최종 텍스트로 채운다.
        if (ev.text) patchLastMessage(id, (m) => (m.text ? m : { ...m, text: ev.text }));
        if (ev.isError) patchLastMessage(id, (m) => ({ ...m, error: true, text: m.text || '요청을 처리하지 못했습니다.' }));
        break;
      case 'error': {
        // 되살린 대화의 에이전트 세션이 사라졌으면(세션 파일 정리 등) 다음 발화는 새 세션으로 간다.
        const lostSession = !!conv.sessionId && /no conversation found|session.*not found|could not resume/i.test(ev.message);
        if (lostSession) patchConversation(id, (c) => ({ ...c, sessionId: undefined }));
        patchLastMessage(id, (m) => ({
          ...m,
          error: true,
          text: m.text + (m.text ? '\n\n' : '') + `⚠ ${ev.message}`
            + (lostSession ? '\n이전 세션을 찾지 못해 다음 질문부터는 새 세션으로 이어 갑니다. 같은 내용을 다시 보내 주세요.' : ''),
        }));
        break;
      }
      case 'done':
        patchConversation(id, (c) => ({ ...c, running: false, runId: null, updatedAt: Date.now() }));
        disposers.get(id)?.();
        disposers.delete(id);
        persist(id);
        break;
      default:
        break;
    }
  });
  disposers.set(id, dispose);
}

/** 지금 화면이 보고 있는 접속·DB·스키마. 접속이 안 돼 있으면 null. */
export function currentSqlContext(): SqlContext | null {
  const s = getState();
  const connectionId = activeConnectionId(s);
  const session = sessionOf(connectionId, s);
  if (!connectionId || !session?.connected) return null;
  const tab = activeTab(s);
  return {
    connectionId,
    database: session.currentDatabase ?? '',
    schema: tab && 'schema' in tab ? tab.schema : (session.currentSchema ?? ''),
  };
}

/** 접속 이름·종류까지 붙인 한 줄 설명 — 에이전트에게 맥락으로 준다. */
export function describeContext(ctx: SqlContext): string {
  const s = getState();
  const conn = connectionOf(ctx.connectionId, s);
  const session = sessionOf(ctx.connectionId, s);
  const parts = [conn ? `접속 ${conn.name}` : null, session?.kind ? `(${session.kind})` : null];
  if (ctx.database) parts.push(`데이터베이스 ${ctx.database}`);
  if (ctx.schema && session?.hasSchemaLevel) parts.push(`스키마 ${ctx.schema}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * SQL 편집기에서 온 "AI 에게 질문하기". 새 대화를 열고 쿼리와 질문을 정리해 보낸다.
 * 사이드바가 닫혀 있으면 연다.
 */
export function askAboutSql(req: { sql: string; question: string; context: SqlContext | null }): void {
  const sql = req.sql.trim();
  const question = req.question.trim();
  if (!sql || !question) return;
  const lines: string[] = [];
  if (req.context) lines.push(`[현재 접속] ${describeContext(req.context)}`, '');
  lines.push('아래 SQL 에 대한 질문입니다.', '', '```sql', sql, '```', '', `질문: ${question}`);

  const id = newConversation({ title: titleFrom(question), context: req.context ?? undefined });
  setState({ chatOpen: true });
  sendPrompt(lines.join('\n'), id);
}

/** SqlEditor 가 듣는 이벤트 — 스크래치에 넣어 둔 새 본문을 화면에 반영하라는 신호 */
export const SQL_APPLIED_EVENT = 'dbstudio:sql-applied';

/**
 * 쿼리를 넣을 SQL 편집기를 고른다: 보고 있는 화면의 활성 SQL 탭 → 다른 화면의 활성 SQL 탭
 * → 열려 있는 아무 SQL 탭(마지막 것). 없으면 null.
 */
function targetSqlTab() {
  const s = getState();
  const tabs = sqlTabs(s);
  if (!tabs.length) return null;
  const focused = tabs.find((t) => t.id === paneActiveId(s, s.focusedPane));
  if (focused) return focused;
  const other = tabs.find((t) => t.id === paneActiveId(s, s.focusedPane === 0 ? 1 : 0));
  return other ?? tabs[tabs.length - 1];
}

/**
 * 답변의 쿼리를 SQL 편집기에 넣는다.
 * 열려 있는 SQL 편집기가 있으면 그 편집기 끝에 이어 붙이고(기존 내용은 지우지 않는다),
 * 없으면 지금 연결된 접속·스키마로 새 편집기를 열어 넣는다. 접속도 없으면 대화가 시작된
 * 맥락으로, 그것도 없으면 안내만 한다.
 */
export interface ApplyResult {
  how: 'appended' | 'opened';
  /** 테이블 이름에 붙인 스키마. 붙일 스키마가 없었으면 null */
  schema: string | null;
}

/**
 * 편집기가 쓰는 접속의 "현재 선택된 스키마" — 툴바에서 고른 것(MySQL 은 데이터베이스)이 우선,
 * 없으면 탭이 만들어질 때의 스키마.
 */
function schemaFor(connectionId: string, tabSchema: string): { schema: string; dialect: 'mysql' | 'postgres' } | null {
  const session = sessionOf(connectionId, getState());
  const schema = session?.currentSchema || tabSchema;
  if (!schema) return null;
  return { schema, dialect: session?.kind === 'postgres' ? 'postgres' : 'mysql' };
}

export function applySqlToEditor(sql: string, conv: Conversation | null): ApplyResult | false {
  const existing = targetSqlTab();
  if (existing) {
    // 답변의 쿼리는 스키마 없이 `FROM t` 로 오기 쉬운데, 편집기는 현재 선택된 스키마로 실행한다.
    const q = schemaFor(existing.connectionId, existing.schema);
    const body = q ? qualifySql(sql.trim(), q.schema, q.dialect) : sql.trim();
    const prev = getTabScratch<string>(existing.id, 'sql', '');
    const sep = prev.trim() ? (prev.endsWith('\n') ? '\n' : '\n\n') : '';
    setTabScratch(existing.id, 'sql', prev + sep + body + '\n');
    setActiveTab(existing.id);
    scheduleWorkspaceSave();
    // 편집기가 화면에 붙어 있으면 새 본문을 읽어 가고, 아니면 붙을 때 스크래치에서 읽는다.
    window.dispatchEvent(new CustomEvent(SQL_APPLIED_EVENT, { detail: { tabId: existing.id } }));
    return { how: 'appended', schema: q?.schema ?? null };
  }

  const s = getState();
  let ctx = currentSqlContext();
  if (!ctx && conv?.context && sessionOf(conv.context.connectionId, s)?.connected) ctx = conv.context;
  if (!ctx) {
    notify('info', '열려 있는 접속이 없어 편집기를 만들 수 없습니다. 먼저 접속하세요.');
    return false;
  }
  const q = schemaFor(ctx.connectionId, ctx.schema);
  const body = q ? qualifySql(sql.trim(), q.schema, q.dialect) : sql.trim();
  openSqlTab(ctx.connectionId, ctx.database, ctx.schema, body + '\n');
  return { how: 'opened', schema: q?.schema ?? null };
}
