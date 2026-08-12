// Tests for the outlet stub-rate & invalid-content-rate monitor
// (scripts/audit-outlet-stub-rate.js, card #100, generalized by card #1244).
// Requires the REAL collectReviewRecords/computeOutletStubRates/
// computeOutletInvalidRates per CLAUDE.md §15 — no logic copies. Registered
// explicitly in tests/unit-test-manifest.txt (root-level scripts/*.test.mjs
// is not globbed).
//
// Born from TheaterMania's 2026 Bootstrap redesign: its article-extractor.js
// pattern silently stopped matching, 26 reviews corpus-wide sat as
// contentTier:stub, and nothing alerted — caught by accident chasing one
// unrelated show. computeOutletStubRates() is the detector that should have
// caught it: a spike in the STUB rate among RECENTLY collected reviews for
// one outlet, distinct from legacy/pre-collection-era stub debt.
//
// computeOutletInvalidRates() (card #1244) generalizes the same idea to
// contentTier:'invalid' (extraction returned something, just not real
// article text). Corpus probe on 2026-08-11 found 'invalid' is 23x larger
// than 'stub' and includes outlets that are CHRONICALLY near-100% invalid
// (paywalled/bot-blocked) — a flat rate threshold false-positived on 22
// outlets including Variety, Deadline, Hollywood Reporter, Daily Mail. So
// computeOutletInvalidRates additionally requires the recent rate to SPIKE
// over the outlet's own pre-window baseline; the tests below cover both the
// shared threshold behavior and that baseline-spike differentiator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectReviewRecords, computeOutletStubRates, computeOutletInvalidRates, computeOutletTierRates } = require('./audit-outlet-stub-rate.js');

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n) {
  return new Date(NOW - n * DAY).toISOString();
}

