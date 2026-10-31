// BRO-2507: unit tests for the pure decision logic behind the
// `Validate market expansion` gate in .github/workflows/test.yml
// (scripts/validate-market-expansion.js → scripts/lib/market-expansion-validator.js).
// CLAUDE.md §15: require() the real functions, never copy logic here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  MARKETS,
  THRESHOLD_SOURCES,
  CLOSING_GRACE_DAYS,
  findSlugMarkerMisses,
  findIdMarkerMisses,
  findShowsWithoutSlug,
  findSlugCollisions,
  findStaleOpenShows,
  findMissingRequiredFields,
  buildOutletDomainMaps,
  urlMatchesOutletDomain,
  scanShowReviews,
  sourceHandlesMarket,
  browseSerializesCategory,
  seoMarkerFor,
  summarize,
} = require('../../scripts/lib/market-expansion-validator.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY = 24 * 60 * 60 * 1000;

test('MARKETS covers the three non-Broadway markets the gate checks', () => {
  assert.deepEqual(MARKETS, ['west-end', 'off-west-end', 'off-broadway']);
});

test('findSlugMarkerMisses flags slugs without the market marker', () => {
  const shows = [
    { slug: 'hadestown-west-end' },
    { slug: 'hadestown' },
  ];
  assert.deepEqual(findSlugMarkerMisses(shows, 'west-end').map(s => s.slug), ['hadestown']);
  assert.deepEqual(
    findSlugMarkerMisses([{ slug: 'petra' }, { slug: 'petra-off-broadway' }], 'off-broadway').map(s => s.slug),
    ['petra'],
  );
});

test('findSlugMarkerMisses accepts legacy "west-end" slugs for off-west-end shows', () => {
  const shows = [
    { slug: 'magic-mike-live-west-end' },     // legacy slug: accepted
    { slug: 'some-show-off-west-end' },       // contains west-end: accepted
    { slug: 'fringe-thing' },                 // no marker: flagged
  ];
  assert.deepEqual(findSlugMarkerMisses(shows, 'off-west-end').map(s => s.slug), ['fringe-thing']);
});

test('findIdMarkerMisses has no legacy exemption (off-west-end ids need "off-west-end")', () => {
  const shows = [
    { id: 'magic-mike-live-west-end-2021' },
    { id: 'x-off-west-end-2025' },
  ];
  assert.deepEqual(findIdMarkerMisses(shows, 'off-west-end').map(s => s.id), ['magic-mike-live-west-end-2021']);
  assert.deepEqual(findIdMarkerMisses(shows, 'west-end'), []);
});

test('findSlugCollisions reports only EXACT duplicate slugs, across markets', () => {
  const shows = [
    { id: 'a-2024', slug: 'a', category: 'broadway' },
    { id: 'a-west-end-2024', slug: 'a', category: 'west-end' },
    { id: 'b-2024', slug: 'b' },
    { id: 'b-west-end-2024', slug: 'b-west-end', category: 'west-end' }, // similar base, not a collision
  ];
  const collisions = findSlugCollisions(shows);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0][0], 'a');
  assert.deepEqual(collisions[0][1].map(s => s.id), ['a-2024', 'a-west-end-2024']);
  assert.deepEqual(findSlugCollisions([{ slug: 'x' }, { slug: 'y' }]), []);
});

test('slug-less shows: reported by findShowsWithoutSlug, skipped by collision/marker checks', () => {
  const shows = [
    { id: 'no-slug-a', category: 'west-end' },
    { id: 'no-slug-b', slug: '', category: 'west-end' },
    { id: 'ok-west-end-2024', slug: 'ok-west-end', category: 'west-end' },
  ];
  assert.deepEqual(findShowsWithoutSlug(shows).map(s => s.id), ['no-slug-a', 'no-slug-b']);
  // two empty/missing slugs must not be reported as a collision with each other
  assert.deepEqual(findSlugCollisions(shows), []);
  // and must not crash the marker check; they are reported once, as the no-slug error
  assert.deepEqual(findSlugMarkerMisses(shows, 'west-end').map(s => s.id), []);
  assert.deepEqual(findShowsWithoutSlug([{ id: 'x', slug: 'x' }]), []);
});

test('findStaleOpenShows respects the 7+1 day auto-close grace window', () => {
  assert.equal(CLOSING_GRACE_DAYS, 8);
  const now = new Date('2026-06-30T12:00:00Z');
  const iso = (days) => new Date(now.getTime() - days * DAY).toISOString().slice(0, 10);
  const shows = [
    { id: 'just-closed', status: 'open', closingDate: iso(5) },    // inside grace: not flagged
    { id: 'stale', status: 'open', closingDate: iso(10) },         // past grace: flagged
    { id: 'closed', status: 'closed', closingDate: iso(30) },      // already closed: ignored
    { id: 'open-ended', status: 'open' },                          // no closingDate: ignored
    { id: 'future', status: 'open', closingDate: iso(-30) },
  ];
  assert.deepEqual(findStaleOpenShows(shows, now).map(s => s.id), ['stale']);
});

