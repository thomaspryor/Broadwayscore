// BRO-4271: same-title older productions (2023 London School Girls) ingested
// as the 2026 Broadway show and blocking its real reviews. Every assertion
// below require()s the production function (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { otherProductionSignal, urlPathYear } = require('./other-production-signal.js');
const { detectIngestCollision } = require('./manual-review-fields.js');
const { isRedundantPendingStub } = require('../replay-pending-bylines.js');
const { wetCandidateShows, wetPostOtherProduction } = require('../scrape-westendtheatre-roundups.js');
const { matchTitleToShow } = require('./show-matching.js');

const SCHOOL_GIRLS = {
  id: 'school-girls-or-the-african-mean-girls-play-2026',
  title: 'School Girls; Or, The African Mean Girls Play',
  category: 'broadway',
  venue: 'Samuel J. Friedman Theatre',
  previewsStartDate: '2026-09-08',
  openingDate: '2026-09-28',
};

// The real 2023 London files, metadata as they sat in the review-texts repo.
const GUARDIAN_2023 = {
  outletId: 'guardian',
  criticName: 'Miriam Gillinson',
  url: 'https://www.theguardian.com/stage/2023/jun/18/school-girls-or-the-african-mean-girls-play-review-lyric-hammersmith',
  publishDate: '2023-06-15',
  source: 'westendtheatre',
  wrongProduction: true,
};
const GUARDIAN_2026 = {
  outletId: 'guardian',
  criticName: 'Juan A. Ramirez',
  url: 'https://www.theguardian.com/stage/2026/sep/28/school-african-mean-girls-play-review',
  publishDate: '2026-09-28',
};
// Stored date is WRONG (taken from a Time Out New York listing a url
// recovery once swapped in); only non-date signals can catch it.
const TIMEOUT_LONDON_BAD_DATE = {
  outletId: 'timeout-london',
  criticName: 'Alice Saville',
  url: 'https://www.timeout.com/london/theatre/school-girls-or-the-african-mean-girls-play-review',
  publishDate: '2026-09-10',
  source: 'westendtheatre',
  wrongProduction: true,
};

test('2023-dated Guardian review for the 2026 show is another production', () => {
  const sig = otherProductionSignal(GUARDIAN_2023, SCHOOL_GIRLS);
  assert.ok(sig, 'expected a signal');
  assert.equal(sig.signal, 'url-year');
  // ...and still caught with the date ignored entirely.
  assert.ok(otherProductionSignal(GUARDIAN_2023, SCHOOL_GIRLS, { skipDate: true }));
});

test('the 2026 Guardian review for the same outlet is accepted', () => {
  assert.equal(otherProductionSignal(GUARDIAN_2026, SCHOOL_GIRLS), null);
  assert.equal(otherProductionSignal({ ...GUARDIAN_2026, publishDate: null }, SCHOOL_GIRLS), null);
});

test('Time Out London review with a wrong in-window date is caught without the date', () => {
  const sig = otherProductionSignal(TIMEOUT_LONDON_BAD_DATE, SCHOOL_GIRLS, { skipDate: true });
  assert.ok(sig);
  assert.equal(sig.signal, 'url-edition-market');
});

test('Time Out New York on the Broadway show is not flagged', () => {
  const tony = { outletId: 'timeout', url: 'https://www.timeout.com/newyork/news/broadway-review-school-girls-or-the-african-mean-girls-play-092926', publishDate: '2026-09-29' };
  assert.equal(otherProductionSignal(tony, SCHOOL_GIRLS), null);
});

test('London-only outlet on a NYC show fires outlet-market; dual-market outlet does not', () => {
  const regionMaps = { outletRegionMap: { standard: 'london', guardian: 'london' }, dualMarket: new Set(['guardian']) };
  const standard = { outletId: 'standard', url: 'https://www.standard.co.uk/culture/theatre/school-girls-review-b1087967.html' };
  assert.equal(otherProductionSignal(standard, SCHOOL_GIRLS, { regionMaps }).signal, 'outlet-market');
  assert.equal(otherProductionSignal({ outletId: 'guardian', url: GUARDIAN_2026.url }, SCHOOL_GIRLS, { regionMaps }), null);
});

