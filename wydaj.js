// Wydanie nowej wersji jedną komendą:
//   node wydaj.js 1.2.1
// Podbija wersję w package.json + package-lock.json, commituje, taguje
// i wypycha na GitHub — workflow "Release (Windows)" zbuduje instalator
// i opublikuje go w Releases, a zainstalowane aplikacje same zaproponują
// aktualizację.
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const wersja = process.argv[2];
if (!wersja || !/^\d+\.\d+\.\d+$/.test(wersja)) {
  console.error('Użycie: node wydaj.js X.Y.Z   (np. node wydaj.js 1.2.1)');
  process.exit(1);
}

const run = cmd => { console.log('> ' + cmd); execSync(cmd, { stdio: 'inherit', cwd: __dirname }); };

const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version === wersja) { console.error('Ta wersja już jest w package.json'); process.exit(1); }
pkg.version = wersja;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Wersja: ${wersja}`);

run('npm install --package-lock-only');
run('git add package.json package-lock.json');
run(`git commit -m "Wersja ${wersja}"`);
run('git push origin main');
run(`git tag v${wersja}`);
run(`git push origin v${wersja}`);

console.log(`\n✅ Wydano ${wersja}. GitHub Actions buduje instalator —`);
console.log('   za ~10 minut pojawi się na github.com/diketes/agroserwis-serwis/releases,');
console.log('   a zainstalowane aplikacje same zaproponują aktualizację.');
