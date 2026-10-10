// TESTS-VS-DERIVED-DATA-EXEMPT: structural check that measured coverage
// (derived from current shows.json/reviews.json) doesn't drift from the
// registry's coverageExpectation claim — not a pinned fact about any show.
//
// Regression test for BRO-2297 — the coverageExpectation drift health check
// flagged ap, broadwaynews, latimes as needing re-decision (their
// coverageExpectationDecidedAt had aged past the 14-day decay window). Fixed
// by re-measuring and refreshing outlet-registry.json. This guards the fix:
// if any outlet's claim decays again without a re-decision, the health check
// should catch it, not silently drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateCoverageExpectationDrift } = require('../../scripts/audit-standing-coverage.js');

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

test('outlet-registry.json carries no coverageExpectation drift on the previously flagged outlets', () => {
  const shows = readJson('data/shows.json').shows;
  const reviews = readJson('data/reviews.json').reviews;
  const outlets = readJson('data/outlet-registry.json').outlets;

  // Pinned to shortly after EACH outlet's own coverageExpectationDecidedAt,
  // not Date.now() (BRO-1987 — found by scripts/audit-time-bomb-tests.js: this
  // test passed today and would have started failing ~14 days after whatever
  // date it happened to run on, with no commit behind it, once decidedAt aged
  // past COVERAGE_EXPECTATION_DECAY_DAYS). The live clock is correct for the
  // actual production check (scripts/audit-standing-coverage.js's cron, which
  // must notice real drift); this unit test's job is only to confirm the decay
  // logic treats a freshly-decided outlet as fresh. Evaluated per-outlet (not
  // a single shared pin across all three) so a future re-probe that refreshes
  // only one of them can never leave an older sibling's decidedAt stale
  // relative to the pin (ship-check/Codex finding).
  for (const outletId of ['ap', 'broadwaynews', 'latimes']) {
    const decidedAtMs = Date.parse(outlets[outletId].coverageExpectationDecidedAt);
    const { rows, needsReprobe } = evaluateCoverageExpectationDrift(shows, reviews, outlets, decidedAtMs + 86400000);
    const row = rows.find((r) => r.outletId === outletId);
    assert.ok(row, `${outletId} should carry a coverageExpectation claim in outlet-registry.json`);
    // 'active' specifically, not just "absent from needsReprobe" — that list
    // also excludes 'no-evidence' rows (too little measured data to have an
    // opinion), which would silently mask a real regression instead of
    // confirming the claim is actually being verified against evidence.
    assert.equal(
      row.status,
      'active',
      `${outletId} is '${row.status}', not 'active' — re-run node scripts/audit-standing-coverage.js --coverage-expectation and update outlet-registry.json`
    );
    assert.ok(!needsReprobe.includes(outletId));
  }
});
