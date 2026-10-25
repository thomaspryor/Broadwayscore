/**
 * BRO-4911: prevention for the Into the Woods page bugs (BRO-4887 leftovers).
 * Real data shapes from data/review-texts/into-the-woods-2022. Per CLAUDE.md
 * rule 15 every check require()s the real function.
 *
 *  1. Same-url byline dedup: the copy whose own text bylines its critic wins.
 *  2. Fabricated web-search row (talkinbroadway--matthew-murray: url null, no
 *     text, scored 88) stays out of reviews.json.
 *  3. An openingDate a person corrected survives every shows.json writer.
 *  4. mergeReviews' venue-transfer self-heal needs the url to have changed.
 *
 * Run: node --test tests/unit/itw-prevention-byline-fabricated.test.mjs
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'itw-4911-'));

const require = createRequire(import.meta.url);
const { compareFilesForDedupPriority } = require('../../scripts/lib/rebuild-helpers.js');
const { isBylineAttestedInText } = require('../../scripts/lib/byline-attestation.js');
const { explainExclusion } = require('../../scripts/lib/review-guards.js');
const { createShowsWriteGuard } = require('../../scripts/lib/shows-write-guard.js');
const { stampHumanCorrectedOpeningDate } = require('../../scripts/lib/opening-date-guard.js');
const { mergeReviews } = require('../../scripts/lib/review-normalization.js');

const ITW_2022 = {
  id: 'into-the-woods-2022', title: 'Into the Woods', category: 'broadway',
  previewsStartDate: '2022-06-28', openingDate: '2022-07-10', closingDate: '2023-01-08',
};

test('1: same-url dedup prefers the copy whose text bylines its own critic', () => {
  const text = 'Into the Woods review. By David Cote. The Sondheim revival casts a spell. '.repeat(10);
  const meta = (file, critic) => ({
    file, isDupe: 0, hasScore: 1, isUnknown: 0, isOutletAsCritic: 0, isVerified: 0, hasEnsemble: 0,
    isBylineUnattested: isBylineAttestedInText(critic, text) ? 0 : 1,
  });
  // Alphabetical order alone keeps the wrong copy (ITW: a misattributed
  // byline on the Observer row). 'a' < 'd', so only the new rank can fix it.
  const wrong = meta('observer--adam-feldman.json', 'Adam Feldman');
  const right = meta('observer--david-cote.json', 'David Cote');
  const sorted = [wrong, right].sort(compareFilesForDedupPriority);
  assert.equal(sorted[0].file, 'observer--david-cote.json');
  // Callers that never compute the flag keep the old order.
  const a = { file: 'b.json', hasScore: 1 }, b = { file: 'a.json', hasScore: 1 };
  assert.equal([a, b].sort(compareFilesForDedupPriority)[0].file, 'a.json');
});

test('2: the fabricated Talkin\' Broadway web-search row is excluded', () => {
  const row = {
    showId: 'into-the-woods-2022', outletId: 'talkinbroadway', outlet: "Talkin' Broadway",
    criticName: 'Matthew Murray', url: null, source: 'web-search', assignedScore: 88,
    contentTier: 'excerpt', excerpt: 'Into the Woods is a delightful revival that showcases...',
  };
  assert.equal(explainExclusion(row, ITW_2022, null), 'unverifiableWebSearchRow');
  // Control: the same row with a real url and text is not excluded for this reason.
  const real = { ...row, url: 'https://www.talkinbroadway.com/page/ob/into-the-woods', fullText: 'x '.repeat(600) };
  assert.notEqual(explainExclusion(real, ITW_2022, null), 'unverifiableWebSearchRow');
});

test('3: a human-corrected openingDate survives an enricher write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itw-shows-'));
  const file = path.join(dir, 'shows.json');
  fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows: [{ ...ITW_2022, openingDate: '2022-06-28', openingDateSource: 'ibdb' }] }, null, 2));
  const guard = createShowsWriteGuard(file);

  // The approved data-edit plan corrects the date.
  let data = guard.loadShows();
  data.shows[0].openingDate = '2022-07-10';
  stampHumanCorrectedOpeningDate(data.shows[0], '2022-07-10');
  guard.saveShows(data);
  assert.equal(guard.loadShows().shows[0].humanCorrectedOpeningDate, '2022-07-10');

  // A later IBDB enrich run writes the old date straight onto the record.
  data = guard.loadShows();
  data.shows[0].openingDate = '2022-06-28';
  data.shows[0].openingDateSource = 'ibdb';
  guard.saveShows(data);
  const saved = guard.loadShows().shows[0];
  assert.equal(saved.openingDate, '2022-07-10');
  assert.equal(saved.openingDateSource, 'human-correction');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('4: the same url seen again does not clear a url-based wrongProduction flag', () => {
  const url = 'https://nypost.com/2022/07/10/into-the-woods-broadway-review-high-octane-unfiltered-sondheim/';
  const existing = {
    outletId: 'nypost', outlet: 'New York Post', criticName: 'Johnny Oleksinski', url,
    wrongProduction: true, wrongProductionNote: 'Same URL as into-the-woods-1987/nypost--johnny-oleksinski.json',
    fullText: 'x'.repeat(400),
  };
  for (const ctx of [{ show: ITW_2022, showId: ITW_2022.id }, {}]) {
    const merged = mergeReviews({ ...existing }, { url: url + '?utm_source=x', source: 'gather-reviews' }, {}, { ...ctx, script: 'test' });
    assert.equal(merged.wrongProduction, true);
    assert.equal(merged.wrongProductionAutoCleared, undefined);
  }
});