test('findMissingRequiredFields: type is exempt while announced, or upcoming as a provisional venue-page stub', () => {
  const shows = [
    { id: 'ok', title: 'T', category: 'off-broadway', status: 'open', type: 'play' },
    { id: 'announced-no-type', title: 'T', category: 'off-broadway', status: 'announced' },
    { id: 'upcoming-no-type', title: 'T', category: 'off-broadway', status: 'upcoming', type: null },
    // A dated venue-page stub (BRO-4396): genre not listed yet, so type stays null.
    { id: 'provisional-upcoming-no-type', title: 'T', category: 'off-broadway', status: 'upcoming', type: null, provisional: true, discoverySource: 'venue-page:here-arts-center' },
    { id: 'provisional-previews-no-type', title: 'T', category: 'off-broadway', status: 'previews', type: null, provisional: true, discoverySource: 'venue-page:here-arts-center' },
    // BRO-5261: only the venue-page stub class is exempt, not every provisional source.
    { id: 'manual-upcoming-no-type', title: 'T', category: 'off-broadway', status: 'upcoming', type: null, provisional: true, discoverySource: 'manual-user-request' },
    { id: 'no-title', category: 'off-broadway', status: 'open', type: 'musical' },
    { id: 'no-status', title: 'T', category: 'off-broadway', type: 'musical' },
    { id: 'no-category', title: 'T', status: 'open', type: 'musical' },
  ];
  assert.deepEqual(
    findMissingRequiredFields(shows).map(s => s.id),
    ['upcoming-no-type', 'provisional-previews-no-type', 'manual-upcoming-no-type', 'no-title', 'no-status', 'no-category'],
  );
});

test('buildOutletDomainMaps lowercases domains and aliases; tolerates a null registry', () => {
  const maps = buildOutletDomainMaps({
    outlets: {
      nyt: { domain: 'NYTimes.com', domainAliases: ['NYT.com'] },
      nodomain: { name: 'x' },
    },
  });
  assert.deepEqual(maps.outletDomains, { nyt: 'nytimes.com' });
  assert.deepEqual(maps.outletDomainAliases, { nyt: ['nyt.com'] });
  assert.deepEqual(buildOutletDomainMaps(null), { outletDomains: {}, outletDomainAliases: {} });
});

test('urlMatchesOutletDomain: exact, www, subdomain, alias, mismatch, unparseable', () => {
  assert.equal(urlMatchesOutletDomain('https://nytimes.com/a', 'nytimes.com'), true);
  assert.equal(urlMatchesOutletDomain('https://www.nytimes.com/a', 'www.nytimes.com'), true);
  assert.equal(urlMatchesOutletDomain('https://m.nytimes.com/a', 'nytimes.com'), true);
  assert.equal(urlMatchesOutletDomain('https://nyt.com/a', 'nytimes.com', ['www.nyt.com']), true);
  assert.equal(urlMatchesOutletDomain('https://evil.example.com/a', 'nytimes.com', ['nyt.com']), false);
  // suffix that is not a subdomain boundary must not match
  assert.equal(urlMatchesOutletDomain('https://notnytimes.com/a', 'nytimes.com'), false);
  assert.equal(urlMatchesOutletDomain('not a url', 'nytimes.com'), null);
});

test('scanShowReviews counts URL mismatches, duplicate outlet pairs and early reviews', () => {
  const { outletDomains, outletDomainAliases } = buildOutletDomainMaps({
    outlets: {
      wet: { domain: 'westendtheatre.com', domainAliases: ['westendtheatre.co.uk'] },
      we: { domain: 'westend.com' },
    },
  });
  const show = { id: 'hadestown-west-end-2024', openingDate: '2024-02-22' };
  const reviews = [
    { file: 'wet--a.json', review: { outletId: 'wet', url: 'https://www.westendtheatre.co.uk/r1', publishDate: '2024-02-23' } },
    // wrong domain + >1y early + same outlet as above (duplicate pair)
    { file: 'wet--b.json', review: { outletId: 'wet', url: 'https://evil.example.com/r2', publishDate: '2020-01-01' } },
    // outletId falls back to the filename prefix; subdomain match; text date
    { file: 'we--c.json', review: { url: 'https://m.westend.com/x', publishDate: 'February 25, 2024' } },
    // flagged reviews are excluded entirely
    { file: 'we--d.json', review: { outletId: 'we', url: 'https://other.com/x', wrongProduction: true } },
    { file: 'we--e.json', review: { outletId: 'we', duplicateOf: 'we--c.json' } },
  ];
  assert.deepEqual(scanShowReviews(show, reviews, outletDomains, outletDomainAliases), {
    totalReviews: 3,
    urlMismatches: 1,
    duplicatePairs: 1,
    earlyReviews: 1,
  });
});

