/**
 * Workplace Training — desktop-only screen capture pipeline.
 *
 * Lifecycle (renderer ↔ main):
 *   1. listSources()  → desktopCapturer entries (screens + windows).
 *   2. startSession() → main creates a session in 'starting' and spawns a
 *      hidden recorder BrowserWindow (recorder.html + recorderPreload.cjs).
 *      The recorder calls wt-recorder:ready to fetch its config, opens
 *      getUserMedia against the chosen sourceId, starts MediaRecorder at
 *      RECORDER_CHUNK_INTERVAL_MS chunks, and pipes each chunk back via
 *      the shared wt:append-chunk handler. When MediaRecorder is actually
 *      running it fires wt-recorder:started → main flips the session to
 *      'recording' and broadcasts 'started'. If getUserMedia rejects
 *      (TCC denial on macOS, source revoked, etc.) the recorder fires
 *      wt-recorder:error → 'failed' event with the OS error attached.
 *   3. stopSession()  → main flips to 'stopping', signals the recorder to
 *      stop. After the final chunk flushes the recorder fires
 *      wt-recorder:stopped → 'stopped' event, hidden window is closed.
 *   4. A separate uploader (slice 3) drains the chunk dir to the server.
 *
 * Hidden window is intentionally minimal — its preload exposes only
 * recorder-scoped IPC (recorderPreload.cjs), backgroundThrottling is off
 * (otherwise MediaRecorder gets throttled to a crawl when not visible).
 *
 * Director-level consent is on file for our enterprise customers; we still
 * surface a tray indicator + one-click stop because operational visibility
 * (was it on, when did it stop) is worth more than the few lines it costs.
 */
const { ipcMain, desktopCapturer, app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const desktopPresence = require('./desktopPresence.cjs');

// v2: real recorder. wt:start no longer transitions synchronously to
// 'recording'; the renderer must wait for the 'started' event (or 'failed')
// after firing wt:start. Bumped together with preload.cjs's version field
// and cloudplatform's OBSERVABILITY_REQUIRED_BRIDGE.
const BRIDGE_VERSION = 2;

const RECORDER_CHUNK_INTERVAL_MS = 5000;

// Continuous-mode workspaces auto-start a recording on workspace switch
// and roll it over every hour so stitching + KS dispatch stay bounded
// per session. Tracked via continuousSessionId so we know what to stop
// on workspace switch / quit / rollover.
const CONTINUOUS_ROLLOVER_MS = 60 * 60 * 1000; // 1 hour
let continuousSessionId = null;
let continuousSessionWorkspaceId = null;
let continuousRolloverTimer = null;

// In-memory session table. Persisted state (chunk files, final manifest)
// lives on disk under userData/workplace-training/<sessionId>/.
const sessions = new Map();

// Per-session hidden recorder windows. Routes wt-recorder:* IPC back to
// the right session and lets us close the window on stop/fail.
const recorderWindows = new Map();

// Latest upload config handed over from the renderer via wt:set-upload-config.
// Pinned into each session at start time so a mid-recording workspace switch
// or token refresh doesn't change where in-flight uploads land.
let uploadConfig = null;

let tray = null;
let trayMenuRefresh = () => {};

function sessionRoot() {
  const root = path.join(app.getPath('userData'), 'workplace-training');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sessionDir(sessionId) {
  const dir = path.join(sessionRoot(), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(sessionId, partial) {
  const manifestPath = path.join(sessionDir(sessionId), 'manifest.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first write */ }
  const merged = { ...existing, ...partial, sessionId, updatedAt: new Date().toISOString() };
  fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2));
  return merged;
}

// =============================================================================
// Server sync — register session on start, patch on terminal events. The
// `final: true` chunk POST in the uploader (slice 3) signals stitching.
// Auth is pinned per-session in session.uploadConfig so token refresh /
// workspace switch mid-recording can't redirect in-flight syncs.
// =============================================================================

function deriveSourceKind(sourceId) {
  return typeof sourceId === 'string' && sourceId.startsWith('screen:') ? 'screen' : 'window';
}

function buildRegisterPayload(session) {
  return {
    session_id: session.id,
    workflow_id: session.sessionMeta?.workflowId || null,
    workflow_name: session.sessionMeta?.workflowName || null,
    run_id: session.sessionMeta?.runId || null,
    source_label: session.sourceLabel || null,
    source_kind: deriveSourceKind(session.sourceId),
    started_from: session.sessionMeta?.startedFrom || null,
    started_at: session.startedAt,
  };
}

async function registerSessionOnServer(session) {
  const cfg = session.uploadConfig;
  if (!cfg || !cfg.apiBase || !cfg.jwt || !cfg.workspaceId) return;
  const url = cfg.apiBase.replace(/\/$/, '') + '/observability/sessions';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.jwt,
        'X-Workspace-ID': cfg.workspaceId,
      },
      body: JSON.stringify(buildRegisterPayload(session)),
    });
    if (res.ok) {
      session.serverRegistered = true;
    }
    // Silent on non-2xx — register is fire-and-forget. The drainer/patch
    // path will retry on its own cadence; spamming the console on every
    // failure when UAC is unreachable doesn't help anyone.
  } catch {
    // Network error — same reasoning. Drainer surfaces real problems if
    // they persist; transient unreachability isn't worth a warn.
  }
}

