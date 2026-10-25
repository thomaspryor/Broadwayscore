/**
 * BRO-4101 — the shared ingest chokepoint (createOrMergeReviewFile) must
 * refuse a write whose URL matches a NAMED_NON_REVIEW_URL_PATTERNS entry
 * (non-review-url-patterns.js), for unvetted-SERP-sourced writes. Confirmed
 * live: the-last-ship-west-end-2026's londontheatre.co.uk/show/47207 ticket
 * page (synopsis + "Book tickets" copy, no critic byline) was ingested via
 * serp-discovery and LLM-scored 82 before this guard existed.
 *
 * Scoped to isUnvettedSerpSource(input.source) — NOT unconditional — because
 * this guard runs before the merge-vs-create fork: an unscoped version would
 * permanently refuse any future re-merge/refresh write to a file like
 * burn-this-2019/new-york-city-theatre--nicola-quinn.json, a real, scored
 * review (source: show-score-playwright) whose citation URL happens to sit
 * on a host-wide named pattern (verified against the full corpus, see
 * review-guards.js's identically-scoped namedNonReviewUrl rule). Runs via
 * the scripts/lib/*.test.mjs CI glob; dryRun only.
 *
 * BRO-4125: reviewTextsDir is pinned to a throwaway temp dir, NOT the real
 * data/review-texts corpus (the default createOrMergeReviewFile falls back
 * to). the-last-ship-west-end-2026 is a REAL, currently-running West End
 * show (opened 2026-09-23) — once its real London Theatre/Marianka Swain
 * review lands in the live corpus, the "accepts" test's identical
 * outlet/critic/url/source input has nothing left to merge, so `changed`
 * stays false and _mergeIntoExisting returns skipped/'no-changes' — a false
 * failure of an unrelated later guard, not of the named-non-review-url gate
 * this file exists to test. dryRun:true means nothing is ever written to
 * this temp dir; it only needs to exist so findExistingReviewFile/
 * findCrossShowOwners see an empty corpus instead of the real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-writer-named-non-review-'));

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
};

const call = (outlet, critic, url, source = 'serp-discovery') => quiet(() => createOrMergeReviewFile(
  'the-last-ship-west-end-2026',
  { outlet, criticName: critic, url, source, fields: {} },
  { dryRun: true, reviewTextsDir }
));

test('rejects londontheatre.co.uk/show/NNNN ticket page (serp-discovery)', () => {
  const r = call('London Theatre', 'Unknown', 'https://www.londontheatre.co.uk/show/47207-the-last-ship');
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /^named-non-review-url: ticketing-listing$/);
});

test('accepts londontheatre.co.uk/reviews/ (same host, real reviews path)', () => {
  const r = call('London Theatre', 'Marianka Swain', 'https://www.londontheatre.co.uk/reviews/the-last-ship');
  assert.notEqual(r.action, 'skipped');
});

test('rejects across all isUnvettedSerpSource labels, not just serp-discovery', () => {
  for (const source of ['serp-discovery-per-critic', 'outlet-serp-discovery', 'broad-web-serp', 'site-search', 'opening-night-discovery']) {
    const r = call('London Theatre', 'Unknown', 'https://www.londontheatre.co.uk/show/47207-the-last-ship', source);
    assert.equal(r.action, 'skipped', `source=${source} should be skipped`);
    assert.match(r.reason, /^named-non-review-url:/);
  }
});

test('does NOT reject a non-SERP source sharing a named-pattern host (the burn-this-2019 false-positive class)', () => {
  const r = call('New York City Theatre', 'Nicola Quinn', 'https://www.newyorkcitytheatre.com/reviews/22031', 'show-score-playwright');
  assert.notEqual(r.reason, 'named-non-review-url: ticketing-reseller');
});

test('rejects another named host+path pair (broadwayworld.com/shows/.../cast — venue-production-page)', () => {
  const r = call('BroadwayWorld', 'Unknown', 'https://www.broadwayworld.com/shows/Some-Show-123456/cast');
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /^named-non-review-url: venue-production-page$/);
});