function rec(outletId, contentTier, textFetchedAt, outlet, contentTierReason) {
  return { outletId, outlet: outlet || null, contentTier, textFetchedAt, contentTierReason: contentTierReason || null };
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

// ── computeOutletInvalidRates (card #1244): shared threshold behavior ─────

test('invalid: flags an outlet whose recent reviews are mostly invalid, spiking from a clean baseline', () => {
  const records = [
    // broken-outlet: clean baseline (0/2 invalid), then a recent spike to
    // 3/4 invalid (75% > 50%, count 3 >= 3, spike 75%-0%=75% >= 30pt delta)
    rec('broken-outlet', 'invalid', daysAgo(1), 'Broken Outlet'),
    rec('broken-outlet', 'invalid', daysAgo(2)),
    rec('broken-outlet', 'invalid', daysAgo(5)),
    rec('broken-outlet', 'complete', daysAgo(10)),
    rec('broken-outlet', 'complete', daysAgo(60)),
    rec('broken-outlet', 'complete', daysAgo(90)),
    // healthy-outlet: mixed, mostly complete — not flagged
    rec('healthy-outlet', 'complete', daysAgo(1), 'Healthy Outlet'),
    rec('healthy-outlet', 'complete', daysAgo(3)),
    rec('healthy-outlet', 'invalid', daysAgo(4)),
    rec('healthy-outlet', 'complete', daysAgo(6)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });

  assert.deepEqual(flaggedOutletIds, ['broken-outlet']);

  const broken = outlets.find((o) => o.outletId === 'broken-outlet');
  assert.equal(broken.flagged, true);
  assert.equal(broken.recentTotal, 4);
  assert.equal(broken.recentInvalidCount, 3);
  assert.equal(broken.recentInvalidRate, 0.75);
  assert.equal(broken.baselineInvalidRate, 0);
  assert.equal(broken.outlet, 'Broken Outlet');

  const healthy = outlets.find((o) => o.outletId === 'healthy-outlet');
  assert.equal(healthy.flagged, false);
});

test('invalid: a chronically-invalid outlet (steady rate, no spike) is NOT flagged even above 50%/3 — the false-positive class this tier exists to filter', () => {
  // Mirrors the corpus probe finding (2026-08-11): major outlets like
  // Variety/Daily Mail sit at a high invalid rate for a long time
  // (paywalled/bot-blocked) without a new break. Recent rate alone clears
  // the >50%/>=3 bar, but it's flat vs. baseline, so it must not flag.
  const records = [
    rec('chronic-outlet', 'invalid', daysAgo(1)),
    rec('chronic-outlet', 'invalid', daysAgo(2)),
    rec('chronic-outlet', 'invalid', daysAgo(3)),
    rec('chronic-outlet', 'complete', daysAgo(5)),
    // baseline: same ~70% invalid rate as recent, well past minBaseline
    rec('chronic-outlet', 'invalid', daysAgo(60)),
    rec('chronic-outlet', 'invalid', daysAgo(90)),
    rec('chronic-outlet', 'invalid', daysAgo(120)),
    rec('chronic-outlet', 'invalid', daysAgo(150)),
    rec('chronic-outlet', 'invalid', daysAgo(180)),
    rec('chronic-outlet', 'invalid', daysAgo(210)),
    rec('chronic-outlet', 'invalid', daysAgo(240)),
    rec('chronic-outlet', 'complete', daysAgo(270)),
    rec('chronic-outlet', 'complete', daysAgo(300)),
    rec('chronic-outlet', 'complete', daysAgo(330)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'chronic-outlet');
  assert.ok(o.recentInvalidRate > 0.5 && o.recentInvalidCount >= 3, 'sanity: clears the flat threshold');
  assert.ok(o.baselineTotal >= 5, 'sanity: baseline sample is large enough to trust');
  assert.ok(o.recentInvalidRate - o.baselineInvalidRate < 0.3, 'sanity: no real spike over baseline');
  assert.equal(o.flagged, false);
  assert.deepEqual(flaggedOutletIds, []);
});

test('invalid: a brand-new outlet with no baseline history (insufficient sample) still flags on the plain threshold', () => {
  // No baseline signal exists yet to compare against — computeOutletTierRates
  // falls back to the flat rate+count threshold rather than silently passing
  // outlets too new to have a trustworthy baseline.
  const records = [
    rec('new-outlet', 'invalid', daysAgo(1)),
    rec('new-outlet', 'invalid', daysAgo(2)),
    rec('new-outlet', 'invalid', daysAgo(3)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'new-outlet');
  assert.equal(o.baselineTotal, 0);
  assert.equal(o.flagged, true);
  assert.deepEqual(flaggedOutletIds, ['new-outlet']);
});

test('invalid: old pre-collection-era invalid records do not count toward the recent window', () => {
  const records = [
    rec('legacy-outlet', 'invalid', daysAgo(400)),
    rec('legacy-outlet', 'invalid', daysAgo(500)),
    rec('legacy-outlet', 'invalid', daysAgo(600)),
    rec('legacy-outlet', 'invalid', daysAgo(700)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  assert.deepEqual(flaggedOutletIds, []);
  const legacy = outlets.find((o) => o.outletId === 'legacy-outlet');
  assert.equal(legacy.invalidRate, 1);
  assert.equal(legacy.recentTotal, 0);
  assert.equal(legacy.recentInvalidRate, 0);
  assert.equal(legacy.flagged, false);
});

test('invalid: an outlet with fewer than 3 recent invalid records is not flagged even at 100% recent rate', () => {
  const records = [
    rec('small-outlet', 'invalid', daysAgo(1)),
    rec('small-outlet', 'invalid', daysAgo(2)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  assert.deepEqual(flaggedOutletIds, []);
  const small = outlets.find((o) => o.outletId === 'small-outlet');
  assert.equal(small.recentInvalidRate, 1);
  assert.equal(small.recentInvalidCount, 2);
  assert.equal(small.flagged, false);
});

test('invalid: an outlet at exactly 50% recent invalid rate is not flagged (threshold is strictly greater than 50%)', () => {
  const records = [
    rec('half-outlet', 'invalid', daysAgo(1)),
    rec('half-outlet', 'invalid', daysAgo(1)),
    rec('half-outlet', 'invalid', daysAgo(1)),
    rec('half-outlet', 'complete', daysAgo(1)),
    rec('half-outlet', 'complete', daysAgo(1)),
    rec('half-outlet', 'complete', daysAgo(1)),
  ];
  const { outlets } = computeOutletInvalidRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'half-outlet');
  assert.equal(o.recentInvalidRate, 0.5);
  assert.equal(o.flagged, false);
});

test('invalid: requireBaselineSpike can be disabled via opts to fall back to the plain threshold shape', () => {
  const records = [
    rec('chronic-outlet', 'invalid', daysAgo(1)),
    rec('chronic-outlet', 'invalid', daysAgo(2)),
    rec('chronic-outlet', 'invalid', daysAgo(3)),
    rec('chronic-outlet', 'invalid', daysAgo(60)),
    rec('chronic-outlet', 'invalid', daysAgo(90)),
    rec('chronic-outlet', 'invalid', daysAgo(120)),
    rec('chronic-outlet', 'invalid', daysAgo(150)),
    rec('chronic-outlet', 'invalid', daysAgo(180)),
  ];
  const withSpikeCheck = computeOutletInvalidRates(records, { nowMs: NOW });
  const withoutSpikeCheck = computeOutletInvalidRates(records, { nowMs: NOW, requireBaselineSpike: false });
  assert.deepEqual(withSpikeCheck.flaggedOutletIds, []);
  assert.deepEqual(withoutSpikeCheck.flaggedOutletIds, ['chronic-outlet']);
});

test('invalid: every outlet record has the expected schema, including baseline fields, and value ranges', () => {
  const records = [
    rec('schema-outlet', 'invalid', daysAgo(1)),
    rec('schema-outlet', 'complete', daysAgo(40)),
  ];
  const { outlets } = computeOutletInvalidRates(records, { nowMs: NOW });
  const o = outlets[0];
  const expectedKeys = [
    'outletId', 'outlet', 'total', 'invalidCount', 'invalidRate',
    'recentTotal', 'recentInvalidCount', 'recentInvalidRate',
    'baselineTotal', 'baselineInvalidCount', 'baselineInvalidRate', 'flagged',
  ].sort();
  assert.deepEqual(Object.keys(o).sort(), expectedKeys);
  assert.equal(typeof o.outletId, 'string');
  assert.equal(typeof o.outlet, 'string');
  assert.equal(typeof o.flagged, 'boolean');
  for (const rate of [o.invalidRate, o.recentInvalidRate, o.baselineInvalidRate]) {
    assert.ok(rate >= 0 && rate <= 1, `rate ${rate} out of [0,1] range`);
  }
  assert.ok(o.invalidCount <= o.total);
  assert.ok(o.recentInvalidCount <= o.recentTotal);
  assert.ok(o.recentTotal <= o.total);
  assert.ok(o.baselineInvalidCount <= o.baselineTotal);
  assert.equal(o.baselineTotal + o.recentTotal, o.total);
});

test('invalid: collectReviewRecords + computeOutletInvalidRates walk a real review-texts fixture tree end-to-end', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-invalid-rate-test-'));
  try {
    const showDir = path.join(tmpDir, 'some-show-2026');
    fs.mkdirSync(showDir);
    fs.writeFileSync(
      path.join(showDir, 'broken-outlet--critic-a.json'),
      JSON.stringify({ outletId: 'broken-outlet', outlet: 'Broken Outlet', contentTier: 'invalid', textFetchedAt: daysAgo(1) }),
    );
    fs.writeFileSync(
      path.join(showDir, 'broken-outlet--critic-b.json'),
      JSON.stringify({ outletId: 'broken-outlet', contentTier: 'complete', textFetchedAt: daysAgo(2) }),
    );

    const records = collectReviewRecords(tmpDir);
    assert.equal(records.length, 2);

    const { outlets } = computeOutletInvalidRates(records, { nowMs: NOW });
    assert.equal(outlets.length, 1);
    assert.equal(outlets[0].total, 2);
    assert.equal(outlets[0].invalidCount, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── computeOutletInvalidRates (card #1266): excludes wrongProduction/
// wrongShow-reasoned records so this extractor-health check doesn't conflate
// with the unrelated wrongProduction FP sweep (tasks #24/#243) ────────────

test('invalid: an outlet whose recent invalid spike is 100% wrongProduction-reasoned is NOT flagged', () => {
  const records = [
    // All 4 recent "invalid" records are the wrongProduction/wrongShow gate,
    // not a broken extractor — real article text, wrong show matched.
    rec('cross-market-outlet', 'invalid', daysAgo(1), null, 'Wrong production'),
    rec('cross-market-outlet', 'invalid', daysAgo(2), null, 'Wrong production'),
    rec('cross-market-outlet', 'invalid', daysAgo(3), null, 'Wrong show'),
    rec('cross-market-outlet', 'invalid', daysAgo(4), null, 'Wrong show'),
    rec('cross-market-outlet', 'complete', daysAgo(10)),
    rec('cross-market-outlet', 'complete', daysAgo(60)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  assert.deepEqual(flaggedOutletIds, []);
  const o = outlets.find((x) => x.outletId === 'cross-market-outlet');
  // The wrongProduction/wrongShow records are excluded from the pool
  // entirely, not just uncounted as invalid — total shrinks accordingly.
  assert.equal(o.total, 2);
  assert.equal(o.recentTotal, 1); // daysAgo(10) is within the 30-day window
  assert.equal(o.invalidCount, 0);
  assert.equal(o.flagged, false);
});

test('invalid: a genuine extractor-failure spike is still flagged when a wrongProduction spike coexists at the same outlet', () => {
  const records = [
    // Genuine broken-extractor signature: 3 recent invalid with a real
    // extraction-failure reason.
    rec('mixed-outlet', 'invalid', daysAgo(1), null, 'Garbage content: Cookie consent/GDPR banner'),
    rec('mixed-outlet', 'invalid', daysAgo(2), null, 'Garbage content: Cookie consent/GDPR banner'),
    rec('mixed-outlet', 'invalid', daysAgo(3), null, 'Garbage content: Cookie consent/GDPR banner'),
    // Plus a batch of wrongProduction noise that must not dilute or hide the signal.
    rec('mixed-outlet', 'invalid', daysAgo(1), null, 'Wrong production'),
    rec('mixed-outlet', 'invalid', daysAgo(2), null, 'Wrong production'),
    rec('mixed-outlet', 'complete', daysAgo(60)),
    rec('mixed-outlet', 'complete', daysAgo(90)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  assert.deepEqual(flaggedOutletIds, ['mixed-outlet']);
  const o = outlets.find((x) => x.outletId === 'mixed-outlet');
  assert.equal(o.recentTotal, 3);
  assert.equal(o.recentInvalidCount, 3);
});

test('invalid: wrongProduction exclusion can be disabled via opts.excludeTierReasons for callers that want the raw rate', () => {
  const records = [
    rec('cross-market-outlet', 'invalid', daysAgo(1), null, 'Wrong production'),
    rec('cross-market-outlet', 'invalid', daysAgo(2), null, 'Wrong production'),
    rec('cross-market-outlet', 'invalid', daysAgo(3), null, 'Wrong show'),
    rec('cross-market-outlet', 'complete', daysAgo(10)),
  ];
  const excluded = computeOutletInvalidRates(records, { nowMs: NOW });
  const included = computeOutletInvalidRates(records, { nowMs: NOW, excludeTierReasons: [] });
  assert.deepEqual(excluded.flaggedOutletIds, []);
  assert.deepEqual(included.flaggedOutletIds, ['cross-market-outlet']);
});

test('invalid: computeOutletStubRates is unaffected by the wrongProduction exclusion (stub tier never carries those reasons)', () => {
  const records = [
    rec('stub-outlet', 'stub', daysAgo(1), null, 'Wrong production'), // synthetic; stub-tier never actually gets this reason
    rec('stub-outlet', 'stub', daysAgo(2), null, 'Wrong production'),
    rec('stub-outlet', 'stub', daysAgo(3), null, 'Wrong production'),
    rec('stub-outlet', 'complete', daysAgo(10)),
  ];
  const { flaggedOutletIds } = computeOutletStubRates(records, { nowMs: NOW });
  // computeOutletStubRates has no excludeTierReasons default — it still flags.
  assert.deepEqual(flaggedOutletIds, ['stub-outlet']);
});

test('computeOutletTierRates: excludeTierReasons removes matching records from total/recent/baseline, not just the tier count', () => {
  const records = [
    rec('outlet-x', 'invalid', daysAgo(1), null, 'Wrong production'),
    rec('outlet-x', 'complete', daysAgo(2)),
    rec('outlet-x', 'complete', daysAgo(60)),
  ];
  const { outlets } = computeOutletTierRates(records, {
    nowMs: NOW,
    tier: 'invalid',
    excludeTierReasons: ['Wrong production'],
  });
  const o = outlets.find((x) => x.outletId === 'outlet-x');
  assert.equal(o.total, 2);
  assert.equal(o.recentTotal, 1);
  assert.equal(o.baselineTotal, 1);
});

test('invalid: exclusion shrinking baselineTotal below the trust floor does NOT reopen the no-history bypass — outlet is NOT flagged', () => {
  // established-outlet has a real 6-record baseline (>= minBaselineForSpikeCheck),
  // but 5 of those 6 are wrongProduction noise. After exclusion, the clean
  // baseline is just 1 record — below the trust floor. Recent is a modest,
  // stable-looking genuine-invalid rate (not an actual spike vs. what little
  // clean baseline exists). Before the #1273-class fix, shrinking
  // baselineTotal below 5 would fall through to the plain-threshold bypass
  // and flag this outlet purely because exclusion thinned its clean sample —
  // not because anything about its extractor actually changed.
  const records = [
    rec('established-outlet', 'invalid', daysAgo(1), null, undefined), // genuine, recent
    rec('established-outlet', 'invalid', daysAgo(2), null, undefined), // genuine, recent
    rec('established-outlet', 'invalid', daysAgo(3), null, undefined), // genuine, recent
    rec('established-outlet', 'complete', daysAgo(4)), // recent
    rec('established-outlet', 'invalid', daysAgo(60), null, undefined), // genuine, baseline (1 clean baseline record)
    rec('established-outlet', 'invalid', daysAgo(70), null, 'Wrong production'), // baseline, excluded
    rec('established-outlet', 'invalid', daysAgo(80), null, 'Wrong production'), // baseline, excluded
    rec('established-outlet', 'invalid', daysAgo(90), null, 'Wrong show'), // baseline, excluded
    rec('established-outlet', 'invalid', daysAgo(100), null, 'Wrong production'), // baseline, excluded
    rec('established-outlet', 'invalid', daysAgo(110), null, 'Wrong production'), // baseline, excluded
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'established-outlet');
  assert.ok(o.recentInvalidRate > 0.5 && o.recentInvalidCount >= 3, 'sanity: clears the plain rate threshold');
  assert.equal(o.baselineTotal, 1, 'sanity: clean baseline shrank below the trust floor');
  assert.equal(o.flagged, false);
  assert.deepEqual(flaggedOutletIds, []);
});

test('invalid: a genuinely thin/new outlet (no real history either way) still flags on the plain threshold after exclusion', () => {
  // Contrast with the previous test: here there is NO baseline at all, with
  // or without exclusion — a brand-new outlet, not one whose baseline was
  // thinned by exclusion. The pre-#1266 bypass must still apply.
  const records = [
    rec('new-outlet-2', 'invalid', daysAgo(1)),
    rec('new-outlet-2', 'invalid', daysAgo(2)),
    rec('new-outlet-2', 'invalid', daysAgo(3)),
  ];
  const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records, { nowMs: NOW });
  const o = outlets.find((x) => x.outletId === 'new-outlet-2');
  assert.equal(o.baselineTotal, 0);
  assert.equal(o.flagged, true);
  assert.deepEqual(flaggedOutletIds, ['new-outlet-2']);
});
