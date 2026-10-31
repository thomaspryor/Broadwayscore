import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  isReturnOfProduction,
  buildMultiProdDirectorGuard,
  findPriorRunSiblings,
  inheritPriorRunReviews,
  collectCarriedFiles,
  collectHousedSiblingFiles,
  urlNamesPriorRunVenue,
  urlDatedInPriorRun,
} = require('./prior-run-sibling');

// Real shapes from shows.json (BRO-4759): the Feb 2026 NYU Skirball run has NO
// creativeTeam, the Oct 2026 St. Ann's entry lists Daniel Fish and declares the
// Skirball run on priorRuns.
const SKIRBALL = {
  id: 'kramerfauci-off-broadway-2026', title: 'Kramer/Fauci', category: 'off-broadway',
  venue: 'NYU Skirball Center for the Performing Arts',
  openingDate: '2026-02-11', closingDate: '2026-02-21', creativeTeam: [],
};
const ST_ANNS = {
  id: 'kramerfauci-st-anns-off-broadway-2026', title: 'Kramer/Fauci', category: 'off-broadway',
  venue: "St. Ann's Warehouse", openingDate: '2026-10-04', closingDate: '2026-10-24',
  creativeTeam: [{ name: 'Daniel Fish', role: 'Director' }],
  priorRuns: [{ openingDate: '2026-02-11', closingDate: '2026-02-21', venue: 'NYU Skirball Center for the Performing Arts' }],
};

test('a show that declares the earlier entry on priorRuns is a return of it', () => {
  assert.equal(isReturnOfProduction(ST_ANNS, SKIRBALL), true);
});

test('the link is directional and needs a declared priorRuns', () => {
  assert.equal(isReturnOfProduction(SKIRBALL, ST_ANNS), false);
  assert.equal(isReturnOfProduction({ ...ST_ANNS, priorRuns: undefined }, SKIRBALL), false);
  assert.equal(isReturnOfProduction({ ...ST_ANNS, priorRuns: [] }, SKIRBALL), false);
});

test('same venue with openings a few weeks apart still matches (preview vs official date)', () => {
  const drift = { ...SKIRBALL, openingDate: '2026-02-28' };
  assert.equal(isReturnOfProduction(ST_ANNS, drift), true);
});

test('a priorRuns entry for a different venue and date does not link an unrelated earlier entry', () => {
  const other = { ...SKIRBALL, venue: 'The Public Theater', openingDate: '2024-05-01', closingDate: '2024-06-01' };
  assert.equal(isReturnOfProduction(ST_ANNS, other), false);
});

test('different category is never a return (rebuild does not compare across markets)', () => {
  assert.equal(isReturnOfProduction(ST_ANNS, { ...SKIRBALL, category: 'broadway' }), false);
});

test('an earlier entry that opened AFTER the declaring show is not its prior run', () => {
  assert.equal(isReturnOfProduction(ST_ANNS, { ...SKIRBALL, openingDate: '2026-10-05' }), false);
});

test('director guard: no guard on the earlier entry of a declared return (the Kramer/Fauci bug)', () => {
  const guard = buildMultiProdDirectorGuard([SKIRBALL, ST_ANNS]);
  assert.equal(guard[SKIRBALL.id], undefined);
});

test('director guard still protects a genuinely different later production', () => {
  const revival = {
    id: 'kramerfauci-revival-off-broadway-2031', title: 'Kramer/Fauci', category: 'off-broadway',
    venue: 'Other Theatre', openingDate: '2031-03-01',
    creativeTeam: [{ name: 'Someone Else', role: 'Director' }],
  };
  const guard = buildMultiProdDirectorGuard([SKIRBALL, revival]);
  assert.deepEqual([...guard[SKIRBALL.id]], [['someone else', { newerId: revival.id, newerStart: '2031-03-01' }]]);
});

test('director guard: a priorRuns pointing at some OTHER earlier run does not exempt this entry', () => {
  const unrelatedLater = {
    ...ST_ANNS,
    priorRuns: [{ openingDate: '2019-01-01', closingDate: '2019-02-01', venue: 'Somewhere Else' }],
  };
  const guard = buildMultiProdDirectorGuard([SKIRBALL, unrelatedLater]);
  assert.deepEqual([...guard[SKIRBALL.id]], [['daniel fish', { newerId: ST_ANNS.id, newerStart: (ST_ANNS.previewsStartDate || ST_ANNS.openingDate).slice(0, 10) }]]);
});