// =============================================================================
// Chunk uploader — per-session sequential background drainer.
//
// Each chunk written via wt:append-chunk lands on disk first, then is queued
// for upload. A single in-flight drainer per session pops from the queue,
// POSTs to /sessions/{id}/chunks (multipart), deletes the local file on 2xx,
// and updates the manifest. Retries on network/5xx/401 with capped backoff.
// On non-retryable 4xx (bad multipart, etc.) it logs and skips the chunk
// rather than blocking the queue. When the queue empties on a stopped
// session, fires a final PATCH so the server can kick off stitching + KS.
// =============================================================================

const UPLOAD_BACKOFF_MS = [1000, 5000, 30_000, 120_000];

function uploadBackoff(attempt) {
  return UPLOAD_BACKOFF_MS[Math.min(attempt, UPLOAD_BACKOFF_MS.length - 1)];
}

function chunkPathFor(sessionId, chunkIndex) {
  return path.join(sessionDir(sessionId), 'chunk-' + String(chunkIndex).padStart(6, '0') + '.webm');
}

function bumpUploadedChunks(session) {
  session.uploadedChunks = (session.uploadedChunks || 0) + 1;
  writeManifest(session.id, { uploadedChunks: session.uploadedChunks });
}

async function uploadOneChunk(session, chunkIndex) {
  const cfg = session.uploadConfig;
  if (!cfg || !cfg.apiBase || !cfg.jwt || !cfg.workspaceId) {
    return { ok: false, reason: 'no-config' };
  }
  const filePath = chunkPathFor(session.id, chunkIndex);
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, reason: 'missing', err: err.message };
  }
  const url = cfg.apiBase.replace(/\/$/, '') + '/observability/sessions/' + session.id + '/chunks';
  const form = new FormData();
  form.append('chunk_index', String(chunkIndex));
  form.append('file', new Blob([bytes], { type: 'video/webm' }), 'chunk-' + chunkIndex + '.webm');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.jwt,
        'X-Workspace-ID': cfg.workspaceId,
      },
      body: form,
    });
  } catch (err) {
    return { ok: false, reason: 'network', err: err && err.message };
  }

  if (res.ok) {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    bumpUploadedChunks(session);
    return { ok: true };
  }
  if (res.status === 401) return { ok: false, reason: 'auth', status: 401 };
  if (res.status >= 500) return { ok: false, reason: 'server', status: res.status };
  // 4xx other than 401 — non-retryable; log and skip so we don't block.
  const text = await res.text().catch(() => '');
  console.warn('[wt] chunk', chunkIndex, 'rejected', res.status, text);
  try { fs.unlinkSync(filePath); } catch { /* keep on disk for debugging if you prefer */ }
  return { ok: false, reason: 'rejected', status: res.status };
}

