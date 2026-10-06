import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json needs a plain release version');
const node = /^>=(\d+(?:\.\d+)?)$/.exec(pkg.engines.node)?.[1];
if (!node) throw new Error('package.json needs a minimum Node version (>=N or >=N.M)');

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') throw new Error('Use --write or --check');

// Only current release fields: dependency pins and historical release notes keep their versions.
const fields = [
  ['herdr/herdr-plugin.toml', /^version = "[^"]+"$/m, `version = "${version}"`],
  ['site/index.html', /<span data-version>[^<]+<\/span>/, `<span data-version>v${version}</span>`],
  ['site/index.html', /"softwareVersion": "[^"]+"/, `"softwareVersion": "${version}"`],
  ['README.md', /\[!\[Release\]\([^\n]+?\)\]\([^\n]+?\)/, `[![Release](https://img.shields.io/badge/release-v${version}-8b5cf6?style=flat-square)](https://github.com/henkisdabro/sandcastle-kit/releases/latest)`],
  ['README.md', /\[!\[Node\]\([^\n]+?\)\]\([^\n]+?\)/, `[![Node](https://img.shields.io/badge/node-${node}%2B-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)`],
];

// Validate every marker before writing, so a renamed field cannot leave a partial update.
const files = new Map();
for (const [path, pattern, replacement] of fields) {
  const content = files.get(path) ?? readFileSync(join(root, path), 'utf8');
  if (!pattern.test(content)) throw new Error(`${path}: missing version field ${pattern}`);
  files.set(path, content.replace(pattern, replacement));
}

let stale = false;
for (const [path, content] of files) {
  if (content === readFileSync(join(root, path), 'utf8')) continue;
  if (mode === '--write') writeFileSync(join(root, path), content);
  else {
    console.error(`${path}: stale version field; run pnpm version:sync`);
    stale = true;
  }
}
if (mode === '--check') {
  const released = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))?.[1];
  if (released !== version) {
    console.error(`CHANGELOG.md: latest release ${released} differs from package.json ${version}`);
    stale = true;
  }
}
if (stale) process.exitCode = 1;