test('director guard: same director on both entries needs no guard either way', () => {
  const withDirector = { ...SKIRBALL, creativeTeam: [{ name: 'Daniel Fish', role: 'Director' }] };
  const noLink = { ...ST_ANNS, priorRuns: undefined };
  assert.equal(buildMultiProdDirectorGuard([withDirector, noLink])[SKIRBALL.id], undefined);
});

// BRO-5373: Dear England's 2023 transfer had no openingDate on file and was
// sorted last, so its director was treated as a newer production's.
test('director guard orders an entry with no openingDate by its other dates', () => {
  const transfer = { id: 'dear-england-west-end-2023', title: 'Dear England', category: 'west-end',
    venue: 'Prince Edward Theatre', openingDate: null, previewsStartDate: '2023-10-09', closingDate: '2024-01-13',
    creativeTeam: [{ name: 'Rupert Goold', role: 'Director' }] };
  const returnRun = { id: 'dear-england-west-end-2025', title: 'Dear England', category: 'west-end',
    venue: 'Olivier Theatre', openingDate: '2025-03-18', creativeTeam: [] };
  const guard = buildMultiProdDirectorGuard([transfer, returnRun]);
  assert.equal(guard[returnRun.id], undefined);
  assert.deepEqual([...guard[transfer.id] || []], []);
});

test('director guard maps a director to the earliest newer production that lists them', () => {
  const mid = { id: 'kf-2028', title: 'Kramer/Fauci', category: 'off-broadway', venue: 'A', openingDate: '2028-05-01',
    creativeTeam: [{ name: 'Pat Same', role: 'Director' }] };
  const late = { id: 'kf-2030', title: 'Kramer/Fauci', category: 'off-broadway', venue: 'B', openingDate: '2030-05-01',
    creativeTeam: [{ name: 'Pat Same', role: 'Director' }] };
  const guard = buildMultiProdDirectorGuard([late, SKIRBALL, mid]);
  assert.deepEqual(guard[SKIRBALL.id].get('pat same'), { newerId: 'kf-2028', newerStart: '2028-05-01' });
});

test('findPriorRunSiblings returns the earlier entry and ignores other titles', () => {
  const unrelated = { ...SKIRBALL, id: 'other-2026', title: 'Something Else' };
  const found = findPriorRunSiblings(ST_ANNS, [SKIRBALL, unrelated, ST_ANNS]);
  assert.deepEqual(found.map(f => f.sibling.id), [SKIRBALL.id]);
});

const review = (over) => ({
  showId: SKIRBALL.id, outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Juan A. Ramírez',
  url: 'https://www.nytimes.com/2026/02/12/theater/larry-kramer-anthony-fauci-daniel-fish-aids.html',
  publishDate: '2026-02-12', assignedScore: 69, ...over,
});

test('inherits in-window reviews of the earlier entry onto the returning entry', () => {
  const reviews = [review({}), review({ outletId: 'theatlantic', criticName: 'Talya Zax', url: 'https://theatlantic.com/x', publishDate: '2026-02-21' })];
  const { inherited, links } = inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]);
  assert.equal(inherited.length, 2);
  assert.ok(inherited.every(r => r.showId === ST_ANNS.id && r.inheritedFromShowId === SKIRBALL.id));
  assert.deepEqual(links, [{ newerId: ST_ANNS.id, olderId: SKIRBALL.id, count: 2 }]);
});

test('does not mutate the input reviews', () => {
  const reviews = [review({})];
  inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]);
  assert.equal(reviews[0].showId, SKIRBALL.id);
  assert.equal(reviews[0].inheritedFromShowId, undefined);
});

test('a review dated outside the prior-run window or undated stays on the earlier entry', () => {
  const reviews = [
    review({ publishDate: '2026-10-05', url: 'https://x.test/late', outletId: 'late', criticName: 'Late' }),
    review({ publishDate: undefined, url: 'https://x.test/undated', outletId: 'undated', criticName: 'Undated' }),
  ];
  assert.equal(inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]).inherited.length, 0);
});

