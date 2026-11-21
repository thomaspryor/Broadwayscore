// BRO-2268: hermetic fixture test for scripts/backfill-fetch-abandonment.js.
// No real-ledger check here: the gate is date-based (closedOld flips at 180d), so a
// live-data assertion would redden with no code change. Real-data check: the script's --dry-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve('scripts/backfill-fetch-abandonment.js');

function run(cwd, ...args) {
  return spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2268-'));
  fs.mkdirSync(path.join(dir, 'data/review-texts/old-show-2001'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data/review-texts/live-show-2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/shows.json'), JSON.stringify({ shows: [
    { id: 'old-show-2001', status: 'closed', closingDate: '2002-01-01' },
    { id: 'live-show-2026', status: 'open', openingDate: new Date().toISOString().slice(0, 10) },
  ] }));
  const w = (id, file, obj) =>
    fs.writeFileSync(path.join(dir, 'data/review-texts', id, file), JSON.stringify(obj, null, 2));
  w('old-show-2001', 'a--x.json', { url: 'u1', keep: 'me' });
  w('old-show-2001', 'b--y.json', { url: 'u2', fetchDiscoveryAbandoned: true });
  w('live-show-2026', 'c--z.json', { url: 'u3' });
  fs.writeFileSync(path.join(dir, 'data/review-texts/failed-fetches.json'), JSON.stringify([
    { showId: 'old-show-2001', file: 'a--x.json', failureReason: 'url_dead_404', failureCount: 5 },
    { showId: 'old-show-2001', file: 'b--y.json', failureReason: 'url_dead_404', failureCount: 5 },
    { showId: 'live-show-2026', file: 'c--z.json', failureReason: 'url_dead_404', failureCount: 1 },
  ]));
  return dir;
}

const read = (dir, id, f) => JSON.parse(fs.readFileSync(path.join(dir, 'data/review-texts', id, f), 'utf8'));

test('dry-run reports candidates without writing', () => {
  const dir = makeFixture();
  const r = run(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Candidates to abandon:\s+1\b/);
  assert.match(r.stdout, /Already abandoned:\s+1\b/);
  assert.equal(read(dir, 'old-show-2001', 'a--x.json').fetchDiscoveryAbandoned, undefined);
});

test('live run abandons exhausted closed-old entry only, nothing else disturbed', () => {
  const dir = makeFixture();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const a = read(dir, 'old-show-2001', 'a--x.json');
  assert.equal(a.fetchDiscoveryAbandoned, true);
  assert.match(a.fetchAbandonmentReason, /^backfill:url_dead_404:5$/);
  assert.equal(a.keep, 'me');
  assert.equal(a.url, 'u1');
  assert.equal(read(dir, 'live-show-2026', 'c--z.json').fetchDiscoveryAbandoned, undefined);
  assert.deepEqual(read(dir, 'old-show-2001', 'b--y.json'), { url: 'u2', fetchDiscoveryAbandoned: true });
  // idempotent
  assert.match(run(dir, '--dry-run').stdout, /Candidates to abandon:\s+0\b/);
});
