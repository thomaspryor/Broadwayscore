// BRO-8268: skip the paid site-search render when the outlet's website has never
// had a review in the show's category. Fails open; a small audit sample still renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mh = require('../../scripts/lib/site-search-market-history.js');
const ss = require('../../scripts/lib/site-search-discovery.js');

const CATS = { b1: 'broadway', w1: 'west-end', t1: 'tour' };
function fixtureCounts() {
  const reviews = [];
  for (let i = 0; i < 600; i++) reviews.push({ showId: 'b1', url: `https://www.nytimes.com/r/${i}` });
  for (let i = 0; i < 600; i++) reviews.push({ showId: 'w1', url: `https://www.theguardian.com/r/${i}` });
  reviews.push({ showId: 'b1', url: 'https://deadline.com/2025/01/x-review/' });
  reviews.push({ showId: 'w1', url: 'https://www.timeout.com/london/theatre/x-review' });
  reviews.push({ showId: 'b1', url: 'https://www.timeout.com/newyork/theater/y-review' });
  reviews.push({ showId: 'b1', url: 'https://variety.com/2025/legit/reviews/z' }); // subdomain-free host
  reviews.push({ showId: 'b1', url: 'https://news.example.org/a-review' });
  reviews.push({ showId: 't1', url: 'https://deadline.com/2025/02/tour-review/' }); // tour total is tiny
  reviews.push({ showId: 'zz', url: 'https://deadline.com/2025/03/unknown/' }); // unknown show: ignored
  reviews.push({ showId: 'b1' }); // no url: ignored
  return mh.buildDomainCategoryCounts(reviews, id => CATS[id] || null);
}

test('counts by hostname per category, ignoring unknown shows and missing urls', () => {
  const c = fixtureCounts();
  assert.equal(c.totals.get('broadway'), 604);
  assert.equal(c.totals.get('west-end'), 601);
  assert.equal(c.totals.get('tour'), 1);
  assert.equal(mh.domainCount(c.byCategory.get('broadway'), 'deadline.com'), 1);
  assert.equal(mh.domainCount(c.byCategory.get('broadway'), 'example.org'), 1, 'subdomain counts toward its domain');
  assert.equal(mh.domainCount(c.byCategory.get('broadway'), 'ample.org'), 0, 'no suffix overmatch');
});

test('decision: never-covered skips, covered keeps', () => {
  const counts = fixtureCounts();
  const env = {};
  assert.deepEqual(mh.neverCoveredMarketDecision({ domain: 'deadline.com', category: 'west-end', counts, env }),
    { skip: true, reason: 'never-covered', count: 0 });
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'deadline.com', category: 'broadway', counts, env }).skip, false);
  // timeout.com is searched under outletId timeout-london even for NYC shows: hostname counting keeps it
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'timeout.com', category: 'broadway', counts, env }).reason, 'covered');
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'www.timeout.com', category: 'west-end', counts, env }).reason, 'covered');
});

test('decision fails open: no data, unknown category/domain, small category, kill switch', () => {
  const counts = fixtureCounts();
  const env = {};
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'deadline.com', category: 'west-end', counts: null, env }).reason, 'no-data');
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'deadline.com', category: null, counts, env }).reason, 'unknown-category-or-domain');
  assert.equal(mh.neverCoveredMarketDecision({ domain: '', category: 'west-end', counts, env }).reason, 'unknown-category-or-domain');
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'ew.com', category: 'tour', counts, env }).reason, 'small-category');
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'ew.com', category: 'regional', counts, env }).reason, 'small-category');
  assert.equal(mh.neverCoveredMarketDecision({ domain: 'deadline.com', category: 'west-end', counts, env: { SITE_SEARCH_MARKET_HISTORY_GATE: '0' } }).reason, 'disabled');
});

test('audit rate: default, valid override, junk falls back', () => {
  assert.equal(mh.resolveAuditRate({}), 0.05);
  assert.equal(mh.resolveAuditRate({ SITE_SEARCH_MARKET_HISTORY_AUDIT: '0.2' }), 0.2);
  assert.equal(mh.resolveAuditRate({ SITE_SEARCH_MARKET_HISTORY_AUDIT: '7' }), 0.05);
  assert.equal(mh.resolveAuditRate({ SITE_SEARCH_MARKET_HISTORY_AUDIT: 'abc' }), 0.05);
});

test('real data loads and gives the expected answers for the four JS outlets', () => {
  mh._resetCacheForTests();
  const counts = mh.loadDomainCategoryCounts();
  if (!counts) return; // data not present in this checkout: fail-open path, nothing to assert
  const d = (domain, category) => mh.neverCoveredMarketDecision({ domain, category, counts, env: {} }).reason;
  assert.equal(d('deadline.com', 'broadway'), 'covered');
  assert.equal(d('ew.com', 'broadway'), 'covered');
  assert.equal(d('timeout.com', 'broadway'), 'covered');
  assert.equal(d('timeout.com', 'off-broadway'), 'covered');
  assert.equal(d('hollywoodreporter.com', 'west-end'), 'covered');
  assert.equal(d('deadline.com', 'west-end'), 'never-covered');
});

// --- integration through searchOutletSite ---
function withEndpoint(fn) {
  ss.SITE_SEARCH_ENDPOINTS.__t_js = {
    name: 'TJS', url: 'https://deadline.com/?s={TITLE}', domain: 'deadline.com',
    linkPattern: /href="(https:\/\/deadline\.com\/\d{4}\/[^"]*)"/gi, requiresJs: true,
  };
  return fn().finally(() => { delete ss.SITE_SEARCH_ENDPOINTS.__t_js; });
}
const HTML = '<a href="https://deadline.com/2025/05/the-show-review-123/">x</a>';

test('never-covered market: no paid call, outcome not-attempted (does not count toward give-up)', () => withEndpoint(async () => {
  let calls = 0;
  const outcomes = {};
  const res = await ss.searchOutletSite('__t_js', 'The Show', {
    show: { id: 'w1', title: 'The Show', category: 'west-end' }, market: 'west-end', outcomes,
    _deps: { sbFetch: async () => { calls++; return HTML; }, random: () => 0.99, marketHistoryCounts: fixtureCounts() },
  });
  assert.deepEqual(res, []);
  assert.equal(calls, 0);
  assert.equal(outcomes.__t_js, 'not-attempted');
}));

test('audit sample still pays the render and logs a hit', () => withEndpoint(async () => {
  let calls = 0;
  const warn = console.warn; const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    const res = await ss.searchOutletSite('__t_js', 'The Show', {
      show: { id: 'w1', title: 'The Show', category: 'west-end' }, market: 'west-end', outcomes: {},
      _deps: { sbFetch: async () => { calls++; return HTML; }, random: () => 0.01, marketHistoryCounts: fixtureCounts() },
    });
    assert.equal(calls, 1);
    assert.equal(res.length, 1);
  } finally { console.warn = warn; }
  assert.ok(lines.some(l => l.startsWith('MARKET-HISTORY-AUDIT-HIT [TJS]')), lines.join('\n'));
}));

test('covered market and missing data both render as before', () => withEndpoint(async () => {
  for (const [category, counts] of [['broadway', fixtureCounts()], ['west-end', null]]) {
    let calls = 0;
    const res = await ss.searchOutletSite('__t_js', 'The Show', {
      show: { id: 'x', title: 'The Show', category }, outcomes: {},
      _deps: { sbFetch: async () => { calls++; return HTML; }, random: () => 0.99, marketHistoryCounts: counts },
    });
    assert.equal(calls, 1, `${category} should render`);
    assert.equal(res.length, 1);
  }
}));
