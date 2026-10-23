/** buildCitation / getCitableScore (src/lib/cite-score.ts, BRO-5982). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCitation, getCitableScore, formatRetrievedDate } from '../../src/lib/cite-score';

const WHEN = new Date('2026-10-22T09:00:00Z');
const base = { title: 'Hamilton', slug: 'hamilton', year: 2015, score: 92, reviewCount: 44, siteName: 'Broadway Scorecard' };

test('citation matches the card example', () => {
  assert.equal(
    buildCitation(base, WHEN),
    'Hamilton (2015). Critic Score 92/100 from 44 reviews. Broadway Scorecard. https://broadwayscorecard.com/show/hamilton. Retrieved 22 October 2026.',
  );
});

test('singular review, missing year', () => {
  const s = buildCitation({ ...base, year: null, reviewCount: 1 }, WHEN);
  assert.match(s, /^Hamilton\. Critic Score 92\/100 from 1 review\. /);
});

test('retrieved date is UTC and unpadded', () => {
  assert.equal(formatRetrievedDate(new Date('2026-03-05T23:59:00Z')), '5 March 2026');
});

const show = (over: Record<string, unknown> = {}) => ({
  id: 'hamilton-2015', title: 'Hamilton', slug: 'hamilton', openingDate: '2015-08-06',
  category: 'broadway', status: 'open',
  criticScore: { score: 91.6, reviewCount: 44, tier1Count: 5, tier2Count: 6 },
  ...over,
}) as unknown as Parameters<typeof getCitableScore>[0];

test('scored show: score rounded exactly like the badge, count from criticScore', () => {
  assert.deepEqual(getCitableScore(show()), { title: 'Hamilton', slug: 'hamilton', year: 2015, score: 92, reviewCount: 44, siteName: 'Broadway Scorecard' });
});

test('no score, or too few reviews: null (badge reads TBD)', () => {
  assert.equal(getCitableScore(show({ criticScore: null })), null);
  assert.equal(getCitableScore(show({ criticScore: { score: 80, reviewCount: 1, tier1Count: 0, tier2Count: 0 } })), null);
  assert.equal(getCitableScore(show({ status: 'previews' })), null);
});

test('West End show cites the West End brand', () => {
  const c = getCitableScore(show({ category: 'west-end' }));
  assert.equal(c?.siteName, 'West End Scorecard');
  assert.match(buildCitation(c!, WHEN), /\. West End Scorecard\. https:/);
});
