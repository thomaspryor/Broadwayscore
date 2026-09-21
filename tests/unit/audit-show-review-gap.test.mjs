// BRO-3928 — the review-gap auditor's headline "missing" count was counting
// citations that belong to an EARLIER production of the same title (a prior
// Broadway/West End run, a stale-year Show Score URL, a prior-run WE
// roundup). The audit already classifies these correctly (`m.priorRun`,
// stamped by lib/gap-ingest-policy.js's production-identity checks) and
// permanently ingest-blocks them — the bug was that the summary counts never
// READ the tag, so a revival with a well-cited earlier run (Cats, Kimberly
// Akimbo, The Cherry Orchard, Golden Boy) read as catastrophically
// incomplete, training everyone to ignore the warning.
//
// This does not re-implement the classifier (CLAUDE.md §15) — every
// assertion calls the SAME real, exported functions the production audit
// uses: `countsFor` (scripts/lib/gap-audit-merge.js, feeds the run Summary
// line and --fail-on-gap) and `computeResidualCounts`
// (scripts/audit-show-review-gap.js, feeds the "Expected-vs-captured"
// residual-gap warning).
//
// Run: node --test tests/unit/audit-show-review-gap.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { countsFor } = require('../../scripts/lib/gap-audit-merge.js');

// Same guard as the colocated scripts/audit-show-review-gap.test.mjs: the
// module spawns real `gh` subprocesses with no --help guard, so patch
// execFileSync to throw before requiring it — this test only needs the pure
// exported helper, never a real subprocess.
const childProcess = require('node:child_process');
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = () => {
  throw new Error('execFileSync must not be called by this test');
};
let computeResidualCounts;
let currentRunUncollected;
try {
  ({ computeResidualCounts, currentRunUncollected } = require('../../scripts/audit-show-review-gap.js'));
} finally {
  childProcess.execFileSync = originalExecFileSync;
}

const priorMiss = (n, host = 'broadwayworld.com') =>
  Array.from({ length: n }, (_, i) => ({ host, url: `https://${host}/${i}`, priorRun: true, priorRunSource: 'aggregator-article-date' }));
const currentMiss = (n, host = 'vulture.com') =>
  Array.from({ length: n }, (_, i) => ({ host, url: `https://${host}/${i}` }));

test('countsFor: a revival whose ONLY citations are from a prior production reports zero gap (Cats/Kimberly Akimbo/Golden Boy class)', () => {
  const revivalWithNoGenuineGap = {
    showId: 'the-cherry-orchard-broadway-2026',
    title: 'The Cherry Orchard',
    missing: priorMiss(21, 'nytimes.com'), // 2016 Broadway roundup, per the corpus evidence
  };
  const c = countsFor([revivalWithNoGenuineGap]);
  assert.equal(c.withGap, 0, 'a show with only prior-production citations must not read as "with gap"');
  assert.equal(c.missingCurrentRun, 0, 'the headline missing count must not include prior-production citations');
  assert.equal(c.priorProductionCitations, 21, 'the prior-run citations are still visible, just informational');
});

test('countsFor: a revival with BOTH a genuine current-run gap and prior-production noise reports only the genuine one as actionable', () => {
  const mixed = {
    showId: 'golden-boy-broadway-2026',
    title: 'Golden Boy',
    missing: [...priorMiss(12), ...currentMiss(1)],
  };
  const c = countsFor([mixed]);
  assert.equal(c.withGap, 1);
  assert.equal(c.missingCurrentRun, 1, 'only the genuinely-uncaptured current-run URL counts');
  assert.equal(c.priorProductionCitations, 12);
});

test('countsFor: --fail-on-gap reads .withGap, which must stay 0 for a prior-production-only show', () => {
  // Mirrors audit-show-review-gap.js main()'s `const runWithGap = countsFor(results).withGap`
  // used to decide the --fail-on-gap exit code — this is the exact value that
  // must not be inflated by prior-production noise.
  const results = [
    { showId: 'cats-broadway-2026', title: 'Cats', missing: priorMiss(29) },
    { showId: 'kimberly-akimbo-broadway-2026', title: 'Kimberly Akimbo', missing: priorMiss(37) },
  ];
  const runWithGap = countsFor(results).withGap;
  assert.equal(runWithGap, 0);
});

test('countsFor: prior-production citations in flaggedMisses/citedNoUrl are excluded the same way as missing', () => {
  const c = countsFor([{
    showId: 'x',
    missing: [],
    flaggedMisses: [{ host: 'a.com', url: 'https://a.com/1', priorRun: true }],
    citedNoUrl: [{ outletId: 'stage', priorRun: true }],
  }]);
  assert.equal(c.withGap, 0);
  assert.equal(c.totalFlaggedMisses, 0);
  assert.equal(c.totalCitedNoUrl, 0);
  assert.equal(c.priorProductionCitations, 2);
});

test('computeResidualCounts: prior-production URLs never count toward the "still uncaptured" residual (already correct — regression guard)', () => {
  const r = {
    showId: 'as-you-like-it-broadway-2026',
    missing: priorMiss(20),
    flaggedMisses: [],
    ingestResults: [],
    recoveryResults: [],
  };
  // ingestMissing=false path: uningested = missing.filter(!priorRun).length
  const counts = computeResidualCounts(r, false);
  assert.equal(counts.uningested, 0);
  assert.equal(counts.residual, 0);
});

test('computeResidualCounts: a genuine uncaptured URL alongside prior-run noise still surfaces as residual', () => {
  const r = {
    showId: 'twelfth-night-broadway-2026',
    missing: [...priorMiss(18), ...currentMiss(2)],
    flaggedMisses: [],
    ingestResults: [],
    recoveryResults: [],
  };
  const counts = computeResidualCounts(r, false);
  assert.equal(counts.uningested, 2);
  assert.equal(counts.residual, 2);
});

// currentRunUncollected feeds the BRO-3928 item-3 opening-window digest
// (routeAlert(disposition:'digest') in main()). Codex adversarial review
// finding: the first draft snapshotted this BEFORE --ingest-missing ran, so a
// gap the SAME run just closed still reported as open.
test('currentRunUncollected: prior-run citations are excluded, matching pre-send-check.mjs\'s "uncollected"', () => {
  const r = { missing: priorMiss(5), citedNoUrl: [{ outletId: 'o', priorRun: true }] };
  assert.equal(currentRunUncollected(r), 0);
});

test('currentRunUncollected: a URL this same run successfully ingested no longer counts as uncollected', () => {
  const r = {
    missing: [{ host: 'a.com', url: 'https://a.com/1' }, { host: 'b.com', url: 'https://b.com/1' }],
    ingestResults: [{ url: 'https://a.com/1', ok: true }, { url: 'https://b.com/1', ok: false }],
  };
  assert.equal(currentRunUncollected(r), 1, 'only the URL that failed to ingest is still uncollected');
});

test('currentRunUncollected: an ingest attempt that failed or was skipped still counts as uncollected', () => {
  const r = {
    missing: [{ host: 'a.com', url: 'https://a.com/1' }],
    citedNoUrl: [{ outletId: 'o1' }],
    ingestResults: [],
  };
  assert.equal(currentRunUncollected(r), 2);
});
