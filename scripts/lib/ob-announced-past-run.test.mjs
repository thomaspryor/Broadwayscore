// BRO-8196 replay: the nine off-broadway-2026 rows created status=announced
// with no dates, which ran Mar-Jun 2026 and were hand-dated
// (humanCorrectedOpeningDate, execute-approved-fix 2026-11-22). Reverting each
// to its pre-fix shape (announced, no dates) and stubbing the Playbill
// production-page lookup with the human-corrected dates must reproduce the
// human fix exactly via the real decision functions.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAnnouncedPastRunCandidate, pastRunChanges } = require('./ob-announced-past-run');

const TODAY = '2026-11-26';
const SOURCE = 'playbill-production-page:announced-past-run';

// Ground truth copied from data/shows.json (2026-11-26) + each row's review
// publishDates from data/reviews.json (null = review with no publishDate).
const GROUND_TRUTH = [
  ['is-anything-ok-off-broadway-2026', '2026-03-04', '2026-03-04', '2026-03-15', ['2026-03-19']],
  ['miracle-on-south-division-street-off-broadway-2026', '2026-04-14', '2026-04-19', '2026-05-10', ['2026-04-22']],
  ['stories-from-the-brink-off-broadway-2026', '2026-03-18', '2026-03-19', '2026-04-03', ['2026-03-30']],
  ['heavenly-baba-off-broadway-2026', '2026-04-02', '2026-04-02', '2026-04-25', ['2026-04-07']],
  ['pea-dinneen-raising-her-voice-off-broadway-2026', '2026-06-16', '2026-06-16', '2026-06-28', ['2026-06-20']],
  ['north-star-off-broadway-2026', null, '2026-06-03', '2026-06-21', [null]],
  ['our-house-off-broadway-2026', null, '2026-03-06', '2026-03-21', ['2026-03-08', '2026-03-07', '2026-03-10']],
  ['the-paparazzi-off-broadway-2026', null, '2026-03-06', '2026-04-11', ['2026-03-14', '2026-03-28', null]],
  ['the-wedding-march-off-broadway-2026', null, '2026-04-09', '2026-05-03', [null]],
].map(([id, previewsStartDate, openingDate, closingDate, pubs]) => ({
  id, previewsStartDate, openingDate, closingDate,
  reviews: pubs.map(publishDate => ({ showId: id, publishDate })),
}));

function preFix(truth) {
  return { id: truth.id, category: 'off-broadway', status: 'announced', previewsStartDate: null, openingDate: null, closingDate: null };
}

function stubLookup(truth) {
  return { source: 'playbill-production-page', firstPreview: truth.previewsStartDate, opening: truth.openingDate, closing: truth.closingDate };
}

function replay(truth, reviews) {
  const show = preFix(truth);
  if (!isAnnouncedPastRunCandidate(show, reviews)) return { admitted: false };
  const changes = pastRunChanges(show, stubLookup(truth), TODAY);
  return { admitted: true, after: changes && Object.fromEntries(changes.map(c => [c.field, c.new])) };
}

function assertMatchesTruth(truth, result) {
  assert.equal(result.admitted, true, `${truth.id} not admitted to the Phase 3 lookup`);
  assert.deepEqual(result.after, {
    openingDate: truth.openingDate,
    closingDate: truth.closingDate,
    previewsStartDate: truth.previewsStartDate,
    status: 'closed',
    openingDateSource: SOURCE,
  }, truth.id);
}

test('replay: all nine hand-fixed rows reproduce their human-corrected dates', () => {
  assert.equal(GROUND_TRUTH.length, 9);
  for (const truth of GROUND_TRUTH) assertMatchesTruth(truth, replay(truth, truth.reviews));
});

test('replay against live data/shows.json + reviews.json when present', (t) => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
  const showsPath = path.join(root, 'data/shows.json');
  const reviewsPath = path.join(root, 'data/reviews.json');
  if (!fs.existsSync(showsPath) || !fs.existsSync(reviewsPath)) return t.skip('core data not checked out');
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const reviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews || [];
  for (const { id } of GROUND_TRUTH) {
    const live = shows.find(s => s.id === id);
    if (!live || live.openingDateSource !== 'human-correction') continue; // data moved on
    const truth = { id, previewsStartDate: live.previewsStartDate ?? null, openingDate: live.openingDate, closingDate: live.closingDate };
    assertMatchesTruth(truth, replay(truth, reviews.filter(r => r.showId === id)));
  }
});

test('replay guards: contaminated reviews, wrong-year source, or a future/missing close block the fix', () => {
  const truth = GROUND_TRUTH[0];
  const show = preFix(truth);
  for (const flag of ['wrongShow', 'wrongProduction', 'isRoundupArticle'])
    assert.equal(isAnnouncedPastRunCandidate(show, truth.reviews.map(r => ({ ...r, [flag]: true }))), false, flag);
  assert.equal(isAnnouncedPastRunCandidate(show, []), false, 'no reviews');
  assert.equal(isAnnouncedPastRunCandidate({ ...show, category: 'broadway' }, truth.reviews), false, 'broadway');
  assert.equal(isAnnouncedPastRunCandidate({ ...show, openingDate: '2026-03-04' }, truth.reviews), false, 'already dated');
  const entry = stubLookup(truth);
  // A later revival's page (opening year != id year) must not overwrite the row.
  assert.equal(pastRunChanges(show, { ...entry, opening: '2027-03-04', closing: '2027-03-15', firstPreview: null }, '2027-12-01'), null);
  assert.equal(pastRunChanges(show, { ...entry, closing: '2026-12-31' }, TODAY), null, 'still running');
  assert.equal(pastRunChanges(show, { ...entry, closing: null }, TODAY), null, 'no closing');
  assert.equal(pastRunChanges(show, { ...entry, source: 'spectra-iobdb' }, TODAY), null, 'non-Playbill source');
  assert.equal(pastRunChanges(show, { ...entry, firstPreview: '2026-03-05' }, TODAY), null, 'preview after opening');
});
