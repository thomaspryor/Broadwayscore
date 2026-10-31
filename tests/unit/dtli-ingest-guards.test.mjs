// TESTS-VS-DERIVED-DATA-EXEMPT: picks a show and an absent id from shows.json at runtime, dates relative to that show; pins no show fact
// BRO-5288: the 2026-10-13 review refresh (broadway-review-texts c94cf8756)
// filed older-production DTLI rows under show ids shows.json does not have,
// re-quarantined 2014 rows for a 2026 production, and replaced the page byline
// on side-show-2014/timeout--david-cote.json with DTLI's critic column.
// Requires the REAL saveReview and guards (CLAUDE.md §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { saveReview } = require('../../scripts/extract-dtli-reviews.js');
const { newRowPredatesProduction, canonicalSlotNamesOtherCritic } = require('../../scripts/lib/dtli-ingest-guards.js');
const shows = require('../../data/shows.json').shows;
const showById = new Map(shows.map(s => [s.id, s]));

// A Broadway show with plain dates and no prior runs/tour legs, picked at
// runtime so no show fact is pinned; dates below are relative to it.
const SHOW = shows.find(s => s.category === 'broadway' && /^\d{4}-\d{2}-\d{2}$/.test(s.openingDate || '')
  && /^\d{4}-\d{2}-\d{2}$/.test(s.previewsStartDate || '') && !s.priorRuns && !s.tourLegs && !s.closingDate
  && s.openingDate < '2020-01-01' && !s._skipCrossShowDupe) ||
  shows.find(s => s.category === 'broadway' && /^\d{4}-\d{2}-\d{2}$/.test(s.openingDate || '') && !s.priorRuns && !s.tourLegs);
const SHOW_ID = SHOW.id;
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function longDate(iso, addDays = 0) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + addDays);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
const IN_WINDOW = longDate(SHOW.openingDate, 1);
const YEARS_BEFORE = longDate(SHOW.openingDate, -3 * 365);
const ABSENT_IDS = ['bro-5288-not-a-show', 'purpose-bro-5288-probe'].filter(id => !showById.has(id));

function withTempCorpus(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-guards-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function dtliRow(overrides) {
  return {
    outlet: 'The New York Times',
    outletId: 'nytimes',
    criticName: 'Charles Isherwood',
    url: 'https://www.nytimes.com/2013/01/11/theater/reviews/example.html',
    publishDate: 'January 10, 2013',
    dtliExcerpt: 'excerpt',
    fullText: null,
    isFullReview: false,
    originalScore: null,
    assignedScore: null,
    dtliThumb: 'Up',
    source: 'dtli',
    ...overrides,
  };
}

test('an archived page id that is not a shows.json row writes nothing', () => {
  // c94cf8756 created folders like the-other-place-2026 and purpose for ids shows.json lacks.
  assert.equal(ABSENT_IDS.length, 2);
  for (const showId of ABSENT_IDS) {
    withTempCorpus((dir) => {
      const out = saveReview(dtliRow({ showId }), false, dir);
      assert.equal(out, null);
      assert.equal(fs.existsSync(path.join(dir, showId)), false, 'no folder for an unknown id');
    });
  }
});

test('a new row dated years before the production is not created, not even in _pending', () => {
  const showId = SHOW_ID;
  withTempCorpus((dir) => {
    const out = saveReview(dtliRow({ showId, publishDate: YEARS_BEFORE, url: 'https://www.nytimes.com/old/theater/review.html' }), false, dir);
    assert.equal(out, null);
    assert.equal(fs.existsSync(path.join(dir, showId)), false);
    assert.equal(fs.existsSync(path.join(dir, '_pending')), false);
  });
});

test('a new row inside the production window is still written', () => {
  const showId = SHOW_ID;
  withTempCorpus((dir) => {
    const out = saveReview(dtliRow({ showId, criticName: 'Ben Brantley', publishDate: IN_WINDOW, url: 'https://www.nytimes.com/new/theater/review.html' }), false, dir);
    assert.ok(out, 'expected a written path');
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).criticName, 'Ben Brantley');
  });
});

function sideShowOnDisk() {
  // Shape of side-show-2014/timeout--david-cote.json after BRO-5232's fix.
  return {
    showId: SHOW_ID,
    outletId: 'timeout',
    outlet: 'Time Out New York',
    criticName: 'Adam Feldman',
    url: 'http://www.timeout.com/newyork/theater/side-show-1',
    publishDate: IN_WINDOW,
    fullText: 'x'.repeat(4000),
    isFullReview: true,
    assignedScore: 57,
    dtliThumb: 'Meh',
    source: 'dtli',
  };
}

function writeOnDisk(dir, data) {
  const showDir = path.join(dir, SHOW_ID);
  fs.mkdirSync(showDir, { recursive: true });
  const p = path.join(showDir, 'timeout--david-cote.json');
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

test('Side Show: a DTLI critic column never replaces the stored page byline (same url)', () => {
  withTempCorpus((dir) => {
    const p = writeOnDisk(dir, sideShowOnDisk());
    saveReview(dtliRow({
      showId: SHOW_ID, outletId: 'timeout', outlet: 'Time Out New York', criticName: 'David Cote',
      url: 'http://www.timeout.com/newyork/theater/side-show-1', publishDate: IN_WINDOW, dtliThumb: 'Meh',
    }), false, dir);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.criticName, 'Adam Feldman');
    assert.equal(after.isFullReview, true);
  });
});

