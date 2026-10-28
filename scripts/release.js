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

// gh may not be on PATH yet in a shell opened before it was installed.
const gh = [process.env.GH_PATH, path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe')].find((p) => p && fs.existsSync(p)) || 'gh';
const notes = process.argv[2] || `Lumen ${pkg.version}`;
execFileSync(gh, ['release', 'create', `v${pkg.version}`, ...files, '--title', `Lumen ${pkg.version}`, '--notes', notes, '--latest'], { stdio: 'inherit', shell: gh === 'gh' });
console.log(`Publicada v${pkg.version}`);
