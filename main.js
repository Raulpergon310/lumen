const { app, BaseWindow, BrowserWindow, protocol, ipcMain, shell, Menu, powerSaveBlocker, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { resolveAppPath, mimeFor } = require('./paths');
const { setupUpdates } = require('./updater');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// LUMEN_PROFILE lets a separate profile run side by side (used for testing).
if (process.env.LUMEN_PROFILE) app.setPath('userData', path.join(app.getPath('appData'), 'Lumen-' + process.env.LUMEN_PROFILE));

// Without this, Chromium's DirectComposition layer is drawn above child windows and hides the
// embedded mpv video.
app.commandLine.appendSwitch('disable-direct-composition');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userDir = app.getPath('userData');
const CONFIG_FILE = path.join(userDir, 'config.json');
const LOG_FILE = path.join(userDir, 'lumen.log');

function log(...parts) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch {}
}

// Config is written atomically; a corrupt file is set aside instead of blocking startup.
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (fs.existsSync(CONFIG_FILE)) {
      log('config corrupta, se renombra:', e.message);
      try { fs.renameSync(CONFIG_FILE, CONFIG_FILE + '.bad'); } catch {}
    }
    return {};
  }
}

let config = readConfig();
if (!config.deviceId) config.deviceId = crypto.randomUUID();

function writeConfig() {
  try {
    fs.mkdirSync(userDir, { recursive: true });
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    log('no se pudo guardar config:', e.message);
  }
}

ipcMain.on('cfg:all', (e) => { e.returnValue = config; });
ipcMain.handle('cfg:set', (_e, key, value) => {
  if (value === undefined) delete config[key];
  else config[key] = value;
  writeConfig();
});
ipcMain.on('log', (_e, msg) => log('[renderer]', msg));
ipcMain.on('app:can-close', () => { if (win && !win.isDestroyed()) win.destroy(); });

let blockerId = null;
ipcMain.on('power:keepAwake', (_e, on) => {
  if (on && blockerId === null) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
});

// ---------- mpv (external player for direct play, HDR and every audio format) ----------
const net = require('net');
const { spawn } = require('child_process');

const MPV_DIR = app.isPackaged ? path.join(process.resourcesPath, 'mpv') : path.join(__dirname, 'vendor', 'mpv');
const MPV_EXE = path.join(MPV_DIR, 'mpv.exe');
let mpv = null; // { proc, sock, pipe, buf, reqId }

function mpvSend(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('mpv:event', evt);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('mpv:event', evt);
}

const MPV_PROPS = ['time-pos', 'duration', 'pause', 'aid', 'sid', 'volume', 'mute', 'eof-reached', 'track-list', 'demuxer-cache-time', 'paused-for-cache'];

function mpvCommand(command) {
  if (!mpv?.sock || mpv.sock.destroyed) return false;
  mpv.sock.write(JSON.stringify({ command }) + '\n');
  return true;
}

function mpvConnect(state, attempt = 0) {
  const sock = net.connect(state.pipe);
  sock.setEncoding('utf8');
  sock.on('connect', () => {
    state.sock = sock;
    MPV_PROPS.forEach((p, i) => mpvCommand(['observe_property', i + 1, p]));
    mpvSend({ event: 'ready' });
  });
  sock.on('data', (chunk) => {
    state.buf += chunk;
    let nl;
    while ((nl = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, nl);
      state.buf = state.buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.event) mpvSend(msg);
      } catch {}
    }
  });
  sock.on('error', () => {
    if (state.sock || state.proc.exitCode !== null) return;
    if (attempt < 200) setTimeout(() => mpvConnect(state, attempt + 1), 100);
    else log('mpv: no se pudo conectar al pipe');
  });
}

ipcMain.handle('mpv:available', () => fs.existsSync(MPV_EXE));

// Embedded mode: mpv draws into a plain native window (no web page on it, so nothing covers the
// video) glued over the app's content area, and a transparent window on top of that carries the
// app's own controls. To the user it is all one window.
let videoHost = null;
let overlay = null;
let restoreFullScreen = null;

