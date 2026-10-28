// Copies the freshly built installer to the NAS updates folder and then writes latest.json (last, so an
// app never sees a version whose installer is still copying). Usage: npm run publicar [-- "notas"]
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const dir = process.env.LUMEN_UPDATE_DIR || 'Z:\Lumen';
const file = `Lumen-Setup-${pkg.version}.exe`;
const src = path.join(__dirname, '..', 'dist', file);

if (!fs.existsSync(src)) { console.error(`No existe ${src}: compila primero (electron-builder --win nsis).`); process.exit(1); }
try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.error(`No puedo usar ${dir}: ${e.message}`); process.exit(1); }

fs.copyFileSync(src, path.join(dir, file + '.part'));
fs.renameSync(path.join(dir, file + '.part'), path.join(dir, file));
const latest = { version: pkg.version, file, notes: process.argv[2] || '', date: new Date().toISOString() };
fs.writeFileSync(path.join(dir, 'latest.json.tmp'), JSON.stringify(latest, null, 2));
fs.renameSync(path.join(dir, 'latest.json.tmp'), path.join(dir, 'latest.json'));
// Older installers are no longer needed.
for (const f of fs.readdirSync(dir)) if (/^Lumen-Setup-.*\.exe$/.test(f) && f !== file) fs.rmSync(path.join(dir, f), { force: true });
console.log(`Publicada Lumen ${pkg.version} en ${dir}`);