async function drainSession(session) {
  if (session.draining) return;
  session.draining = true;
  let attempt = 0;
  try {
    while (session.uploadQueue && session.uploadQueue.length > 0) {
      const idx = session.uploadQueue[0];
      const result = await uploadOneChunk(session, idx);
      if (result.ok) {
        session.uploadQueue.shift();
        attempt = 0;
        continue;
      }
      if (result.reason === 'no-config' || result.reason === 'auth') {
        // Halt; resume when setUploadConfig is called again. Don't shift —
        // the chunk stays queued so we retry it with fresh creds.
        break;
      }
      if (result.reason === 'missing') {
        // File vanished (manual cleanup, etc.) — drop from queue and move on.
        session.uploadQueue.shift();
        attempt = 0;
        continue;
      }
      if (result.reason === 'rejected') {
        // 4xx — already deleted file in uploadOneChunk; move on.
        session.uploadQueue.shift();
        attempt = 0;
        continue;
      }
      // network / 5xx — backoff and retry the same chunk
      const wait = uploadBackoff(attempt);
      attempt += 1;
      await new Promise((r) => setTimeout(r, wait));
    }

    // Queue drained. If the session has stopped and we haven't yet sent
    // the all-chunks-uploaded signal, do it now so the server can stitch.
    if ((session.status === 'stopped' || session.status === 'failed') && !session.allChunksAcknowledged) {
      const ok = await sendAllChunksUploadedPatch(session);
      if (ok) session.allChunksAcknowledged = true;
    }
  } finally {
    session.draining = false;
    // If new chunks arrived while we were finishing up, kick again.
    if (session.uploadQueue && session.uploadQueue.length > 0) {
      drainSession(session).catch(() => {});
    }
  }
}

async function sendAllChunksUploadedPatch(session) {
  const cfg = session.uploadConfig;
  if (!cfg || !cfg.apiBase || !cfg.jwt || !cfg.workspaceId) return false;
  if (!session.serverRegistered) return false;
  const url = cfg.apiBase.replace(/\/$/, '') + '/observability/sessions/' + session.id;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.jwt,
        'X-Workspace-ID': cfg.workspaceId,
      },
      body: JSON.stringify({
        chunk_count: session.chunkCount,
        bytes_written: session.bytesWritten,
        all_chunks_uploaded: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function kickDrain(session) {
  if (!session.uploadQueue) session.uploadQueue = [];
  if (session.draining) return;
  drainSession(session).catch((err) => {
    console.warn('[wt] drain error', err && err.message);
  });
}

// Re-kick draining for any session sitting in auth-halted / no-config state
// once the renderer hands us fresh credentials. Called from the
// wt:set-upload-config handler.
function reapplyConfigToSessions() {
  if (!uploadConfig) return;
  for (const session of sessions.values()) {
    // Only refresh sessions that don't have their own pinned config yet.
    // Already-running sessions keep the config they were started with.
    if (!session.uploadConfig) {
      session.uploadConfig = { ...uploadConfig };
    } else if (session.uploadConfig.workspaceId === uploadConfig.workspaceId) {
      // Same workspace — refresh the JWT in case the old one expired.
      session.uploadConfig.jwt = uploadConfig.jwt;
    }
    if (session.uploadQueue && session.uploadQueue.length > 0 && !session.draining) {
      kickDrain(session);
    }
    if ((session.status === 'stopped' || session.status === 'failed') && !session.allChunksAcknowledged) {
      kickDrain(session);
    }
    if (!session.serverRegistered) {
      registerSessionOnServer(session);
    }
  }
}

async function patchSessionOnServer(session, patch) {
  if (!session.serverRegistered) return;
  const cfg = session.uploadConfig;
  if (!cfg || !cfg.apiBase || !cfg.jwt || !cfg.workspaceId) return;
  const url = cfg.apiBase.replace(/\/$/, '') + '/observability/sessions/' + session.id;
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.jwt,
        'X-Workspace-ID': cfg.workspaceId,
      },
      body: JSON.stringify(patch),
    });
    // Silent on failure — patch is fire-and-forget. Drainer's next retry
    // will catch it up if there's a real problem.
  } catch {
    // Network unreachable — silent. Drainer handles persistent issues.
  }
}

function publicSessionView(s) {
  return {
    id: s.id,
    status: s.status,
    sourceId: s.sourceId,
    sourceLabel: s.sourceLabel,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    chunkCount: s.chunkCount,
    bytesWritten: s.bytesWritten,
    sessionMeta: s.sessionMeta,
    error: s.error || null,
  };
}

