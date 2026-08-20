import {
  getState, getTabScratch, restoreSqlTabs, setWorkspaceListener, notify,
} from './store';
import type { SavedSqlEditor, SqlTab } from '../types';

/**
 * 열려 있는 SQL 편집기를 파일에 남기고, 다음 실행 때 되살린다.
 *
 * 본문은 탭 스크래치에 있고 (전역 리렌더를 피하려고 store 밖에 둔다) 화면에 붙어 있지 않은
 * 탭도 스크래치에는 그대로 남아 있으므로, 여기서 한 번에 모아 저장할 수 있다.
 * 결과 그리드와 실행 계획은 저장하지 않는다 — 다시 실행하면 되고, 파일만 커진다.
 */

const SAVE_DELAY_MS = 700;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastSaved = '';
let ready = false;

function isSql(t: { kind: string }): t is SqlTab {
  return t.kind === 'sql';
}

/** 지금 열려 있는 편집기들을 저장할 모양으로 모은다. */
function snapshot(): { activeId: string | null; editors: SavedSqlEditor[] } {
  const s = getState();
  const editors: SavedSqlEditor[] = s.tabs.filter(isSql).map((t) => ({
    id: t.id,
    title: t.title,
    connectionId: t.connectionId,
    database: t.database,
    schema: t.schema,
    sql: getTabScratch<string>(t.id, 'sql', ''),
    editorRatio: getTabScratch<number>(t.id, 'editorRatio', 45),
  }));
  const activeId = s.activeTabId && editors.some((e) => e.id === s.activeTabId) ? s.activeTabId : null;
  return { activeId, editors };
}

/** 바뀐 게 없으면 디스크를 건드리지 않는다. */
function changedSnapshot(): { snap: ReturnType<typeof snapshot>; text: string } | null {
  const snap = snapshot();
  const text = JSON.stringify(snap);
  if (text === lastSaved) return null;
  return { snap, text };
}

/** 잠시 모았다가 저장한다. 타이핑마다 파일을 쓰지 않기 위한 것이다. */
export function scheduleWorkspaceSave(): void {
  if (!ready || !window.api?.workspace) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void saveNow();
  }, SAVE_DELAY_MS);
}

async function saveNow(): Promise<void> {
  const pending = changedSnapshot();
  if (!pending) return;
  try {
    await window.api.workspace.save(pending.snap);
    lastSaved = pending.text;
  } catch (_) {
    /* 저장 실패로 편집을 막지는 않는다. 다음 변경 때 다시 시도한다. */
  }
}

/** 창이 닫히는 중에 쓰는 마지막 저장. 비동기 응답을 기다릴 수 없어 동기로 보낸다. */
export function flushWorkspace(): void {
  if (!ready || !window.api?.workspace) return;
  if (timer) { clearTimeout(timer); timer = null; }
  const pending = changedSnapshot();
  if (!pending) return;
  window.api.workspace.flush(pending.snap);
  lastSaved = pending.text;
}

/**
 * 저장해 둔 편집기를 되살린다.
 * 접속은 아직 열려 있지 않으므로, 편집기는 '접속 안 됨' 상태로 뜨고 내용만 그대로 보인다.
 */
export async function restoreWorkspace(): Promise<void> {
  if (!window.api?.workspace) return;
  try {
    const saved = await window.api.workspace.load();
    if (saved?.editors?.length) {
      restoreSqlTabs(saved.editors, saved.activeId ?? null);
      notify('info', `SQL 편집기 ${saved.editors.length}개를 이어서 엽니다.`);
    }
  } catch (e) {
    notify('error', `저장된 SQL 편집기를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // 읽기 전에 저장이 끼어들어 빈 목록으로 덮어쓰는 일이 없도록, 다 읽은 뒤에 켠다.
    ready = true;
    lastSaved = JSON.stringify(snapshot());
    setWorkspaceListener(scheduleWorkspaceSave);
    window.addEventListener('beforeunload', flushWorkspace);
  }
}
