import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';

/**
 * 창 하나. 렌더러는 HTTP로만 API를 호출한다(IPC로 백엔드 기능을 우회하지 않는다).
 * 보안 기본값: contextIsolation, sandbox, nodeIntegration 끔. preload 없음.
 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '민원 답변 작성',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 외부 링크는 앱 안에서 열지 않는다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (!app.isPackaged) {
    // dev 모드에서만: 렌더러 경고·오류를 터미널에 보여준다(CSP 위반, 로드 실패 확인용)
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`[renderer:${e.level}] ${e.message}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log(`[renderer:load-failed] ${code} ${desc}`));
  }

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