test('date well before first preview fires; a late-preview date does not', () => {
  const times = { outletId: 'times-uk', url: 'https://www.thetimes.co.uk/article/school-girls-review-c26fjdvzq', publishDate: '2023-06-15' };
  assert.equal(otherProductionSignal(times, SCHOOL_GIRLS).signal, 'date-before-production');
  assert.equal(otherProductionSignal({ ...times, publishDate: '2026-09-20' }, SCHOOL_GIRLS), null);
});

test('London venue in text is opt-in and needs the show venue absent', () => {
  const r = { outletId: 'x', url: 'https://example.com/r', fullText: 'At the Lyric Hammersmith, Monique Touko directs.' };
  assert.equal(otherProductionSignal(r, SCHOOL_GIRLS), null);
  assert.equal(otherProductionSignal(r, SCHOOL_GIRLS, { useText: true }).signal, 'venue-text');
  const transfer = { ...r, fullText: 'Transferring from the Lyric Hammersmith to the Samuel J. Friedman Theatre.' };
  assert.equal(otherProductionSignal(transfer, SCHOOL_GIRLS, { useText: true }), null);
});

test('urlPathYear reads a year path segment only', () => {
  assert.equal(urlPathYear(GUARDIAN_2023.url), 2023);
  assert.equal(urlPathYear('https://nystagereview.com/2026/09/28/x/'), 2026);
  assert.equal(urlPathYear('https://www.standard.co.uk/culture/theatre/b1087967.html'), null);
});

function tmpShowDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4271-'));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }
  return dir;
}

test('collision: a flagged 2023 Guardian file no longer blocks the undated 2026 roundup row', () => {
  const showDir = tmpShowDir({ 'guardian--miriam-gillinson.json': GUARDIAN_2023 });
  const incoming = { showDir, outletId: 'guardian', criticName: 'Unknown', url: GUARDIAN_2026.url, publishDate: null };
  // Before BRO-4271 (no show passed): the exact opening-night refusal.
  const before = detectIngestCollision(incoming);
  assert.equal(before.ok, false);
  assert.equal(before.reason, 'stale-flag-on-existing-file');
  // With the show: the 2023 file is provably another production.
  assert.deepEqual(detectIngestCollision({ ...incoming, show: SCHOOL_GIRLS }), { ok: true });
});

test('collision: the Time Out London file with the wrong date does not block Time Out London rows', () => {
  const showDir = tmpShowDir({ 'timeout-london--alice-saville.json': TIMEOUT_LONDON_BAD_DATE });
  const r = detectIngestCollision({ showDir, outletId: 'timeout-london', criticName: 'Someone Else', url: 'https://www.timeout.com/london/theatre/other', show: SCHOOL_GIRLS });
  assert.equal(r.ok, true);
});

test('collision: same filename still blocks (Beaches protection)', () => {
  const showDir = tmpShowDir({ 'guardian--unknown.json': { ...GUARDIAN_2023, criticName: 'Unknown' } });
  const r = detectIngestCollision({ showDir, outletId: 'guardian', criticName: 'Unknown', url: GUARDIAN_2026.url, show: SCHOOL_GIRLS });
  assert.equal(r.ok, false);
  const showDir2 = tmpShowDir({ 'guardian--miriam-gillinson.json': GUARDIAN_2023 });
  const r2 = detectIngestCollision({ showDir: showDir2, outletId: 'guardian', criticName: 'Miriam Gillinson', url: GUARDIAN_2026.url, show: SCHOOL_GIRLS });
  assert.equal(r2.ok, false);
});

