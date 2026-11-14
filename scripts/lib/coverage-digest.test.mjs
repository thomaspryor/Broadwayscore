// Coverage Verdict S3 (task #905) — coverage digest line formatting.
// Run: node --test scripts/lib/coverage-digest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { coverageDigestLine, coverageDigestLines, coverageDigestItems } = require('./coverage-digest.js');

test('Car Man-shaped result renders the plan\'s exact example line', () => {
  const line = coverageDigestLine({
    title: 'The Car Man',
    showId: 'the-car-man-west-end-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
    missing: [
      { url: 'a', host: 'a.com' },
      { url: 'b', host: 'b.com' },
      { url: 'c', host: 'c.com', priorRun: true },
    ],
  });
  assert.strictEqual(line, 'The Car Man: 11 of 14 known reviews live — 2 being fetched, 1 excluded (older production)');
});

test('no-census-yet never renders a line (fail open)', () => {
  const line = coverageDigestLine({
    title: 'Some Show',
    showId: 'some-show',
    censusVerdict: { verdict: 'no-census-yet', liveCount: 0, candidateCount: 0 },
    missing: [],
  });
  assert.strictEqual(line, null);
});

test('fully live show renders nothing — no news is no line', () => {
  const line = coverageDigestLine({
    title: 'Complete Show',
    showId: 'complete-show',
    censusVerdict: { verdict: 'complete', liveCount: 5, candidateCount: 5 },
    missing: [],
  });
  assert.strictEqual(line, null);
});

test('missing censusVerdict entirely (COVERAGE_GATE_DISABLED / audit gap) renders nothing', () => {
  assert.strictEqual(coverageDigestLine({ title: 'X', showId: 'x' }), null);
  assert.strictEqual(coverageDigestLine(null), null);
});

test('all-pending show (no exclusions) omits the excluded clause', () => {
  const line = coverageDigestLine({
    title: 'Pending Show',
    showId: 'pending-show',
    censusVerdict: { verdict: 'incomplete', liveCount: 3, candidateCount: 5 },
    missing: [{ url: 'a' }, { url: 'b' }],
  });
  assert.strictEqual(line, 'Pending Show: 3 of 5 known reviews live — 2 being fetched');
});

test('coverageDigestItems produces the renderNamedDigestBlock {title, detail} shape', () => {
  const items = coverageDigestItems([{
    title: 'The Car Man',
    showId: 'the-car-man-west-end-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
    missing: [{ url: 'a' }, { url: 'b' }, { url: 'c', priorRun: true }],
  }]);
  assert.deepStrictEqual(items, [{
    title: 'The Car Man',
    detail: '11 of 14 known reviews live — 2 being fetched, 1 excluded (older production)',
  }]);
});

// ── Line coherence when `excluded` (drawn from the broader all-history
// missing-citation list) exceeds `candidateCount` (this run's roundup
// census) — task #907, othello-off-broadway-2026: 38 census candidates but
// 54 correctly-flagged priorRun citations from the unrelated 2025 Broadway
// production. The line must never read "N excluded" where N > "of M known" —
// and must NOT fix that by inflating "known" to swallow an unrelated
// production's citations (ship-check finding: an earlier version of this
// fix reported "0 of 54 known reviews live", falsely implying those 54 were
// part of Othello's own known pool). `candidateCount` (38) stays truthful;
// the overflow renders as its own explicitly-unrelated clause instead.

test('excluded count exceeding candidateCount never inflates "known" — overflow renders as a separate, explicitly-unrelated clause (Othello-shaped fixture)', () => {
  const missing = Array.from({ length: 54 }, (_, i) => ({ url: `https://outlet${i}.com/othello-2025-review`, priorRun: true }));
  const line = coverageDigestLine({
    title: 'Othello',
    showId: 'othello-off-broadway-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 0, candidateCount: 38 },
    missing,
  });
  assert.strictEqual(
    line,
    "Othello: 0 of 38 known reviews live — 38 being fetched — separately, 54 (older production) on file from outside this run's candidate pool",
  );
  // "known" must stay the true census figure — never inflated to absorb an
  // unrelated production's citation count.
  const knownMatch = line.match(/of (\d+) known/);
  assert.equal(Number(knownMatch[1]), 38);
  // And no clause anywhere in the line may read as "N excluded" with
  // N > known (the original incoherence) — the overflow's own wording
  // ("on file from outside this run's candidate pool") makes clear it isn't
  // part of the "of 38 known" tally at all.
  assert.doesNotMatch(line, /\d+ excluded/);
});