test('scanShowReviews: clean show reports all zeros except the total', () => {
  const { outletDomains, outletDomainAliases } = buildOutletDomainMaps({ outlets: { we: { domain: 'westend.com' } } });
  const stats = scanShowReviews(
    { openingDate: '2024-02-22' },
    [{ file: 'we--a.json', review: { outletId: 'we', url: 'https://westend.com/a', publishDate: '2024-02-23' } }],
    outletDomains,
    outletDomainAliases,
  );
  assert.deepEqual(stats, { totalReviews: 1, urlMismatches: 0, duplicatePairs: 0, earlyReviews: 0 });
});

test('scanShowReviews: an unparseable URL counts toward the total but skips dedup/early checks', () => {
  const { outletDomains, outletDomainAliases } = buildOutletDomainMaps({ outlets: { we: { domain: 'westend.com' } } });
  const reviews = [
    { file: 'we--a.json', review: { outletId: 'we', url: 'not a url', publishDate: '2000-01-01' } },
    { file: 'we--b.json', review: { outletId: 'we', url: 'also bad', publishDate: '2000-01-01' } },
  ];
  assert.deepEqual(
    scanShowReviews({ openingDate: '2024-02-22' }, reviews, outletDomains, outletDomainAliases),
    { totalReviews: 2, urlMismatches: 0, duplicatePairs: 0, earlyReviews: 0 },
  );
});

test('sourceHandlesMarket requires the quoted market literal', () => {
  assert.equal(sourceHandlesMarket(`if (m === 'west-end') return 3;`, 'west-end'), true);
  assert.equal(sourceHandlesMarket(`// west-end handled elsewhere`, 'west-end'), false);
  // 'west-end' inside 'off-west-end' must not count as handling off-west-end
  assert.equal(sourceHandlesMarket(`case 'west-end':`, 'off-west-end'), false);
});

test('browseSerializesCategory needs both the key and the show.category source', () => {
  assert.equal(browseSerializesCategory('{ category: show.category }'), true);
  assert.equal(browseSerializesCategory('{ category: "x" }'), false);
  assert.equal(browseSerializesCategory('{ cat: show.category }'), false);
});

test('seoMarkerFor maps each market to its site name', () => {
  assert.equal(seoMarkerFor('west-end'), 'West End Scorecard');
  assert.equal(seoMarkerFor('off-west-end'), 'Off-West End Scorecard');
  assert.equal(seoMarkerFor('off-broadway'), 'Off-Broadway Scorecard');
});

test('summarize: any error fails (exit 1); warnings alone pass (exit 0)', () => {
  assert.deepEqual(summarize(1, 0), { exitCode: 1, status: 'failed' });
  assert.deepEqual(summarize(2, 5), { exitCode: 1, status: 'failed' });
  assert.deepEqual(summarize(0, 3), { exitCode: 0, status: 'warnings' });
  assert.deepEqual(summarize(0, 0), { exitCode: 0, status: 'passed' });
});

// Code-only structural check: reads tracked src/ files only (no data/), so
// it cannot make this advisory gate's data checks blocking (CLAUDE.md §19).
test('structural: score-buckets.ts handles every market and the browse page serializes category', () => {
  // The display gate score-buckets.ts re-exports lives in scripts/lib/min-reviews.js (BRO-4312).
  const scoreBuckets = THRESHOLD_SOURCES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  for (const market of MARKETS) {
    assert.ok(sourceHandlesMarket(scoreBuckets, market), `score-buckets.ts / min-reviews.js do not handle '${market}'`);
  }
  const browse = fs.readFileSync(path.join(ROOT, 'src', 'app', 'browse', '[slug]', 'page.tsx'), 'utf8');
  assert.ok(browseSerializesCategory(browse), 'browse page no longer serializes category');
});

test('findUntypedStubsNearPreviews names exempt untyped stubs inside the warning window (BRO-5261)', () => {
  const { findUntypedStubsNearPreviews } = require('../../scripts/lib/market-expansion-validator.js');
  const stub = (id, previewsStartDate, extra = {}) => ({ id, title: 'T', category: 'off-broadway', status: 'upcoming', type: null, provisional: true, discoverySource: 'venue-page:x', previewsStartDate, ...extra });
  const now = new Date('2027-03-20T12:00:00Z');
  const shows = [
    stub('soon', '2027-04-08'),
    stub('late', '2027-09-09'),
    stub('typed', '2027-04-01', { type: 'play' }),
    stub('undated', null),
    stub('overdue', '2027-03-01'),
  ];
  assert.deepEqual(findUntypedStubsNearPreviews(shows, now).map((s) => s.id), ['soon', 'overdue']);
});
