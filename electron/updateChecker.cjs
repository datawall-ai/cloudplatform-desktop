/**
 * Update checker — polls GitHub Releases for a newer version.
 *
 * Why this and not electron-updater?
 *   electron-updater wants `latest.yml` / `latest-mac.yml` / `latest-linux.yml`
 *   metadata files alongside each release (written by `electron-builder publish`)
 *   and full code-signature chains for silent install. Our build.sh uses
 *   `gh release create` directly, so those metadata files aren't there. We
 *   also don't yet have Windows/Linux signing in place, so silent installs
 *   would be brittle. This module is the small, dependency-free first cut:
 *
 *     1. On startup (after a short delay) and every UPDATE_INTERVAL_MS,
 *        GET https://api.github.com/repos/<owner>/<repo>/releases/latest.
 *     2. Parse `tag_name` (strip leading "v"), compare numerically against
 *        `app.getVersion()` segment-by-segment. Our version scheme is
 *        YYMMDD.HHMM.0 — three numeric segments, NOT semver — so we use a
 *        plain numeric compare per segment.
 *     3. If a newer version exists, fire a non-blocking notification + a
 *        renderer-side event. User can open the dialog from the menu
 *        ("Help → Check for Updates…") which offers "Open Release Page".
 *
 * The renderer can query state via the `app:get-update-status` /
 * `app:check-updates` IPC channels exposed in preload.cjs.
 *
 * If anything else later wants electron-updater proper, the IPC contract
 * here is the public surface — swapping the implementation should be
 * transparent to the cloudplatform web UI.
 */

const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell } = require('electron');
const https = require('https');

const GITHUB_OWNER = 'datawall-ai';
const GITHUB_REPO = 'cloudplatform-desktop';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// Poll once on startup (after STARTUP_DELAY_MS) and then every UPDATE_INTERVAL_MS.
// 6 hours keeps us well under GitHub's 60-req/hour unauthenticated rate limit
// even with multiple windows + reloads, and gets users on a new build within
// a workday without being annoying.
const STARTUP_DELAY_MS = 30 * 1000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

const status = {
  // 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'
  state: 'idle',
  currentVersion: null,
  latestVersion: null,
  releaseUrl: null,
  releaseName: null,
  publishedAt: null,
  assetForPlatform: null,
  lastCheckedAt: null,
  error: null,
};

let pollTimer = null;
let manualCheckInFlight = false;

// ---------------------------------------------------------------------------
// Version comparison — numeric segments, not semver. "260504.1452.0" parses
// as [260504, 1452, 0]; missing segments are treated as 0 so a tag like
// "260601" still compares cleanly against "260504.1452.0".
// ---------------------------------------------------------------------------

function parseVersion(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/^v/i, '');
  const parts = cleaned.split('.').map((seg) => {
    const n = Number.parseInt(seg, 10);
    return Number.isFinite(n) ? n : null;
  });
  if (parts.some((p) => p === null)) return null;
  return parts;
}

function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  return compareVersions(a, b) > 0;
}

// ---------------------------------------------------------------------------
// GitHub fetch
// ---------------------------------------------------------------------------

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      RELEASES_API,
      {
        headers: {
          // GitHub requires a User-Agent on every request.
          'User-Agent': `${GITHUB_REPO}/${app.getVersion()}`,
          Accept: 'application/vnd.github+json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub releases API returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse releases JSON: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('GitHub releases API request timed out'));
    });
  });
}

// Pick the asset that matches this OS + architecture so the dialog can offer
// a direct download link instead of just dumping the user on the release page.
// arm64 macs must NOT match an x64 dmg, hence the explicit arch check.
function pickAssetForPlatform(assets) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  const arch = process.arch; // 'x64' | 'arm64' | ...
  const platform = process.platform; // 'darwin' | 'win32' | 'linux'
  const archHints = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64', 'amd64'];

  let extensions;
  if (platform === 'darwin') extensions = ['.dmg', '.zip'];
  else if (platform === 'win32') extensions = ['.exe', '.msi'];
  else if (platform === 'linux') extensions = ['.AppImage', '.deb', '.rpm'];
  else extensions = [];

  // Prefer extension+arch match. Fall back to extension match alone (some
  // builds publish a single architecture-less Windows installer).
  const byExt = assets.filter((a) =>
    extensions.some((ext) => (a.name || '').toLowerCase().endsWith(ext.toLowerCase())),
  );
  if (byExt.length === 0) return null;

  const archMatch = byExt.find((a) => {
    const n = (a.name || '').toLowerCase();
    return archHints.some((hint) => n.includes(hint));
  });
  return archMatch || byExt[0];
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function broadcastStatus() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('app:update-status', { ...status });
    }
  }
}