test('Side Show: with no url match the conflicting slot is left untouched', () => {
  withTempCorpus((dir) => {
    const p = writeOnDisk(dir, sideShowOnDisk());
    const before = fs.readFileSync(p, 'utf8');
    const out = saveReview(dtliRow({
      showId: SHOW_ID, outletId: 'timeout', outlet: 'Time Out New York', criticName: 'David Cote',
      url: null, publishDate: IN_WINDOW,
    }), false, dir);
    assert.equal(out, null);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });
});

test('newRowPredatesProduction: before window skips, in window and dateless do not', () => {
  const show = { id: 'x-2026', previewsStartDate: '2026-09-20', openingDate: '2026-10-10' };
  assert.equal(newRowPredatesProduction({ publishDate: 'January 24, 2014', show, outletId: 'nytimes' }).skip, true);
  assert.equal(newRowPredatesProduction({ publishDate: 'October 11, 2026', show, outletId: 'nytimes' }).skip, false);
  assert.equal(newRowPredatesProduction({ publishDate: null, show, outletId: 'nytimes' }).skip, false);
  assert.equal(newRowPredatesProduction({ publishDate: 'January 24, 2014', show: null }).skip, false);
});

test('newRowPredatesProduction: a declared prior run of this production is not skipped', () => {
  const show = {
    id: 'x-2026', previewsStartDate: '2026-09-20', openingDate: '2026-10-10',
    priorRuns: [{ openingDate: '2014-01-01', closingDate: '2014-03-01' }],
  };
  assert.equal(newRowPredatesProduction({ publishDate: 'January 24, 2014', show, outletId: 'nytimes' }).skip, false);
});

test('canonicalSlotNamesOtherCritic: only two different real critics conflict', () => {
  assert.equal(canonicalSlotNamesOtherCritic('David Cote', { criticName: 'Adam Feldman' }), true);
  assert.equal(canonicalSlotNamesOtherCritic('David Cote', { criticName: 'David Cote' }), false);
  assert.equal(canonicalSlotNamesOtherCritic('David Cote', { criticName: 'Unknown' }), false);
  assert.equal(canonicalSlotNamesOtherCritic(null, { criticName: 'Adam Feldman' }), false);
  assert.equal(canonicalSlotNamesOtherCritic('David Cote', null), false);
});

test('loadLiveShowIds: reads shows.json ids; a missing file keeps everything (fail open like the floor)', () => {
  const { loadLiveShowIds, filterToLiveShowIds } = require('../../scripts/lib/live-show-ids.js');
  const live = loadLiveShowIds();
  assert.ok(live.has(SHOW_ID));
  assert.deepEqual(filterToLiveShowIds([ABSENT_IDS[0], SHOW_ID], live).dropped, [ABSENT_IDS[0]]);
  assert.equal(loadLiveShowIds('/nonexistent/shows.json'), null);
  assert.deepEqual(filterToLiveShowIds(['purpose'], null).dropped, []);
});

test('two critics at one outlet sharing a url: the DTLI row merges into its own critic file only', () => {
  // all-the-way-2014 shape: timeout--adam-feldman.json and timeout--david-cote.json share one url.
  withTempCorpus((dir) => {
    const showDir = path.join(dir, SHOW_ID);
    fs.mkdirSync(showDir, { recursive: true });
    const url = 'http://www.timeout.com/newyork/theater/side-show-1';
    const feldman = { ...sideShowOnDisk(), url, dtliExcerpt: 'feldman excerpt', originalScore: '4/5' };
    const cote = { ...sideShowOnDisk(), criticName: 'David Cote', url, dtliExcerpt: 'old cote excerpt', fullText: null, isFullReview: false, assignedScore: null };
    const pF = path.join(showDir, 'timeout--adam-feldman.json');
    const pC = path.join(showDir, 'timeout--david-cote.json');
    fs.writeFileSync(pF, JSON.stringify(feldman, null, 2));
    fs.writeFileSync(pC, JSON.stringify(cote, null, 2));
    const feldmanBefore = fs.readFileSync(pF, 'utf8');
    saveReview(dtliRow({
      showId: SHOW_ID, outletId: 'timeout', outlet: 'Time Out New York', criticName: 'David Cote',
      url, publishDate: IN_WINDOW, dtliExcerpt: 'new cote excerpt',
    }), false, dir);
    assert.equal(fs.readFileSync(pF, 'utf8'), feldmanBefore, "Feldman's file is untouched");
    assert.equal(JSON.parse(fs.readFileSync(pC, 'utf8')).dtliExcerpt, 'new cote excerpt');
  });
});

test('a new row a few weeks or months before previews is still written (only >180d is another production)', () => {
  const show = { id: 'x-2026', previewsStartDate: '2026-09-20', openingDate: '2026-10-10' };
  assert.equal(newRowPredatesProduction({ publishDate: 'July 22, 2026', show }).skip, false);
  assert.equal(newRowPredatesProduction({ publishDate: 'January 2, 2026', show }).skip, true);
});
