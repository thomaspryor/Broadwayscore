import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isLockFresh, STALE_AGE_MS, LAUNCH_GRACE_MS } = require('./monitor-lock-staleness.js');

function mkLock() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lock-'));
}

test('#476 repro: a 46h-old meta.json is STALE regardless of the dir mtime being touched just now', () => {
  const dir = mkLock();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ launchedAt: new Date(Date.now() - 46 * 3600 * 1000).toISOString() }));
  fs.utimesSync(dir, new Date(), new Date()); // simulate the unrelated smoketest touch
  assert.equal(isLockFresh(dir), false);
});

test('a 1h-old meta.json is FRESH', () => {
  const dir = mkLock();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ launchedAt: new Date(Date.now() - 3600 * 1000).toISOString() }));
  assert.equal(isLockFresh(dir), true);
});

test('exactly at the 20h boundary is still fresh; just past it is stale', () => {
  const dir = mkLock();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ launchedAt: new Date(Date.now() - STALE_AGE_MS + 1000).toISOString() }));
  assert.equal(isLockFresh(dir), true);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ launchedAt: new Date(Date.now() - STALE_AGE_MS - 1000).toISOString() }));
  assert.equal(isLockFresh(dir), false);
});

test('missing meta.json on a very young dir (launcher mid-launch) reads FRESH', () => {
  const dir = mkLock(); // just created — no meta.json written yet
  assert.equal(isLockFresh(dir), true);
});

test('missing meta.json on an old dir (genuine orphan) reads STALE', () => {
  const dir = mkLock();
  const old = new Date(Date.now() - LAUNCH_GRACE_MS - 60 * 1000);
  fs.utimesSync(dir, old, old);
  assert.equal(isLockFresh(dir), false);
});

test('corrupt meta.json on an old dir reads STALE, not a thrown error', () => {
  const dir = mkLock();
  fs.writeFileSync(path.join(dir, 'meta.json'), 'not json');
  const old = new Date(Date.now() - LAUNCH_GRACE_MS - 60 * 1000);
  fs.utimesSync(dir, old, old);
  assert.doesNotThrow(() => isLockFresh(dir));
  assert.equal(isLockFresh(dir), false);
});

test('a malformed launchedAt string (non-parseable date) reads STALE, not FRESH', () => {
  const dir = mkLock();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ launchedAt: 'not-a-date' }));
  assert.equal(isLockFresh(dir), false);
});

test('a nonexistent lock dir reads STALE, not a thrown error', () => {
  assert.doesNotThrow(() => isLockFresh('/tmp/does-not-exist-monitor-lock-476'));
  assert.equal(isLockFresh('/tmp/does-not-exist-monitor-lock-476'), false);
});
