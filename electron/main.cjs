const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const REMOTE_URL = 'https://c.datawall.ai';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Cloud Platform',
    icon: path.join(__dirname, '..', 'icons', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(REMOTE_URL);

  // Show offline fallback if the remote URL fails to load
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    // Ignore aborted loads (e.g. navigation interrupted by a new load)
    if (errorCode === -3) return;
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // Allow navigation within the app's own domain
    if (url.startsWith(REMOTE_URL)) {
      return { action: 'allow' };
    }

    // Allow OAuth popups to open as child BrowserWindows so that
    // sessionStorage (copied from opener per spec) and window.opener
    // are preserved — required for the callback to read state and
    // postMessage the result back.
    const isOAuthPopup = frameName && (
      frameName.startsWith('oauth_') || frameName === 'email_oauth'
    );
    if (isOAuthPopup) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 600,
          height: 700,
          title: 'Sign In',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Open external links clicked inside OAuth child windows in the system browser
  mainWindow.webContents.on('did-create-window', (childWindow) => {
    childWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  // Also handle in-page link clicks that try to navigate away
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appOrigin = new URL(REMOTE_URL).origin;
    if (!url.startsWith(appOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
