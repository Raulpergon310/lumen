// Builds dist/Lumen-Setup-<version>.exe. NSIS can't open its own include files when the project sits
// in a very long path (Windows' 260-character limit), so the build runs from a short copy in %TEMP%.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const work = path.join(os.tmpdir(), 'lumen-build');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });

// Only the project's own dist/android/.claude are skipped (node_modules has many "dist" folders).
const r = run('robocopy', [root, work, '/MIR', '/XD', path.join(root, 'dist'), path.join(root, 'android'), path.join(root, '.claude'), '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'].map((a) => `"${a}"`));
if (r.status >= 8) { console.error('robocopy falló'); process.exit(1); }
if (run('npx', ['electron-builder', '--win', 'nsis'], { cwd: work }).status !== 0) process.exit(1);

const { version } = require(path.join(root, 'package.json'));
const file = `Lumen-Setup-${version}.exe`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.copyFileSync(path.join(work, 'dist', file), path.join(root, 'dist', file));
console.log(`Listo: dist/${file}`);
