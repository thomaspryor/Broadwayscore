// BRO-2268: hermetic fixture test for scripts/backfill-fetch-abandonment.js,
// plus a real-ledger invariant when the private review-texts repo is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve('scripts/backfill-fetch-abandonment.js');
const { shouldRetryFetch } = require('./lib/review-guards.js');

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
  // idempotent
  assert.match(run(dir, '--dry-run').stdout, /Candidates to abandon:\s+0\b/);
});

// Real data (Mac Studio only): after the BRO-2268 backfill no ledger entry
// may still be a gate-confirmed abandonment candidate.
const realDir = path.join(os.homedir(), 'broadway-review-texts');
const realShows = path.resolve('data/shows.json');
test('real ledger has zero remaining abandonment candidates',
  { skip: !fs.existsSync(path.join(realDir, 'failed-fetches.json')) || !fs.existsSync(realShows) },
  () => {
    const shows = JSON.parse(fs.readFileSync(realShows, 'utf8'));
    const byId = Object.fromEntries((shows.shows || shows).map((s) => [s.id, s]));
    const ledger = JSON.parse(fs.readFileSync(path.join(realDir, 'failed-fetches.json'), 'utf8'));
    const stale = [];
    for (const f of ledger) {
      const p = path.join(realDir, f.showId || '', f.file || '');
      if (!f.showId || !f.file || !fs.existsSync(p)) continue;
      const review = JSON.parse(fs.readFileSync(p, 'utf8'));
      const g = shouldRetryFetch(byId[f.showId] || null, review,
        { failureReason: f.failureReason || '', failureCount: f.failureCount || 1 });
      if (!g.shouldRetry && g.updates?.fetchDiscoveryAbandoned) stale.push(`${f.showId}/${f.file}`);
    }
    assert.deepEqual(stale.slice(0, 5), []);
  });
