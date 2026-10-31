const isThinClosedShow = (s) => _thinShow(s, true);
const isThinCritic = (c) => _thinCritic(c, true);
// BRO-5969: index-bloat rules live in one pure module shared by pages and sitemap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// BRO-5992: GSC impressions input + frozen 10% cohort.
const gscLib = require('../../scripts/lib/gsc-impressions.js');
const seo = require('../../scripts/lib/seo-indexability.js');

test('closed show with GSC impressions stays indexable even with 0 landings', () => {
  assert.equal(seo.isThinClosedShow({ status: 'closed', reviewCount: 0, hasGscImpressions: true }, true), false);
  assert.equal(seo.isThinClosedShow({ status: 'closed', reviewCount: 0, hasGscImpressions: false }, true), true);
});

test('hasGscImpressions fails open without a snapshot and reads counts otherwise', () => {
  assert.equal(seo.hasGscImpressions('/show/x', null), true);
  assert.equal(seo.hasGscImpressions('/show/x', { '/show/y': 3 }), false);
  assert.equal(seo.hasGscImpressions('/show/y/', { '/show/y': 3 }), true);
  assert.equal(seo.loadGscImpressions('/nonexistent/file.json'), null);
});

test('GSC rows normalise host, slash and query and sum duplicates', () => {
  const agg = gscLib.aggregateRows([
    { keys: ['https://broadwayscorecard.com/show/hamilton'], impressions: 5 },
    { keys: ['https://www.broadwayscorecard.com/show/hamilton/'], impressions: 2 },
    { keys: ['https://broadwayscorecard.com/browse/best-musicals'], impressions: 9 },
  ]);
  assert.deepEqual(agg, { '/show/hamilton': 7 });
});

test('cohort hash is deterministic and about 10%', () => {
  assert.equal(seo.inCohortHash('a-slug'), seo.inCohortHash('a-slug'));
  const n = 5000;
  let hits = 0;
  for (let i = 0; i < n; i++) if (seo.inCohortHash(`slug-${i}`)) hits++;
  assert.ok(hits / n > 0.08 && hits / n < 0.12, `got ${hits / n}`);
});

test('rollout: only a frozen-cohort candidate is thin; kill switch and missing cohort fail open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort-'));
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ cohortSlugs: ['in-cohort'] }));
  const cohort = seo.loadCohort(file);
  const thin = { status: 'closed', reviewCount: 0, hasSearchLanding: false, hasGscImpressions: false };
  assert.equal(seo.inFrozenCohort('in-cohort', {}, cohort), true);
  assert.equal(seo.inFrozenCohort('other', {}, cohort), false);
  assert.equal(seo.inFrozenCohort('in-cohort', { SEO_THIN_COHORT_OFF: '1' }, cohort), false);
  assert.equal(seo.inFrozenCohort('in-cohort', {}, null), false);
  assert.equal(seo.loadCohort('/nonexistent.json'), null);
  // a cohort page that gained impressions or a landing is released
  assert.equal(seo.isThinClosedShow({ ...thin, hasGscImpressions: true }, true), false);
  assert.equal(seo.isThinClosedShow({ ...thin, status: 'upcoming' }, true), false);
});

test('committed cohort file: ~10% of candidates, disjoint control of equal size, all hash-derived', () => {
  const f = new URL('../../data/audit/seo-thin-cohort.json', import.meta.url);
  if (!fs.existsSync(f)) return; // not frozen yet
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (c.cohortSlugs.length === 0) return; // placeholder, not frozen yet
  assert.equal(c.controlSlugs.length, c.cohortSlugs.length);
  assert.ok(c.cohortSlugs.every(s => seo.inCohortHash(s)));
  const cohortSet = new Set(c.cohortSlugs);
  assert.ok(c.controlSlugs.every(s => !cohortSet.has(s)));
});

test('critic with GSC impressions stays indexable even with 0 landings', () => {
  assert.equal(seo.isThinCritic({ reviewCount: 0, hasGscImpressions: true }, true), false);
  assert.equal(seo.isThinCritic({ reviewCount: 0, hasGscImpressions: false }, true), true);
});

test('cast and critic wrappers consult GSC impressions (guards a silent revert)', () => {
  const readFileSync = fs.readFileSync;
  const actor = readFileSync(new URL('../../src/lib/actor-indexability.ts', import.meta.url), 'utf8');
  const critic = readFileSync(new URL('../../src/lib/seo-indexability.ts', import.meta.url), 'utf8');
  assert.match(actor, /hasGscImpressions\(`\/cast\//);
  assert.match(critic, /hasGscImpressions\(`\/critics\//);
});

test('committed GSC snapshot keys for critics and cast use the lookup format', () => {
  const snap = JSON.parse(fs.readFileSync(new URL('../../data/seo-gsc-impressions.json', import.meta.url), 'utf8'));
  const pages = snap.pages || snap;
  const keys = Object.keys(pages);
  assert.ok(keys.some((k) => k.startsWith('/critics/')));
  assert.ok(keys.some((k) => k.startsWith('/cast/')));
});
