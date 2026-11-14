// BRO-6702: Specimen (specimen-off-broadway-2026, press night 2026-10-30) read "0 of 4 reviews live,
// Failed". The four Show Score listings (Theater Scene, Front Row Center, This Week in New York, Off Off
// Online) were the May 2026 world-premiere run's reviews; the Oct run is an encore of the same production.
// Three causes, each pinned here against the real functions:
//   1. the press-night grader counted a listing that IS a pre-night wrongProduction file as a night miss
//      (fixed in press-night-review-state.censusExclusions with BRO-6701's listing rule; BRO-6702 adds the
//      priorRunCandidate hint and keeps the file url normalized);
//   2. flag-wrong-production-by-date wrote "review undefined" when it dated a file from its URL;
//   3. so wrong-production-autoclear could not clear that flag once priorRuns was declared.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = require('./lib/press-night-review-state.js');
const pn = require('./lib/press-night-record.js');
const { censusVerdict } = require('./lib/review-census.js');
const { shouldAutoClearWrongProductionPriorRun } = require('./lib/wrong-production-autoclear.js');
const { guardNoteDate } = require('./lib/date-guard.js');

const NIGHT = '2026-10-30';
const EMB = '2026-10-31T02:00:00.000Z';
const WINDOW = Date.parse(EMB) - pn.DEFAULT_GATES.nightStartH * 3600000;
const OPTS = { windowStartMs: WINDOW, night: NIGHT };

// The real Show Score census for the night (parseShowScore of the archived page).
const URLS = {
  'theater-scene': 'https://www.theaterscene.net/plays/offbway-plays/specimen/tony-marinelli/',
  'front-row-center': 'https://thefrontrowcenter.com/2026/05/specimen/',
  'this-week-in-new-york': 'https://twi-ny.com/2026/05/20/axis-theatre-specimen-randall-sharp/',
  'off-off-online': 'https://www.offoffonline.com/offoffonline/2026/5/4/specimen',
};
const census = {
  hadAnySource: true,
  entries: Object.entries(URLS).map(([outletId, url]) => ({ outlet: outletId, critic: 'Unknown', stars: null, url, outletId })),
};
census.count = census.entries.length;

// fileState rows as the record captured them (first seen 2026-10-27, three days before the night).
const preNightFile = (outletId, url, extra = {}) => ({
  outletId, url, firstSeenAt: '2026-10-27T07:06:30.000Z', publishDate: '2026-05-21', includable: false, reason: 'wrongProduction', ...extra,
});
const specimenFiles = Object.entries(URLS).map(([o, u]) => preNightFile(o, u, o === 'this-week-in-new-york' ? { publishDate: null } : {}));