test('does not duplicate a review the returning entry already has (same URL)', () => {
  const reviews = [review({}), review({ showId: ST_ANNS.id, publishDate: '2026-10-05', criticName: 'Other Critic' })];
  assert.equal(inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]).inherited.length, 0);
});

test('does not duplicate the same outlet + critic already on the returning entry', () => {
  const reviews = [
    review({ criticName: 'Mark Rifkin', outletId: 'twiny', url: 'https://twi-ny.com/feb', publishDate: '2026-02-20' }),
    review({ showId: ST_ANNS.id, criticName: 'Mark Rifkin', outletId: 'twiny', url: 'https://twi-ny.com/sep', publishDate: '2026-09-24' }),
  ];
  assert.equal(inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]).inherited.length, 0);
});

test('a different critic at the same outlet is inherited (NYT Feb + NYT Oct both count)', () => {
  const reviews = [
    review({}),
    review({ showId: ST_ANNS.id, criticName: 'Helen Shaw', url: 'https://www.nytimes.com/2026/10/05/theater/kramer-fauci.html', publishDate: '2026-10-05' }),
  ];
  const { inherited } = inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]);
  assert.equal(inherited.length, 1);
  assert.equal(inherited[0].criticName, 'Juan A. Ramírez');
});

test('idempotent: feeding the output back in inherits nothing more', () => {
  const reviews = [review({})];
  const first = inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]);
  const again = inheritPriorRunReviews([...reviews, ...first.inherited], [SKIRBALL, ST_ANNS]);
  assert.equal(again.inherited.length, 0);
});

test('already-inherited reviews are never re-inherited down a chain', () => {
  const third = {
    ...ST_ANNS, id: 'kramerfauci-third-off-broadway-2027', openingDate: '2027-03-01', venue: 'Third Theatre',
    priorRuns: [{ openingDate: '2026-10-04', closingDate: '2026-10-24', venue: "St. Ann's Warehouse" }],
  };
  const inheritedOnStAnns = { ...review({}), showId: ST_ANNS.id, inheritedFromShowId: SKIRBALL.id, publishDate: '2026-10-10' };
  assert.equal(inheritPriorRunReviews([inheritedOnStAnns], [SKIRBALL, ST_ANNS, third]).inherited.length, 0);
});

test('canonicalizeUrl option is used for the duplicate check', () => {
  const reviews = [
    review({ url: 'https://x.test/a?utm=1' }),
    review({ showId: ST_ANNS.id, url: 'https://x.test/a', criticName: 'Other', outletId: 'other', publishDate: '2026-10-05' }),
  ];
  const canonicalizeUrl = u => String(u).split('?')[0];
  assert.equal(inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS], { canonicalizeUrl }).inherited.length, 0);
});

// collectCarriedFiles feeds the gap audit, which reads review-text FOLDERS.
const files = {
  [SKIRBALL.id]: [
    { _file: 'nyt.json', url: 'https://nyt.test/feb', publishDate: '2026-02-12' },
    { _file: 'late.json', url: 'https://x.test/late', publishDate: '2026-10-05' },
    { _file: 'undated.json', url: 'https://x.test/undated' },
    { _file: 'tm.json', url: 'https://tm.test/feb', publishDate: 'February 17th, 2026' },
    { _file: 'flagged.json', url: 'https://x.test/flagged', publishDate: '2026-02-13', wrongShow: true },
  ],
};
const deps = { loadFiles: (id) => files[id] || [], isCovered: (d) => !d.wrongShow };

test('collectCarriedFiles carries in-window includable files, tagged with their own entry', () => {
  const got = collectCarriedFiles(ST_ANNS, [SKIRBALL, ST_ANNS], deps);
  assert.deepEqual(got.map(d => d._file).sort(), ['nyt.json', 'tm.json']);
  assert.ok(got.every(d => d._ctxShow.id === SKIRBALL.id && d._carriedFromShowId === SKIRBALL.id));
});

