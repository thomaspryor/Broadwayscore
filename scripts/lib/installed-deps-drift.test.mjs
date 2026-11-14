import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { detectDrift, formatMessage, checkDir } = require('./installed-deps-drift.js');

const lock = {
  packages: {
    '': { dependencies: { next: '^16.0.0', react: '^19.0.0' }, devDependencies: { typescript: '^5' }, optionalDependencies: { fsevents: '^2' } },
    'node_modules/next': { version: '16.4.3' },
    'node_modules/react': { version: '19.1.0' },
    'node_modules/typescript': { version: '5.6.2' },
    'node_modules/fsevents': { version: '2.3.3', optional: true },
  },
};
const reader = (map) => (n) => (n in map ? map[n] : null);

test('the BRO-7492 incident: next 15.5.27 vs locked 16.4.3 is a major drift', () => {
  const r = detectDrift(lock, reader({ next: '15.5.27', react: '19.1.0', typescript: '5.6.2' }));
  assert.deepEqual(r.drift, [{ name: 'next', locked: '16.4.3', installed: '15.5.27', kind: 'major' }]);
  assert.match(formatMessage(r, '/x'), /next: installed 15\.5\.27, lockfile 16\.4\.3 {2}\[MAJOR\]/);
});

test('in sync (optional platform dep absent) is clean', () => {
  const r = detectDrift(lock, reader({ next: '16.4.3', react: '19.1.0', typescript: '5.6.2' }));
  assert.equal(r.drift.length, 0);
  assert.equal(formatMessage(r, '/x'), '');
});

test('missing required dep and minor drift are reported, major sorted first', () => {
  const r = detectDrift(lock, reader({ next: '16.4.2', typescript: '4.9.5' }));
  assert.deepEqual(r.drift.map((d) => [d.name, d.kind]), [['typescript', 'major'], ['react', 'missing'], ['next', 'version']]);
});

test('checkDir: no node_modules or no lockfile is not drift', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'idd-'));
  assert.equal(checkDir(d), null);
  fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify(lock));
  assert.equal(checkDir(d), null);
});

test('checkDir + CLI exit code on real files', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'idd-'));
  fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify(lock));
  fs.mkdirSync(path.join(d, 'node_modules', '.bin'), { recursive: true });
  for (const [n, v] of [['next', '15.5.27'], ['react', '19.1.0'], ['typescript', '5.6.2']]) {
    fs.mkdirSync(path.join(d, 'node_modules', n), { recursive: true });
    fs.writeFileSync(path.join(d, 'node_modules', n, 'package.json'), JSON.stringify({ version: v }));
  }
  assert.equal(checkDir(d).drift[0].name, 'next');
  const bad = spawnSync('node', [new URL('./installed-deps-drift.js', import.meta.url).pathname, d], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /NODE_MODULES DRIFT/);
  fs.writeFileSync(path.join(d, 'node_modules/next/package.json'), JSON.stringify({ version: '16.4.3' }));
  const ok = spawnSync('node', [new URL('./installed-deps-drift.js', import.meta.url).pathname, d]);
  assert.equal(ok.status, 0);
});

test('worktree-shaped dir: lockfile in child, node_modules in an ancestor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idd-'));
  const wt = path.join(root, '.claude', 'worktrees', 'w');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'package-lock.json'), JSON.stringify(lock));
  for (const [n, v] of [['next', '15.5.27'], ['react', '19.1.0'], ['typescript', '5.6.2']]) {
    fs.mkdirSync(path.join(root, 'node_modules', n), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', n, 'package.json'), JSON.stringify({ version: v }));
  }
  assert.equal(checkDir(wt).drift[0].name, 'next');
});

test('installed package.json without a version is skipped, not "missing"', () => {
  const r = detectDrift(lock, (n) => (n === 'next' ? undefined : n === 'react' ? '19.1.0' : n === 'typescript' ? '5.6.2' : null));
  assert.equal(r.drift.length, 0);
});

test('a bare node_modules/.cache in the worktree does not shadow the real ancestor install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idd-'));
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, 'node_modules', '.cache'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'package-lock.json'), JSON.stringify(lock));
  for (const [n, v] of [['next', '16.4.3'], ['react', '19.1.0'], ['typescript', '5.6.2']]) {
    fs.mkdirSync(path.join(root, 'node_modules', n), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', n, 'package.json'), JSON.stringify({ version: v }));
  }
  assert.equal(checkDir(wt).drift.length, 0);
});

test('devOptional deps absent (npm install --omit=dev) are not drift', () => {
  const l = { packages: { '': { dependencies: { a: '1' } }, 'node_modules/a': { version: '1.0.0', devOptional: true } } };
  assert.equal(detectDrift(l, () => null).drift.length, 0);
});