test('collision: a flagged file with no other-production signal still blocks', () => {
  const flaggedCurrent = { outletId: 'guardian', criticName: 'X', url: 'https://www.theguardian.com/stage/2026/sep/29/other', publishDate: '2026-09-29', wrongProduction: true };
  const showDir = tmpShowDir({ 'guardian--x.json': flaggedCurrent });
  const r = detectIngestCollision({ showDir, outletId: 'guardian', criticName: 'Unknown', url: GUARDIAN_2026.url, show: SCHOOL_GIRLS });
  assert.equal(r.ok, false);
});

test('collision: an UNFLAGGED older --unknown file still blocks (it is a merge target)', () => {
  // Ship-check repro: findExistingReviewFile merges any named critic into an
  // --unknown file, so the carve-out must not open this path.
  const old = { outletId: 'guardian', criticName: 'Unknown', url: 'https://www.theguardian.com/stage/2022/jan/01/x', publishDate: '2022-01-01' };
  const showDir = tmpShowDir({ 'guardian--unknown.json': old });
  const r = detectIngestCollision({ showDir, outletId: 'guardian', criticName: 'Juan A. Ramirez', url: GUARDIAN_2026.url, publishDate: '2026-01-01', show: { ...SCHOOL_GIRLS, previewsStartDate: '2024-09-01', openingDate: '2024-09-28' } });
  assert.equal(r.ok, false);
});

test('pending stub: a stub carrying a score or excerpt is kept', () => {
  const stub = { outletId: 'nysr', criticName: 'Unknown', url: 'https://nystagereview.com/2026/09/28/x/' };
  assert.equal(isRedundantPendingStub({ ...stub, originalScore: '4/5' }, 'nysr--frank-scheck.json'), false);
  assert.equal(isRedundantPendingStub({ ...stub, bwwExcerpt: 'quote' }, 'nysr--frank-scheck.json'), false);
  assert.equal(isRedundantPendingStub({ ...stub, bwwExcerpt: null, originalScore: null }, 'nysr--frank-scheck.json'), true);
});

test('pending stub: byline-less textless stub whose url landed is redundant', () => {
  const stub = { outletId: 'nysr', criticName: 'Unknown', url: 'https://nystagereview.com/2026/09/28/x/', fullText: null };
  assert.equal(isRedundantPendingStub(stub, 'nysr--frank-scheck.json'), true);
  assert.equal(isRedundantPendingStub(stub, null), false);
  assert.equal(isRedundantPendingStub({ ...stub, fullText: 'real text' }, 'nysr--frank-scheck.json'), false);
  assert.equal(isRedundantPendingStub({ ...stub, criticName: 'Frank Scheck' }, 'nysr--frank-scheck.json'), false);
});

test('WET roundups only match London shows: School Girls roundup no longer lands on Broadway', () => {
  const shows = [SCHOOL_GIRLS, { id: 'hamlet-west-end-2026', title: 'Hamlet', category: 'west-end', previewsStartDate: '2026-05-01', openingDate: '2026-05-10' }];
  const candidates = wetCandidateShows(shows);
  assert.deepEqual(candidates.map(s => s.id), ['hamlet-west-end-2026']);
  assert.equal(matchTitleToShow('School Girls; Or, The African Mean Girls Play', candidates, { market: 'west-end' }), null);
  // Before: the same call over all shows matched the Broadway row.
  assert.equal(matchTitleToShow('School Girls; Or, The African Mean Girls Play', shows, { market: 'west-end' }).show.id, SCHOOL_GIRLS.id);
});

test('declared priorRuns exempt their dates, url years and markets', () => {
  const transfer = {
    id: 'abigails-party-west-end-2026', category: 'west-end', venue: "Wyndham's",
    previewsStartDate: '2026-08-12', openingDate: '2026-08-19',
    priorRuns: [{ venue: 'Theatre Royal Stratford East', openingDate: '2024-09-06', closingDate: '2024-10-05' }],
  };
  const r = { outletId: 'everything-theatre', url: 'https://everything-theatre.co.uk/2024/09/review-abigails-party-stratford-east/', publishDate: '2024-09-14' };
  assert.equal(otherProductionSignal(r, transfer), null);
  // Without the declared run, the same review is another production.
  const { priorRuns, ...noPrior } = transfer;
  assert.ok(otherProductionSignal(r, noPrior));
});

