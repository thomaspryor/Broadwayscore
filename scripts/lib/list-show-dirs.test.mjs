import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { listShowDirs } = require('./list-show-dirs.js');

function makeTmpCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'list-show-dirs-test-'));
  fs.mkdirSync(path.join(root, 'hamilton'));
  fs.mkdirSync(path.join(root, 'wicked'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'failed-fetches.json'), '{}');
  // Dangling symlink — target does not exist. This is the exact shape that
  // took down the collection pipeline for ~8h on 2026-05-27.
  fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(root, 'broadway-review-texts'));
  return root;
}

test('listShowDirs returns real show subdirectories, sorted order not required', () => {
  const root = makeTmpCorpus();
  try {
    const dirs = listShowDirs(root);
    assert.deepEqual([...dirs].sort(), ['hamilton', 'wicked']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listShowDirs skips a dangling symlink instead of throwing', () => {
  const root = makeTmpCorpus();
  try {
    assert.doesNotThrow(() => listShowDirs(root));
    const dirs = listShowDirs(root, { silent: true });
    assert.ok(!dirs.includes('broadway-review-texts'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listShowDirs skips dotfiles and non-directory stray files', () => {
  const root = makeTmpCorpus();
  try {
    const dirs = listShowDirs(root, { silent: true });
    assert.ok(!dirs.includes('.git'));
    assert.ok(!dirs.includes('failed-fetches.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listShowDirs tolerates an unreadable-permission entry', () => {
  const root = makeTmpCorpus();
  const lockedDir = path.join(root, 'locked-show');
  fs.mkdirSync(lockedDir);
  fs.chmodSync(root, 0o755);
  fs.chmodSync(lockedDir, 0o000);
  try {
    // chmod 000 on the entry itself doesn't block stat(2) on most POSIX
    // systems (permission bits gate access to contents, not the stat call
    // via the parent dir listing) — so this mainly guards against a crash;
    // the entry should still surface as a valid directory.
    assert.doesNotThrow(() => listShowDirs(root, { silent: true }));
  } finally {
    fs.chmodSync(lockedDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listShowDirs re-throws when the base directory itself is missing', () => {
  const missing = path.join(os.tmpdir(), 'list-show-dirs-test-does-not-exist-' + Date.now());
  assert.throws(() => listShowDirs(missing), /ENOENT/);
});

test('listShowDirs silent option suppresses the warning but still skips bad entries', () => {
  const root = makeTmpCorpus();
  try {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      listShowDirs(root, { silent: true });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
