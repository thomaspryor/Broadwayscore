/**
 * Tests for scripts/lib/nyt-pick-coverage.js (BRO-4192).
 *
 * Run: node --test scripts/lib/nyt-pick-coverage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sameDay, canonicalUrl, parsePickUrl, inReviewWindow, candidateShows, auditPickCoverage } = require('./nyt-pick-coverage.js');

const english = { id: 'english-2025', title: 'English', status: 'closed',
  // Stored swapped in shows.json (opening before previews); matching must still work.
  openingDate: '2025-01-03', previewsStartDate: '2025-01-23', closingDate: '2025-03-02' };
const ohMaryWE = { id: 'oh-mary-west-end-2025', title: 'Oh, Mary!', status: 'open', openingDate: '2025-12-08' };
const ohMaryOB = { id: 'oh-mary-off-broadway-2024', title: 'Oh, Mary!', status: 'closed', openingDate: '2024-02-08', closingDate: '2024-05-19' };
const job = { id: 'job-2024', title: 'Job', status: 'closed', openingDate: '2024-01-10', closingDate: '2024-03-01' };

test('canonicalUrl strips query, trailing slash and normalizes host', () => {
  assert.equal(canonicalUrl('http://nytimes.com/2024/07/11/theater/oh-mary-review.html?searchResultPosition=1'),
    'https://www.nytimes.com/2024/07/11/theater/oh-mary-review.html');
});

test('parsePickUrl reads the publish date and slug words', () => {
  const p = parsePickUrl('https://www.nytimes.com/2025/01/23/theater/english-review-broadway-toossi.html');
  assert.equal(p.date, '2025-01-23');
  assert.deepEqual(p.slugWords, ['english', 'toossi']);
  assert.equal(parsePickUrl('https://www.nytimes.com/section/theater'), null);
});

test('inReviewWindow uses the earlier of previews/opening and respects closing', () => {
  assert.equal(inReviewWindow(english, '2025-01-23'), true);
  assert.equal(inReviewWindow(english, '2025-06-01'), false);
  assert.equal(inReviewWindow(ohMaryOB, '2025-12-19'), false);
  assert.equal(inReviewWindow(ohMaryWE, '2025-12-19'), true);
});

test('candidateShows matches title words + run window, picks the right production', () => {
  const url = 'https://www.nytimes.com/2025/12/19/theater/oh-mary-trafalgar-theater-london.html';
  assert.deepEqual(candidateShows(url, [ohMaryOB, ohMaryWE, english]).map(s => s.id), ['oh-mary-west-end-2025']);
});

test('short single-word titles do not match long unrelated slugs', () => {
  const url = 'https://www.nytimes.com/2024/02/01/theater/a-job-well-done-at-the-public-review.html';
  assert.deepEqual(candidateShows(url, [job]), []);
});

test('auditPickCoverage splits matched vs unmatched and reports existing NYT reviews', () => {
  const picks = [
    'https://www.nytimes.com/2025/01/23/theater/english-review-broadway-toossi.html',
    'https://www.nytimes.com/2024/07/11/theater/oh-mary-review-cole-escola.html',
  ];
  const reviews = [
    { showId: 'oh-mary-2024', outletId: 'nytimes', url: 'https://www.nytimes.com/2024/07/11/theater/oh-mary-review-cole-escola.html?searchResultPosition=1' },
  ];
  const { matched, unmatched } = auditPickCoverage(picks, reviews, [english, ohMaryWE]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].showId, 'oh-mary-2024');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].candidates[0].showId, 'english-2025');
  assert.deepEqual(unmatched[0].candidates[0].existingNytReviews, []);
});

test('sameDay handles long-form, ordinal and ISO publish dates', () => {
  assert.equal(sameDay('April 18, 2024', '2024-04-18'), true);
  assert.equal(sameDay('June 20th, 2024', '2024-06-20'), true);
  assert.equal(sameDay('2024-04-18T00:00:00Z', '2024-04-18'), true);
  assert.equal(sameDay('April 19, 2024', '2024-04-18'), false);
  assert.equal(sameDay(null, '2024-04-18'), false);
});

test('a designated pick stored under a non-NYT URL (manual PDF entry) counts as covered', () => {
  const gun = { id: 'gun-and-powder-paper-mill-regional-2024', title: 'Gun & Powder', status: 'closed', openingDate: '2024-04-11', closingDate: '2024-05-05' };
  const pick = 'https://www.nytimes.com/2024/04/18/theater/gun-powder-review.html';
  const pdf = { showId: gun.id, outletId: 'nytimes', url: 'https://papermill.org/wp-content/uploads/2024/04/review.pdf', publishDate: 'April 18, 2024', designation: 'Critics_Pick' };
  const covered = auditPickCoverage([pick], [pdf], [gun]);
  assert.equal(covered.unmatched.length, 0);
  assert.equal(covered.matched[0].showId, gun.id);
  // Without the designation it is still reported as missing.
  const missing = auditPickCoverage([pick], [{ ...pdf, designation: undefined }], [gun]);
  assert.equal(missing.unmatched.length, 1);
});
