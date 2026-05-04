/**
 * Environment selection — which deployed cloudplatform + UAC the desktop
 * shell talks to.
 *
 * Each environment has TWO URLs:
 *   - frontend (loaded into the BrowserWindow — the cloudplatform UI)
 *   - uac      (target of cloudplatform's API calls)
 *
 * In production these can both live on the same domain. In local dev on
 * a LAN (e.g. desktop running on Windows over RDP, frontend on a Mac at
 * 10.144.x.x:3002, UAC on the same Mac at :6436) they're explicitly
 * different — and the desktop has to inject the UAC URL into the
 * renderer because cloudplatform's `localhost` resolves to the wrong host
 * on Windows.
 *
 * Active env + per-env URL overrides are persisted in
 * `userData/environment.json`. Backward-compatible read: the older
 * `customUrls: {<key>: <string>}` format is interpreted as a frontend
 * override (existing behavior), and `customUacUrls` is a parallel map.
 *
 * Origin checks elsewhere (will-navigate, setWindowOpenHandler) read the
 * current env's frontend URL via getCurrent() so they stay correct after
 * a switch.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ENVIRONMENTS = {
  local: {
    label: 'Local',
    defaultFrontendUrl: 'http://localhost:5173',
    defaultUacUrl: 'http://localhost:6436',
    customizable: true,
  },
  dev: {
    label: 'Dev',
    defaultFrontendUrl: 'https://cloudplatform-dev.k8s.datawall.ai',
    defaultUacUrl: 'https://prd.buldak-server-2.datawall.ai/uac',
    customizable: true,
  },
  prod: {
    label: 'Production',
    defaultFrontendUrl: 'https://cloudplatform.k8s.datawall.ai',
    defaultUacUrl: 'https://prd.buldak-server-2.datawall.ai/uac',
    customizable: false,
  },
};

const DEFAULT_ENV = 'prod';

let active = DEFAULT_ENV;
// Per-key URL overrides. Frontend (loaded in the window) and UAC (API
// calls from cloudplatform) are tracked separately so a LAN setup can
// configure them independently.
let customUrls = {};       // {<envKey>: <frontend url>}
let customUacUrls = {};    // {<envKey>: <uac api url>}

function configPath() {
  return path.join(app.getPath('userData'), 'environment.json');
}

function readPersisted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      active: (parsed.active && ENVIRONMENTS[parsed.active]) ? parsed.active : DEFAULT_ENV,
      customUrls: parsed.customUrls && typeof parsed.customUrls === 'object'
        ? parsed.customUrls
        : {},
      customUacUrls: parsed.customUacUrls && typeof parsed.customUacUrls === 'object'
        ? parsed.customUacUrls
        : {},
    };
  } catch {
    return { active: DEFAULT_ENV, customUrls: {}, customUacUrls: {} };
  }
}

function writePersisted() {
  fs.writeFileSync(
    configPath(),
    JSON.stringify({ active, customUrls, customUacUrls }, null, 2),
  );
}

function init() {
  const persisted = readPersisted();
  active = persisted.active;
  customUrls = persisted.customUrls;
  customUacUrls = persisted.customUacUrls;
}

function frontendUrlFor(key) {
  const env = ENVIRONMENTS[key];
  if (!env) return null;
  if (env.customizable && customUrls[key]) return customUrls[key];
  return env.defaultFrontendUrl;
}

function uacUrlFor(key) {
  const env = ENVIRONMENTS[key];
  if (!env) return null;
  if (env.customizable && customUacUrls[key]) return customUacUrls[key];
  return env.defaultUacUrl;
}

function getCurrent() {
  const env = ENVIRONMENTS[active];
  return {
    key: active,
    label: env.label,
    // `url` retained for backwards-compat with earlier callers that
    // expect a single URL — represents the frontend.
    url: frontendUrlFor(active),
    frontendUrl: frontendUrlFor(active),
    uacUrl: uacUrlFor(active),
    defaultUrl: env.defaultFrontendUrl,
    defaultFrontendUrl: env.defaultFrontendUrl,
    defaultUacUrl: env.defaultUacUrl,
    customizable: env.customizable,
  };
}

function listAll() {
  return Object.entries(ENVIRONMENTS).map(([key, value]) => ({
    key,
    label: value.label,
    url: frontendUrlFor(key),
    frontendUrl: frontendUrlFor(key),
    uacUrl: uacUrlFor(key),
    defaultUrl: value.defaultFrontendUrl,
    defaultFrontendUrl: value.defaultFrontendUrl,
    defaultUacUrl: value.defaultUacUrl,
    customizable: value.customizable,
  }));
}

function setActive(key) {
  if (!ENVIRONMENTS[key]) {
    throw new Error(`Unknown environment: ${key}`);
  }
  active = key;
  writePersisted();
  return getCurrent();
}

// Override the frontend URL for a customizable env. Pass an empty string
// or null to revert to the default.
function setCustomUrl(key, url) {
  const env = ENVIRONMENTS[key];
  if (!env) throw new Error(`Unknown environment: ${key}`);
  if (!env.customizable) throw new Error(`Environment ${key} is not customizable`);
  if (!url || !String(url).trim()) {
    delete customUrls[key];
  } else {
    customUrls[key] = String(url).trim().replace(/\/+$/, '');
  }
  writePersisted();
  return getCurrent();
}

// Override the UAC API URL for a customizable env. Same shape as
// setCustomUrl but targets the api-calls endpoint, not the frontend.
function setCustomUacUrl(key, url) {
  const env = ENVIRONMENTS[key];
  if (!env) throw new Error(`Unknown environment: ${key}`);
  if (!env.customizable) throw new Error(`Environment ${key} is not customizable`);
  if (!url || !String(url).trim()) {
    delete customUacUrls[key];
  } else {
    customUacUrls[key] = String(url).trim().replace(/\/+$/, '');
  }
  writePersisted();
  return getCurrent();
}

module.exports = { init, getCurrent, listAll, setActive, setCustomUrl, setCustomUacUrl };
