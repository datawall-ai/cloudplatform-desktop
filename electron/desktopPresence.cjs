/**
 * Desktop presence — tells the server "this user has the cloudplatform desktop
 * app installed on this machine, currently running on platform X with bridge
 * version N." Heartbeats while the app is open so the server can distinguish
 * "ever-installed" from "online right now."
 *
 * The renderer never sees this directly; it's wired up in main.cjs at app
 * startup. Whenever workplaceTraining.cjs receives a setUploadConfig call,
 * it forwards the credentials here via setCredentials() and we fire a
 * registration immediately + start the heartbeat interval. Auth is shared
 * with the observability uploads on purpose — same JWT, same workspace, no
 * separate token-handshake story for presence.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 min — match UAC's ONLINE_WINDOW.

let credentials = null;
let machineId = null;
let heartbeatTimer = null;

function machineIdPath() {
  return path.join(app.getPath('userData'), 'machine-id.json');
}

function loadOrCreateMachineId() {
  if (machineId) return machineId;
  try {
    const data = JSON.parse(fs.readFileSync(machineIdPath(), 'utf8'));
    if (data && typeof data.machineId === 'string' && data.machineId.length > 0) {
      machineId = data.machineId;
      return machineId;
    }
  } catch {
    // First launch or corrupted file — fall through.
  }
  machineId = randomUUID();
  try {
    fs.writeFileSync(machineIdPath(), JSON.stringify({ machineId, host: os.hostname() }, null, 2));
  } catch (err) {
    // If we can't persist, fall back to an ephemeral ID. The admin sees a
    // new row each launch, which is annoying but not broken.
    console.warn('[presence] failed to persist machine id', err && err.message);
  }
  return machineId;
}

function bridgeVersion() {
  // Bridge version is owned by workplaceTraining.cjs; reading it from the
  // module avoids a circular import.
  try {
    return require('./workplaceTraining.cjs').BRIDGE_VERSION || 0;
  } catch {
    return 0;
  }
}

function buildPayload() {
  return {
    machine_id: loadOrCreateMachineId(),
    app_version: app.getVersion(),
    bridge_version: bridgeVersion(),
    platform: process.platform,
    capabilities: ['workplaceTraining'],
  };
}

async function postPresence() {
  if (!credentials) return;
  const { apiBase, jwt, workspaceId } = credentials;
  const url = apiBase.replace(/\/$/, '') + '/desktop/presence';
  // Presence is fire-and-forget. If unreachable, the next heartbeat
  // (~5min) tries again. Logging on each tick spams the console when
  // UAC is offline, so we just swallow non-2xx and network errors.
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + jwt,
        'X-Workspace-ID': workspaceId,
      },
      body: JSON.stringify(buildPayload()),
    });
  } catch { /* silent */ }
}

function setCredentials(cfg) {
  // cfg is the same shape workplaceTraining receives via wt:set-upload-config.
  // null/undefined clears credentials and stops heartbeats.
  if (!cfg || !cfg.apiBase || !cfg.jwt || !cfg.workspaceId) {
    credentials = null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    return;
  }
  credentials = { ...cfg };
  // Fire one immediately so admins see the install right after sign-in.
  postPresence();
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(postPresence, HEARTBEAT_INTERVAL_MS);
  }
}

function getMachineInfo() {
  return {
    machineId: loadOrCreateMachineId(),
    platform: process.platform,
    appVersion: app.getVersion(),
    bridgeVersion: bridgeVersion(),
  };
}

function shutdown() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  credentials = null;
}

module.exports = { setCredentials, getMachineInfo, shutdown };
