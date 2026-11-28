// BRO-7497: page-vetted exclusions must not become live coverage when removed
// from missing[]. These are metadata-only shapes from the 2026-11-17 audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { censusVerdictFor, mergeGapAudit, riskStateMap, isRiskyGapChange } = require('../../scripts/lib/gap-audit-merge');
const { blastRadiusCheck } = require('../../scripts/lib/coverage-gate');

const now = '2026-11-17T23:04:04.192Z';
const cases = [
  ['arcadia-west-end-2026', 'http://www.theatermania.com/off-broadway/reviews/pity-in-history-and-arcadia-potomac-theatre_81820.html', 'page-date-before-run'],
  ['peter-pan-off-west-end-2026', 'https://www.afridiziak.com/reviews/peter-pan/', 'page-date-before-run'],
  ['222-a-ghost-story-off-broadway-2026', 'https://www.timeout.com/newyork/theater/2-22-a-ghost-story', 'timeout-listing-blurb'],
];
const rowFor = ([showId, url, reason]) => ({
  showId, aggregatorListedUrls: [url], missing: [], flaggedMisses: [], citedNoUrl: [],
  nonReviewCandidates: [{ url, nonReviewVerdict: reason }], computedAt: now,
});

for (const sample of cases) {
  test(`BRO-7497: ${sample[0]} does not count its rejected page as live`, () => {
    const row = rowFor(sample);
    const v = censusVerdictFor(row, { now });
    assert.equal(v.liveCount, 0);
    assert.equal(v.candidateCount, 0);
    assert.equal(v.verdict, 'no-census-yet');
    assert.deepEqual(v.excluded.map(e => [e.url, e.reason]), [[sample[1], sample[2]]]);
    assert.deepEqual(row.aggregatorListedUrls, [sample[1]], 'retain the source evidence');
  });
}

test('BRO-7497: a rejected page cannot cover a genuine miss from the same outlet', () => {
  const row = rowFor(cases[2]);
  const missing = { url: 'https://www.timeout.com/newyork/theater/current-review', host: 'timeout.com' };
  row.aggregatorListedUrls.push(missing.url);
  row.missing = [missing];
  const v = censusVerdictFor(row, { now });
  assert.equal(v.verdict, 'incomplete');
  assert.equal(v.liveCount, 0);
  assert.equal(v.candidateCount, 1);
  assert.deepEqual(v.candidates.map(c => c.url), [missing.url]);
});

test('BRO-7497: recorded exclusions win on every candidate path', () => {
  const row = rowFor(cases[0]);
  row.missing = [{ url: cases[0][1], host: 'theatermania.com' }];
  row.flaggedMisses = [{ url: cases[0][1], host: 'theatermania.com' }];
  row.citedNoUrl = [{ url: cases[0][1], outletId: 'theatermania' }];
  const v = censusVerdictFor(row, { now });
  assert.equal(v.candidateCount, 0);
  assert.equal(v.excluded.length, 1);
});

test('BRO-7497: an unrelated schema-4 baseline is carried without recomputing it', () => {
  const row = {
    showId: 'unrelated-show', computedAt: now,
    aggregatorListedUrls: ['https://www.nytimes.com/2026/11/17/theater/current-review.html'],
    censusVerdict: { censusSchema: 4, verdict: 'incomplete', liveCount: 1, candidateCount: 2, candidates: [] },
  };
  const merged = mergeGapAudit({ generatedAt: now, results: [row] }, { generatedAt: now, results: [] });
  assert.deepEqual(merged.results[0].censusVerdict, row.censusVerdict);
  assert.equal(riskStateMap([row], { now })[row.showId], 'incomplete:1:2');
});

test('BRO-7497: migrate the inflated baseline without hiding a broken checkout', () => {
  const realUrl = 'https://www.nytimes.com/2026/11/17/theater/current-production-review.html';
  const previous = Array.from({ length: 35 }, (_, i) => {
    const row = rowFor(cases[i % cases.length]);
    row.showId = `show-${i}`;
    row.aggregatorListedUrls.push(realUrl);
    // Schema 4 wrote both the excluded page and the real review as live.
    row.censusVerdict = {
      censusSchema: 4, verdict: 'complete', liveCount: 2, candidateCount: 2,
      candidates: row.aggregatorListedUrls.map(url => ({ url, state: 'live', firstSeenAt: now })),
    };
    return row;
  });
  const prior = { generatedAt: now, results: previous };
  const merged = mergeGapAudit(prior, { generatedAt: now, results: [] });
  assert.ok(merged.results.every(r => r.censusVerdict.liveCount === 1));
  assert.ok(merged.results.every(r => r.censusVerdict.candidateCount === 1));
  assert.ok(merged.results.every(r => r.computedAt === now), 'migration does not refresh audit timestamps');
  const prev = riskStateMap(previous, { now });
  const next = riskStateMap(merged.results, { now });
  const clean = blastRadiusCheck(prev, next, { env: {}, isRiskyChange: isRiskyGapChange });
  assert.equal(clean.changed, 0, 'removing invented live coverage is not a lost-review incident');
  assert.equal(clean.ok, true);

  const broken = mergeGapAudit(prior, { generatedAt: now, results: previous.map(r => ({
    ...r, missing: [{ url: realUrl, host: 'nytimes.com' }],
  })) });
  const loss = blastRadiusCheck(prev, riskStateMap(broken.results, { now }), { env: {}, isRiskyChange: isRiskyGapChange });
  assert.equal(loss.changed, 35);
  assert.equal(loss.ok, false, 'real review loss must still refuse the batch');
});