test('collectCarriedFiles judges includability against the entry that holds the file', () => {
  const seen = [];
  collectCarriedFiles(ST_ANNS, [SKIRBALL, ST_ANNS], { loadFiles: deps.loadFiles, isCovered: (d, s) => { seen.push(s.id); return true; } });
  assert.ok(seen.length > 0 && seen.every(id => id === SKIRBALL.id));
});

test('collectCarriedFiles is empty without a link, or without a shows list', () => {
  assert.deepEqual(collectCarriedFiles(SKIRBALL, [SKIRBALL, ST_ANNS], deps), []);
  assert.deepEqual(collectCarriedFiles(ST_ANNS, undefined, deps), []);
});

test('an explicit priorRuns id link wins over mismatched dates and category', () => {
  const linked = { ...ST_ANNS, priorRuns: [{ id: SKIRBALL.id, openingDate: '2019-01-01', venue: 'Elsewhere' }] };
  assert.equal(isReturnOfProduction(linked, SKIRBALL), true);
  assert.equal(isReturnOfProduction(linked, { ...SKIRBALL, category: 'broadway' }), true);
});

test('showId, productionId and bare-string links are recognized (isCrossLinked vocabulary)', () => {
  for (const run of [{ showId: SKIRBALL.id }, { productionId: SKIRBALL.id }, SKIRBALL.id]) {
    assert.equal(isReturnOfProduction({ ...ST_ANNS, priorRuns: [run] }, SKIRBALL), true);
  }
});

test('a run explicitly linked to ANOTHER entry is never heuristically matched to this one', () => {
  const other = { ...ST_ANNS, priorRuns: [{ id: 'some-other-entry-2025', openingDate: '2026-02-11', venue: SKIRBALL.venue }] };
  assert.equal(isReturnOfProduction(other, SKIRBALL), false);
});

test('a dateless id link inherits using the earlier entry\'s own run as the window', () => {
  const idOnly = { ...ST_ANNS, priorRuns: [{ id: SKIRBALL.id }] };
  const reviews = [review({}), review({ url: 'https://x.test/late', outletId: 'late', criticName: 'Late', publishDate: '2026-10-05' })];
  const { inherited } = inheritPriorRunReviews(reviews, [SKIRBALL, idOnly]);
  assert.deepEqual(inherited.map(r => r.outletId), ['nytimes']);
});

test('a bare-string link carries reviews from the earlier entry\'s own dates', () => {
  const bare = { ...ST_ANNS, priorRuns: [SKIRBALL.id] };
  assert.equal(inheritPriorRunReviews([review({})], [SKIRBALL, bare]).inherited.length, 1);
});

test('an explicit id link holds across different titles; a date/venue match still needs the same title', () => {
  const retitled = { ...SKIRBALL, title: 'Kramer and Fauci: Workshop' };
  const linked = { ...ST_ANNS, priorRuns: [{ id: SKIRBALL.id, openingDate: '2026-02-11' }] };
  assert.deepEqual(findPriorRunSiblings(linked, [retitled, linked]).map(f => f.sibling.id), [SKIRBALL.id]);
  const unlinked = { ...ST_ANNS, title: 'Something Else Entirely' };
  assert.deepEqual(findPriorRunSiblings(unlinked, [SKIRBALL, unlinked]), []);
});

test('each earlier entry contributes only reviews inside ITS OWN run window', () => {
  const second = { ...SKIRBALL, id: 'kramerfauci-second-off-broadway-2026', venue: 'Other Hall', openingDate: '2026-05-01', closingDate: '2026-05-20' };
  const both = { ...ST_ANNS, priorRuns: [...ST_ANNS.priorRuns, { openingDate: '2026-05-01', closingDate: '2026-05-20', venue: 'Other Hall' }] };
  // A review in the FIRST entry's folder dated inside the SECOND run's window is not that entry's.
  const stray = review({ url: 'https://x.test/stray', outletId: 'stray', criticName: 'Stray', publishDate: '2026-05-10' });
  assert.equal(inheritPriorRunReviews([stray], [SKIRBALL, second, both]).inherited.length, 0);
});

