import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { countReviewVerdicts, countReviewSentiments, getReviewBadgePresentation } = require('./review-breakdown');
const { getSiteReviewStats, getShowReviewStats } = require('./opening-night-review-stats');
require('tsx/cjs');
const React = require('react');
const previousReact = globalThis.React;
globalThis.React = React;
test.after(() => { globalThis.React = previousReact; });
const { renderToStaticMarkup } = require('react-dom/server');
const { ScoreBreakdownBar } = require('../../src/components/show-cards/ScoreBreakdownBar');
const ReviewsList = require('../../src/components/ReviewsList').default;
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const cases = [
  {
    name: 'verdict overrides conflicting numeric bands', category: 'off-broadway',
    reviews: [
      { reviewScore: 67, verdict: 'Mixed' },
      { reviewScore: 53, verdict: 'mixed' },
      { reviewScore: 90, verdict: 'Pan' },
      { reviewScore: 80, verdict: 'rave' },
      { reviewScore: 60, verdict: 'Positive' },
    ],
    counts: { rave: 1, positive: 1, mixed: 2, negative: 1 },
    sentiments: { positive: 2, mixed: 2, negative: 1 },
  },
  {
    name: 'Broadway score fallback rounds and retains zero', category: 'broadway',
    reviews: [82.6, 64.6, 64, 0].map(reviewScore => ({ reviewScore })),
    counts: { rave: 1, positive: 1, mixed: 1, negative: 1 },
    sentiments: { positive: 2, mixed: 1, negative: 1 },
  },
  {
    name: 'London fallback uses its Gold threshold', category: 'off-west-end',
    reviews: [{ reviewScore: 84 }, { reviewScore: 84.6 }, { reviewScore: 60 }, { reviewScore: 54 }],
    counts: { rave: 1, positive: 1, mixed: 1, negative: 1 },
    sentiments: { positive: 2, mixed: 1, negative: 1 },
  },
];

for (const fixture of cases) {
  test(fixture.name, () => {
    assert.deepEqual(countReviewVerdicts(fixture.reviews, fixture.category), fixture.counts);
    assert.deepEqual(countReviewSentiments(fixture.reviews, fixture.category), fixture.sentiments);
    const html = renderToStaticMarkup(React.createElement(ScoreBreakdownBar, fixture));
    const c = fixture.counts;
    assert.ok(html.includes(`${fixture.reviews.length} reviews: ${c.rave} rave, ${c.positive} positive, ${c.mixed} mixed, ${c.negative} negative`), html);
    const site = getSiteReviewStats({
      cs: 67, rc: fixture.reviews.length, cat: fixture.category,
      rv: fixture.reviews.map(r => ({ s: r.reviewScore, v: r.verdict })),
      bd: { positive: 99, mixed: 99, negative: 99 },
    });
    assert.deepEqual(site, { score: 67, reviewCount: fixture.reviews.length, ...fixture.sentiments });
    // Readiness intentionally excludes zero-score reviews from live stats.
    const scored = fixture.reviews.filter(r => r.reviewScore > 0);
    const live = getShowReviewStats(scored.map(r => ({
      showId: 'test-show', outletId: 'nytimes', assignedScore: r.reviewScore, verdict: r.verdict,
    })), 'test-show', {}, fixture.category, site);
    const { positive, mixed, negative } = live;
    assert.deepEqual({ positive, mixed, negative }, countReviewSentiments(scored, fixture.category));
    assert.equal(live.siteScore, site.score);
    assert.equal(live.score, site.score);
    assert.equal(live.total, scored.length);
  });
}

test('absent verdicts and invalid scores do not manufacture negative reviews', () => {
  assert.deepEqual(countReviewVerdicts([null, undefined, NaN, Infinity].map(reviewScore => ({ reviewScore }))),
    { rave: 0, positive: 0, mixed: 0, negative: 0 });
  assert.deepEqual(countReviewSentiments([]), { positive: 0, mixed: 0, negative: 0 });
  assert.equal(getReviewBadgePresentation('bogus', 67).label, 'Positive');
});

test('opening-night stats retain missing-site fallback and readiness filtering', () => {
  assert.equal(getSiteReviewStats(null), null);
  assert.equal(getSiteReviewStats({ rc: 1 }), null);
  assert.deepEqual(getSiteReviewStats({ cs: 0, rc: 0 }), {
    score: 0, reviewCount: 0, positive: 0, mixed: 0, negative: 0,
  });
  const rows = [
    { showId: 'target', outletId: 'nytimes', assignedScore: 67, verdict: 'Mixed' },
    { showId: 'target', outletId: 'nytimes', assignedScore: 0, verdict: 'Pan' },
    { showId: 'target', outletId: 'nytimes', assignedScore: null, verdict: 'Pan' },
    { showId: 'other', outletId: 'nytimes', assignedScore: 90, verdict: 'Rave' },
  ];
  const stats = getShowReviewStats(rows, 'target', {}, 'broadway');
  assert.equal(stats.total, 1);
  assert.equal(stats.positive, 0);
  assert.equal(stats.mixed, 1);
  assert.equal(stats.negative, 0);
  assert.equal(stats.score, stats.liveScore);
  assert.equal(stats.siteScore, null);
  assert.equal(stats.scoreDrift, null);
  assert.deepEqual(stats.outletsSeen, ['nytimes']);
  const empty = getShowReviewStats(rows, 'missing', {}, 'broadway');
  assert.equal(empty.total, 0);
  assert.equal(empty.score, null);
});

test('actual review badges use verdict labels and colors, retaining the numeric score and size', () => {
  const rows = cases[0].reviews.map((review, index) => ({ ...review,
    outletId: `outlet-${index}`, outlet: `Outlet ${index}`, outletBadge: null,
    url: null, publishDate: '2026-10-29', tier: 2,
  }));
  const html = renderToStaticMarkup(React.createElement(ReviewsList, { reviews: rows }));
  for (const [score, label, color] of [[67, 'Mixed', 'score-tepid'], [53, 'Mixed', 'score-tepid'],
    [90, 'Negative', 'score-skip'], [80, 'Rave', 'score-must-see'], [60, 'Positive', 'score-great']]) {
    assert.match(html, new RegExp(`class="[^"]*w-11 h-11 sm:w-12 sm:h-12[^"]*${color}"[^>]*aria-label="Score: ${score} - ${label}"`));
  }
});

test('status and email callers normalize source rows into the shared counter', () => {
  for (const file of ['scripts/generate-status-page.js', 'scripts/lib/opening-night-review-stats.js']) {
    const source = read(file);
    assert.match(source, /countReviewSentiments\(\s*showRevs\.map\(r => \(\{ reviewScore: r\.assignedScore, verdict: r\.verdict \}\)\), show(?:\.category|Category)\)/);
    assert.doesNotMatch(source, /r\.assignedScore >= (75|55)/);
    assert.doesNotMatch(source, /data\.bd/);
  }
  assert.match(read('scripts/send-opening-night-broadcast.js'), /countReviewVerdicts\(\s*showReviews\.map\(r => \(\{ reviewScore: r\.assignedScore, verdict: r\.verdict \}\)\), market\)/);
});

test('both inline and lazy review lists receive the verdict from their writer', () => {
  assert.match(read('src/lib/show-review-items.ts'), /verdict: r\.verdict/);
  for (const file of ['src/app/show/[slug]/page.tsx', 'src/app/show/[slug]/reviews.json/route.ts']) {
    assert.match(read(file), /getReviewListItems\(show\)/);
  }
});
