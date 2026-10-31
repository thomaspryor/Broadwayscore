// Regression lock for LBO individual-review URL → show matching.
//
// Background: the LBO sitemap sweep (scrape-london-box-office-roundups.js) used
// to derive the show title by stripping a HARDCODED theatre-name list from the
// URL slug. Any venue not on that list (Royal Court was missing) left the title
// polluted, dropped the match below high confidence, and SILENTLY skipped the
// review — Stuart King's Archduke review (Royal Court, 2026-06-27) was lost this
// way. The sweep now routes individual review URLs through matchSlugToShow,
// which is token-based and venue-agnostic. These cases lock that in.
//
// Self-contained fixture (no data/shows.json dependency) so it runs in the
// no-data unit-tests batch — per CLAUDE.md §15.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchSlugToShow } = require('./show-matching.js');

const SHOWS = [
  { id: 'archduke-west-end-2026', title: 'Archduke', category: 'west-end', market: 'west-end' },
  // Numeric title (BRO-5631, was PR #391): the single-token gate used to reject
  // the 4-digit "1536" and silently drop Stuart King's review of it.
  { id: '1536-west-end-2026', title: '1536', category: 'west-end', market: 'west-end' },
  { id: 'avenue-q-west-end-2026', title: 'Avenue Q', category: 'west-end', market: 'west-end' },
  { id: 'glengarry-glen-ross-west-end-2026', title: 'Glengarry Glen Ross', category: 'west-end', market: 'west-end' },
  { id: 'sinatra-the-musical-west-end-2026', title: 'Sinatra the Musical', category: 'west-end', market: 'west-end' },
  { id: 'the-truth-a-comedy-by-florian-zeller-west-end-2026', title: 'The Truth: A Comedy by Florian Zeller', category: 'west-end', market: 'west-end' },
  // Distractor with no token overlap — confirms the matcher does not reach for
  // an unrelated show. (matchSlugToShow ignores the market option; the sweep's
  // cross-market scoping comes from pre-filtering the candidate pool, not this
  // object's category.)
  { id: 'some-other-show-2026', title: 'Some Other Show', category: 'west-end', market: 'west-end' },
];

const postSlug = (url) =>
  url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/news\/post\//, '').replace(/\/$/, '');

const CASES = [
  // The original miss: Royal Court is in no venue list, yet this must still match.
  { url: 'https://www.londonboxoffice.co.uk/news/post/archduke-royal-court-theatre-review', id: 'archduke-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/review-glengarry-glen-ross-old-vic', id: 'glengarry-glen-ross-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/sinatra-aldwych-theatre-review', id: 'sinatra-the-musical-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/review-the-truth-apollo-theatre', id: 'the-truth-a-comedy-by-florian-zeller-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/1536-ambassadors-review', id: '1536-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/avenue-q-shaftesbury-review', id: 'avenue-q-west-end-2026' },
];

test('LBO individual review URLs match their show at high confidence, venue-agnostically', () => {
  for (const { url, id } of CASES) {
    const m = matchSlugToShow(postSlug(url), SHOWS, { market: 'west-end' });
    assert.ok(m && m.show, `${url} should match a show`);
    assert.equal(m.confidence, 'high', `${url} should match at high confidence`);
    assert.equal(m.show.id, id, `${url} should map to ${id}`);
  }
});

test('Genuinely off-West-End fringe URLs correctly match nothing (no false positives)', () => {
  const m = matchSlugToShow('some-random-fringe-show-etcetera-theatre', SHOWS, { market: 'west-end' });
  assert.ok(!m || !m.show, 'a non-tracked fringe show must not match');
});

test('a lone number only matches on a hyphen boundary (1536 never matches 21536)', () => {
  const m = matchSlugToShow('21536-something-review', SHOWS, { market: 'west-end' });
  assert.ok(!m || !m.show || m.show.id !== '1536-west-end-2026');
});

const { pickLboIndividualReviewUrls } = require('./lbo-individual-serp.js');
const byId = (id) => SHOWS.find((s) => s.id === id);

test('SERP pick: takes the individual review for the targeted show', () => {
  const urls = [
    'https://www.londonboxoffice.co.uk/news/post/1536-review-round-up',
    'https://www.londonboxoffice.co.uk/news/post/1536-ambassadors-review?utm=x',
  ];
  assert.deepEqual(pickLboIndividualReviewUrls(urls, byId('1536-west-end-2026'), SHOWS),
    ['https://www.londonboxoffice.co.uk/news/post/1536-ambassadors-review']);
});

test('SERP pick: refuses roundups, other domains and slugs that win for another show', () => {
  const show = byId('avenue-q-west-end-2026');
  assert.deepEqual(pickLboIndividualReviewUrls([
    'https://www.londonboxoffice.co.uk/news/post/avenue-q-review-round-up',
    'https://www.example.com/news/post/avenue-q-review',
    'https://www.londonboxoffice.co.uk/news/post/review-archduke-royal-court',
    'https://www.londonboxoffice.co.uk/whats-on/avenue-q-review',
    null,
  ], show, SHOWS), []);
});

test('same-title productions resolve by year: dated 1536 West End beats the announced off-West-End 1536', () => {
  const pool = [...SHOWS, { id: '1536-off-west-end-2026', title: '1536', category: 'off-west-end', market: 'west-end', status: 'announced' }]
    .map((s) => (s.id === '1536-west-end-2026' ? { ...s, openingDate: '2026-04-10', status: 'closed' } : s));
  const m = matchSlugToShow('1536-ambassadors-review', pool, { year: 2026 });
  assert.equal(m && m.show && m.show.id, '1536-west-end-2026');
  assert.deepEqual(pickLboIndividualReviewUrls([
    'https://www.londonboxoffice.co.uk/news/post/1536-almeida-review',
    'https://www.londonboxoffice.co.uk/news/post/1536-ambassadors-review',
  ], pool.find((s) => s.id === '1536-west-end-2026'), pool, { year: 2026 }), [
    'https://www.londonboxoffice.co.uk/news/post/1536-almeida-review',
    'https://www.londonboxoffice.co.uk/news/post/1536-ambassadors-review',
  ], 'both go on; the page-date guard keeps the Ambassadors one');
});