test('opera is exempt from the London-outlet signal (Bachtrack reviews the Met)', () => {
  const met = { id: 'turandot-off-broadway-2025', category: 'off-broadway', type: 'opera', openingDate: '2025-09-23' };
  const regionMaps = { outletRegionMap: { bachtrack: 'london' }, dualMarket: new Set() };
  assert.equal(otherProductionSignal({ outletId: 'bachtrack', url: 'https://bachtrack.com/review-turandot-met' }, met, { regionMaps }), null);
});

test('a December review of a show whose previews start in early January is not a prior year', () => {
  const show = { id: 'pen-pals-off-broadway-2025', category: 'off-broadway', previewsStartDate: '2025-01-06', openingDate: '2025-01-06' };
  assert.equal(otherProductionSignal({ outletId: 'x', url: 'https://thefrontrowcenter.com/2024/12/pen-pals/' }, show, { only: ['url-year'] }), null);
});

test('only: restricts to the named signals', () => {
  const dateOnly = { outletId: 'times-uk', url: 'https://www.thetimes.co.uk/article/x', publishDate: '2023-06-15' };
  assert.ok(otherProductionSignal(dateOnly, SCHOOL_GIRLS));
  assert.equal(otherProductionSignal(dateOnly, SCHOOL_GIRLS, { only: ['url-edition-market', 'url-year'] }), null);
});

test('auditIncludedReviews reports URL-proven other productions only', () => {
  const { auditIncludedReviews } = require('./other-production-signal.js');
  const hits = auditIncludedReviews(
    [GUARDIAN_2023, GUARDIAN_2026, { outletId: 'times-uk', url: 'https://www.thetimes.co.uk/article/x', publishDate: '2023-06-15' }]
      .map(r => ({ ...r, showId: SCHOOL_GIRLS.id })),
    [SCHOOL_GIRLS],
  );
  assert.deepEqual(hits.map(h => [h.outletId, h.signal]), [['guardian', 'url-year']]);
});

test('londonAggregatorCandidates keeps west-end and off-west-end rows only', () => {
  const { londonAggregatorCandidates } = require('./other-production-signal.js');
  const rows = [SCHOOL_GIRLS, { id: 'a', category: 'west-end' }, { id: 'b', category: 'off-west-end' }, { id: 'c', category: 'off-broadway' }, { id: 'd' }];
  assert.deepEqual(londonAggregatorCandidates(rows).map(s => s.id), ['a', 'b']);
});

test('no London-aggregator scraper matches West End titles against the unfiltered show list', () => {
  // Cousin guard (BRO-4271): the WestEndTheatre scraper and Stagedoor both
  // matched London roundups against ALL shows, so a same-title Broadway row
  // won whenever the London run was missing from shows.json.
  const files = [
    '../scrape-westendtheatre-roundups.js', '../scrape-stagedoor-critics.js', '../scrape-thestage-roundups.js',
    '../scrape-london-box-office-roundups.js', '../scrape-theatre-reviews.js', '../sweep-we-aggregators.js',
  ];
  const unfiltered = /matchTitleToShow\([^,]+,\s*(allShows|ourShows|shows|showsList)\s*,\s*\{\s*market:\s*'west-end'/;
  for (const rel of files) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!unfiltered.test(src), `${rel} matches a West End title against the unfiltered show list`);
  }
});

test('WET post dated before a London revival previews is another production', () => {
  const revival = { id: 'hamlet-west-end-2026', title: 'Hamlet', category: 'west-end', previewsStartDate: '2026-05-01', openingDate: '2026-05-10' };
  assert.ok(wetPostOtherProduction(revival, 'https://www.westendtheatre.com/123/reviews/hamlet-review-roundup/', '2023-06-15'));
  assert.equal(wetPostOtherProduction(revival, 'https://www.westendtheatre.com/124/reviews/hamlet-review-roundup/', '2026-05-11'), null);
});