test('Specimen: listings that ARE the earlier run\'s excluded articles are not night misses', () => {
  const excluded = state.censusExclusions(census, specimenFiles, OPTS);
  assert.deepEqual(excluded.map((x) => x.outletId).sort(), Object.keys(URLS).sort());
  for (const x of excluded) {
    assert.match(x.reason, /another production's review \(wrongProduction\)/);
    assert.equal(x.priorRunCandidate, true); // "declare priorRuns if this is the same production"
  }
  const kept = pn.filterCensus(census, excluded);
  assert.equal(kept.count, 0);
  assert.deepEqual(censusVerdict(kept, new Set()).missing, []);
});

test('the listing exclusion stays narrow', () => {
  const one = { hadAnySource: true, count: 1, entries: [census.entries[0]] };
  const old = [preNightFile('theater-scene', URLS['theater-scene'])];
  // the outlet's night review is includable: listing stays in the denominator
  const nightOk = preNightFile('theater-scene', 'https://www.theaterscene.net/encore/', { firstSeenAt: '2026-10-31T02:30:00.000Z', publishDate: NIGHT, includable: true, reason: null });
  assert.deepEqual(state.censusExclusions(one, [...old, nightOk], OPTS), []);
  // merged entry: another aggregator lists a URL that is not the old article, so it may be the night review
  const merged = { ...one, entries: [{ ...census.entries[0], urls: [URLS['theater-scene'], 'https://www.theaterscene.net/specimen-encore/'] }] };
  assert.deepEqual(state.censusExclusions(merged, old, OPTS), []);
  // a pre-night file with a DIFFERENT url does not excuse the outlet's night listing (BRO-6079)
  const nightListing = { ...one, entries: [{ outletId: 'theater-scene', url: 'https://www.theaterscene.net/plays/offbway-plays/specimen-encore/tony-marinelli/' }] };
  assert.deepEqual(state.censusExclusions(nightListing, old, OPTS), []);
  // a URL match on an INCLUDABLE file still counts (it should be live)
  assert.deepEqual(state.censusExclusions(one, [{ ...old[0], includable: true, reason: null }], OPTS), []);
  // a pre-night non-review (ticket page) is not "another production": no exclusion, no prior-run hint
  assert.deepEqual(state.censusExclusions(one, [{ ...old[0], reason: 'isNonReview' }], OPTS), []);
  // wrongShow is excluded but is not a prior-run candidate
  const [ws] = state.censusExclusions(one, [{ ...old[0], reason: 'wrongShow' }], OPTS);
  assert.equal(ws.priorRunCandidate, undefined);
});

test('a raw census URL matches the same article stored normalized (tracking params, /amp, host alias)', () => {
  for (const raw of ['https://www.independent.co.uk/arts/x.html', 'https://a.com/r/?ref=bww', 'https://a.com/r/amp', 'https://a.com/r/?gaa_at=1&gaa_n=2']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6702-'));
    fs.mkdirSync(path.join(dir, 's'));
    fs.writeFileSync(path.join(dir, 's', 'o--c.json'), JSON.stringify({ showId: 's', outletId: 'o', outlet: 'O', criticName: 'C', url: raw, publishDate: '2026-05-25', wrongProduction: true, fullText: 'x '.repeat(400) }));
    const files = state.readReviewFileState('s', { id: 's', title: 'S', openingDate: NIGHT }, { dir }).files.map((f) => ({ ...f, firstSeenAt: '2026-10-27T07:06:30.000Z' }));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(files[0].reason, 'wrongProduction', raw);
    assert.equal(state.censusExclusions({ hadAnySource: true, count: 1, entries: [{ outletId: 'o', url: raw }] }, files, OPTS).length, 1, raw);
  }
});

test('URL match tolerates www / trailing slash differences', () => {
  const files = [preNightFile('theater-scene', 'https://theaterscene.net/plays/offbway-plays/specimen/tony-marinelli')];
  const one = { hadAnySource: true, count: 1, entries: [census.entries[0]] };
  assert.equal(state.censusExclusions(one, files, OPTS).length, 1);
});

test('readReviewFileState carries the review url so the census can be matched to it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6702-'));
  fs.mkdirSync(path.join(dir, 's'));
  fs.writeFileSync(path.join(dir, 's', 'theater-scene--tony-marinelli.json'), JSON.stringify({
    showId: 's', outletId: 'theater-scene', outlet: 'Theater Scene', criticName: 'Tony Marinelli', url: URLS['theater-scene'] + '?gaa_at=eafs&gaa_n=tok',
    publishDate: '2026-05-25', wrongProduction: true, fullText: 'x '.repeat(400),
  }));
  const read = state.readReviewFileState('s', { id: 's', title: 'S', openingDate: NIGHT }, { dir });
  assert.equal(read.available, true);
  // normalized: the row lands in the public record, so paywall-access tokens are stripped
  assert.equal(read.files[0].url, 'theaterscene.net/plays/offbway-plays/specimen/tony-marinelli');
  assert.equal(state.censusExclusions({ hadAnySource: true, count: 1, entries: [census.entries[0]] }, read.files.map((f) => ({ ...f, firstSeenAt: '2026-10-27T07:06:30.000Z' })), OPTS).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The real TWI-NY record shape: no publishDate, flagged from its URL date, note "review undefined".
const specimenShow = (priorRuns) => ({
  id: 'specimen-off-broadway-2026', title: 'Specimen', category: 'off-broadway', venue: 'Axis Theatre',
  previewsStartDate: '2026-10-28', openingDate: NIGHT, closingDate: '2026-11-21', ...(priorRuns ? { priorRuns } : {}),
});
const SPRING = [{ previewsStartDate: '2026-05-06', openingDate: '2026-05-09', closingDate: '2026-06-06', venue: 'Axis Theatre' }];
const twiny = () => ({
  outletId: 'this-week-in-new-york', url: URLS['this-week-in-new-york'], wrongProduction: true,
  wrongProductionNote: 'Date guard: review undefined is 140d before 2026-10-28 (preview/open) — likely different production',
});

test('priorRuns clears a URL-dated date-guard flag (no publishDate, legacy "review undefined" note)', () => {
  assert.equal(shouldAutoClearWrongProductionPriorRun(twiny(), specimenShow(SPRING)), true);
  assert.equal(shouldAutoClearWrongProductionPriorRun(twiny(), specimenShow(null)), false);
  const outside = { ...twiny(), url: 'https://twi-ny.com/2025/05/20/axis-theatre-specimen-randall-sharp/' };
  assert.equal(shouldAutoClearWrongProductionPriorRun(outside, specimenShow(SPRING)), false);
  const legacyNull = { ...twiny(), wrongProductionNote: twiny().wrongProductionNote.replace('undefined', 'null') };
  assert.equal(shouldAutoClearWrongProductionPriorRun(legacyNull, specimenShow(SPRING)), true);
});

test('the URL-date fallback is scoped to undated date-guard notes', () => {
  // a CV-promoted flag was never based on the URL date: a priorRuns window must not clear it via the URL
  const cv = { outletId: 'x', url: URLS['this-week-in-new-york'], wrongProduction: true, wrongProductionReason: 'CV-promoted: different cast' };
  assert.equal(shouldAutoClearWrongProductionPriorRun(cv, specimenShow(SPRING)), false);
});

test('priorRuns clears the three publishDate-carrying Specimen flags', () => {
  for (const pd of ['2026-05-11', '2026-05-21', '2026-05-25']) {
    const d = { outletId: 'x', url: 'https://example.com/specimen', publishDate: pd, wrongProduction: true,
      wrongProductionNote: `Date guard: review ${pd} is 139d before 2026-10-28 (preview/open) — likely different production` };
    assert.equal(shouldAutoClearWrongProductionPriorRun(d, specimenShow(SPRING)), true, pd);
  }
});

test('date-guard note names the date it used, never "undefined"', () => {
  assert.equal(guardNoteDate({ publishDate: '2026-05-21' }, new Date('2026-05-21')), '2026-05-21');
  assert.equal(guardNoteDate({}, new Date('2026-05-20T00:00:00Z')), '2026-05-20');
  assert.equal(guardNoteDate({}, null), 'unknown date');
});