test('excluded within candidateCount is unaffected by the known-total fix (regression guard)', () => {
  const line = coverageDigestLine({
    title: 'The Car Man',
    showId: 'the-car-man-west-end-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
    missing: [
      { url: 'a' }, { url: 'b' }, { url: 'c', priorRun: true },
    ],
  });
  assert.strictEqual(line, 'The Car Man: 11 of 14 known reviews live — 2 being fetched, 1 excluded (older production)');
});

test('excluded count exactly equal to the remaining slots is NOT treated as overflow (boundary)', () => {
  const line = coverageDigestLine({
    title: 'Boundary Show',
    showId: 'boundary-show',
    censusVerdict: { verdict: 'incomplete', liveCount: 0, candidateCount: 3 },
    missing: [{ url: 'a', priorRun: true }, { url: 'b', priorRun: true }, { url: 'c', priorRun: true }],
  });
  assert.strictEqual(line, 'Boundary Show: 0 of 3 known reviews live — 3 excluded (older production)');
});

test('coverageDigestLines sorts least-complete first and respects the limit', () => {
  const results = [
    { title: 'Mostly Done', showId: 'a', censusVerdict: { verdict: 'incomplete', liveCount: 4, candidateCount: 5 }, missing: [{ url: 'x' }] },
    { title: 'Barely Started', showId: 'b', censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 5 }, missing: [{ url: 'x' }, { url: 'y' }, { url: 'z' }, { url: 'w' }] },
    { title: 'Complete', showId: 'c', censusVerdict: { verdict: 'complete', liveCount: 5, candidateCount: 5 }, missing: [] },
  ];
  const lines = coverageDigestLines(results, { limit: 1 });
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^Barely Started/);
});

test('v2 verdict: a prior-production citation never eats a "being fetched" slot', () => {
  // The same Car Man shape, but with a verdict the CURRENT rule produced.
  // candidateCount no longer contains the old citation, so all 3 outstanding
  // slots are genuinely still being fetched — reporting "2" would understate
  // the real work by exactly the number of un-actionable old citations.
  const line = coverageDigestLine({
    title: 'The Car Man',
    showId: 'the-car-man-west-end-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14, censusSchema: 2 },
    missing: [
      { url: 'https://a.com/review-x', host: 'a.com' },
      { url: 'https://b.com/review-x', host: 'b.com' },
      { url: 'https://c.com/review-x', host: 'c.com', priorRun: true },
    ],
  });
  assert.strictEqual(
    line,
    "The Car Man: 11 of 13 known reviews live — 2 being fetched, 1 unverified search hit, may be other productions — separately, 1 (older production) on file from outside this run's candidate pool",
  );
});

test('a pre-v2 verdict keeps the original fit-or-overflow heuristic unchanged', () => {
  // No schema stamp: the legacy row is read exactly as it was written, so an
  // excluded citation that FITS in the remaining slots still consumes one.
  // (An earlier cut decided this by candidate-URL membership; withdrawn —
  // candidateCount is outlet-distinct, so URL matching mixed counting units.)
  const line = coverageDigestLine({
    title: 'Legacy Show',
    showId: 'legacy-show-2026',
    censusVerdict: {
      verdict: 'incomplete',
      liveCount: 1,
      candidateCount: 3,
      candidates: [{ url: 'a' }, { url: 'b' }, { url: 'c' }],
    },
    missing: [{ url: 'b', host: 'b.com' }, { url: 'c', host: 'c.com', priorRun: true }],
  });
  assert.strictEqual(line, 'Legacy Show: 1 of 3 known reviews live — 1 being fetched, 1 excluded (older production)');
});

