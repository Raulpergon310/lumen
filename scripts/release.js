// Publishes dist/Lumen-Setup-<version>.exe and dist/Lumen-tv.apk as GitHub release v<version>.
// Installed apps (Windows and TV) find it through GitHub's "latest release". Needs the gh CLI logged in.
// Usage: npm run release -- "Qué hay de nuevo"
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const dist = path.join(__dirname, '..', 'dist');
const files = [`Lumen-Setup-${pkg.version}.exe`, 'Lumen-tv.apk'].map((f) => path.join(dist, f));
for (const f of files) if (!fs.existsSync(f)) { console.error(`Falta ${f}`); process.exit(1); }

const gh = process.platform === 'win32' && fs.existsSync('C:\Program Files\GitHub CLI\gh.exe') ? 'C:\Program Files\GitHub CLI\gh.exe' : 'gh';
const notes = process.argv[2] || `Lumen ${pkg.version}`;
execFileSync(gh, ['release', 'create', `v${pkg.version}`, ...files, '--title', `Lumen ${pkg.version}`, '--notes', notes, '--latest'], { stdio: 'inherit' });
console.log(`Publicada v${pkg.version}`);