test('chains do not propagate: a third run that names only the second gets nothing from the first', () => {
  const second = { ...ST_ANNS, id: 'kramerfauci-second-off-broadway-2026', openingDate: '2026-10-04' };
  const third = {
    ...ST_ANNS, id: 'kramerfauci-third-off-broadway-2027', openingDate: '2027-03-01', venue: 'Third Hall',
    priorRuns: [{ id: second.id, openingDate: '2026-10-04', closingDate: '2026-10-24' }],
  };
  const reviews = [review({}), { ...review({}), showId: second.id, inheritedFromShowId: SKIRBALL.id, publishDate: '2026-10-10' }];
  assert.equal(inheritPriorRunReviews(reviews, [SKIRBALL, second, third]).inherited.length, 0);
});

test('an unnamed and a named critic at the same outlet are different pairs and both carry', () => {
  const reviews = [
    review({ criticName: 'Jesse Green' }),
    review({ showId: ST_ANNS.id, criticName: undefined, url: 'https://www.nytimes.com/2026/10/05/theater/kramer-fauci.html', publishDate: '2026-10-05' }),
  ];
  assert.equal(inheritPriorRunReviews(reviews, [SKIRBALL, ST_ANNS]).inherited.length, 1);
});

test('inheritReviews:false on a priorRuns entry opts out of carrying reviews but keeps the link', () => {
  const optOut = { ...ST_ANNS, priorRuns: [{ ...ST_ANNS.priorRuns[0], inheritReviews: false }] };
  assert.equal(isReturnOfProduction(optOut, SKIRBALL), true); // director-guard exemption stays
  assert.equal(buildMultiProdDirectorGuard([SKIRBALL, optOut])[SKIRBALL.id], undefined);
  assert.equal(inheritPriorRunReviews([review({})], [SKIRBALL, optOut]).inherited.length, 0);
  assert.deepEqual(collectCarriedFiles(optOut, [SKIRBALL, optOut], deps), []);
});

test('carried files vouch for their own URL only (never the rest of their host)', () => {
  const got = collectCarriedFiles(ST_ANNS, [SKIRBALL, ST_ANNS], deps);
  assert.ok(got.length > 0 && got.every(d => d._exactMatchOnly === true));
});

// BRO-5333: real shapes. The 2026 Adelphi return opts out of the 2025 run's
// reviews and the 2025 run has its own entry, so its window no longer exempts
// a 2025-dated review from the pre-opening guard. A run with no entry of its
// own stays exempt; a run that carries reviews stays exempt.
const { preWindowExemptPriorRuns } = require('./prior-run-sibling');
const SPIES_2025 = {
  id: 'the-comedy-about-spies-west-end-2025', title: 'The Comedy About Spies', category: 'west-end',
  venue: 'Noël Coward Theatre', previewsStartDate: '2025-04-14', openingDate: '2025-05-06', closingDate: '2025-09-05',
};
const SPIES_RUN = { openingDate: '2025-04-14', closingDate: '2025-08-03', venue: 'Noël Coward Theatre', inheritReviews: false };
const SPIES_2026 = {
  id: 'the-comedy-about-spies-west-end-2026', title: 'The Comedy About Spies', category: 'west-end',
  venue: 'Adelphi Theatre', previewsStartDate: '2026-08-01', openingDate: '2026-08-06', closingDate: '2026-09-26',
  priorRuns: [SPIES_RUN],
};

test('BRO-5333: an opted-out prior run with its own entry no longer exempts the pre-opening guard', () => {
  assert.deepEqual(preWindowExemptPriorRuns(SPIES_2026, [SPIES_2025, SPIES_2026]), []);
});

test('BRO-5333: an opted-out run with no entry of its own stays exempt', () => {
  assert.deepEqual(preWindowExemptPriorRuns(SPIES_2026, [SPIES_2026]), [SPIES_RUN]);
});

test('BRO-5333: a carried run, or no priorRuns at all, is unchanged', () => {
  const carried = { ...SPIES_2026, priorRuns: [{ ...SPIES_RUN, inheritReviews: undefined }] };
  assert.deepEqual(preWindowExemptPriorRuns(carried, [SPIES_2025, carried]), carried.priorRuns);
  assert.equal(preWindowExemptPriorRuns(SPIES_2025, [SPIES_2025]), undefined);
  assert.equal(preWindowExemptPriorRuns(null, []), undefined);
});

