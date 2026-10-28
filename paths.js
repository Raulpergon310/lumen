// Maps app:// (and dev server) URL paths to files on disk.
const path = require('path');

const ROOT = __dirname;
const MOUNTS = [
  ['/vendor/hls/', path.join(ROOT, 'node_modules', 'hls.js', 'dist')],
  ['/vendor/jassub/', path.join(ROOT, 'node_modules', 'jassub', 'dist')],
  ['/', path.join(ROOT, 'src')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function resolveAppPath(urlPath) {
  let p = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0]);
  if (p === '' || p === '/') p = '/index.html';
  for (const [prefix, base] of MOUNTS) {
    if (!p.startsWith(prefix)) continue;
    const full = path.normalize(path.join(base, p.slice(prefix.length)));
    return full.startsWith(base + path.sep) ? full : null;
  }
  return null;
}

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

module.exports = { resolveAppPath, mimeFor };