// Spawn the hidden recorder window for a session. The window loads
// recorder.html which calls wt-recorder:ready to fetch its config, then
// runs MediaRecorder against the chosen desktopCapturer source. Errors
// (most commonly TCC permission denial on macOS) are reported back via
// wt-recorder:error and surfaced to the renderer panel as a 'failed' event.
async function spawnRecorder(session) {
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    // Critical: MediaRecorder gets throttled to a crawl in hidden windows
    // unless this is explicitly disabled. Without it chunks arrive every
    // ~minute instead of every chunkIntervalMs.
    webPreferences: {
      preload: path.join(__dirname, 'recorderPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // Stash config on the window object so wt-recorder:ready can return it
  // by looking up BrowserWindow.fromWebContents(event.sender). Avoids
  // serializing config into the URL or a side channel.
  win.__wtConfig = {
    sessionId: session.id,
    sourceId: session.sourceId,
    chunkIntervalMs: RECORDER_CHUNK_INTERVAL_MS,
  };
  recorderWindows.set(session.id, win);
  win.on('closed', () => {
    if (recorderWindows.get(session.id) === win) {
      recorderWindows.delete(session.id);
    }
    // If the recorder window died while we still expected it to be alive
    // (renderer process crash, etc.), don't leave the session hanging in
    // 'recording'. finalizeSession's normal close path runs after status
    // is already 'stopped' so this guard skips it.
    const live = sessions.get(session.id);
    if (live && (live.status === 'starting' || live.status === 'recording' || live.status === 'stopping')) {
      failSession(live, 'Recorder window closed unexpectedly');
    }
  });
  await win.loadFile(path.join(__dirname, 'recorder.html'));
}

function failSession(session, error) {
  if (session.status === 'stopped' || session.status === 'failed') return;
  session.status = 'failed';
  session.error = String(error || 'Unknown error');
  session.stoppedAt = session.stoppedAt || new Date().toISOString();
  writeManifest(session.id, {
    status: 'failed',
    error: session.error,
    stoppedAt: session.stoppedAt,
  });
  broadcastSessionEvent('failed', session);
  patchSessionOnServer(session, {
    status: 'failed',
    stopped_at: session.stoppedAt,
    error: session.error,
    chunk_count: session.chunkCount,
    bytes_written: session.bytesWritten,
  });
  // Kick the uploader so the all-chunks-uploaded signal fires once the
  // pending queue drains (or immediately if it's already empty).
  kickDrain(session);
  const win = recorderWindows.get(session.id);
  if (win && !win.isDestroyed()) {
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 50);
  }
}

function finalizeSession(session) {
  if (session.status === 'stopped' || session.status === 'failed') return;
  session.status = 'stopped';
  session.stoppedAt = session.stoppedAt || new Date().toISOString();
  writeManifest(session.id, { stoppedAt: session.stoppedAt, status: 'stopped' });
  broadcastSessionEvent('stopped', session);
  // Slice 3 (chunk uploader) is responsible for dispatching the final-chunk
  // PATCH once all uploads have flushed. Here we just record the local stop.
  patchSessionOnServer(session, {
    status: 'stopped',
    stopped_at: session.stoppedAt,
    chunk_count: session.chunkCount,
    bytes_written: session.bytesWritten,
  });
  kickDrain(session);
  const win = recorderWindows.get(session.id);
  if (win && !win.isDestroyed()) {
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 50);
  }
}

function broadcastSessionEvent(event, session) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('wt:event', { event, session: publicSessionView(session) });
  }
  trayMenuRefresh();
}

// =============================================================================
// IPC handlers — exposed to the renderer via preload.cjs
// =============================================================================

ipcMain.handle('wt:bridge-version', () => BRIDGE_VERSION);

ipcMain.handle('wt:set-upload-config', (_event, cfg = {}) => {
  // Renderer hands us { apiBase, jwt, workspaceId } on panel mount and
  // again on token refresh / workspace switch. We snapshot into each
  // session at start, so this just updates the "default for next start".
  if (!cfg || !cfg.apiBase || !cfg.jwt || !cfg.workspaceId) {
    uploadConfig = null;
    return { ok: false, reason: 'missing fields' };
  }
  const prev = uploadConfig;
  uploadConfig = {
    apiBase: String(cfg.apiBase),
    jwt: String(cfg.jwt),
    workspaceId: String(cfg.workspaceId),
  };
  // Apply to any existing sessions waiting on credentials and re-kick drains
  // that were halted on 401 / no-config.
  reapplyConfigToSessions();
  // Hand the same credentials to the presence module so it can register
  // this desktop install + start heartbeating.
  desktopPresence.setCredentials(uploadConfig);
  // Re-render the tray so the "Start screen recording" item flips from
  // disabled → enabled the moment we have credentials.
  trayMenuRefresh();
  // If the workspace changed (or this is the first config), check the
  // workspace's recording_mode and auto-start continuous capture if
  // configured. Fire-and-forget — credentials handshake completes
  // immediately for the renderer regardless.
  const workspaceChanged = !prev || prev.workspaceId !== uploadConfig.workspaceId;
  if (workspaceChanged) {
    maybeStartContinuousRecording().catch((err) => {
      console.warn('[wt] continuous start error', err && err.message);
    });
  }
  return { ok: true };
});