test('a v2 verdict ignores the candidate list entirely — outside by construction', () => {
  // Same row, now stamped v2. The citation cannot be a candidate, so it must
  // not eat a "being fetched" slot no matter what the candidate list says.
  const line = coverageDigestLine({
    title: 'Legacy Show',
    showId: 'legacy-show-2026',
    censusVerdict: {
      verdict: 'incomplete',
      liveCount: 1,
      candidateCount: 3,
      censusSchema: 2,
      candidates: [{ url: 'a' }, { url: 'b' }, { url: 'c' }],
    },
    missing: [{ url: 'https://b.com/review-x', host: 'b.com' }, { url: 'https://c.com/review-x', host: 'c.com', priorRun: true }],
  });
  assert.strictEqual(
    line,
    "Legacy Show: 1 of 2 known reviews live — 1 being fetched, 1 unverified search hit, may be other productions — separately, 1 (older production) on file from outside this run's candidate pool",
  );
});

// BRO-7153: Tosca Off-Broadway 2026 snapshot (2026-11-08). The SERP census pool
// held a 2018 Met Tosca, Royal Opera House, an album review, Chicago, Oxford and a
// film listing: none are the off-Broadway run. The line must not call them known.
test('BRO-7153: census-only candidates from other productions are not "known reviews"', () => {
  const cand = (outletId, url, state = 'GAP') => ({ outletId, url, state });
  const serp = (url) => ({ url, serpCensus: true });
  const urls = [
    'https://www.express.co.uk/entertainment/theatre/911185/Puccini-Tosca-opera-Royal-Opera-House-Jonathan-Kent',
    'https://theclassicreview.com/album-reviews/review-puccini-tosca-buratto/',
    'https://aroundthetownchicago.com/theatre-reviews/tosca-reviewed-by-jacob-davis/',
    'https://bachtrack.com/review-tosca-terfel-giannattasio-pirgu-oxford-interational-opera-september-2026',
    'https://www.viewlogue.com/film/the-metropolitan-opera-tosca',
  ];
  const result = {
    title: 'Tosca',
    showId: 'tosca-off-broadway-2026',
    censusVerdict: {
      verdict: 'incomplete', liveCount: 1, candidateCount: 11, censusSchema: 4,
      candidates: [cand('newyorkclassicalreview.com', 'http://newyorkclassicalreview.com/2018/01/yoncheva-triumphs-in-premiere-of-mets-new-and-dazzling-tosca/', 'live'), ...urls.map((u, i) => cand(`o${i}`, u))],
    },
    missing: urls.map(serp),
  };
  const line = coverageDigestLine(result);
  assert.doesNotMatch(line, /of 11/);
  assert.doesNotMatch(line, /10 being fetched/);
  assert.match(line, /^Tosca: 1 of 1 known reviews live — 10 unverified search hits, may be other productions$/);
  // A genuinely aggregator-cited miss is still "being fetched".
  const cited = coverageDigestLine({ ...result, missing: [...result.missing, { url: 'https://nytimes.com/2026/11/02/theater/tosca-review.html', knownOutletId: 'nytimes' }] });
  assert.match(cited, /^Tosca: 1 of 2 known reviews live — 1 being fetched, 9 unverified/);
});

test('BRO-7153: no cited reviews and no search hits renders nothing; no cited reviews yet reads plainly', () => {
  const base = { title: 'X', showId: 'x', missing: [{ url: 'https://a.com/x', serpCensus: true }] };
  assert.strictEqual(coverageDigestLine({ ...base, censusVerdict: { verdict: 'incomplete', liveCount: 0, candidateCount: 1, censusSchema: 4 } }),
    'X: no aggregator-cited reviews yet — 1 unverified search hit, may be other productions');
  assert.strictEqual(coverageDigestLine({ ...base, missing: [], censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 1, censusSchema: 4 } }), null);
});

test('BRO-7153: a cited miss outside the census pool still renders (census count 0)', () => {
  const line = coverageDigestLine({
    title: 'Y', showId: 'y',
    censusVerdict: { verdict: 'incomplete', liveCount: 0, candidateCount: 0, censusSchema: 4 },
    missing: [{ url: 'https://nytimes.com/2026/11/02/theater/y-review.html', knownOutletId: 'nytimes' }],
  });
  assert.strictEqual(line, 'Y: 0 of 1 known reviews live — 1 being fetched');
});