async function check({ source = 'auto' } = {}) {
  if (manualCheckInFlight && source === 'manual') return { ...status };
  manualCheckInFlight = source === 'manual';
  status.state = 'checking';
  status.error = null;
  status.currentVersion = app.getVersion();
  broadcastStatus();

  try {
    const release = await fetchLatestRelease();
    const tag = release.tag_name || release.name || '';
    const latest = tag.replace(/^v/i, '');
    const asset = pickAssetForPlatform(release.assets);

    status.latestVersion = latest;
    status.releaseUrl = release.html_url || RELEASES_PAGE;
    status.releaseName = release.name || tag;
    status.publishedAt = release.published_at || null;
    status.assetForPlatform = asset
      ? { name: asset.name, url: asset.browser_download_url, size: asset.size }
      : null;
    status.lastCheckedAt = new Date().toISOString();

    if (isNewer(latest, status.currentVersion)) {
      status.state = 'update-available';
      if (source === 'auto') notifyUpdateAvailable();
    } else {
      status.state = 'up-to-date';
    }
  } catch (err) {
    status.state = 'error';
    status.error = err.message || String(err);
    status.lastCheckedAt = new Date().toISOString();
  } finally {
    manualCheckInFlight = false;
    broadcastStatus();
  }
  return { ...status };
}

function notifyUpdateAvailable() {
  // Native OS notification on auto-detect — non-blocking, dismissible.
  // The dialog only appears when the user clicks the menu item or the
  // notification, so background polling never steals focus.
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: 'Cloud Platform update available',
    body: `Version ${status.latestVersion} is available (you're on ${status.currentVersion}).`,
    silent: false,
  });
  n.on('click', () => showUpdateDialog());
  n.show();
}

function showUpdateDialog(parentWindow) {
  // Manual-check entry point. If we don't actually have an update, surface
  // the up-to-date / error state instead so the user gets feedback either way.
  const win = parentWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;

  if (status.state === 'checking') {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Checking for updates',
      message: 'Already checking for updates — hang on a moment.',
    });
    return;
  }

  if (status.state === 'error') {
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Update check failed',
      message: 'Could not check for updates.',
      detail: status.error || 'Unknown error.',
    });
    return;
  }

  if (status.state !== 'update-available') {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Up to date',
      message: `You're running the latest version (${status.currentVersion}).`,
    });
    return;
  }

  const buttons = ['Download', 'View Release Notes', 'Later'];
  const result = dialog.showMessageBoxSync(win, {
    type: 'info',
    title: 'Update available',
    message: `Cloud Platform ${status.latestVersion} is available.`,
    detail: [
      `You're currently on ${status.currentVersion}.`,
      status.assetForPlatform
        ? `Download will open ${status.assetForPlatform.name} (${formatSize(status.assetForPlatform.size)}).`
        : 'No installer detected for your platform — release page will open instead.',
      '',
      'Quit and reopen Cloud Platform after installing.',
    ].filter(Boolean).join('\n'),
    buttons,
    defaultId: 0,
    cancelId: 2,
  });

  if (result === 0) {
    // Open the direct asset download in the user's browser. We deliberately
    // don't fetch + auto-launch the installer ourselves — that path needs
    // checksum verification and signed binaries to be safe, and we're not
    // there yet. Browser download is good enough for a first cut.
    shell.openExternal(status.assetForPlatform?.url || RELEASES_PAGE);
  } else if (result === 1) {
    shell.openExternal(status.releaseUrl || RELEASES_PAGE);
  }
}

function formatSize(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return '?';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function buildMenuItem() {
  return {
    label: 'Check for Updates…',
    click: async () => {
      await check({ source: 'manual' });
      showUpdateDialog();
    },
  };
}

function init() {
  status.currentVersion = app.getVersion();

  ipcMain.handle('app:check-updates', async () => {
    return await check({ source: 'manual' });
  });
  ipcMain.handle('app:get-update-status', () => ({ ...status }));
  ipcMain.handle('app:open-release-page', () => {
    shell.openExternal(status.releaseUrl || RELEASES_PAGE);
  });

  // Skip background polling in unpackaged/dev runs — `app.getVersion()`
  // there is whatever package.json says, which is fine, but we'd be
  // hammering the API during local dev for no reason.
  if (!app.isPackaged) return;

  setTimeout(() => { check({ source: 'auto' }).catch(() => {}); }, STARTUP_DELAY_MS);
  pollTimer = setInterval(() => {
    check({ source: 'auto' }).catch(() => {});
  }, UPDATE_INTERVAL_MS);

  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
}

module.exports = {
  init,
  check,
  showUpdateDialog,
  buildMenuItem,
  // Exposed for tests / unit verification.
  _internal: { parseVersion, compareVersions, isNewer, pickAssetForPlatform },
};