ipcMain.handle('wt:list-sources', async () => {
  // `thumbnail` is omitted to keep the IPC payload small; the renderer can
  // request a full thumbnail per-source via a follow-up call if it wants
  // to show previews in the picker.
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    displayId: s.display_id || null,
    appIcon: null,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
  }));
});

// Start a new session. Callable from the wt:start IPC handler (renderer-
// initiated, typically with workflow context) and from the tray menu
// (main-initiated, no workflow context — recording goes to the workspace
// KB without a workflow_id/run_id binding). The server treats both the
// same; sessionMeta is freeform and workflow_id is just a nullable column.
function startNewSession(opts = {}) {
  const { sourceId, sourceLabel = '', sessionMeta = {} } = opts;
  if (!sourceId) {
    throw new Error('startNewSession requires { sourceId }');
  }
  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    status: 'starting',
    sourceId,
    sourceLabel,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    chunkCount: 0,
    bytesWritten: 0,
    uploadedChunks: 0,
    sessionMeta,
    error: null,
    // Pinned per-session so a workspace switch / token refresh
    // mid-recording can't redirect in-flight uploads.
    uploadConfig: uploadConfig ? { ...uploadConfig } : null,
    serverRegistered: false,
  };
  sessions.set(sessionId, session);
  writeManifest(sessionId, {
    startedAt: session.startedAt,
    sourceId, sourceLabel, sessionMeta,
  });
  broadcastSessionEvent('starting', session);

  // Fire-and-forget register on the server. If it fails (no config yet,
  // network down, 401), the patch/upload paths will skip silently and
  // the session still lives locally.
  registerSessionOnServer(session);

  // Spawn the hidden recorder. The renderer will see 'started' once
  // MediaRecorder is actually running, or 'failed' if getUserMedia
  // rejects (most commonly because macOS Screen Recording permission
  // hasn't been granted yet).
  spawnRecorder(session).catch((err) => {
    failSession(session, 'Failed to spawn recorder window: ' + (err && err.message ? err.message : err));
  });

  return session;
}

ipcMain.handle('wt:start', async (_event, opts = {}) => {
  const session = startNewSession(opts);
  return publicSessionView(session);
});

// =============================================================================
// Continuous mode — workspace says "record while this user is signed in."
// Driven by workspace_observability_settings.recording_mode = 'continuous'.
// We auto-start on workspace switch (when uploadConfig changes), stop on
// switch-out / quit, and roll over every CONTINUOUS_ROLLOVER_MS so any
// individual session fits a reasonable stitching budget.
// =============================================================================

async function fetchWorkspaceSettings(cfg) {
  if (!cfg || !cfg.apiBase || !cfg.jwt || !cfg.workspaceId) return null;
  const url = cfg.apiBase.replace(/\/$/, '') + '/observability/settings';
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + cfg.jwt,
        'X-Workspace-ID': cfg.workspaceId,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function stopContinuousSession(reason) {
  if (!continuousSessionId) return;
  const session = sessions.get(continuousSessionId);
  if (!session) {
    continuousSessionId = null;
    continuousSessionWorkspaceId = null;
    return;
  }
  if (continuousRolloverTimer) {
    clearTimeout(continuousRolloverTimer);
    continuousRolloverTimer = null;
  }
  // Reuse the standard stop path so the recorder window flushes properly
  // and chunks finish uploading. The session goes through stitching + KS
  // dispatch like any other. The reason is persisted on the manifest so
  // operators can see why a continuous session ended without us spamming
  // the console.
  const trackedId = continuousSessionId;
  continuousSessionId = null;
  continuousSessionWorkspaceId = null;
  if (reason) {
    try { writeManifest(trackedId, { stopReason: String(reason) }); } catch { /* manifest dir may be gone */ }
  }
  if (session.status === 'recording' || session.status === 'starting') {
    session.status = 'stopping';
    broadcastSessionEvent('stopping', session);
    const win = recorderWindows.get(trackedId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('wt-recorder:stop');
    } else {
      finalizeSession(session);
    }
  }
}

async function startContinuousSession(cfg) {
  // Don't double-start.
  for (const s of sessions.values()) {
    if ((s.status === 'starting' || s.status === 'recording')
        && s.sessionMeta && s.sessionMeta.startedFrom === 'continuous'
        && s.sessionMeta.workspaceId === cfg.workspaceId) {
      continuousSessionId = s.id;
      continuousSessionWorkspaceId = cfg.workspaceId;
      return s;
    }
  }
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 },
    });
  } catch (err) {
    console.warn('[wt] continuous: getSources failed', err && err.message);
    return null;
  }
  const primary = (sources || [])[0];
  if (!primary) {
    console.warn('[wt] continuous: no screens available');
    return null;
  }
  const session = startNewSession({
    sourceId: primary.id,
    sourceLabel: primary.name,
    sessionMeta: {
      startedFrom: 'continuous',
      workspaceId: cfg.workspaceId,
    },
  });
  continuousSessionId = session.id;
  continuousSessionWorkspaceId = cfg.workspaceId;
  // Roll over so individual sessions stay bounded for stitching/KS.
  if (continuousRolloverTimer) clearTimeout(continuousRolloverTimer);
  continuousRolloverTimer = setTimeout(() => {
    rolloverContinuousSession().catch((err) => {
      console.warn('[wt] continuous rollover error', err && err.message);
    });
  }, CONTINUOUS_ROLLOVER_MS);
  return session;
}

