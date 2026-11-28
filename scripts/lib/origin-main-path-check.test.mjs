import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { fetchOriginMain, pathExistsOnOriginMain } = require('./origin-main-path-check.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-main-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const seed = path.join(root, 'seed');
  const git = (repo, ...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(seed, 'dir'));
  fs.writeFileSync(path.join(seed, 'dir', 'file.txt'), 'first\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(seed, 'second.txt'), 'second\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'second');
  return { root, seed, git };
}

test('path probes distinguish files, directories, absent paths and unresolved refs', (t) => {
  const { seed, git } = fixture(t);
  git(seed, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const opts = { repo: seed };
  assert.equal(pathExistsOnOriginMain('dir/file.txt', opts), true);
  assert.equal(pathExistsOnOriginMain('dir', opts), true);
  assert.equal(pathExistsOnOriginMain('dir', { ...opts, fileOnly: true }), false);
  assert.equal(pathExistsOnOriginMain('dir/file.txt', { ...opts, fileOnly: true }), true);
  assert.equal(pathExistsOnOriginMain('missing.txt', opts), false);
  assert.equal(pathExistsOnOriginMain('missing.txt', { ...opts, fileOnly: true }), false);
  const logs = [];
  assert.equal(pathExistsOnOriginMain('dir/file.txt', {
    ...opts, ref: 'origin/nonexistent', log: (s) => logs.push(s),
  }), null);
  assert.match(logs[0], /could not check origin\/nonexistent/);
  assert.equal(pathExistsOnOriginMain('dir/file.txt', { ...opts, ref: 'HEAD' }), true);
});

for (const shallow of [false, true]) {
  test(`fetch refreshes origin/main in a ${shallow ? 'shallow' : 'complete'} checkout`, (t) => {
    const { root, seed, git } = fixture(t);
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', ...(shallow ? ['--depth=1'] : []), `file://${seed}`, clone]);
    const base = git(clone, 'rev-parse', 'HEAD');
    assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), String(shallow));
    fs.writeFileSync(path.join(seed, 'landed.txt'), 'landed\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'landed');
    assert.equal(pathExistsOnOriginMain('landed.txt', { repo: clone }), false);
    assert.equal(fetchOriginMain({ repo: clone }), true);
    assert.equal(pathExistsOnOriginMain('landed.txt', { repo: clone }), true);
    assert.equal(git(clone, 'rev-parse', 'origin/main'), git(seed, 'rev-parse', 'HEAD'));
    git(clone, 'merge-base', '--is-ancestor', base, 'origin/main');
    if (!shallow) assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'false');
  });
}

test('a failed fetch reports failure even with a usable cached origin/main', (t) => {
  const { root, seed, git } = fixture(t);
  git(seed, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(seed, 'remote', 'add', 'origin', path.join(root, 'offline'));
  let sleeps = 0;
  const logs = [];
  assert.equal(fetchOriginMain({
    repo: seed, sleepMs: () => { sleeps++; }, log: (s) => logs.push(s),
  }), false);
  assert.equal(sleeps, 0, 'network failures must not be retried as lock collisions');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /could not fetch origin\/main/);
  assert.equal(pathExistsOnOriginMain('dir/file.txt', { repo: seed }), true);
});
