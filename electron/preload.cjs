const { contextBridge, ipcRenderer } = require('electron');

/**
 * The web app at c.datawall.ai feature-detects the desktop bridge by
 * reading window.electronAPI. New capability surfaces should be nested
 * under their own namespace and carry a `version` so the web app can
 * gracefully gate on capability presence — `if (electronAPI.x?.version >= N)`
 * instead of scattered presence checks.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  // Environment switching — used today by offline.html's retry button so
  // it reloads the active env rather than a hardcoded URL, and reserved
  // for a future renderer gesture (e.g. long-press the logo) that lets
  // internal users hop between local and prod without restarting.
  app: {
    version: 1,
    getEnvironment: () => ipcRenderer.invoke('app:get-environment'),
    listEnvironments: () => ipcRenderer.invoke('app:list-environments'),
    setEnvironment: (key) => ipcRenderer.invoke('app:set-environment', key),
    reload: () => ipcRenderer.invoke('app:reload'),
  },

  workplaceTraining: {
    // Bumped when the bridge contract changes in a non-additive way.
    // Web UI gates new capabilities on this so old desktop builds keep
    // working with new web releases.
    //
    // v2: real recorder. startSession resolves with status='starting' and
    // the renderer must wait for an 'started' event (or 'failed') instead
    // of treating the resolved session as already-recording.
    version: 2,

    // List capturable screens + windows. Renderer uses this to populate
    // its source picker. Returns: [{ id, name, kind, displayId }].
    listSources: () => ipcRenderer.invoke('wt:list-sources'),

    // Begin a recording session against a chosen source. The main
    // process owns the recorder + chunk persistence; renderer just
    // tracks the lifecycle through `onEvent`.
    startSession: (opts) => ipcRenderer.invoke('wt:start', opts),

    // Stop a running session by id.
    stopSession: (sessionId) => ipcRenderer.invoke('wt:stop', sessionId),

    // Look up status — pass an id for one session, omit for all.
    getStatus: (sessionId) => ipcRenderer.invoke('wt:status', sessionId),

    // Hand the main process the credentials it needs to register sessions
    // and (slice 3) upload chunks. Renderer should call this on panel mount
    // and again whenever the workspace changes or the JWT is refreshed.
    // Auth is pinned per-session at start time, so changing this mid-recording
    // is safe — in-flight uploads keep using their original config.
    setUploadConfig: (cfg) => ipcRenderer.invoke('wt:set-upload-config', cfg),

    // Subscribe to lifecycle events (starting/started/stopping/stopped/failed/stop-requested).
    // Returns an unsubscribe function so React effects can clean up.
    onEvent: (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on('wt:event', wrapped);
      return () => ipcRenderer.removeListener('wt:event', wrapped);
    },
  },
});
