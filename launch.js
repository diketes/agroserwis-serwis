// Launcher — finds electron binary and starts the app
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const appDir = __dirname;

// Look for electron binary
const candidates = [
  // Local devDependency (preferred)
  path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
];

// Search parent directories
let dir = path.dirname(appDir);
for (let i = 0; i < 4; i++) {
  candidates.push(path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe'));
  dir = path.dirname(dir);
}

const electronPath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!electronPath) {
  console.error('\nNie znaleziono electron.exe!\n');
  console.error('Zainstaluj electron globalnie:  npm install -g electron@28');
  process.exit(1);
}

// Remove ELECTRON_RUN_AS_NODE so electron starts as GUI app, not as node
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

console.log('Uruchamianie:', electronPath);
const child = spawn(electronPath, [appDir], { stdio: 'inherit', windowsHide: false, env });
child.on('close', code => process.exit(code || 0));
