// 2026-11-17: fetch-guardian-reviews.yml rebuilt reviews.json with no lease file (it never ran the
// opening-night-lease-sync action), read "nothing leased" and wiped the-fantasticks-2026's 20 lane-written
// reviews on its press night. rebuild-all-reviews.js now self-syncs when a CI job left the file missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const guard = require(path.join(ROOT, 'scripts/lib/opening-night-lane/lease-guard.js'));
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-self-sync-')), 'leases.json');
const LEASED = (show) => JSON.stringify({ leases: { [`${show}|2026-11-16`]: { holder: 'gha-lane', expiresAt: new Date(Date.now() + 3600e3).toISOString() } } });

test('CI with no lease file: runs the sync, then the publish view names the leased show', () => {
  const file = tmpFile();
  let ran = 0;
  const r = guard.syncIfMissing({ file, env: { GITHUB_ACTIONS: 'true' }, run: () => { ran++; fs.writeFileSync(file, LEASED('the-fantasticks-2026')); } });
  assert.equal(r, 'synced');
  assert.equal(ran, 1);
  assert.deepEqual(guard.leasedShowIds({ file, env: {} }), ['the-fantasticks-2026']);
});

test('CI, sync throws and writes nothing: the unknown marker is written, never a silent "nothing leased" file', () => {
  const file = tmpFile();
  const r = guard.syncIfMissing({ file, env: { GITHUB_ACTIONS: 'true', OPENING_NIGHT_SHOWS_FILE: '/nonexistent' }, run: () => { throw new Error('no network'); } });
  assert.equal(r, 'unknown');
  assert.equal(guard.readUnknownMarker(file), true);
});

test('file already present (the action ran) or off CI: no sync', () => {
  const file = tmpFile();
  fs.writeFileSync(file, LEASED('x-2026'));
  assert.equal(guard.syncIfMissing({ file, env: { GITHUB_ACTIONS: 'true' }, run: () => assert.fail('must not sync') }), 'present');
  const missing = tmpFile();
  assert.equal(guard.syncIfMissing({ file: missing, env: {}, run: () => assert.fail('must not sync') }), 'not-ci');
  assert.equal(fs.existsSync(missing), false);
});

test('structural: rebuild-all-reviews self-syncs before it reads the publish view', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const syncAt = src.search(/^if \(!SHOW_FILTER\) leaseGuard\.syncIfMissing\(\);/m); // a live statement, not a comment
  const readAt = src.indexOf('leaseGuard.leasedShowIds()');
  assert.ok(syncAt > 0 && readAt > syncAt, 'syncIfMissing() must run before leasedShowIds()');
});

test('structural: every workflow that runs rebuild-all-reviews either syncs leases or relies on the self-sync (listed)', () => {
  // Auto-discovered, so a new workflow cannot slip past a hand-kept list. The self-sync covers the rest; this
  // records which workflows lean on it so a removal of syncIfMissing shows up here too.
  const dir = path.join(ROOT, '.github/workflows');
  const unsynced = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).filter((f) => {
    const y = fs.readFileSync(path.join(dir, f), 'utf8');
    return /rebuild-all-reviews\.js/.test(y) && !/opening-night-lease-sync|opening-night-lease\.js"? sync/.test(y);
  });
  // No assertion on which workflows are unsynced: adding the sync action to one is the right fix and must not fail here.
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8'), /leaseGuard\.syncIfMissing\(\)/,
    `${unsynced.length} workflows rebuild without a lease sync step; the script's self-sync is their only guard`);
});

test('syncIfMissing: CLI that wrote the unknown marker reports unknown, not synced', () => {
  const file = tmpFile();
  assert.equal(guard.syncIfMissing({ file, env: { GITHUB_ACTIONS: 'true' }, run: () => fs.writeFileSync(file, '{"leases":{},"unknown":true}') }), 'unknown');
});
