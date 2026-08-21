/**
 * Tests for scripts/unabandon-fetch-cycles.js — the rollback for the fetch
 * retry lifecycle gate (BRO-787's shouldRetryFetch/recordFetchAttempt).
 *
 * Runs the real script as a subprocess against a synthetic fixture directory
 * (a temp dir with its own data/shows.json + data/review-texts/), mirroring
 * scripts/audit-cross-outlet-attributions.test.mjs's execFileSync pattern.
 * The script's fs calls are cwd-relative, so pointing `cwd` at the fixture
 * dir isolates it from the real corpus without touching production code.
 *
 * Run: node --test scripts/lib/unabandon-fetch-cycles.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'unabandon-fetch-cycles.js');

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unabandon-fetch-fixture-'));
  fs.mkdirSync(path.join(dir, 'data', 'review-texts', 'show-a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'review-texts', 'show-b'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'review-texts', 'show-c'), { recursive: true });

  const shows = [
    // show-a: WAS closedOld (>180d, strict max 0) when abandoned; the
    // closingDate has since been corrected to closedRecent (30d) — strict
    // max there is 2, so a single confirmed-dead failure no longer meets
    // the abandonment threshold. Should clear.
    { id: 'show-a', status: 'closed', closingDate: daysAgo(30) },
    // show-b: genuinely closedOld with a confirmed-dead failure at the
    // tiered max (0 retries) — still correctly gated, must stay abandoned.
    { id: 'show-b', status: 'closed', closingDate: daysAgo(200) },
    // show-c: not abandoned at all — untouched no-op.
    { id: 'show-c', status: 'open', openingDate: daysAgo(10), category: 'broadway' },
  ];
  fs.writeFileSync(path.join(dir, 'data', 'shows.json'), JSON.stringify({ shows }));

  const failedFetches = [
    { reviewId: 'show-a/review1.json', showId: 'show-a', failureReason: 'url_dead_404', failureCount: 1 },
    { reviewId: 'show-b/review1.json', showId: 'show-b', failureReason: 'url_dead_404', failureCount: 1 },
  ];
  fs.writeFileSync(path.join(dir, 'data', 'review-texts', 'failed-fetches.json'), JSON.stringify(failedFetches));

  const abandonedA = {
    url: 'https://example.com/show-a-review',
    outletId: 'example',
    fetchDiscoveryAbandoned: true,
    fetchAbandonmentReason: 'backfill:url_dead_404:1',
    fetchAbandonmentDate: '2026-06-01',
  };
  fs.writeFileSync(path.join(dir, 'data', 'review-texts', 'show-a', 'review1.json'), JSON.stringify(abandonedA));

  const abandonedB = {
    url: 'https://example.com/show-b-review',
    outletId: 'example',
    fetchDiscoveryAbandoned: true,
    fetchAbandonmentReason: 'backfill:url_dead_404:1',
    fetchAbandonmentDate: '2026-06-01',
  };
  fs.writeFileSync(path.join(dir, 'data', 'review-texts', 'show-b', 'review1.json'), JSON.stringify(abandonedB));

  const notAbandonedC = {
    url: 'https://example.com/show-c-review',
    outletId: 'example',
  };
  fs.writeFileSync(path.join(dir, 'data', 'review-texts', 'show-c', 'review1.json'), JSON.stringify(notAbandonedC));

  return dir;
}

function run(dir, extraArgs = []) {
  try {
    return execFileSync(process.execPath, [scriptPath, ...extraArgs], { cwd: dir, encoding: 'utf8' });
  } catch (err) {
    // Script exits 1 on error paths — surface stdout for assertions anyway.
    return err.stdout || '';
  }
}

test('abandoned-and-should-clear: reclassified show gets fetchDiscoveryAbandoned cleared', () => {
  const dir = makeFixture();
  run(dir);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-a', 'review1.json'), 'utf8'));
  assert.strictEqual(after.fetchDiscoveryAbandoned, null);
  assert.strictEqual(after.fetchAbandonmentReason, null);
  assert.strictEqual(after.fetchAbandonmentDate, null);
});

test('abandoned-and-still-correctly-gated: genuinely closedOld+dead stays abandoned', () => {
  const dir = makeFixture();
  run(dir);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-b', 'review1.json'), 'utf8'));
  assert.strictEqual(after.fetchDiscoveryAbandoned, true);
  assert.strictEqual(after.fetchAbandonmentReason, 'backfill:url_dead_404:1');
});

test('not-abandoned-noop: untouched file is left byte-identical', () => {
  const dir = makeFixture();
  const before = fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-c', 'review1.json'), 'utf8');
  run(dir);
  const after = fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-c', 'review1.json'), 'utf8');
  assert.strictEqual(after, before);
});

test('--dry-run makes no writes', () => {
  const dir = makeFixture();
  const before = fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-a', 'review1.json'), 'utf8');
  const out = run(dir, ['--dry-run']);
  assert.match(out, /DRY RUN/);
  const after = fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-a', 'review1.json'), 'utf8');
  assert.strictEqual(after, before);
});

test('--show filter scopes to a single show directory', () => {
  const dir = makeFixture();
  run(dir, ['--show=show-b']);
  // show-a wasn't scanned at all, so it must still be untouched despite
  // being a genuine reclassification candidate.
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-a', 'review1.json'), 'utf8'));
  assert.strictEqual(a.fetchDiscoveryAbandoned, true);
});

test('no ledger entry: abandoned file with no matching failed-fetches.json row is left alone', () => {
  const dir = makeFixture();
  fs.mkdirSync(path.join(dir, 'data', 'review-texts', 'show-d'), { recursive: true });
  const orphan = {
    url: 'https://example.com/show-d-review',
    fetchDiscoveryAbandoned: true,
    fetchAbandonmentReason: 'manual',
    fetchAbandonmentDate: '2026-01-01',
  };
  fs.writeFileSync(path.join(dir, 'data', 'review-texts', 'show-d', 'review1.json'), JSON.stringify(orphan));
  fs.writeFileSync(path.join(dir, 'data', 'shows.json'), JSON.stringify({
    shows: [
      { id: 'show-a', status: 'closed', closingDate: daysAgo(30) },
      { id: 'show-b', status: 'closed', closingDate: daysAgo(200) },
      { id: 'show-c', status: 'open', openingDate: daysAgo(10), category: 'broadway' },
      { id: 'show-d', status: 'closed', closingDate: daysAgo(30) },
    ],
  }));
  run(dir);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'review-texts', 'show-d', 'review1.json'), 'utf8'));
  assert.strictEqual(after.fetchDiscoveryAbandoned, true, 'no ledger entry means nothing to re-derive against — must not blind-clear');
});