// BRO-5705: files a sibling holds but does not carry are "housed", so the gap audit skips them.
const OPTED_OUT = { ...ST_ANNS, priorRuns: [{ ...ST_ANNS.priorRuns[0], inheritReviews: false }] };

test('collectHousedSiblingFiles returns in-window covered files of an opted-out sibling', () => {
  assert.deepEqual(collectCarriedFiles(OPTED_OUT, [SKIRBALL, OPTED_OUT], deps), []);
  const got = collectHousedSiblingFiles(OPTED_OUT, [SKIRBALL, OPTED_OUT], deps);
  assert.deepEqual(got.map(d => d._file).sort(), ['nyt.json', 'tm.json', 'undated.json']); // SKIRBALL closed before OPTED_OUT opened
  assert.ok(got.every(d => d._housedOnShowId === SKIRBALL.id));
});

test('collectHousedSiblingFiles is empty when the sibling is carried (no double-report) or unlinked', () => {
  assert.deepEqual(collectHousedSiblingFiles(ST_ANNS, [SKIRBALL, ST_ANNS], deps), []);
  assert.deepEqual(collectHousedSiblingFiles(SKIRBALL, [SKIRBALL, ST_ANNS], deps), []);
  assert.deepEqual(collectHousedSiblingFiles(OPTED_OUT, undefined, deps), []);
});

test('urlNamesPriorRunVenue: slug naming the earlier house and not this one', () => {
  const nc = { venue: 'Noël Coward Theatre', priorRuns: [{ venue: 'Bridge Theatre', openingDate: '2025-12-11' }] };
  assert.equal(urlNamesPriorRunVenue('https://x.uk/article/review-into-the-woods-at-bridge-theatre', nc), true);
  assert.equal(urlNamesPriorRunVenue('https://x.uk/review-into-the-woods-noel-coward-theatre', nc), false);
  assert.equal(urlNamesPriorRunVenue('https://x.uk/review-into-the-woods-bridge-theatre-then-noel-coward-theatre', nc), false);
  assert.equal(urlNamesPriorRunVenue('https://x.uk/the-bridge-review', nc), false);
  assert.equal(urlNamesPriorRunVenue('https://bridge-theatre.uk/review-into-the-woods', nc), false);
  assert.equal(urlNamesPriorRunVenue('https://x.uk/at-bridge-theatre', { venue: 'Y', priorRuns: [] }), false);
  assert.equal(urlNamesPriorRunVenue('https://x.uk/into-the-woods-transfers-from-bridge-theatre', nc), false);
  assert.equal(urlNamesPriorRunVenue('https://x.uk/review-bridge-theatre-no%C3%ABl-coward', nc), false);
  assert.equal(urlNamesPriorRunVenue('https://x.uk/review-bridge-theatre-noel-coward', nc), false);
});

test('collectHousedSiblingFiles skips undated files of a sibling still running when this run starts', () => {
  const open = { ...SKIRBALL, closingDate: undefined };
  const got = collectHousedSiblingFiles(OPTED_OUT, [open, OPTED_OUT], deps);
  assert.ok(!got.some(d => d._file === 'undated.json'));
});

test('urlDatedInPriorRun: path date inside the earlier run and before this run starts', () => {
  const nc = { openingDate: '2026-10-07', previewsStartDate: '2026-09-22', priorRuns: [{ venue: 'Bridge Theatre', openingDate: '2025-12-11', closingDate: '2026-05-30' }] };
  assert.equal(urlDatedInPriorRun('https://b.wordpress.com/2026/03/29/review-into-the-woods-london/', nc), true);
  assert.equal(urlDatedInPriorRun('https://x.com/2025/12/review/', nc), true);
  assert.equal(urlDatedInPriorRun('https://x.com/2026/10/08/review/', nc), false); // this run
  assert.equal(urlDatedInPriorRun('https://x.com/2026/09/30/review/', nc), false); // after run start (previews)
  assert.equal(urlDatedInPriorRun('https://x.com/review-into-the-woods/', nc), false); // undated fails open
  assert.equal(urlDatedInPriorRun('https://x.com/2026/03/29/r/', { ...nc, priorRuns: [] }), false);
});

