// BRO-3161: a single-outlet fetch workflow (fetch-guardian-reviews.yml et al.)
// checks out data/review-texts once at job start, then runs a slow loop
// before rebuilding + pushing reviews.json. If a concurrent workflow adds a
// review for a DIFFERENT outlet mid-run, the rebuild's local checkout can't
// see it and silently regenerates reviews.json without that row (confirmed
// incident: Kimberly Akimbo / The Times (UK) / Clive Davis, 2026-09-10).
//
// Prevention now has two layers:
//   1. fetch-guardian-reviews.yml reuses rebuild-reviews.yml's existing
//      "stale-checkout race guard" (explicit-refspec fetch + SHA-drift
//      detection + targeted per-file checkout of drifted files +
//      scripts/check-rebuild-staleness.js's BLOCKING post-rebuild
//      verification) — see scripts/lib/rebuild-staleness-guard.js and
//      that workflow's inline comments for the full design. That guard
//      already has its own coverage; this file does not re-test it.
//   2. mergeReviewsJson (scripts/lib/merge-reviews-json.js) — the safety net
//      already wired into push-core-data/action.yml: even if a stale rebuild
//      still ships, disjoint-identity rows (a different outlet's review)
//      union rather than get silently dropped on any push that hits
//      reconciliation.
//
// This test pins layer 2 directly against the exact incident shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReviewsJson } from '../../scripts/lib/merge-reviews-json.js';

function review(overrides = {}) {
  return {
    showId: 'kimberly-akimbo-off-west-end-2026',
    outlet: 'Guardian',
    outletId: 'guardian',
    criticName: 'A Critic',
    assignedScore: 70,
    contentTier: 'complete',
    publishDate: '2026-09-01',
    url: 'https://example.com/guardian-review',
    ...overrides,
  };
}

test('mergeReviewsJson: a single-outlet writer\'s stale rebuild cannot delete another outlet\'s row', () => {
  // "ours" = fetch-guardian-reviews.yml's rebuild, built from a review-texts
  // checkout taken BEFORE gather-reviews.yml pushed the Times (UK) review —
  // it only knows about the Guardian row.
  const guardianRow = review();
  const ours = { reviews: [guardianRow], _meta: { lastUpdated: '2026-09-10T21:00:00.000Z' } };

  // "remote" = origin/main's current tip, which already has BOTH the
  // Guardian row and the Times (UK) row gather-reviews.yml just added.
  const timesUkRow = review({
    outlet: 'The Times (UK)',
    outletId: 'the-times-uk',
    criticName: 'Clive Davis',
    assignedScore: 78,
    url: 'https://example.com/times-uk-review',
  });
  const remote = { reviews: [guardianRow, timesUkRow], _meta: { lastUpdated: '2026-09-10T21:30:00.000Z' } };

  const { merged, stats } = mergeReviewsJson(ours, remote);

  assert.equal(merged.reviews.length, 2);
  assert.ok(
    merged.reviews.some((r) => r.outletId === 'the-times-uk' && r.criticName === 'Clive Davis'),
    'The Times (UK) / Clive Davis row must survive the merge even though "ours" never saw it'
  );
  assert.equal(stats.added, 1);
});
