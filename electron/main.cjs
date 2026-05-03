const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const workplaceTraining = require('./workplaceTraining.cjs');
const environment = require('./environment.cjs');

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

  mainWindow.loadURL(environment.getCurrent().url);

  // Show offline fallback if the remote URL fails to load
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    // Ignore aborted loads (e.g. navigation interrupted by a new load)
    if (errorCode === -3) return;
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // Allow navigation within the app's own domain (whichever env is active)
    if (url.startsWith(environment.getCurrent().url)) {
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
    const appOrigin = new URL(environment.getCurrent().url).origin;
    if (!url.startsWith(appOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function switchEnvironment(key) {
  environment.setActive(key);
  buildMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(environment.getCurrent().url);
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const current = environment.getCurrent();

  // Radio items reflect the persisted active env; clicking switches and
  // reloads the window. Rebuilt on every switch so the check mark moves.
  const environmentItems = environment.listAll().map((env) => ({
    label: `${env.label}  —  ${env.url}`,
    type: 'radio',
    checked: env.key === current.key,
    click: () => switchEnvironment(env.key),
  }));

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
      label: 'Environment',
      submenu: [
        { label: `Active: ${current.label}`, enabled: false },
        { type: 'separator' },
        ...environmentItems,
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
  // Read persisted env before anything reads getCurrent() — the menu and
  // the first loadURL both depend on it.
  environment.init();

  // Renderer-side IPC for env (offline.html retry, future logo gesture).
  ipcMain.handle('app:get-environment', () => environment.getCurrent());
  ipcMain.handle('app:list-environments', () => environment.listAll());
  ipcMain.handle('app:set-environment', (_event, key) => {
    switchEnvironment(key);
    return environment.getCurrent();
  });
  ipcMain.handle('app:reload', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(environment.getCurrent().url);
    }
  });

  buildMenu();
  // Register Workplace Training IPC handlers + tray indicator before the
  // window opens so the renderer never sees a missing-handler error if the
  // page boots fast and queries the bridge immediately.
  workplaceTraining.init();
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
