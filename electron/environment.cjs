/**
 * Environment selection — which deployed cloudplatform the desktop shell loads.
 *
 * The shell can target multiple cloudplatform environments without a rebuild
 * so internal users can validate dev-branch work against a real desktop bridge
 * before that work reaches production. The active env is persisted in
 * `userData/environment.json` and changed via the native Application menu
 * (Environment submenu in main.cjs) or, in a future slice, via a renderer
 * gesture wired through preload.cjs's `app` namespace.
 *
 * Origin checks elsewhere (will-navigate, setWindowOpenHandler) read the
 * current env's URL through getCurrent() so they stay correct after a switch.
 *
 * Adding a new environment is a one-line change to ENVIRONMENTS below.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ENVIRONMENTS = {
  local: { label: 'Local (Vite)', url: 'http://localhost:5173' },
  prod: { label: 'Production', url: 'https://c.datawall.ai' },
};

const DEFAULT_ENV = 'prod';

let active = DEFAULT_ENV;

function configPath() {
  return path.join(app.getPath('userData'), 'environment.json');
}

function readPersisted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (parsed && parsed.active && ENVIRONMENTS[parsed.active]) {
      return parsed.active;
    }
  } catch {
    // First run or corrupted file — fall through to default.
  }
  return DEFAULT_ENV;
}

function writePersisted(key) {
  fs.writeFileSync(configPath(), JSON.stringify({ active: key }, null, 2));
}

function init() {
  active = readPersisted();
}

function getCurrent() {
  return { key: active, ...ENVIRONMENTS[active] };
}

function listAll() {
  return Object.entries(ENVIRONMENTS).map(([key, value]) => ({ key, ...value }));
}

function setActive(key) {
  if (!ENVIRONMENTS[key]) {
    throw new Error(`Unknown environment: ${key}`);
  }
  active = key;
  writePersisted(key);
  return getCurrent();
}

module.exports = { init, getCurrent, listAll, setActive };
