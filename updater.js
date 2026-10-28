// Updates from the project's GitHub Releases (`npm run release`), or from a folder on the NAS when
// config.updateDir is set (`npm run publicar` leaves the installer and latest.json there). The
// installed app checks at start and every 6 h, fetches a newer installer to a temp folder in the
// background and offers "Reiniciar y actualizar"; if the offer is ignored, the update installs
// silently when the app closes. The portable .exe can't replace itself, so it only checks when installed.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = require('./package.json').lumen?.githubRepo || '';
const EVERY_MS = 6 * 60 * 60 * 1000;
const INSTALLER = /^Lumen-Setup-.*\.exe$/;

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function setupUpdates({ getWin, config, log }) {
  const installed = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
  let ready = null; // { version, file }
  let installing = false;
  let busy = false;

  const where = () => config.updateDir || (REPO ? `github.com/${REPO}` : 'ningún sitio');

  async function fromNas() {
    const info = JSON.parse(await fs.promises.readFile(path.join(config.updateDir, 'latest.json'), 'utf8'));
    return { version: info.version, name: info.file, path: path.join(config.updateDir, info.file), notes: info.notes || '' };
  }

  async function fromGitHub() {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lumen' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const rel = await r.json();
    const asset = (rel.assets || []).find((a) => INSTALLER.test(a.name));
    if (!asset) throw new Error('la versión publicada no trae instalador');
    return { version: String(rel.tag_name).replace(/^v/, ''), name: asset.name, url: asset.browser_download_url, notes: rel.body || '' };
  }

  async function fetchTo(info, dest) {
    if (info.path) return fs.promises.copyFile(info.path, dest);
    const r = await fetch(info.url, { headers: { 'User-Agent': 'Lumen' } });
    if (!r.ok || !r.body) throw new Error(`descarga ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  }

  async function check() {
    if (!installed) return { state: 'portable' };
    if (ready) return { state: 'ready', version: ready.version };
    if (busy) return { state: 'checking' };
    busy = true;
    try {
      let info = null;
      try {
        info = config.updateDir ? await fromNas() : REPO ? await fromGitHub() : null;
      } catch (e) {
        log('actualización', e.message);
      }
      if (!info) return { state: 'unreachable', dir: where() };
      if (!info.version || !newer(info.version, app.getVersion())) return { state: 'current', version: app.getVersion() };
      const tmpDir = path.join(os.tmpdir(), 'lumen-update');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const dest = path.join(tmpDir, path.basename(info.name));
      await fetchTo(info, dest + '.part');
      await fs.promises.rename(dest + '.part', dest);
      ready = { version: info.version, file: dest };
      log('actualización lista', info.version);
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('update:ready', { version: info.version, notes: info.notes });
      return { state: 'ready', version: info.version };
    } catch (e) {
      log('actualización', e.message);
      return { state: 'error', message: e.message };
    } finally {
      busy = false;
    }
  }

  function runInstaller(relaunch) {
    if (!ready || installing) return false;
    installing = true;
    const args = ['/S'];
    if (relaunch) args.push('--force-run');
    spawn(ready.file, args, { detached: true, stdio: 'ignore' }).unref();
    log('instalando', ready.version, relaunch ? '(y reabriendo)' : '(al cerrar)');
    return true;
  }

  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:info', () => ({ version: app.getVersion(), installed, dir: where(), ready: ready?.version || null }));
  ipcMain.handle('update:install', () => {
    if (!runInstaller(true)) return false;
    // The normal close path stops playback and tells the server first.
    const win = getWin();
    if (win && !win.isDestroyed()) win.close();
    else app.quit();
    return true;
  });
  app.on('will-quit', () => runInstaller(false));

  setTimeout(check, 15000);
  setInterval(check, EVERY_MS);
}

module.exports = { setupUpdates };