async function rolloverContinuousSession() {
  // Stop the current session, then start a new one against the same
  // workspace + creds. The old session goes through stitching + KS
  // independently; the new one starts fresh chunk numbering.
  if (!continuousSessionId || !uploadConfig) return;
  const cfg = uploadConfig;
  await stopContinuousSession('hourly rollover');
  // Brief pause so the recorder window from the old session has time
  // to finish closing before we open a new one.
  await new Promise((r) => setTimeout(r, 500));
  await startContinuousSession(cfg);
}

async function maybeStartContinuousRecording() {
  if (!uploadConfig) return;
  const cfg = uploadConfig;
  // Workspace changed since the last continuous session — stop the old
  // one before checking the new workspace's policy.
  if (continuousSessionId && continuousSessionWorkspaceId !== cfg.workspaceId) {
    await stopContinuousSession('workspace switch');
  }
  const settings = await fetchWorkspaceSettings(cfg);
  if (!settings) return;
  if (!settings.observability_enabled) {
    if (continuousSessionId) await stopContinuousSession('observability disabled');
    return;
  }
  if (settings.recording_mode !== 'continuous') {
    if (continuousSessionId) await stopContinuousSession('mode is no longer continuous');
    return;
  }
  // Server enforces audience on session register; if we're rejected we'll
  // see it surface through 'failed' on the recorder. We still try.
  if (!continuousSessionId) {
    await startContinuousSession(cfg);
  }
}

// Tray-initiated recording. Auto-picks the primary screen and starts a
// session with no workflow context — the recording lands in the workspace
// KB with workflow_id=null, run_id=null. Requires uploadConfig to have
// been seeded by a previous renderer mount (so we have a JWT).
async function startTrayRecording() {
  if (!uploadConfig) {
    console.warn('[wt] tray recording: no upload config yet — open the app once first');
    return null;
  }
  // Don't double-start if something is already capturing.
  for (const s of sessions.values()) {
    if (s.status === 'starting' || s.status === 'recording') {
      return s; // already recording, no-op
    }
  }
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 },
    });
  } catch (err) {
    console.warn('[wt] tray recording: getSources failed', err && err.message);
    return null;
  }
  const primary = sources[0];
  if (!primary) {
    console.warn('[wt] tray recording: no screens available');
    return null;
  }
  const session = startNewSession({
    sourceId: primary.id,
    sourceLabel: primary.name,
    sessionMeta: { startedFrom: 'tray' },
  });
  return session;
}

ipcMain.handle('wt:stop', async (_event, sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  if (session.status === 'stopped' || session.status === 'failed') {
    return publicSessionView(session);
  }
  session.status = 'stopping';
  broadcastSessionEvent('stopping', session);

  const win = recorderWindows.get(sessionId);
  if (win && !win.isDestroyed()) {
    win.webContents.send('wt-recorder:stop');
    // The recorder window will fire wt-recorder:stopped after MediaRecorder
    // flushes its final chunk, which calls finalizeSession(). If the window
    // dies before reporting, the 'closed' handler still cleans up the map
    // but we don't transition to stopped — which is fine, the session
    // sits in 'stopping' and the panel stays consistent.
  } else {
    // No recorder window alive (spawn failed mid-flight or already gone).
    finalizeSession(session);
  }

  return publicSessionView(session);
});