function syncOverlay() {
  if (!win || win.isDestroyed()) return;
  const b = win.getContentBounds();
  if (videoHost && !videoHost.isDestroyed()) {
    videoHost.setBounds(b);
    plainRectangle(videoHost);
  }
  if (overlay && !overlay.isDestroyed()) overlay.setBounds(b);
}

// Electron keeps a caption style on the video window (a BaseWindow) and ignores roundedCorners for
// it, so Windows 11 rounds its corners and draws a grey 1 px border: around a fullscreen movie that
// shows as grey edges. Strip the caption and turn rounding and border off through Win32 (koffi).
let win32 = null;
function plainRectangle(w) {
  if (process.platform !== 'win32') return;
  try {
    if (!win32) {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const dwm = koffi.load('dwmapi.dll');
      win32 = {
        getStyle: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
        setStyle: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
        setPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
        dwmSet: dwm.func('long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attr, _In_ int32_t *value, uint32_t size)'),
      };
    }
    const hwnd = Number(nativeHandle(w));
    const WS_CAPTION = 0x00c00000;
    const WS_THICKFRAME = 0x00040000;
    const style = Number(win32.getStyle(hwnd, -16));
    if (style & (WS_CAPTION | WS_THICKFRAME)) {
      win32.setStyle(hwnd, -16, style & ~(WS_CAPTION | WS_THICKFRAME));
      // NOSIZE | NOMOVE | NOZORDER | NOACTIVATE | FRAMECHANGED
      win32.setPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020);
    }
    win32.dwmSet(hwnd, 33, [1], 4); // DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_DONOTROUND
    win32.dwmSet(hwnd, 34, [-2], 4); // DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE
  } catch (e) {
    log('plainRectangle', e.message);
  }
}

function openVideoHost() {
  if (videoHost && !videoHost.isDestroyed()) return videoHost;
  videoHost = new BaseWindow({
    parent: win,
    frame: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    show: false,
  });
  videoHost.on('closed', () => { videoHost = null; });
  syncOverlay();
  videoHost.showInactive();
  return videoHost;
}

