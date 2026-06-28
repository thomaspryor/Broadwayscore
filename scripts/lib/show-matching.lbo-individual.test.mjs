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
  { id: 'glengarry-glen-ross-west-end-2026', title: 'Glengarry Glen Ross', category: 'west-end', market: 'west-end' },
  { id: 'sinatra-the-musical-west-end-2026', title: 'Sinatra the Musical', category: 'west-end', market: 'west-end' },
  { id: 'the-truth-a-comedy-by-florian-zeller-west-end-2026', title: 'The Truth: A Comedy by Florian Zeller', category: 'west-end', market: 'west-end' },
  // Distractor: a Broadway show that must NOT capture West-End-market lookups.
  { id: 'some-other-broadway-show-2026', title: 'Some Other Broadway Show', category: 'broadway', market: 'broadway' },
];

const postSlug = (url) =>
  url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/news\/post\//, '').replace(/\/$/, '');

const CASES = [
  // The original miss: Royal Court is in no venue list, yet this must still match.
  { url: 'https://www.londonboxoffice.co.uk/news/post/archduke-royal-court-theatre-review', id: 'archduke-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/review-glengarry-glen-ross-old-vic', id: 'glengarry-glen-ross-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/sinatra-aldwych-theatre-review', id: 'sinatra-the-musical-west-end-2026' },
  { url: 'https://www.londonboxoffice.co.uk/news/post/review-the-truth-apollo-theatre', id: 'the-truth-a-comedy-by-florian-zeller-west-end-2026' },
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
