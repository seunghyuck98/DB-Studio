'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 메인 프로세스 호출 결과를 풀어 성공값만 돌려주고, 실패는 예외로 던진다. */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) {
    const err = new Error((res && res.error) || '알 수 없는 오류가 발생했습니다.');
    if (res && res.code) err.code = res.code;
    throw err;
  }
  return res.data;
}

const MENU_CHANNELS = [
  'menu:new-sql', 'menu:new-connection', 'menu:commit',
  'menu:rollback', 'menu:toggle-autocommit', 'menu:refresh',
  'menu:history', 'menu:explain', 'menu:sql-list',
];

contextBridge.exposeInMainWorld('api', {
  connections: {
    list: () => call('conn:list'),
    save: (conn) => call('conn:save', conn),
    remove: (id) => call('conn:delete', id),
    test: (conn) => call('conn:test', conn),
    connect: (id, password) => call('conn:connect', id, password),
    disconnect: (id) => call('conn:disconnect', id),
    status: (id) => call('conn:status', id),
    encryptionAvailable: () => call('conn:encryptionAvailable'),
  },
  meta: {
    get: (id, action, args) => call('meta:get', id, action, args || {}),
    setSchema: (id, schema) => call('meta:setSchema', id, schema),
    setDatabase: (id, database) => call('meta:setDatabase', id, database),
    search: (id, req) => call('meta:search', id, req),
  },
  data: {
    select: (id, args) => call('data:select', id, args),
    count: (id, args) => call('data:count', id, args),
    apply: (id, args) => call('data:apply', id, args),
  },
  sql: {
    execute: (id, sql, opts) => call('sql:execute', id, sql, opts || {}),
    explain: (id, sql, opts) => call('sql:explain', id, sql, opts || {}),
  },
  ddl: {
    preview: (id, args) => call('ddl:preview', id, args),
    execute: (id, statements) => call('ddl:execute', id, statements),
  },
  exports: {
    /** 이미 화면에 있는 결과를 그대로 저장한다. */
    rows: (req) => call('export:rows', req),
    /** 페이지 제한 없이 다시 조회해서 저장한다. */
    query: (id, req) => call('export:query', id, req),
  },
  history: {
    list: (query) => call('history:list', query || {}),
    clear: () => call('history:clear'),
  },
  tx: {
    setAutoCommit: (id, value) => call('tx:autoCommit', id, value),
    pending: (id) => call('tx:pending', id),
    commit: (id) => call('tx:commit', id),
    rollback: (id) => call('tx:rollback', id),
  },
  /** 메뉴에서 발생한 명령을 구독한다. 해제 함수를 돌려준다. */
  onMenu: (handler) => {
    const subs = MENU_CHANNELS.map((ch) => {
      const fn = () => handler(ch);
      ipcRenderer.on(ch, fn);
      return () => ipcRenderer.removeListener(ch, fn);
    });
    return () => subs.forEach((off) => off());
  },
  platform: process.platform,
});