function openOverlay() {
  if (overlay && !overlay.isDestroyed()) return;
  overlay = new BrowserWindow({
    parent: videoHost || win,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  syncOverlay();
  overlay.loadURL('app://lumen/overlay.html');
  overlay.once('ready-to-show', () => { syncOverlay(); overlay.show(); overlay.focus(); });
  overlay.on('closed', () => { overlay = null; });
}

function closeOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
  if (videoHost && !videoHost.isDestroyed()) videoHost.destroy();
  videoHost = null;
  if (win && !win.isDestroyed()) {
    if (restoreFullScreen !== null && win.isFullScreen() !== restoreFullScreen) win.setFullScreen(restoreFullScreen);
    win.focus();
  }
  restoreFullScreen = null;
}

function nativeHandle(w) {
  const buf = w.getNativeWindowHandle();
  return String(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
}

ipcMain.on('overlay:ready', () => {
  // Re-observing makes mpv send every current value again to the freshly loaded controls.
  MPV_PROPS.forEach((p, i) => mpvCommand(['observe_property', 100 + i, p]));
  if (win && !win.isDestroyed()) win.webContents.send('mpv:event', { event: 'overlay-ready' });
});
ipcMain.on('overlay:data', (_e, data) => {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:data', data);
});
ipcMain.on('win:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
// The built-in player asks for real fullscreen while it is open, so no window buttons sit over the video.
let builtinRestore = null;
ipcMain.on('win:player', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  if (on) {
    if (builtinRestore === null) builtinRestore = win.isFullScreen();
    if (config.playerFullscreen !== false) win.setFullScreen(true);
  } else {
    if (builtinRestore !== null && win.isFullScreen() !== builtinRestore) win.setFullScreen(builtinRestore);
    builtinRestore = null;
  }
});
ipcMain.on('win:minimize', () => { if (win) win.minimize(); });
ipcMain.on('win:maximize', () => { if (win) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
ipcMain.on('win:close', () => { if (win) win.close(); });
ipcMain.on('win:move-by', (_e, dx, dy) => {
  if (!win || win.isFullScreen() || win.isMaximized()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.handle('mpv:start', (_e, args, { embed = false } = {}) => {
  if (mpv) {
    try { mpv.proc.kill(); } catch {}
    mpv = null;
  }
  const pipe = `\\\\.\\pipe\\lumen-mpv-${process.pid}-${Date.now()}`;
  const extra = [];
  if (embed && win && !win.isDestroyed()) {
    if (restoreFullScreen === null) restoreFullScreen = win.isFullScreen();
    if (config.playerFullscreen !== false) win.setFullScreen(true);
    const host = openVideoHost();
    extra.push(`--wid=${nativeHandle(host)}`, '--fullscreen=no', '--osc=no', '--osd-bar=no', '--input-cursor=no', '--cursor-autohide=no');
    openOverlay();
  }
  const proc = spawn(MPV_EXE, [`--input-ipc-server=${pipe}`, ...extra, ...args], { windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
  const state = { proc, pipe, sock: null, buf: '' };
  let stderrTail = '';
  proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  proc.on('error', (e) => { log('mpv spawn error', e.message); mpvSend({ event: 'process-exit', code: -1, error: e.message }); });
  proc.on('exit', (code) => {
    if (code) log('mpv exit', code, stderrTail.replace(/\s+/g, ' ').slice(-400));
    if (mpv === state) {
      mpv = null;
      closeOverlay();
    }
    mpvSend({ event: 'process-exit', code, stderr: stderrTail.slice(-600) });
  });
  mpv = state;
  mpvConnect(state);
  return true;
});

ipcMain.handle('mpv:command', (_e, command) => mpvCommand(command));
ipcMain.handle('mpv:stop', () => {
  if (!mpv) return;
  // Leave the video right away; mpv finishes shutting down in the background.
  mpvSend({ event: 'stopping' });
  closeOverlay();
  const state = mpv;
  if (!mpvCommand(['quit'])) { try { state.proc.kill(); } catch {} }
  setTimeout(() => { if (state.proc.exitCode === null) { try { state.proc.kill(); } catch {} } }, 3000);
});

let win = null;

function boundsOnScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 100 && b.x + b.width > w.x + 100 && b.y >= w.y - 10 && b.y < w.y + w.height - 100);
}

function createWindow() {
  const saved = boundsOnScreen(config.windowBounds) ? config.windowBounds : null;
  win = new BrowserWindow({
    width: saved?.width || 1440,
    height: saved?.height || 880,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0a0a0c',
    title: 'Lumen',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#f5f5f7', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Jellyfin servers on a LAN are usually plain http.
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
    },
  });
  if (config.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log('render-process-gone', d.reason);
    if (d.reason !== 'clean-exit') setTimeout(() => win && !win.isDestroyed() && win.reload(), 500);
  });
  win.on('unresponsive', () => log('ventana no responde'));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isFullScreen()) return;
    config.maximized = win.isMaximized();
    if (!config.maximized) config.windowBounds = win.getBounds();
  };
  // Give the page a moment to tell the server playback stopped, so no conversion keeps running on the NAS.
  let allowClose = false;
  win.on('close', (e) => {
    saveBounds();
    writeConfig();
    if (allowClose) return;
    e.preventDefault();
    allowClose = true;
    win.webContents.send('app:closing');
    setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); }, 2500);
  });
  win.on('closed', () => { win = null; });
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, syncOverlay);
  win.on('enter-full-screen', () => win.webContents.send('win:fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('win:fullscreen-changed', false));

  win.loadURL('app://lumen/index.html');
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', async (req) => {
    const file = resolveAppPath(new URL(req.url).pathname);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': mimeFor(file) } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  log('inicio v' + app.getVersion());
  createWindow();
  setupUpdates({ getWin: () => win, config, log });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (mpv) { try { mpv.proc.kill(); } catch {} } });
process.on('uncaughtException', (e) => log('uncaughtException', e.stack || e.message));