ipcMain.handle('wt:status', async (_event, sessionId) => {
  if (sessionId) {
    const s = sessions.get(sessionId);
    return s ? publicSessionView(s) : null;
  }
  // No id: return all known sessions (renderer can show history).
  return Array.from(sessions.values()).map(publicSessionView);
});

// =============================================================================
// Recorder window IPC — only the hidden BrowserWindow spawned by spawnRecorder
// should be talking on these channels. Each handler looks up the session via
// the calling window's stashed __wtConfig.
// =============================================================================

function sessionFromSender(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !win.__wtConfig) return null;
  return sessions.get(win.__wtConfig.sessionId) || null;
}

ipcMain.handle('wt-recorder:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && win.__wtConfig ? win.__wtConfig : null;
});

ipcMain.on('wt-recorder:started', (event) => {
  const session = sessionFromSender(event);
  if (!session) return;
  // If the user already hit stop while we were spinning up, don't flip
  // back to 'recording' — leave it as 'stopping' and let the recorder's
  // own onStop handler take it from here.
  if (session.status === 'starting') {
    session.status = 'recording';
    broadcastSessionEvent('started', session);
  } else if (session.status === 'stopping') {
    const win = recorderWindows.get(session.id);
    if (win && !win.isDestroyed()) win.webContents.send('wt-recorder:stop');
  }
});

ipcMain.on('wt-recorder:stopped', (event) => {
  const session = sessionFromSender(event);
  if (!session) return;
  finalizeSession(session);
});

ipcMain.on('wt-recorder:error', (event, message) => {
  const session = sessionFromSender(event);
  if (!session) return;
  failSession(session, message);
});

// Chunk persistence. Called from the hidden recorder window via
// recorderPreload.cjs#appendChunk; also kept callable directly for any
// future flow that wants to inject chunks without going through the
// MediaRecorder path.
ipcMain.handle('wt:append-chunk', async (_event, { sessionId, chunkIndex, bytes }) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  const chunkPath = path.join(sessionDir(sessionId), `chunk-${String(chunkIndex).padStart(6, '0')}.webm`);
  const buf = Buffer.from(bytes);
  fs.writeFileSync(chunkPath, buf);
  session.chunkCount += 1;
  session.bytesWritten += buf.length;
  if (!session.uploadQueue) session.uploadQueue = [];
  session.uploadQueue.push(chunkIndex);
  kickDrain(session);
  return { ok: true, chunkPath };
});

// =============================================================================
// Tray indicator — present whenever a session is active so users always
// have a visual confirmation + one-click stop independent of window state.
// =============================================================================

function createTray() {
  if (tray) return tray;
  // Use a tiny placeholder icon — production should ship a real menu-bar
  // icon (template image on macOS) but we keep this slice asset-free.
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '..', 'icons', 'logo.png'),
  ).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  trayMenuRefresh = () => {
    const active = Array.from(sessions.values()).filter((s) => s.status === 'recording' || s.status === 'starting');
    const items = [];

    if (active.length === 0) {
      items.push({ label: 'Brend: not learning right now', enabled: false });
      // Top-level "show Brend" entry — the desktop's only door to a
      // recording that isn't tied to a specific workflow run. Auto-picks
      // the primary screen; sessionMeta has no workflow_id so the
      // recording lands in the workspace's KB as standalone training
      // material. Disabled until uploadConfig has been seeded by a
      // previous renderer mount (without it we have no JWT for UAC).
      items.push({
        label: uploadConfig
          ? 'Show Brend what you\'re doing (primary display)'
          : 'Show Brend — open the app first to sign in',
        enabled: !!uploadConfig,
        click: () => {
          startTrayRecording().catch((err) => {
            console.warn('[wt] tray start failed', err && err.message);
          });
        },
      });
    } else {
      for (const s of active) {
        items.push({ label: `Brend is watching: ${s.sourceLabel || s.sourceId}`, enabled: false });
        items.push({
          label: `Stop showing "${s.sourceLabel || 'this'}"`,
          click: () => {
            // Tray-started sessions have no renderer panel listening for
            // 'stop-requested', so call the stop path directly. Renderer-
            // started sessions get the same treatment — wt:stop is what
            // the panel would have invoked anyway.
            const fromTray = s.sessionMeta && s.sessionMeta.startedFrom === 'tray';
            if (fromTray) {
              ipcMain.emit('wt:stop', { sender: null }, s.id);
              // ipcMain.emit doesn't actually invoke handle()'d handlers —
              // call the underlying logic directly.
              const session = sessions.get(s.id);
              if (!session) return;
              if (session.status === 'stopped' || session.status === 'failed') return;
              session.status = 'stopping';
              broadcastSessionEvent('stopping', session);
              const win = recorderWindows.get(s.id);
              if (win && !win.isDestroyed()) {
                win.webContents.send('wt-recorder:stop');
              } else {
                finalizeSession(session);
              }
            } else {
              // Renderer-driven session: ask the renderer to stop so the
              // panel UI updates in step.
              for (const win of BrowserWindow.getAllWindows()) {
                win.webContents.send('wt:event', { event: 'stop-requested', session: publicSessionView(s) });
              }
            }
          },
        });
        items.push({ type: 'separator' });
      }
    }
    items.push({ role: 'quit', label: 'Quit Cloud Platform' });
    tray.setContextMenu(Menu.buildFromTemplate(items));
    tray.setToolTip(active.length === 0
      ? 'Cloud Platform — Brend is idle'
      : `Cloud Platform — Brend is learning from ${active.length} screen${active.length === 1 ? '' : 's'}`);
  };
  trayMenuRefresh();
  return tray;
}

