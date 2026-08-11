// Tests for the outlet stub-rate monitor (scripts/audit-outlet-stub-rate.js,
// card #100). Requires the REAL collectReviewRecords/computeOutletStubRates
// per CLAUDE.md §15 — no logic copies. Registered explicitly in
// tests/unit-test-manifest.txt (root-level scripts/*.test.mjs is not globbed).
//
// Born from TheaterMania's 2026 Bootstrap redesign: its article-extractor.js
// pattern silently stopped matching, 26 reviews corpus-wide sat as
// contentTier:stub, and nothing alerted — caught by accident chasing one
// unrelated show. computeOutletStubRates() is the detector that should have
// caught it: a spike in the STUB rate among RECENTLY collected reviews for
// one outlet, distinct from legacy/pre-collection-era stub debt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectReviewRecords, computeOutletStubRates } = require('./audit-outlet-stub-rate.js');

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n) {
  return new Date(NOW - n * DAY).toISOString();
}

function rec(outletId, contentTier, textFetchedAt, outlet) {
  return { outletId, outlet: outlet || null, contentTier, textFetchedAt };
}

// ── computeOutletStubRates: happy path ──────────────────────────────────

test('flags an outlet whose recent reviews are mostly stubs (broken-extractor signature)', () => {
  const records = [
    // broken-outlet: 4 recent, 3 stubs (75% > 50%, count 3 >= 3) — flagged
    rec('broken-outlet', 'stub', daysAgo(1), 'Broken Outlet'),
    rec('broken-outlet', 'stub', daysAgo(2)),
    rec('broken-outlet', 'stub', daysAgo(5)),
    rec('broken-outlet', 'complete', daysAgo(10)),
    // healthy-outlet: mixed, mostly complete — not flagged
    rec('healthy-outlet', 'complete', daysAgo(1), 'Healthy Outlet'),
    rec('healthy-outlet', 'complete', daysAgo(3)),
    rec('healthy-outlet', 'stub', daysAgo(4)),
    rec('healthy-outlet', 'complete', daysAgo(6)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletStubRates(records, { nowMs: NOW });

  assert.deepEqual(flaggedOutletIds, ['broken-outlet']);

  const broken = outlets.find((o) => o.outletId === 'broken-outlet');
  assert.equal(broken.flagged, true);
  assert.equal(broken.recentTotal, 4);
  assert.equal(broken.recentStubCount, 3);
  assert.equal(broken.recentStubRate, 0.75);
  assert.equal(broken.outlet, 'Broken Outlet');

  const healthy = outlets.find((o) => o.outletId === 'healthy-outlet');
  assert.equal(healthy.flagged, false);
});

// ── recent vs. old boundary ──────────────────────────────────────────────

test('old pre-collection-era stubs do not count toward the recent window', () => {
  const records = [
    // legacy-outlet: 100% all-time stub rate, but every stub predates the
    // 30-day recency window — this is the "old stubs are normal" case the
    // card explicitly calls out, must NOT be flagged.
    rec('legacy-outlet', 'stub', daysAgo(400)),
    rec('legacy-outlet', 'stub', daysAgo(500)),
    rec('legacy-outlet', 'stub', daysAgo(600)),
    rec('legacy-outlet', 'stub', daysAgo(700)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletStubRates(records, { nowMs: NOW });

  assert.deepEqual(flaggedOutletIds, []);
  const legacy = outlets.find((o) => o.outletId === 'legacy-outlet');
  assert.equal(legacy.stubRate, 1);
  assert.equal(legacy.recentTotal, 0);
  assert.equal(legacy.recentStubRate, 0);
  assert.equal(legacy.flagged, false);
});

test('a review exactly at the 30-day boundary counts as recent; one day past does not', () => {
  const records = [
    rec('boundary-outlet', 'stub', daysAgo(30)), // inside window (<=)
    rec('boundary-outlet', 'stub', daysAgo(31)), // outside window
    rec('boundary-outlet', 'stub', daysAgo(30)),
    rec('boundary-outlet', 'stub', daysAgo(30)),
  ];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'boundary-outlet');
  assert.equal(o.recentTotal, 3);
  assert.equal(o.recentStubCount, 3);
  assert.equal(o.flagged, true); // 100% recent stub rate, count 3 >= 3
});

// ── edge cases ────────────────────────────────────────────────────────────

test('an outlet with fewer than 3 recent stubs is not flagged even at 100% recent stub rate', () => {
  const records = [
    rec('small-outlet', 'stub', daysAgo(1)),
    rec('small-outlet', 'stub', daysAgo(2)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletStubRates(records, { nowMs: NOW });
  assert.deepEqual(flaggedOutletIds, []);
  const small = outlets.find((o) => o.outletId === 'small-outlet');
  assert.equal(small.recentStubRate, 1);
  assert.equal(small.recentStubCount, 2);
  assert.equal(small.flagged, false);
});

test('an outlet at exactly 50% recent stub rate is not flagged (threshold is strictly greater than 50%)', () => {
  const records = [
    rec('half-outlet', 'stub', daysAgo(1)),
    rec('half-outlet', 'stub', daysAgo(1)),
    rec('half-outlet', 'stub', daysAgo(1)),
    rec('half-outlet', 'complete', daysAgo(1)),
    rec('half-outlet', 'complete', daysAgo(1)),
    rec('half-outlet', 'complete', daysAgo(1)),
  ];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'half-outlet');
  assert.equal(o.recentStubRate, 0.5);
  assert.equal(o.flagged, false);
});

test('100% recent stub rate with the minimum flag count IS flagged', () => {
  const records = [
    rec('fully-broken', 'stub', daysAgo(1)),
    rec('fully-broken', 'stub', daysAgo(2)),
    rec('fully-broken', 'stub', daysAgo(3)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletStubRates(records, { nowMs: NOW });
  assert.deepEqual(flaggedOutletIds, ['fully-broken']);
  const o = outlets.find((x) => x.outletId === 'fully-broken');
  assert.equal(o.recentStubRate, 1);
  assert.equal(o.recentTotal, 3);
});

test('records with a missing or unparseable textFetchedAt are excluded from the recent window, not counted as recent', () => {
  const records = [
    rec('no-timestamp-outlet', 'stub', null),
    rec('no-timestamp-outlet', 'stub', undefined),
    rec('no-timestamp-outlet', 'stub', 'not-a-date'),
    rec('no-timestamp-outlet', 'stub', daysAgo(1)),
  ];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'no-timestamp-outlet');
  assert.equal(o.total, 4);
  assert.equal(o.stubCount, 4);
  assert.equal(o.recentTotal, 1); // only the one real recent timestamp
});

test('a future-dated textFetchedAt (clock skew) is excluded from the recent window rather than crashing or double-counting', () => {
  const records = [rec('future-outlet', 'stub', daysAgo(-5))];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'future-outlet');
  assert.equal(o.recentTotal, 0);
});

test('empty input returns an empty outlet list and no flags', () => {
  const { outlets, flaggedOutletIds } = computeOutletStubRates([], { nowMs: NOW });
  assert.deepEqual(outlets, []);
  assert.deepEqual(flaggedOutletIds, []);
});

test('records with no outletId are skipped entirely', () => {
  const records = [
    { outletId: null, contentTier: 'stub', textFetchedAt: daysAgo(1) },
    { contentTier: 'stub', textFetchedAt: daysAgo(1) },
    rec('real-outlet', 'complete', daysAgo(1)),
  ];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  assert.equal(outlets.length, 1);
  assert.equal(outlets[0].outletId, 'real-outlet');
});

// ── output schema ─────────────────────────────────────────────────────────

test('every outlet record has the expected schema and value ranges', () => {
  const records = [
    rec('schema-outlet', 'stub', daysAgo(1)),
    rec('schema-outlet', 'complete', daysAgo(40)),
  ];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  const o = outlets[0];
  const expectedKeys = ['outletId', 'outlet', 'total', 'stubCount', 'stubRate', 'recentTotal', 'recentStubCount', 'recentStubRate', 'flagged'].sort();
  assert.deepEqual(Object.keys(o).sort(), expectedKeys);
  assert.equal(typeof o.outletId, 'string');
  assert.equal(typeof o.outlet, 'string');
  assert.equal(typeof o.total, 'number');
  assert.equal(typeof o.stubCount, 'number');
  assert.equal(typeof o.flagged, 'boolean');
  for (const rate of [o.stubRate, o.recentStubRate]) {
    assert.ok(rate >= 0 && rate <= 1, `rate ${rate} out of [0,1] range`);
  }
  assert.ok(o.stubCount <= o.total);
  assert.ok(o.recentStubCount <= o.recentTotal);
  assert.ok(o.recentTotal <= o.total);
});

test('falls back to outletId as the display name when no outlet field was ever present', () => {
  const records = [{ outletId: 'nameless', contentTier: 'complete', textFetchedAt: daysAgo(1) }];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  assert.equal(outlets[0].outlet, 'nameless');
});

test('flagged outlets sort first, then by recent stub rate descending', () => {
  const records = [
    rec('low-flagged', 'stub', daysAgo(1)),
    rec('low-flagged', 'stub', daysAgo(1)),
    rec('low-flagged', 'stub', daysAgo(1)),
    rec('low-flagged', 'complete', daysAgo(1)),
    rec('low-flagged', 'complete', daysAgo(1)),
    rec('unflagged-high', 'stub', daysAgo(1)),
    rec('unflagged-high', 'complete', daysAgo(1)),
    rec('high-flagged', 'stub', daysAgo(1)),
    rec('high-flagged', 'stub', daysAgo(1)),
    rec('high-flagged', 'stub', daysAgo(1)),
  ];
  const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
  const flaggedIds = outlets.filter((o) => o.flagged).map((o) => o.outletId);
  assert.deepEqual(flaggedIds, ['high-flagged', 'low-flagged']); // both flagged, 100% before 60%
  assert.equal(outlets[0].flagged, true);
  assert.equal(outlets[outlets.length - 1].outletId, 'unflagged-high'); // unflagged sorts after all flagged
});

// ── collectReviewRecords: I/O boundary (real filesystem, tmp fixture) ─────

test('collectReviewRecords walks a real review-texts fixture tree end-to-end', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-stub-rate-test-'));
  try {
    const showDir = path.join(tmpDir, 'some-show-2026');
    fs.mkdirSync(showDir);
    fs.writeFileSync(
      path.join(showDir, 'broken-outlet--critic-a.json'),
      JSON.stringify({ outletId: 'broken-outlet', outlet: 'Broken Outlet', contentTier: 'stub', textFetchedAt: daysAgo(1) }),
    );
    fs.writeFileSync(
      path.join(showDir, 'broken-outlet--critic-b.json'),
      JSON.stringify({ outletId: 'broken-outlet', contentTier: 'complete', textFetchedAt: daysAgo(2) }),
    );
    // sentinel dir must be skipped
    const pendingDir = path.join(tmpDir, '_pending');
    fs.mkdirSync(pendingDir);
    fs.writeFileSync(
      path.join(pendingDir, 'broken-outlet--critic-c.json'),
      JSON.stringify({ outletId: 'broken-outlet', contentTier: 'stub', textFetchedAt: daysAgo(1) }),
    );
    // non-JSON stray file must be skipped without crashing
    fs.writeFileSync(path.join(tmpDir, 'failed-fetches.json'), '{}');

    const records = collectReviewRecords(tmpDir);
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.showId === 'some-show-2026'));

    const { outlets } = computeOutletStubRates(records, { nowMs: NOW });
    assert.equal(outlets.length, 1);
    assert.equal(outlets[0].total, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
