const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { startServer } = require('../server/index');

let mainWindow = null;
let serverHandle = null;

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#07090d',
    title: '3분 오뚝이영상',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  mainWindow.loadURL(url);
}

async function boot() {
  try {
    const port = process.env.ELECTRON_SERVER_PORT ? Number(process.env.ELECTRON_SERVER_PORT) : 0;
    serverHandle = await startServer({ port });
    createMainWindow(`http://127.0.0.1:${serverHandle.port}/`);
  } catch (error) {
    dialog.showErrorBox(
      '앱 실행 실패',
      `로컬 서버를 시작하지 못했습니다.\n\n${error?.stack || error?.message || String(error)}`
    );
    app.quit();
  }
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle?.port) {
    createMainWindow(`http://127.0.0.1:${serverHandle.port}/`);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverHandle?.server) {
    serverHandle.server.close();
  }
});