// BRO-5489: two unrelated productions sharing a title in one market (Southwark
// musical Aug-Oct 2026, Rose Kingston play from Oct 13 2026). No priorRuns link.
const { collectSameTitleProductionFiles } = require('./prior-run-sibling');
const SOUTHWARK = { id: 'jane-eyre-off-west-end-2026', title: 'Jane Eyre', category: 'off-west-end',
  venue: 'Southwark Playhouse Elephant', previewsStartDate: '2026-08-28', openingDate: '2026-09-08', closingDate: '2026-10-24' };
const KINGSTON = { id: 'jane-eyre-rose-kingston-off-west-end-2026', title: 'Jane Eyre', category: 'off-west-end',
  venue: 'Rose Theatre Kingston', previewsStartDate: '2026-10-13', openingDate: '2026-10-15', closingDate: '2026-10-24' };
const sameTitleFiles = {
  [SOUTHWARK.id]: [
    { _file: 'aysp.json', url: 'https://ayoungishperspective.co.uk/2026/09/11/review-jane-eyre/', publishDate: '2026-09-11' },
    { _file: 'late.json', url: 'https://x.uk/kingston-review', publishDate: '2026-10-16' },
    { _file: 'undated.json', url: 'https://x.uk/undated' },
    { _file: 'flagged.json', url: 'https://x.uk/flagged', publishDate: '2026-09-10', wrongShow: true },
  ],
};
const sameTitleDeps = { loadFiles: id => sameTitleFiles[id] || [], isCovered: d => !d.wrongShow };

test('collectSameTitleProductionFiles: earlier same-title production holds its own dated reviews', () => {
  const got = collectSameTitleProductionFiles(KINGSTON, [SOUTHWARK, KINGSTON], sameTitleDeps);
  assert.deepEqual(got.map(d => d._file), ['aysp.json']);
  assert.equal(got[0]._housedOnShowId, SOUTHWARK.id);
});

test('collectSameTitleProductionFiles: never for the earlier show, another market, another title, or no dates', () => {
  assert.deepEqual(collectSameTitleProductionFiles(SOUTHWARK, [SOUTHWARK, KINGSTON], sameTitleDeps), []);
  assert.deepEqual(collectSameTitleProductionFiles({ ...KINGSTON, category: 'off-broadway' }, [SOUTHWARK, KINGSTON], sameTitleDeps), []);
  assert.deepEqual(collectSameTitleProductionFiles({ ...KINGSTON, title: 'Wuthering Heights' }, [SOUTHWARK, KINGSTON], sameTitleDeps), []);
  assert.deepEqual(collectSameTitleProductionFiles({ ...KINGSTON, previewsStartDate: undefined, openingDate: undefined }, [SOUTHWARK, KINGSTON], sameTitleDeps), []);
  assert.deepEqual(collectSameTitleProductionFiles(KINGSTON, undefined, sameTitleDeps), []);
});

test('collectSameTitleProductionFiles: a review dated after the earlier run closed does not match', () => {
  const closedEarly = { ...SOUTHWARK, closingDate: '2026-09-10' };
  assert.deepEqual(collectSameTitleProductionFiles(KINGSTON, [closedEarly, KINGSTON], sameTitleDeps), []);
});

test('collectSameTitleProductionFiles: date boundaries and an earlier show with no start date', () => {
  const files = {
    [SOUTHWARK.id]: [
      { _file: 'onstart.json', url: 'https://x.uk/onstart', publishDate: '2026-10-13' },
      { _file: 'before.json', url: 'https://x.uk/before', publishDate: '2026-08-01' },
      { _file: 'ok.json', url: 'https://x.uk/ok', publishDate: '2026-10-12' },
    ],
  };
  const deps = { loadFiles: id => files[id] || [], isCovered: () => true };
  assert.deepEqual(collectSameTitleProductionFiles(KINGSTON, [SOUTHWARK, KINGSTON], deps).map(d => d._file), ['ok.json']);
  const noStart = { ...SOUTHWARK, previewsStartDate: undefined, openingDate: undefined };
  assert.deepEqual(collectSameTitleProductionFiles(KINGSTON, [noStart, KINGSTON], deps), []);
});
