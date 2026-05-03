/**
 * Recorder window preload — exposes a narrow IPC surface to the hidden
 * BrowserWindow that runs MediaRecorder. Deliberately separate from the
 * main app preload so the recorder can't accidentally call into anything
 * outside its own lifecycle (no workplaceTraining, no app namespace, etc.).
 *
 * The recorder fetches its config (sessionId, sourceId, chunkIntervalMs)
 * via `ready()` once, then streams chunks back via `appendChunk()` which
 * routes through the same `wt:append-chunk` handler the rest of the app
 * uses for chunk persistence.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderBridge', {
  ready: () => ipcRenderer.invoke('wt-recorder:ready'),
  appendChunk: (sessionId, chunkIndex, bytes) =>
    ipcRenderer.invoke('wt:append-chunk', { sessionId, chunkIndex, bytes }),
  reportStarted: () => ipcRenderer.send('wt-recorder:started'),
  reportStopped: () => ipcRenderer.send('wt-recorder:stopped'),
  reportError: (message) => ipcRenderer.send('wt-recorder:error', String(message ?? 'unknown')),
  onStop: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on('wt-recorder:stop', wrapped);
    return () => ipcRenderer.removeListener('wt-recorder:stop', wrapped);
  },
});
