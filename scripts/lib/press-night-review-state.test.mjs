import './shows-json-empty-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = require('./press-night-review-state.js');

const SHOW = { id: 'x-2026', title: 'X', openingDate: '2026-10-22', category: 'broadway' };

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnrs-'));
  fs.mkdirSync(path.join(dir, 'x-2026'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'x-2026', name), JSON.stringify(body));
  return dir;
}

test('readReviewFileState: no review-texts dir is unavailable, never "nothing excluded"', () => {
  const r = state.readReviewFileState('x-2026', SHOW, { dir: path.join(os.tmpdir(), 'pnrs-does-not-exist') });
  assert.equal(r.available, false);
  assert.deepEqual(r.files, []);
});

test('readReviewFileState: uses the rebuild predicate (wrongProduction and wrongShow are excluded)', () => {
  const dir = dirWith({
    'nytimes--a.json': { outletId: 'nytimes', outlet: 'The New York Times', criticName: 'A', publishDate: '2026-10-22', firstSeenAt: '2026-10-23T02:30:00Z', fullText: 'x'.repeat(2000) },
    'cititour--b.json': { outletId: 'cititour', outlet: 'Cititour', criticName: 'B', publishDate: '2025-06-02', firstSeenAt: '2026-08-14T00:00:00Z', wrongProduction: true },
    'vulture--c.json': { outletId: 'vulture', outlet: 'Vulture', criticName: 'C', publishDate: '2026-10-22', firstSeenAt: '2026-10-23T04:01:00Z', wrongShow: true },
  });
  const { files } = state.readReviewFileState('x-2026', SHOW, { dir });
  const by = Object.fromEntries(files.map((f) => [f.outletId, f]));
  assert.equal(by.nytimes.includable, true);
  assert.equal(by.cititour.includable, false);
  assert.equal(by.cititour.reason, 'wrongProduction');
  assert.equal(by.vulture.includable, false);
});

test('censusExclusions: an outlet whose every file is excluded leaves the census; one includable file keeps it', () => {
  const census = { entries: [{ outletId: 'cititour' }, { outletId: 'nytimes' }, { outletId: 'deadline' }, { outletId: 'nydailynews' }] };
  const files = [
    { outletId: 'cititour', includable: false, reason: 'wrongProduction' },
    { outletId: 'nytimes', includable: false, reason: 'nonReview' },
    { outletId: 'nytimes', includable: true, reason: null },
    { outletId: 'nydailynews', includable: false, reason: 'knownSyndicationSecondary', syndicatedUnder: 'chicagotribune' },
  ];
  const ex = state.censusExclusions(census, files);
  assert.deepEqual(ex.map((e) => e.outletId).sort(), ['cititour', 'nydailynews']);
  assert.match(ex.find((e) => e.outletId === 'nydailynews').reason, /syndicated copy of the chicagotribune review/);
  assert.equal(ex.find((e) => e.outletId === 'cititour').reason, 'wrongProduction');
  // deadline has no file at all (a listing we have not ingested): it stays in the denominator
  assert.ok(!ex.some((e) => e.outletId === 'deadline'));
});

test('BRO-8308: a census listing of a declared prior run\'s live review is not owed on the encore night (Specimen 2026-10-30)', () => {
  const runs = [{ previewsStartDate: '2026-05-06', openingDate: '2026-05-09', closingDate: '2026-06-06' }];
  const night = '2026-10-30';
  const opts = { windowStartMs: Date.parse('2026-10-30T20:00:00Z'), night, priorRuns: runs };
  const census = { entries: [
    { outletId: 'front-row-center', urls: ['https://www.frontrowcenter.com/2026/05/21/specimen-review/'] },
    { outletId: 'theater-scene', urls: ['https://www.theaterscene.net/plays/specimen/x/'] }, // its file is the encore's own
    { outletId: 'nytimes', urls: ['https://www.nytimes.com/2026/10/30/theater/specimen-review.html'] }, // not ingested yet
  ] };
  const files = [
    { outletId: 'front-row-center', includable: true, publishDate: '2026-05-21', firstSeenAt: '2026-05-22T00:00:00Z', url: 'frontrowcenter.com/2026/05/21/specimen-review' },
    { outletId: 'theater-scene', includable: true, publishDate: '2026-10-30', firstSeenAt: '2026-10-31T03:30:00Z', url: 'theaterscene.net/plays/specimen/x' },
  ];
  const ex = state.censusExclusions(census, files, opts);
  assert.deepEqual(ex.map((e) => e.outletId), ['front-row-center']);
  assert.match(ex[0].reason, /declared earlier run/);
  // without priorRuns the same listing stays owed (legacy behaviour)
  assert.deepEqual(state.censusExclusions(census, files, { ...opts, priorRuns: null }), []);
  // a run marked inheritReviews:false is another production and excuses nothing
  assert.deepEqual(state.censusExclusions(census, files, { ...opts, priorRuns: [{ ...runs[0], inheritReviews: false }] }), []);
  // the outlet also has tonight's own includable file: the stale listing does not excuse it
  const withNight = [...files, { outletId: 'front-row-center', includable: true, publishDate: night, firstSeenAt: '2026-10-31T03:10:00Z', url: 'frontrowcenter.com/2026/10/30/specimen-encore' }];
  assert.deepEqual(state.censusExclusions(census, withNight, opts), []);
  // strict window: a review 3 days after the prior run closed is the remount's own, still owed
  const lag = [{ ...files[0], publishDate: '2026-06-09' }];
  assert.deepEqual(state.censusExclusions(census, lag, opts), []);
});

test('BRO-8308: isPriorRunFile is strict, day-precise only and never excuses a file dated on or after the night', () => {
  const runs = [{ openingDate: '2024-11-26', closingDate: '2025-01-05' }];
  assert.equal(state.isPriorRunFile({ publishDate: '2024-12-03' }, '2026-11-24', runs), true);
  assert.equal(state.isPriorRunFile({ publishDate: '2026-11-24' }, '2026-11-24', runs), false);
  assert.equal(state.isPriorRunFile({ publishDate: 'December 3, 2024' }, '2026-11-24', runs), true); // written day-precise date
  assert.equal(state.isPriorRunFile({ publishDate: 'December 3rd, 2024' }, '2026-11-24', runs), true);
  assert.equal(state.isPriorRunFile({ publishDate: 'Dec 2024' }, '2026-11-24', runs), false); // month-only: not day-precise
  assert.equal(state.isPriorRunFile({ publishDate: 'garbage' }, '2026-11-24', runs), false);
  assert.equal(state.isPriorRunFile({ publishDate: '2024-12' }, '2026-11-24', runs), false); // ISO month only
  assert.equal(state.isPriorRunFile({ publishDate: '12/2024' }, '2026-11-24', runs), false);
  assert.equal(state.isPriorRunFile({ publishDate: '2024-12-03' }, '2026-11-24', []), false);
  assert.equal(state.isPriorRunFile({ publishDate: '2025-01-08' }, '2026-11-24', runs), false);
});
