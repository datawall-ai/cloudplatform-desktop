/**
 * Active-window detection — pure-JS, no native modules.
 *
 * Returns the foreground OS window's app name + window title. Used by
 * workplaceTraining.cjs to stamp a window time-series into recording
 * manifests so watch rules can filter by which app/window was visible
 * when the recording was made.
 *
 * Avoids `active-win` / `get-windows` deliberately: those packages ship
 * platform-specific prebuilt binaries that don't survive a Mac-→-Windows
 * cross-compile cleanly. Calling out to `osascript` / PowerShell is a few
 * hundred ms slower per sample but the work pipelines on the OS side and
 * we only sample every 5s anyway.
 *
 * Public API:
 *   getActiveWindow() → Promise<{ app: string, title: string } | null>
 *
 * On unsupported platforms or on script failure (permission denied,
 * timeout) returns null. Callers should treat null as "no sample" and
 * keep recording without it.
 */

const { execFile } = require('child_process');

const SAMPLE_TIMEOUT_MS = 1500;

function execWithTimeout(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: SAMPLE_TIMEOUT_MS, ...opts }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(String(stdout || '').trim());
    });
    // Belt-and-suspenders: execFile's `timeout` kills the child but
    // sometimes the callback still hangs in Electron. Hard-fail at 2x.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, SAMPLE_TIMEOUT_MS * 2).unref();
  });
}

// macOS — System Events tells us the frontmost process and its front
// window title. The two `tell` blocks are intentional: the second one
// can fail if the frontmost app has no windows (e.g. Finder with no
// folder open), and we don't want that to nuke the whole sample.
const MAC_SCRIPT = `
on run
  set appName to ""
  set winName to ""
  try
    tell application "System Events"
      set frontProc to first application process whose frontmost is true
      set appName to name of frontProc
    end tell
  end try
  try
    tell application "System Events"
      tell (first application process whose frontmost is true)
        set winName to name of front window
      end tell
    end tell
  end try
  return appName & "::" & winName
end run
`;

async function getActiveWindowMac() {
  try {
    const out = await execWithTimeout('/usr/bin/osascript', ['-e', MAC_SCRIPT]);
    if (!out) return null;
    const sep = out.indexOf('::');
    const app = sep >= 0 ? out.slice(0, sep).trim() : out.trim();
    const title = sep >= 0 ? out.slice(sep + 2).trim() : '';
    if (!app) return null;
    return { app, title };
  } catch {
    return null;
  }
}

// Windows — minimal P/Invoke via PowerShell. Add-Type compiles the
// Win32 wrappers once per call, which is wasteful but acceptable at
// 5s polling. We resolve the process via Get-Process so we get a
// human-readable app name (e.g. "chrome") not a window class.
const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace WT -Name Win -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)]
public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);
"@
$h = [WT.Win]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][WT.Win]::GetWindowText($h, $sb, 512)
$pid_ = 0
[void][WT.Win]::GetWindowThreadProcessId($h, [ref]$pid_)
$proc = ''
try { $proc = (Get-Process -Id $pid_ -ErrorAction Stop).ProcessName } catch { }
"$proc::$($sb.ToString())"
`;

async function getActiveWindowWindows() {
  try {
    const out = await execWithTimeout('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', WIN_SCRIPT,
    ]);
    if (!out) return null;
    const sep = out.indexOf('::');
    const app = sep >= 0 ? out.slice(0, sep).trim() : out.trim();
    const title = sep >= 0 ? out.slice(sep + 2).trim() : '';
    if (!app && !title) return null;
    return { app: app || 'unknown', title };
  } catch {
    return null;
  }
}

async function getActiveWindowLinux() {
  // Try xdotool first — most common on dev boxes. xprop is a fallback
  // we could add later. Both are absent in headless containers; in that
  // case we just return null and the manifest gets no window metadata.
  try {
    const winId = await execWithTimeout('xdotool', ['getactivewindow']);
    if (!winId) return null;
    const title = await execWithTimeout('xdotool', ['getwindowname', winId]);
    let app = '';
    try {
      const pidStr = await execWithTimeout('xdotool', ['getwindowpid', winId]);
      if (pidStr) {
        app = await execWithTimeout('ps', ['-p', pidStr.trim(), '-o', 'comm=']);
      }
    } catch { /* leave app empty */ }
    return { app: (app || '').trim() || 'unknown', title: (title || '').trim() };
  } catch {
    return null;
  }
}

async function getActiveWindow() {
  if (process.platform === 'darwin') return getActiveWindowMac();
  if (process.platform === 'win32') return getActiveWindowWindows();
  if (process.platform === 'linux') return getActiveWindowLinux();
  return null;
}

module.exports = { getActiveWindow };
