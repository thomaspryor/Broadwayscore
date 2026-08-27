// BRO-58: the 2026-04-22 baseline run of the OLD expected-vs-actual delta
// algorithm flagged 86 shows as "drift" — review-text files existing on disk
// with no matching reviews.json entry. That algorithm was retired wholesale
// by the 2026-07-11 redesign (commit 0fedbea81f0) specifically because
// mirroring rebuild-all-reviews.js's 4000-line inclusion pipeline was
// "unwinnable": it produced -489/+439 false positives in both directions
// (see this file's docblock). The replacement — findSuppressedForShow below —
// calls the CANONICAL predicate (review-guards.isIncludableForRebuild)
// directly instead of a hand-maintained mirror, and adds a production-window
// filter that specifically kills the false-positive class the 86-show
// baseline was full of: historical review-text files that exist on disk for
// a DIFFERENT production year sitting in the same show directory (the
// beetlejuice-west-end-2026 dir holding 2019 Broadway review files is the
// canonical example from the docblock).
//
// These tests exercise that exact scenario — review texts existing but not
// appearing in reviews.json — for both the genuine-miss case (must flag) and
// the expected-noise case (must not flag), using real fixture files on disk
// (REVIEW_TEXTS_DIR override, same pattern as audit-duplicate-of-url-mismatch.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'check-review-count-drift-'));
process.env.REVIEW_TEXTS_DIR = FIXTURE_DIR;

const { findSuppressedForShow, isInOpeningWindow, normUrl } = require('./check-review-count-drift.js');

function writeReviewFile(showDir, filename, data) {
  const dir = path.join(FIXTURE_DIR, showDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data));
}

test.after(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

const SHOW_2026 = { id: 'test-show-2026', previewsStartDate: '2026-06-01', openingDate: '2026-06-10' };

test('findSuppressedForShow flags a genuinely missing in-window review (the real-bug case)', () => {
  writeReviewFile('genuine-miss-2026', 'nytimes--ben-brantley.json', {
    outletId: 'nytimes',
    criticName: 'Ben Brantley',
    humanReviewScore: 80,
    fullText: 'A glowing review of the production.',
    publishDate: '2026-06-11T12:00:00-04:00',
    url: 'https://nytimes.com/review',
  });
  const { suppressed, scanned } = findSuppressedForShow('genuine-miss-2026', SHOW_2026, []);
  assert.equal(scanned, 1);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].outletId, 'nytimes');
});

test('findSuppressedForShow does NOT flag an out-of-window historical review file (BRO-58 root cause)', () => {
  // A review-text file for a PRIOR production year sitting in this show's
  // directory — exists on disk, has no reviews.json entry, but is not this
  // production's review. This is exactly the false-positive class the old
  // delta algorithm could not distinguish from a real drop.
  writeReviewFile('historical-noise-2026', 'variety--old-critic.json', {
    outletId: 'variety',
    criticName: 'Old Critic',
    humanReviewScore: 70,
    fullText: 'A review of a completely different, decades-earlier production.',
    publishDate: '2019-03-01T12:00:00-04:00',
    url: 'https://variety.com/old-review',
  });
  const { suppressed, scanned } = findSuppressedForShow('historical-noise-2026', SHOW_2026, []);
  assert.equal(scanned, 1);
  assert.equal(suppressed.length, 0);
});

test('findSuppressedForShow skips a file already present in reviews.json (filename match)', () => {
  writeReviewFile('already-present-2026', 'nytimes--ben-brantley.json', {
    outletId: 'nytimes',
    criticName: 'Ben Brantley',
    humanReviewScore: 80,
    fullText: 'A glowing review of the production.',
    publishDate: '2026-06-11T12:00:00-04:00',
    url: 'https://nytimes.com/review',
  });
  const showReviews = [{ outletId: 'nytimes', criticName: 'Ben Brantley', url: 'https://nytimes.com/review' }];
  const { suppressed } = findSuppressedForShow('already-present-2026', SHOW_2026, showReviews);
  assert.equal(suppressed.length, 0);
});

test('findSuppressedForShow skips a file matched by URL when the filename diverges (byline drift)', () => {
  writeReviewFile('url-match-2026', 'nytimes--unknown.json', {
    outletId: 'nytimes',
    criticName: 'Unknown',
    humanReviewScore: 80,
    fullText: 'A glowing review of the production.',
    publishDate: '2026-06-11T12:00:00-04:00',
    url: 'https://www.nytimes.com/review/?utm=1',
  });
  const showReviews = [{ outletId: 'nytimes', criticName: 'Ben Brantley', url: 'https://nytimes.com/review' }];
  const { suppressed } = findSuppressedForShow('url-match-2026', SHOW_2026, showReviews);
  assert.equal(suppressed.length, 0);
});

test('findSuppressedForShow ignores a scoreless review file', () => {
  writeReviewFile('scoreless-2026', 'somesite--critic.json', {
    outletId: 'somesite',
    criticName: 'critic',
    fullText: 'Some review text with no extractable score.',
    publishDate: '2026-06-11T12:00:00-04:00',
    url: 'https://somesite.com/review',
  });
  const { suppressed } = findSuppressedForShow('scoreless-2026', SHOW_2026, []);
  assert.equal(suppressed.length, 0);
});

test('findSuppressedForShow returns empty (not a crash) for a show dir that does not exist', () => {
  const { suppressed, scanned } = findSuppressedForShow('does-not-exist-2026', null, []);
  assert.deepEqual(suppressed, []);
  assert.equal(scanned, 0);
});

test('isInOpeningWindow: true within +-7 days of openingDate, false outside', () => {
  const now = new Date('2026-06-10T12:00:00Z').getTime();
  assert.equal(isInOpeningWindow({ openingDate: '2026-06-12' }, now), true);
  assert.equal(isInOpeningWindow({ openingDate: '2026-06-01' }, now), false);
  assert.equal(isInOpeningWindow(null, now), false);
  assert.equal(isInOpeningWindow({}, now), false);
});

test('normUrl strips protocol, www, query string, and trailing slash for cross-scrape matching', () => {
  assert.equal(normUrl('https://www.nytimes.com/review/?utm=1'), 'nytimes.com/review');
  assert.equal(normUrl('http://nytimes.com/review/'), 'nytimes.com/review');
});