// =============================================================================
// Resume on relaunch — scan userData/workplace-training/<id>/manifest.json,
// recreate in-memory sessions for any that have unfinished work, and queue
// their leftover chunks. The drainer kicks once setUploadConfig arrives.
//
// "Unfinished" = there are chunk-NNNNNN.webm files present on disk that
// haven't been deleted by a successful upload, OR the manifest's status
// is still in an active state. Sessions that are clean (status: stopped,
// allChunksAcknowledged, no chunk files) are pruned from the working tree
// next time we touch them — leaving the manifest as an audit trail.
// =============================================================================

function listOnDiskChunks(sessionId) {
  let entries;
  try {
    entries = fs.readdirSync(sessionDir(sessionId));
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^chunk-\d{6}\.webm$/.test(name))
    .map((name) => parseInt(name.slice(6, 12), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function resumeIncompleteSessions() {
  let root;
  try {
    root = sessionRoot();
  } catch {
    return;
  }
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const sessionId of dirs) {
    const manifestPath = path.join(root, sessionId, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue; // No usable manifest — skip; user can clean up by hand.
    }
    const pendingChunks = listOnDiskChunks(sessionId);
    const status = manifest.status || 'recording';
    const fullyDone = (status === 'stopped' || status === 'failed')
      && pendingChunks.length === 0;
    if (fullyDone) continue;

    // Recreate the session in memory. We mark a relaunched session as
    // 'failed' if the manifest never got a stoppedAt — the recorder
    // process is gone, we can't resume capture, but we can still drain
    // whatever chunks made it to disk.
    const restored = {
      id: sessionId,
      status: status === 'recording' || status === 'starting' || status === 'stopping'
        ? 'failed'
        : status,
      sourceId: manifest.sourceId || null,
      sourceLabel: manifest.sourceLabel || '',
      startedAt: manifest.startedAt || new Date().toISOString(),
      stoppedAt: manifest.stoppedAt || new Date().toISOString(),
      chunkCount: pendingChunks.length + (manifest.uploadedChunks || 0),
      bytesWritten: 0, // unknown — re-derived as drains succeed
      uploadedChunks: manifest.uploadedChunks || 0,
      sessionMeta: manifest.sessionMeta || {},
      error: status === 'failed' ? (manifest.error || 'Recovered after relaunch') : null,
      uploadConfig: null, // populated when setUploadConfig fires
      serverRegistered: false,
      uploadQueue: pendingChunks.slice(),
      allChunksAcknowledged: false,
    };
    if (restored.status !== status) {
      restored.error = restored.error || 'Recorder process exited before stop';
      writeManifest(sessionId, {
        status: restored.status,
        stoppedAt: restored.stoppedAt,
        error: restored.error,
      });
    }
    sessions.set(sessionId, restored);
  }
}

function init() {
  resumeIncompleteSessions();
  createTray();
}

module.exports = { init, BRIDGE_VERSION };
