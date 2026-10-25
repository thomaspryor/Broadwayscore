const isThinClosedShow = (s) => _thinShow(s, true);
const isThinCritic = (c) => _thinCritic(c, true);
// BRO-5969: index-bloat rules live in one pure module shared by pages and sitemap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isThinClosedShow: _thinShow, isThinCritic: _thinCritic, hasSearchLanding, thinRulesEnabled } = require('../../scripts/lib/seo-indexability.js');
const { isThinActorProfile } = require('../../scripts/lib/actor-indexability.js');

test('closed show with zero reviews and no search traffic is thin', () => {
  assert.equal(isThinClosedShow({ status: 'closed', reviewCount: 0 }), true);
});

test('closed show with reviews or a search landing stays indexable', () => {
  assert.equal(isThinClosedShow({ status: 'closed', reviewCount: 1 }), false);
  assert.equal(isThinClosedShow({ status: 'closed', reviewCount: 0, hasSearchLanding: true }), false);
});

test('upcoming, announced, previews and open shows are never thin', () => {
  for (const status of ['upcoming', 'announced', 'previews', 'open']) {
    assert.equal(isThinClosedShow({ status, reviewCount: 0 }), false, status);
  }
  assert.equal(isThinClosedShow(undefined), false);
});

test('critic with one review is thin unless it has search traffic', () => {
  assert.equal(isThinCritic({ reviewCount: 1 }), true);
  assert.equal(isThinCritic({ reviewCount: 0 }), true);
  assert.equal(isThinCritic({ reviewCount: 2 }), false);
  assert.equal(isThinCritic({ reviewCount: 1, hasSearchLanding: true }), false);
});

test('strict actor rule: one credit is thin even with a score, unless nominated or searched', () => {
  const one = { showCount: 1, scoredShowCount: 1, avgScore: 70 };
  assert.equal(isThinActorProfile(one, 0, false, true), true);
  assert.equal(isThinActorProfile(one, 1, false, true), false);
  assert.equal(isThinActorProfile(one, 0, true, true), false);
  assert.equal(isThinActorProfile({ showCount: 2 }, 0, false, true), false);
});

test('hasSearchLanding matches paths ignoring trailing slash', () => {
  const set = new Set(['/show/a']);
  assert.equal(hasSearchLanding('/show/a/', set), true);
  assert.equal(hasSearchLanding('/show/b', set), false);
});

test('duplicate venue spellings fold to one canonical page name', () => {
  const { foldVenueName, stubTheaterName } = require('../../scripts/lib/page-name-sources.js');
  assert.equal(foldVenueName('Vivian Beaumont Theater - Lincoln Center Theater'), 'Vivian Beaumont Theater');
  assert.equal(stubTheaterName('National Theatre (Dorfman)'), 'Dorfman Theatre');
  assert.equal(stubTheaterName('Dorfman Theatre (National Theatre)'), 'Dorfman Theatre');
  assert.equal(stubTheaterName('County Hall'), 'London County Hall');
  assert.equal(stubTheaterName('Lower E Side'), 'Lower Eastside Girls Club');
  assert.equal(foldVenueName('Palace Theatre'), 'Palace Theatre');
});

test('a missing or empty search-landings list fails open (nothing becomes noindex)', () => {
  const { loadSearchLandings } = require('../../scripts/lib/seo-indexability.js');
  assert.equal(loadSearchLandings('/nonexistent/landings.json'), null);
  assert.equal(hasSearchLanding('/show/a', null), true);
  assert.equal(isThinClosedShow({ status: 'closed', reviewCount: 0, hasSearchLanding: hasSearchLanding('/show/a', null) }), false);
});

test('venue folds do not chain and every vercel redirect destination is a fold target', () => {
  const { VENUE_PAGE_NAME_FOLDS } = require('../../scripts/lib/page-name-sources.js');
  for (const target of Object.values(VENUE_PAGE_NAME_FOLDS)) assert.equal(VENUE_PAGE_NAME_FOLDS[target], undefined, target);
});

test('thin rules are off by default and only SEO_THIN_NOINDEX=1 turns them on', () => {
  assert.equal(thinRulesEnabled({}), false);
  assert.equal(thinRulesEnabled({ SEO_THIN_NOINDEX: '0' }), false);
  assert.equal(thinRulesEnabled({ SEO_THIN_NOINDEX: '1' }), true);
  assert.equal(_thinShow({ status: 'closed', reviewCount: 0 }, false), false);
  assert.equal(_thinCritic({ reviewCount: 0 }, false), false);
});

test('sitemap count delta warns only past a 3% drop', () => {
  const { sitemapCountDelta, countLocs } = require('../../scripts/lib/sitemap-count-delta.js');
  assert.equal(sitemapCountDelta(1000, 980).ok, true);
  assert.equal(sitemapCountDelta(1000, 960).ok, false);
  assert.equal(sitemapCountDelta(1000, 1100).ok, true);
  assert.equal(sitemapCountDelta(0, 5).ok, true);
  assert.equal(countLocs('<urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>'), 2);
});
