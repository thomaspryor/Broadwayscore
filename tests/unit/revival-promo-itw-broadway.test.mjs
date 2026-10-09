/**
 * BRO-4887 (Into the Woods Broadway pages, revival promo): regression tests
 * for the two prevention items that are not already covered elsewhere.
 * Per CLAUDE.md rule 15 these require() the real functions.
 *
 *  1. mergeReviews' venue-transfer self-heal must NOT auto-clear a URL-based
 *     wrongProduction flag when the url the file keeps is dated clearly
 *     outside the show's run (a 2022 NY Post review filed under the 1987
 *     show went live with wrongProductionAutoCleared:true and a fake date).
 *  2. Pin: once a show's openingDate is corrected, the rebuild's stale dated
 *     pre-opening guard flag is released by shouldAutoClearStaleDateGuard.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Keep the exclusion log out of the real data/audit directory.
process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'itw-veto-'));

const require = createRequire(import.meta.url);
const { mergeReviews } = require('../../scripts/lib/review-normalization.js');
const { evaluateDateGuard } = require('../../scripts/lib/date-guard.js');
const { shouldAutoClearStaleDateGuard } = require('../../scripts/lib/wrong-production-autoclear.js');

const ITW_1987 = {
  id: 'into-the-woods-1987',
  title: 'Into the Woods',
  category: 'broadway',
  previewsStartDate: '1987-09-23',
  openingDate: '1987-11-05',
  closingDate: '1989-09-03',
};
const NYPOST_2022_URL = 'https://nypost.com/2022/07/10/into-the-woods-broadway-review-high-octane-unfiltered-sondheim/';
const NYPOST_1987_URL = 'https://nypost.com/1987/11/06/into-the-woods-review/';

function urlFlagged(url) {
  return {
    outletId: 'nypost',
    outlet: 'New York Post',
    criticName: 'Johnny Oleksinski',
    url,
    publishDate: '1987-11-05',
    wrongProduction: true,
    wrongProductionNote: 'Same URL as into-the-woods-2022/nypost--johnny-oleksinski.json',
    fullText: 'x'.repeat(400),
  };
}

test('auto-clear is vetoed when the kept url is dated far outside the show run', () => {
  const existing = urlFlagged(NYPOST_2022_URL);
  const merged = mergeReviews(existing, { url: NYPOST_2022_URL, source: 'gather-reviews' }, {}, { show: ITW_1987, showId: ITW_1987.id, script: 'test' });
  assert.equal(merged.wrongProduction, true, 'the flag must stay');
  assert.equal(merged.wrongProductionAutoCleared, undefined);
});

test('control: a url dated inside the show run is still auto-cleared (venue-transfer self-heal)', () => {
  const existing = urlFlagged(NYPOST_1987_URL);
  const merged = mergeReviews(existing, { url: NYPOST_1987_URL, source: 'gather-reviews' }, {}, { show: ITW_1987, showId: ITW_1987.id, script: 'test' });
  assert.notEqual(merged.wrongProduction, true);
  assert.equal(merged.wrongProductionAutoCleared, true);
});

test('control: with no show record the old behaviour is unchanged (fails open)', () => {
  const existing = urlFlagged(NYPOST_2022_URL);
  const merged = mergeReviews(existing, { url: NYPOST_2022_URL, source: 'gather-reviews' }, {}, { script: 'test' });
  assert.notEqual(merged.wrongProduction, true);
  assert.equal(merged.wrongProductionAutoCleared, true);
});

test('a declared prior run covering the url date is not vetoed', () => {
  const show = { ...ITW_1987, priorRuns: [{ openingDate: '2022-07-10', closingDate: '2023-01-08', venue: 'St. James Theatre' }] };
  const existing = urlFlagged(NYPOST_2022_URL);
  const merged = mergeReviews(existing, { url: NYPOST_2022_URL, source: 'gather-reviews' }, {}, { show, showId: show.id, script: 'test' });
  assert.equal(merged.wrongProductionAutoCleared, true);
});

test('pin: a stale dated pre-opening flag is released once the openingDate is corrected', () => {
  const pubDate = new Date('2022-07-10');
  const flagged = { wrongProduction: true, wrongProductionNote: 'Pre-opening guard: published before the show opened' };
  const wrong = { id: 'into-the-woods-2022', category: 'broadway', openingDate: '2022-08-20', closingDate: '2023-01-08' };
  const fixed = { ...wrong, openingDate: '2022-07-10' };

  const before = evaluateDateGuard({ pubDate, show: wrong, outletId: 'nypost' });
  assert.equal(before.flag, true, 'with the wrong opening date the review looks pre-opening');
  assert.equal(shouldAutoClearStaleDateGuard(flagged, { nowInWindow: before.flag === false }), false);

  const after = evaluateDateGuard({ pubDate, show: fixed, outletId: 'nypost' });
  assert.equal(after.flag, false, 'with the corrected opening date it is inside the window');
  assert.equal(shouldAutoClearStaleDateGuard(flagged, { nowInWindow: after.flag === false }), true);
});
