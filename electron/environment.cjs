/**
 * Environment selection — which deployed cloudplatform the desktop shell loads.
 *
 * The shell can target three environments without a rebuild:
 *   - prod  → c.datawall.ai
 *   - dev   → cloudplatform-dev.datawall.ai
 *   - local → user-configurable, defaults to http://localhost:5173. Local can
 *             also point at another machine on the LAN (e.g. a dev box) by
 *             overriding the URL via setCustomUrl('local', 'http://192.168...:5173').
 *
 * Active env + per-env URL overrides are persisted in `userData/environment.json`.
 * Origin checks elsewhere (will-navigate, setWindowOpenHandler) read the
 * current env's URL through getCurrent() so they stay correct after a switch.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ENVIRONMENTS = {
  local: {
    label: 'Local',
    defaultUrl: 'http://localhost:5173',
    customizable: true,
  },
  dev: {
    label: 'Dev',
    defaultUrl: 'https://cloudplatform-dev.datawall.ai',
    customizable: false,
  },
  prod: {
    label: 'Production',
    defaultUrl: 'https://c.datawall.ai',
    customizable: false,
  },
};

const DEFAULT_ENV = 'prod';

let active = DEFAULT_ENV;
// Per-key URL overrides. Only populated for envs marked customizable; today
// that's just `local` so a user on Windows can point the desktop at their
// Mac dev server (or vice-versa) without a rebuild.
let customUrls = {};

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
    };
  } catch {
    return { active: DEFAULT_ENV, customUrls: {} };
  }
}

function writePersisted() {
  fs.writeFileSync(
    configPath(),
    JSON.stringify({ active, customUrls }, null, 2),
  );
}

function init() {
  const persisted = readPersisted();
  active = persisted.active;
  customUrls = persisted.customUrls;
}

function urlFor(key) {
  const env = ENVIRONMENTS[key];
  if (!env) return null;
  if (env.customizable && customUrls[key]) return customUrls[key];
  return env.defaultUrl;
}

function getCurrent() {
  const env = ENVIRONMENTS[active];
  return {
    key: active,
    label: env.label,
    url: urlFor(active),
    defaultUrl: env.defaultUrl,
    customizable: env.customizable,
  };
}

function listAll() {
  return Object.entries(ENVIRONMENTS).map(([key, value]) => ({
    key,
    label: value.label,
    url: urlFor(key),
    defaultUrl: value.defaultUrl,
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

// Override (or clear) the URL for a customizable env. Pass an empty string
// or null to revert to the default. Throws on un-customizable envs so we
// never accidentally let a user redirect prod traffic to a localhost.
function setCustomUrl(key, url) {
  const env = ENVIRONMENTS[key];
  if (!env) throw new Error(`Unknown environment: ${key}`);
  if (!env.customizable) throw new Error(`Environment ${key} is not customizable`);
  if (!url || !String(url).trim()) {
    delete customUrls[key];
  } else {
    // Light validation — strip trailing slashes for consistency with how
    // we build URLs elsewhere; real schema/host checks happen at load time.
    customUrls[key] = String(url).trim().replace(/\/+$/, '');
  }
  writePersisted();
  return getCurrent();
}

module.exports = { init, getCurrent, listAll, setActive, setCustomUrl };
