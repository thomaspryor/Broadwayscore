// TESTS-VS-DERIVED-DATA-EXEMPT: structural check (image file exists on disk,
// non-placeholder hash, findImagelessScoredShows() predicate holds) — there is
// no precursor source file for images, the image file itself IS the source of
// truth; nothing here pins a scraped/derived fact.
/**
 * BRO-2650 regression: "Let's Love still has no image after 5 self-heal
 * attempts". By the time this card was dispatched the image had already
 * landed (commit e72596e9517, 2026-09-05) and audit-imageless-scored-shows.js's
 * self-pruning ledger no longer flags the show — the alert was stale, not
 * live. This test pins the resolved state against the REAL data on disk
 * (CLAUDE.md rule 15: no re-implemented predicate) so a future regression
 * that silently deletes/breaks the image fails CI loudly instead of waiting
 * for the next owner-alert-router cycle to notice.
 *
 * "Similar shows": rather than only checking this one id, the second test
 * re-runs the exact imageless-scored-show predicate (image-trigger-guard.js)
 * against the full live shows.json + reviews.json — the same inputs
 * audit-imageless-scored-shows.js itself uses — so ANY scored show that
 * loses its image past the threshold fails this test, not just Let's Love.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { hasRealImage } = require('../../scripts/lib/show-images.js');
const { findImagelessScoredShows, DEFAULT_THRESHOLD_HOURS } = require('../../scripts/lib/image-trigger-guard.js');

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const showsData = require(path.join(repoRoot, 'data', 'shows.json'));
const reviewsData = require(path.join(repoRoot, 'data', 'reviews.json'));

const SHOW_ID = 'lets-love-off-broadway-2026';

function buildReviewCountByShow(data) {
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.reviews) ? data.reviews
    : Object.values(data?.reviews || {});
  const counts = {};
  for (const r of list) {
    if (!r || !r.showId) continue;
    counts[r.showId] = (counts[r.showId] || 0) + 1;
  }
  return counts;
}

// Mirrors audit-imageless-scored-shows.js's resolveSinceMs exactly (earliest
// of the three candidate fields) so this test reflects the same "since when
// has this show been imageless" clock the production auditor uses.
function resolveSinceMs(show) {
  const candidates = [show.discoveredAt, show.openingDate, show.previewsStartDate]
    .map((raw) => (raw ? Date.parse(raw) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

test("Let's Love has a real image on disk (BRO-2650)", () => {
  const show = showsData.shows.find((s) => s.id === SHOW_ID);
  assert.ok(show, `${SHOW_ID} must exist in data/shows.json`);
  assert.equal(
    hasRealImage(show),
    true,
    `${SHOW_ID} must have a real (non-phantom, non-placeholder) image on disk — ` +
      'if this fails, run: node scripts/fetch-show-images-auto.js --show=' + SHOW_ID + ' --dry-run',
  );
});

test('no scored show is currently flagged imageless past the self-heal threshold (similar shows)', () => {
  const reviewCountByShow = buildReviewCountByShow(reviewsData);
  const nowMs = Date.now();
  const normalized = showsData.shows.map((s) => ({
    id: s.id,
    title: s.title,
    hasImages: hasRealImage(s),
    reviewCount: reviewCountByShow[s.id] || 0,
    sinceMs: resolveSinceMs(s),
  }));

  const flagged = findImagelessScoredShows(normalized, { nowMs, thresholdHours: DEFAULT_THRESHOLD_HOURS });

  assert.deepEqual(
    flagged.map((f) => f.id),
    [],
    'the following scored shows have no image on disk past the self-heal threshold: ' +
      JSON.stringify(flagged.map((f) => ({ id: f.id, title: f.title }))),
  );
});
