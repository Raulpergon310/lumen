// Builds the static site for GitHub Pages into site/:
//   /        landing page (web/index.html): open in the browser, Windows installer, Android TV
//   /app/    the Lumen web app (same UI as desktop and TV, plays in the browser)
//   /tv      short address for the TV "Downloader" app: forwards to the latest APK
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const repo = pkg.lumen?.githubRepo || '';
const out = path.join(root, 'site');
const app = path.join(out, 'app');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'src'), app, { recursive: true, filter: (f) => !/overlay(\.html|\.js)$/.test(f) });
fs.mkdirSync(path.join(app, 'vendor', 'hls'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/hls.js/dist/hls.min.js'), path.join(app, 'vendor/hls/hls.min.js'));
fs.cpSync(path.join(root, 'node_modules/jassub/dist'), path.join(app, 'vendor/jassub'), { recursive: true });
fs.writeFileSync(path.join(app, 'js/build-info.js'), `export const BUILD = { version: '${pkg.version}', repo: '${repo}' };\n`);

const fill = (s) => s.replaceAll('{{REPO}}', repo).replaceAll('{{VERSION}}', pkg.version);
fs.writeFileSync(path.join(out, 'index.html'), fill(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8')));
fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(out, 'icon.png'));
const apk = `https://github.com/${repo}/releases/latest/download/Lumen-tv.apk`;
fs.mkdirSync(path.join(out, 'tv'), { recursive: true });
fs.writeFileSync(path.join(out, 'tv/index.html'),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${apk}"><title>Lumen TV</title><a href="${apk}">Descargar Lumen para Android TV</a>\n`);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`site/ listo (Lumen ${pkg.version}, ${repo || 'sin repo'})`);
