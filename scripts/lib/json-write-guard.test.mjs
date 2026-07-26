import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isLockStale, lockOwnerPath, LOCK_STALE_MS, createJsonWriteGuard } = require('./json-write-guard.js');

function mkLockDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'json-write-guard-lock-'));
}

function writeOwner(dir, obj) {
  fs.writeFileSync(lockOwnerPath(dir), JSON.stringify(obj));
}

test('#485 repro: a stale acquiredAt is judged stale even when the lock dir/file mtime was touched just now', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString() });
  fs.utimesSync(dir, new Date(), new Date()); // simulate an unrelated process touching the lock dir
  fs.utimesSync(lockOwnerPath(dir), new Date(), new Date()); // and the owner.json file itself
  assert.equal(isLockStale(dir), true);
});

test('a fresh acquiredAt reads not-stale', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date().toISOString() });
  assert.equal(isLockStale(dir), false);
});

test('exactly at the boundary is not stale; just past it is stale', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date(Date.now() - LOCK_STALE_MS + 1000).toISOString() });
  assert.equal(isLockStale(dir), false);
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString() });
  assert.equal(isLockStale(dir), true);
});

test('missing owner.json throws — caller treats that as "cannot tell, do not break the lock"', () => {
  const dir = mkLockDir();
  assert.throws(() => isLockStale(dir));
});

test('corrupt owner.json content falls back to mtime: old mtime reads stale', () => {
  const dir = mkLockDir();
  fs.writeFileSync(lockOwnerPath(dir), 'not json');
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lockOwnerPath(dir), old, old);
  assert.equal(isLockStale(dir), true);
});

test('corrupt owner.json content falls back to mtime: fresh mtime reads not stale', () => {
  const dir = mkLockDir();
  fs.writeFileSync(lockOwnerPath(dir), 'not json');
  assert.equal(isLockStale(dir), false);
});

test('owner.json missing the acquiredAt field (old format) falls back to mtime', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a' });
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lockOwnerPath(dir), old, old);
  assert.equal(isLockStale(dir), true);
});

test('a malformed acquiredAt string falls back to mtime instead of throwing', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: 'not-a-date' });
  assert.doesNotThrow(() => isLockStale(dir));
});

test('a nonexistent lock dir throws (same as a bare statSync would)', () => {
  assert.throws(() => isLockStale('/tmp/does-not-exist-json-write-guard-485'));
});

test('integration: createJsonWriteGuard.save() breaks a stale lock via acquiredAt even though the dir mtime was just touched', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-write-guard-int-'));
  const filePath = path.join(tmpDir, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify({ shows: [], _meta: {} }));
  const lockDir = `${filePath}.lock`;
  fs.mkdirSync(lockDir);
  writeOwner(lockDir, {
    pid: 999999,
    token: 'dead-holder',
    acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString(),
  });
  fs.utimesSync(lockDir, new Date(), new Date()); // an unrelated touch — must not keep this lock alive

  const guard = createJsonWriteGuard(filePath, { shape: 'array' });
  const data = guard.load();
  data.shows.push({ id: 'x', foo: 1 });
  assert.doesNotThrow(() => guard.save(data));

  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.shows.length, 1);
});
