'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, shell, nativeImage } = require('electron');

const isDev = process.env.NODE_ENV === 'development';
const DEV_URL = 'http://localhost:5273';
const APP_NAME = 'DB Studio';

// 설정 폴더 이름은 앱 이름에서 나온다.
// 소스로 실행할 때(package.json 의 name)와 설치본(productName)이 달라지지 않게 여기서 못 박는다.
// db/store/history 모듈이 경로를 읽기 전에 정해져야 하므로 require 보다 먼저 호출한다.
app.setName(APP_NAME);
migrateUserData();

const db = require('./db');
const store = require('./store');
const exporter = require('./export');
const history = require('./history');

let mainWindow = null;

/**
 * 예전 소스 실행은 설정을 'dbstudio' 폴더에 남겼다.
 * 앱 이름을 통일하면서 폴더가 바뀌므로, 접속 정보와 히스토리를 한 번 옮겨 온다.
 */
function migrateUserData() {
  try {
    const target = app.getPath('userData');
    const legacy = path.join(path.dirname(target), 'dbstudio');
    if (legacy === target || !fs.existsSync(legacy)) return;
    for (const name of ['connections.json', 'query-history.json']) {
      const from = path.join(legacy, name);
      const to = path.join(target, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  } catch (_) {
    /* 이전 설정을 못 옮겨도 앱은 정상 동작해야 한다 */
  }
}

/**
 * 창·Dock 아이콘.
 * 설치본은 번들 아이콘(icon.icns/ico)을 쓰지만, 소스로 실행하면 그게 없어
 * Electron 기본 아이콘이 뜬다. 그때 build/icon.png 를 직접 지정해 준다.
 */
function appIcon() {
  const file = path.join(__dirname, '..', 'build', 'icon.png');
  if (!fs.existsSync(file)) return null;
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? null : image;
}

function createWindow() {
  const icon = appIcon();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#1e1f22',
    // Windows·Linux 는 창 아이콘을 여기서 받는다 (macOS 는 Dock 쪽에서 지정).
    ...(icon ? { icon } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // 외부 링크는 기본 브라우저로 연다.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const send = (channel) => () => mainWindow && mainWindow.webContents.send(channel);
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '파일',
      submenu: [
        { label: '새 SQL 편집기', accelerator: 'CmdOrCtrl+N', click: send('menu:new-sql') },
        { label: '새 접속…', accelerator: 'CmdOrCtrl+Shift+N', click: send('menu:new-connection') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' },
        { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
      ],
    },
    {
      label: '트랜잭션',
      submenu: [
        { label: '커밋', accelerator: 'CmdOrCtrl+Alt+C', click: send('menu:commit') },
        { label: '롤백', accelerator: 'CmdOrCtrl+Alt+R', click: send('menu:rollback') },
        { type: 'separator' },
        { label: '자동 커밋 전환', click: send('menu:toggle-autocommit') },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '새로 고침', accelerator: 'F5', click: send('menu:refresh') },
        { label: '쿼리 히스토리', accelerator: 'CmdOrCtrl+Shift+H', click: send('menu:history') },
        { label: 'SQL 편집기 목록', accelerator: 'CmdOrCtrl+Shift+L', click: send('menu:sql-list') },
        { label: '실행 계획', accelerator: 'CmdOrCtrl+Shift+E', click: send('menu:explain') },
        { type: 'separator' },
        { role: 'reload', label: '화면 다시 읽기' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'resetZoom', label: '기본 배율' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
        { role: 'togglefullscreen', label: '전체 화면' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC --------------------------------------------------------------------

/** 렌더러로 오류를 문자열로 되돌려 주기 위한 래퍼. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), code: e && e.code ? e.code : null };
    }
  });
}

handle('conn:list', () => store.list());
handle('conn:save', (conn) => store.save(conn));
handle('conn:delete', (id) => store.remove(id));
handle('conn:test', (conn) => db.testConnection(conn));
handle('conn:connect', (id, password) => db.connect(store.resolve(id, password)));
handle('conn:disconnect', (id) => db.disconnect(id));
handle('conn:status', (id) => db.status(id));
handle('conn:encryptionAvailable', () => store.encryptionAvailable());

handle('meta:get', (id, action, args) => db.meta(id, action, args));
handle('meta:setSchema', (id, schema) => db.setSchema(id, schema));
handle('meta:setDatabase', (id, database) => db.setDatabase(id, database));
handle('meta:search', (id, req) => db.searchObjects(id, req));

handle('data:select', (id, args) => db.selectData(id, args));
handle('data:count', (id, args) => db.countData(id, args));
handle('data:apply', (id, args) => db.applyChanges(id, args));

handle('sql:execute', (id, sql, opts) => db.executeScript(id, sql, opts));
handle('sql:explain', (id, sql, opts) => db.explain(id, sql, opts));

handle('ddl:preview', (id, args) => db.previewColumnDDL(id, args));
handle('ddl:execute', (id, statements) => db.executeDDL(id, statements));

handle('export:rows', (req) => exporter.exportRows(req));
handle('export:query', async (id, req) => {
  const data = await db.fetchForExport(id, req);
  const result = await exporter.exportRows({ ...req, columns: data.columns, rows: data.rows });
  return { ...result, truncated: data.truncated };
});

handle('history:list', (query) => history.list(query));
handle('history:clear', () => history.clear());

handle('tx:autoCommit', (id, value) => db.setAutoCommit(id, value));
handle('tx:pending', (id) => db.pendingTx(id));
handle('tx:commit', (id) => db.commit(id));
handle('tx:rollback', (id) => db.rollback(id));

// ---- 앱 수명주기 -------------------------------------------------------------

app.whenReady().then(() => {
  // 배포 빌드의 CSP 는 dist/index.html 의 메타 태그로 들어간다 (vite.config.ts 의 csp-on-build).

  // macOS 는 Dock 아이콘을 창 옵션으로 바꿀 수 없어 따로 지정한다.
  if (process.platform === 'darwin' && app.dock) {
    const icon = appIcon();
    if (icon) app.dock.setIcon(icon);
  }

  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await db.closeAll();
  history.flush();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await db.closeAll();
  history.flush();
});
