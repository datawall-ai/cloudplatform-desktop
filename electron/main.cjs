const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const workplaceTraining = require('./workplaceTraining.cjs');
const environment = require('./environment.cjs');

let mainWindow;

// Dev mode toggles whether the native menu bar is visible. Off by default
// in packaged (production) builds so end users get a clean window; on by
// default in unpackaged dev so we don't trip ourselves up. Toggleable at
// any time via Ctrl/Cmd+Shift+D — handler installed in createWindow().
const isMac = process.platform === 'darwin';
let devMode = !app.isPackaged;

function devModeFile() {
  return path.join(app.getPath('userData'), 'dev-mode.json');
}

function readPersistedDevMode() {
  try {
    const data = JSON.parse(fs.readFileSync(devModeFile(), 'utf8'));
    if (typeof data.devMode === 'boolean') return data.devMode;
  } catch { /* first run */ }
  return null;
}

function writePersistedDevMode(value) {
  try {
    fs.writeFileSync(devModeFile(), JSON.stringify({ devMode: value }, null, 2));
  } catch (err) {
    console.warn('[main] failed to persist dev mode', err && err.message);
  }
}

function applyDevMode() {
  // macOS apps must keep their menu — system menu bar is at the top of
  // the screen and removing it breaks copy/paste shortcuts and the app
  // menu. We still flip devMode for parity / future use.
  if (isMac) {
    Menu.setApplicationMenu(buildMenuTemplate());
    return;
  }
  if (devMode) {
    Menu.setApplicationMenu(buildMenuTemplate());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAutoHideMenuBar(false);
      mainWindow.setMenuBarVisibility(true);
    }
  } else {
    Menu.setApplicationMenu(null);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMenuBarVisibility(false);
      mainWindow.setAutoHideMenuBar(true);
    }
  }
}

function toggleDevMode() {
  devMode = !devMode;
  writePersistedDevMode(devMode);
  applyDevMode();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: `Cloud Platform – v${app.getVersion()}`,
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

  // Pin the title bar to "Cloud Platform – v<version>" — without this,
  // the renderer's <title> tag would override on every page load. Prevent
  // the default and re-set our own; the version comes from package.json.
  const pinnedTitle = `Cloud Platform – v${app.getVersion()}`;
  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.getTitle() !== pinnedTitle) {
      mainWindow.setTitle(pinnedTitle);
    }
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

  // Dev-mode toggle chord: Ctrl+Shift+D (Cmd+Shift+D on macOS). Listening
  // at before-input-event means the chord works regardless of menu
  // visibility — important since the menu IS the thing being toggled.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = isMac ? input.meta : input.control;
    if (mod && input.shift && (input.key === 'D' || input.key === 'd')) {
      event.preventDefault();
      toggleDevMode();
    }
  });
}

function switchEnvironment(key) {
  environment.setActive(key);
  applyDevMode();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(environment.getCurrent().url);
  }
}

function buildMenuTemplate() {
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

  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  // Read persisted env before anything reads getCurrent() — the menu and
  // the first loadURL both depend on it.
  environment.init();

  // Renderer-side IPC for env (offline.html retry, future logo gesture).
  ipcMain.handle('app:get-environment', () => environment.getCurrent());
  // Synchronous channel — preload uses sendSync so cloudplatform service
  // modules can read the UAC URL at top-level const init time, before
  // any async fetch happens. sendSync is discouraged in general but
  // appropriate here: it's one boot-time call, no I/O.
  ipcMain.on('app:get-environment-sync', (event) => {
    event.returnValue = environment.getCurrent();
  });
  ipcMain.handle('app:list-environments', () => environment.listAll());
  ipcMain.handle('app:set-environment', (_event, key) => {
    switchEnvironment(key);
    return environment.getCurrent();
  });
  ipcMain.handle('app:set-environment-url', (_event, key, url) => {
    // Override the frontend URL for a customizable env. If the override
    // targets the *active* env, reload the window so the user lands on
    // the new URL immediately.
    const updated = environment.setCustomUrl(key, url);
    applyDevMode();
    if (key === environment.getCurrent().key && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(environment.getCurrent().url);
    }
    return updated;
  });
  ipcMain.handle('app:set-environment-uac-url', (_event, key, url) => {
    // Override the UAC API URL for a customizable env. The renderer
    // captures `initialEnv.uacUrl` synchronously at preload time —
    // service modules read it once at module-load and cache it. So if
    // we're updating the active env we MUST reload the window for the
    // new URL to take effect; otherwise the renderer keeps hitting the
    // old (typically `localhost`) host.
    const updated = environment.setCustomUacUrl(key, url);
    if (key === environment.getCurrent().key && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(environment.getCurrent().url);
    }
    return updated;
  });
  ipcMain.handle('app:reload', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(environment.getCurrent().url);
    }
  });
  ipcMain.handle('app:get-dev-mode', () => devMode);
  ipcMain.handle('app:toggle-dev-mode', () => {
    toggleDevMode();
    return devMode;
  });

  // Restore persisted dev mode (overrides the !app.isPackaged default).
  const persistedDev = readPersistedDevMode();
  if (persistedDev !== null) devMode = persistedDev;
  applyDevMode();
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
