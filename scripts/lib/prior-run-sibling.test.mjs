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
  assert.deepEqual([...guard[SKIRBALL.id]], [['someone else', revival.id]]);
});

test('director guard: a priorRuns pointing at some OTHER earlier run does not exempt this entry', () => {
  const unrelatedLater = {
    ...ST_ANNS,
    priorRuns: [{ openingDate: '2019-01-01', closingDate: '2019-02-01', venue: 'Somewhere Else' }],
  };
  const guard = buildMultiProdDirectorGuard([SKIRBALL, unrelatedLater]);
  assert.deepEqual([...guard[SKIRBALL.id]], [['daniel fish', ST_ANNS.id]]);
});

test('director guard: same director on both entries needs no guard either way', () => {
  const withDirector = { ...SKIRBALL, creativeTeam: [{ name: 'Daniel Fish', role: 'Director' }] };
  const noLink = { ...ST_ANNS, priorRuns: undefined };
  assert.equal(buildMultiProdDirectorGuard([withDirector, noLink])[SKIRBALL.id], undefined);
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
