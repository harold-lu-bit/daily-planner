import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const manifest = await readJson('manifest.json');
const pkg = await readJson('package.json');
const lock = await readJson('package-lock.json');
assert.equal(manifest.id, 'research-planner');
assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(pkg.version, manifest.version, 'package version mismatch');
assert.equal(lock.version, manifest.version, 'lockfile version mismatch');
assert.equal(lock.packages[''].version, manifest.version, 'lockfile root version mismatch');
if (process.env.RELEASE_TAG) assert.equal(process.env.RELEASE_TAG, manifest.version, 'release tag mismatch');

const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
const section = changelog.split(/^## /m).find(s => s.startsWith(`${manifest.version} — `));
assert(section, 'Missing CHANGELOG section for this version');
const output = path.join(root, 'dist', 'release');
await fs.mkdir(output, { recursive: true });
// Only these named assets are published. Never glob workspace files or plugin data.
const names = ['main.js', 'manifest.json', 'styles.css'];
for (const name of names) {
  const bytes = await fs.readFile(path.join(root, name));
  assert(bytes.length > 0, `Empty release file: ${name}`);
  await fs.writeFile(path.join(output, name), bytes);
}
const licenses = [];
for (const name of ['yaml', 'zod']) {
  const folder = path.join(root, 'node_modules', name);
  const files = await fs.readdir(folder, { withFileTypes: true });
  const license = files.find(f => f.isFile() && /^license/i.test(f.name));
  assert(license, `Missing license: ${name}`);
  licenses.push(`${name}\n${await fs.readFile(path.join(folder, license.name), 'utf8')}`);
}
await fs.writeFile(path.join(output, 'THIRD-PARTY-LICENSES.txt'), licenses.join('\n\n'));
names.push('THIRD-PARTY-LICENSES.txt');
const sums = [];
for (const name of names) {
  const bytes = await fs.readFile(path.join(output, name));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
await fs.writeFile(path.join(root, 'dist', 'release-notes.md'), `## ${section.trim()}\n\n安装与更新：[安装指南](https://github.com/harold-lu-bit/daily-planner/blob/${manifest.version}/docs/INSTALL.md)。BRAT 添加 harold-lu-bit/daily-planner；已有安装保留 data.json。所有共享同一 Vault 的设备需使用兼容版本。\n`);
console.log(`Prepared ${manifest.id} ${manifest.version}: ${[...names, 'SHA256SUMS.txt'].join(', ')}`);
