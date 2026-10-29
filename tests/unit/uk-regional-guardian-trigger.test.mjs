// TESTS-VS-DERIVED-DATA-EXEMPT: the one shows.json read is a structural clash check (no feeder-venue pattern may claim a venue filed under another market); it pins no facts about any show.
// BRO-4923: noteworthy UK-regional trigger. A Guardian critic review of a
// production at a flagship house in data/uk-regional-venues.json gets the show
// into shows.json without waiting for a BWW/Playbill roundup (the RSC As You
// Like It, press night 2026-10-06, had none). Tests the real exports
// (CLAUDE.md §15), including the real venue table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractGuardianReview, buildShowTitleIndex, findUnmatchedCandidates } = require('../../scripts/lib/reverse-discovery.js');
const { ukFlagshipVenueFor, isUkFlagshipVenue, ukFlagshipShows, decideUkFlagshipPromotion, stageUkRegionalCandidates } = require('../../scripts/lib/uk-regional-guardian.js');
const { decideRegionalPromotion, buildRegionalShowEntry } = require('../../scripts/promote-ob-venue-candidates.js');
const { feederVenueCity } = require('../../scripts/lib/aggregator-candidate-extract.js');
const { getTheaterAddress } = require('../../scripts/lib/venue-addresses.js');
const table = require('../../data/uk-regional-venues.json');

// Shape of the live feed item for the RSC production (2026-10-07).
const RSC_AYLI_ITEM = {
  title: 'As You Like It review – Jonathan Groff is a joy in an all-male RSC revival',
  link: 'https://www.theguardian.com/stage/2026/oct/07/as-you-like-it-review-rsc',
  categories: ['Theatre', 'Stage', 'Culture', 'Royal Shakespeare Company', 'As You Like It'],
};

test('Guardian RSC review routes to uk-regional with the venue name', () => {
  const r = extractGuardianReview(RSC_AYLI_ITEM);
  assert.equal(r.market, 'uk-regional');
  assert.equal(r.title, 'As You Like It');
  assert.equal(r.venue, 'Royal Shakespeare Theatre');
});

test('a London tag still wins over a flagship-house tag (RSC at the Barbican stays West End)', () => {
  const r = extractGuardianReview({
    title: 'Some Play review – at the Barbican',
    link: 'https://www.theguardian.com/stage/2026/oct/07/some-play-review-barbican-london',
    categories: ['Theatre', 'Royal Shakespeare Company', 'London'],
  });
  assert.equal(r.market, 'west-end');
});

test('a non-flagship regional house is still dropped', () => {
  const r = extractGuardianReview({
    title: 'Educating Rita review – Willy Russell revival',
    link: 'https://www.theguardian.com/stage/2026/oct/05/educating-rita-review-willy-russell-everyman-theatre-cheltenham',
    categories: ['Theatre', 'Stage', 'Everyman theatre'],
  });
  assert.equal(r, null);
});

test('alias matching is whole-phrase: a slug naming the house counts, a longer word does not', () => {
  assert.equal(ukFlagshipVenueFor({ slug: 'hamlet-review-royal-shakespeare-theatre-stratford' }).venue, 'Royal Shakespeare Theatre');
  assert.equal(ukFlagshipVenueFor({ slug: 'hamlet-review-royal-shakespeare-theatrex' }), null);
  // Bare "rsc" is deliberately not an alias (aggregator-candidate-extract.js: too short, collides).
  assert.equal(ukFlagshipVenueFor({ slug: 'as-you-like-it-review-rsc' }), null);
});

test('staging is idempotent: the same report twice yields the same rows (no duplicate shows)', () => {
  const report = [{ title: 'As You Like It', source: 'guardian-review', url: 'https://g/1', date: '2026-10-07T10:00:00Z', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' }];
  const strip = (rows) => rows.map(({ discoveredAt, ...r }) => r);
  assert.deepEqual(strip(stageUkRegionalCandidates(report, 'a')), strip(stageUkRegionalCandidates(report, 'b')));
});

test('the workflow selects only guardian-review promotions for the UK press dispatch', async () => {
  const fs = await import('node:fs');
  const yml = fs.readFileSync(new URL('../../.github/workflows/scrape-new-aggregators.yml', import.meta.url), 'utf8');
  const m = yml.match(/IDS=\$\(node -e "(const d=require[^"]+)"/g).find((s) => s.includes('guardian-review'));
  assert.ok(m, 'dispatch step must filter on source guardian-review');
  const expr = m.replace(/^IDS=\$\(node -e "/, '').replace(/"$/, '');
  const dir = fs.mkdtempSync(new URL('file:///tmp/ukg-').pathname);
  try {
  fs.mkdirSync(`${dir}/data/audit`, { recursive: true });
  fs.writeFileSync(`${dir}/data/audit/last-promotion-ids.json`, JSON.stringify({ promoted: [
    { id: 'a-regional-2026', source: 'guardian-review' },
    { id: 'b-regional-2026', source: 'bww-roundup' },
    { id: 'c-regional-2026', source: 'guardian-review' },
  ] }));
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('node', ['-e', expr], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(out, 'a-regional-2026,c-regional-2026');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same title at two flagship houses stages two distinct ids', () => {
  const rows = stageUkRegionalCandidates([
    { title: 'Hamlet', source: 'guardian-review', url: 'https://g/1', date: '2026-10-07T10:00:00Z', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' },
    { title: 'Hamlet', source: 'guardian-review', url: 'https://g/2', date: '2026-10-08T10:00:00Z', market: 'uk-regional', venue: 'Bristol Old Vic' },
  ]);
  assert.deepEqual(rows.map((r) => r.slug), ['hamlet-rsc', 'hamlet-bristol-old-vic']);
});

test('an open US regional show with the same title does not hide the UK flagship one', () => {
  const shows = [
    { id: 'hamlet-osf-regional-2026', title: 'Hamlet', slug: 'hamlet-osf-regional-2026', category: 'regional', status: 'open', venue: 'Oregon Shakespeare Festival, Ashland, OR' },
    { id: 'hamlet-rsc-regional-2026', title: 'Hamlet', slug: 'hamlet-rsc-regional-2026', category: 'regional', status: 'closed', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon' },
  ];
  assert.equal(ukFlagshipShows(shows).length, 1);
  const item = { title: 'Hamlet', market: 'uk-regional', venue: 'Chichester Festival Theatre' };
  assert.equal(findUnmatchedCandidates([item], buildShowTitleIndex(ukFlagshipShows(shows.slice(0, 1)), 'regional'), { allowClosedRevival: true }).length, 1);
});

test('venue table: every entry is usable by the promoter and the market-utils lookup', () => {
  const matches = new Set();
  for (const e of table) {
    assert.ok(e.match && e.city && e.domain && e.venue, `entry ${JSON.stringify(e)} needs match/city/domain/venue`);
    assert.ok(e.venue.toLowerCase().includes(e.match), `venue "${e.venue}" must contain match "${e.match}" so feederVenueCity resolves it`);
    assert.equal(matches.has(e.match), false, `duplicate match ${e.match}`);
    matches.add(e.match);
    assert.equal(feederVenueCity(e.venue), e.city, `${e.venue} must classify as a regional feeder`);
    assert.equal(isUkFlagshipVenue(`${e.venue}, ${e.city}`), true);
    assert.match(e.idKey, /^[a-z0-9-]+$/);
    assert.ok(getTheaterAddress(e.venue), `${e.venue} needs a street address in venue-addresses.js`);
    assert.ok(getTheaterAddress(`${e.venue}, ${e.city}`), `${e.venue}, ${e.city} needs a street address key`);
  }
  assert.equal(new Set(table.map((e) => e.idKey)).size, table.length, 'idKey must be unique');
});

test('stageUkRegionalCandidates keeps only flagship uk-regional Guardian rows, once each', () => {
  const rows = stageUkRegionalCandidates([
    { title: 'As You Like It', source: 'guardian-review', url: 'https://g/1', date: '2026-10-07T10:00:00Z', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' },
    { title: 'As You Like It', source: 'guardian-review', url: 'https://g/2', date: '2026-10-08T10:00:00Z', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' },
    { title: 'Rent', source: 'guardian-review', url: 'https://g/3', date: '2026-10-09T10:00:00Z', market: 'west-end' },
    { title: 'Elsewhere', source: 'guardian-review', url: 'https://g/4', date: '2026-10-09T10:00:00Z', market: 'uk-regional', venue: 'Curve Theatre' },
    { title: 'Roundup Show', source: 'bww-roundup', url: 'https://b/5', date: '2026-10-09T10:00:00Z', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' },
  ], '2026-10-09T12:00:00.000Z');
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { title: rows[0].title, slug: rows[0].slug, category: rows[0].category, source: rows[0].source, sourceUrl: rows[0].sourceUrl },
    { title: 'As You Like It', slug: 'as-you-like-it-rsc', category: 'regional', source: 'guardian-review', sourceUrl: 'https://g/1' },
  );
});

const staged = stageUkRegionalCandidates([
  { title: 'As You Like It', source: 'guardian-review', url: 'https://www.theguardian.com/stage/2026/oct/07/as-you-like-it-review-rsc', date: '2026-10-07T10:00:00Z', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' },
])[0];

test('decideRegionalPromotion confirms a Guardian flagship candidate with no roundup count', () => {
  const r = decideRegionalPromotion(staged);
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'guardian-review');
});

test('a Guardian candidate at a non-flagship venue, or with no URL, is refused', () => {
  assert.equal(decideUkFlagshipPromotion({ ...staged, venue: 'Curve Theatre' }).confirmed, false);
  assert.equal(decideUkFlagshipPromotion({ ...staged, sourceUrl: undefined }).confirmed, false);
  assert.equal(decideUkFlagshipPromotion({ ...staged, source: 'bww-roundup' }).confirmed, false);
});

test('buildRegionalShowEntry mints a provisional UK regional entry sourced to the Guardian', () => {
  const e = buildRegionalShowEntry(staged);
  assert.equal(e.id, 'as-you-like-it-rsc-regional-2026');
  assert.equal(e.venue, 'Royal Shakespeare Theatre, Stratford-upon-Avon');
  assert.equal(e.category, 'regional');
  assert.equal(e.market, 'regional');
  assert.equal(e.discoverySource, 'guardian-review');
  assert.equal(e.openingDateSource, 'guardian-review');
  assert.equal(e.provisional, true);
  assert.equal(e.openingDate, '2026-10-07');
});

test('audit matching uses regional shows only: the Globe and Broadway As You Like It do not hide the RSC one', () => {
  const shows = [
    { id: 'as-you-like-it-1986', title: 'As You Like It', slug: 'as-you-like-it-1986', category: 'broadway', status: 'closed' },
    { id: 'as-you-like-it-globe-west-end-2026', title: 'As You Like It', slug: 'as-you-like-it-globe-west-end', category: 'west-end', status: 'open' },
  ];
  const item = { title: 'As You Like It', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' };
  const missing = findUnmatchedCandidates([item], buildShowTitleIndex(shows, 'regional'), { allowClosedRevival: true });
  assert.equal(missing.length, 1);
  const withRsc = [...shows, { id: 'as-you-like-it-rsc-regional-2026', title: 'As You Like It', slug: 'as-you-like-it-rsc-regional-2026', category: 'regional', status: 'open' }];
  assert.equal(findUnmatchedCandidates([item], buildShowTitleIndex(withRsc, 'regional'), { allowClosedRevival: true }).length, 0);
});

test('US/Canadian feeder houses added in BRO-4923 resolve to a city and never match a non-regional show venue', async () => {
  const fs = await import('node:fs');
  const { REGIONAL_FEEDER_VENUES } = require('../../scripts/lib/aggregator-candidate-extract.js');
  assert.equal(feederVenueCity('Hartford Stage'), 'Hartford, CT');
  assert.equal(feederVenueCity('Oregon Shakespeare Festival'), 'Ashland, OR');
  assert.equal(feederVenueCity('Alley Theatre'), 'Houston, TX');
  assert.equal(feederVenueCity('Stratford Festival'), 'Stratford, ON');
  assert.equal(feederVenueCity('McCarter Theatre Center'), 'Princeton, NJ');
  // Deliberately excluded: shares a name with, or hosts, non-regional work.
  assert.equal(feederVenueCity('Signature Theatre'), null);
  assert.equal(feederVenueCity('Kennedy Center Opera House'), null);
  // Table-wide guard: no feeder pattern may claim a venue already filed under another market.
  const path = new URL('../../data/shows.json', import.meta.url);
  if (!fs.existsSync(path)) return; // data not linked in this checkout
  const shows = JSON.parse(fs.readFileSync(path, 'utf8')).shows;
  const clashes = [];
  for (const v of REGIONAL_FEEDER_VENUES) {
    for (const s of shows) {
      if (s.venue && s.category !== 'regional' && v.re.test(s.venue)) clashes.push(`${v.domain} claims ${s.id} (${s.venue}, ${s.category})`);
    }
  }
  assert.deepEqual(clashes, []);
});

// ── Ship-check P1s (BRO-4923): same-production matching and tag-only venue proof ──
const { isSameProduction, findSameProduction } = require('../../scripts/lib/uk-regional-guardian.js');
const { cityFromVenue, selectDiscoveryShows } = require('../../scripts/lib/regional-serp-discovery.js');
const { isExemptFromPlaybillCheck } = require('../../scripts/validate-show-venue.js');

const rscShow = (over = {}) => ({
  id: 'x', title: 'Twelfth Night', category: 'regional', status: 'closed',
  venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon',
  previewsStartDate: '2019-03-01', openingDate: '2019-03-12', closingDate: '2019-04-20', ...over,
});
const guardianItem = (over = {}) => ({
  title: 'Twelfth Night', venue: 'Royal Shakespeare Theatre', date: '2026-10-07T10:00:00.000Z', ...over,
});

test('a revival at the same house is a different production from last time\'s run', () => {
  assert.equal(isSameProduction(guardianItem(), rscShow()), false); // 2019 run vs 2026 review
  const current = rscShow({ status: 'open', previewsStartDate: '2026-09-26', openingDate: '2026-10-06', closingDate: '2026-11-07' });
  assert.equal(isSameProduction(guardianItem(), current), true);
  assert.equal(findSameProduction(guardianItem(), [rscShow(), current]), current);
});

test('the same title at another flagship house is a different production', () => {
  const rscHamlet = rscShow({ title: 'Hamlet', status: 'open', previewsStartDate: '2026-09-26', openingDate: '2026-10-06', closingDate: '2026-11-07' });
  assert.equal(isSameProduction({ title: 'Hamlet', venue: 'Bristol Old Vic', date: '2026-10-08T00:00:00Z' }, rscHamlet), false);
  assert.equal(isSameProduction({ title: 'Hamlet', venue: 'Royal Shakespeare Theatre', date: '2026-10-08T00:00:00Z' }, rscHamlet), true);
});

test('a subtitle head matches (Game of Thrones vs Game of Thrones: The Mad King) and an unrelated title does not', () => {
  const got = rscShow({ title: 'Game of Thrones: The Mad King', previewsStartDate: '2026-07-28', openingDate: '2026-08-08', closingDate: '2026-09-05' });
  assert.equal(isSameProduction({ title: 'Game of Thrones', venue: 'Royal Shakespeare Theatre', date: '2026-08-10T00:00:00Z' }, got), true);
  assert.equal(isSameProduction({ title: 'Macbeth', venue: 'Royal Shakespeare Theatre', date: '2026-08-10T00:00:00Z' }, got), false);
});

test('staging drops only the rows of productions already catalogued, keeps a revival', () => {
  const rows = stageUkRegionalCandidates([
    { title: 'Twelfth Night', source: 'guardian-review', url: 'https://g/1', date: '2026-10-07T10:00:00Z', market: 'uk-regional', venue: 'Royal Shakespeare Theatre' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(findSameProduction(rows[0], [rscShow()]), undefined, 'the 2019 run must not swallow the 2026 row');
});

test('a company tag on a tour date is not proof of the house; the house city or name in the slug is', () => {
  const tour = extractGuardianReview({
    title: 'Matilda review – the RSC musical on tour',
    link: 'https://www.theguardian.com/stage/2026/oct/05/matilda-review-theatre-royal-newcastle',
    categories: ['Theatre', 'Royal Shakespeare Company'],
  });
  assert.equal(tour, null);
  const truro = extractGuardianReview({
    title: 'Hamlet review – Bristol Old Vic on the road',
    link: 'https://www.theguardian.com/stage/2026/oct/05/hamlet-review-hall-for-cornwall-truro',
    categories: ['Theatre', 'Bristol Old Vic'],
  });
  assert.equal(truro, null);
  // Chichester's Minerva: the tag plus the city in the slug still routes.
  const chi = extractGuardianReview({
    title: 'Antigone Exits review – new play',
    link: 'https://www.theguardian.com/stage/2026/oct/04/antigone-exits-review-minerva-theatre-chichester-nina-segal',
    categories: ['Theatre', 'Chichester Festival theatre'],
  });
  assert.equal(chi.venue, 'Chichester Festival Theatre');
  // The live RSC As You Like It item (company tag, slug names no venue) still routes.
  assert.equal(extractGuardianReview(RSC_AYLI_ITEM).venue, 'Royal Shakespeare Theatre');
});

test('SERP city: UK venues end in the city, US venues in "City, ST"', () => {
  assert.equal(cityFromVenue('Royal Shakespeare Theatre, Stratford-upon-Avon'), 'Stratford-upon-Avon');
  assert.equal(cityFromVenue('Goodman Theatre, Chicago, IL'), 'Chicago');
  assert.equal(cityFromVenue('Joan and Robert Rechnitz Theater, Two River Theater, Red Bank, NJ'), 'Red Bank');
});

test('the SERP discovery filter takes a comma-separated id list', () => {
  const shows = ['a-regional-2026', 'b-regional-2026', 'c-regional-2026'].map((id) => ({ id, market: 'regional', status: 'open' }));
  assert.deepEqual(selectDiscoveryShows(shows, 'a-regional-2026,c-regional-2026').map((s) => s.id), ['a-regional-2026', 'c-regional-2026']);
  assert.deepEqual(selectDiscoveryShows(shows, 'b-regional-2026').map((s) => s.id), ['b-regional-2026']);
});

test('Guardian-triggered regional shows are exempt from the Playbill check; a manual stub is not', () => {
  assert.equal(isExemptFromPlaybillCheck({ category: 'regional', discoverySource: 'guardian-review' }), true);
  assert.equal(isExemptFromPlaybillCheck({ category: 'regional', discoverySource: 'manual-user-request' }), false);
  assert.equal(isExemptFromPlaybillCheck({ category: 'off-broadway', discoverySource: 'guardian-review' }), false);
});

test('feeder venue spellings: curly apostrophe, one-word Playhouse; Tin Pan Alley is not the Alley Theatre', () => {
  assert.equal(feederVenueCity('Ford’s Theatre'), 'Washington, DC');
  assert.equal(feederVenueCity("Ford's Theatre"), 'Washington, DC');
  assert.equal(feederVenueCity('Cleveland Playhouse'), 'Cleveland, OH');
  assert.equal(feederVenueCity('Tin Pan Alley Theater'), null);
  assert.equal(feederVenueCity('Alley Theatre'), 'Houston, TX');
});

// BRO-6516 ship-check: receiving houses host tours, so they never trigger.
test('a Guardian review at a receiving house (guardianTrigger: false) is not promoted', () => {
  assert.equal(ukFlagshipVenueFor({ tags: ['The Lowry'], slug: 'les-miserables-review-lowry-salford' }), null);
  assert.equal(decideUkFlagshipPromotion({ ...staged, venue: 'Theatre Royal Bath, Bath' }).confirmed, false);
});

test('a slug naming one house beats an earlier house matched only by tag', () => {
  const r = ukFlagshipVenueFor({ tags: ['Liverpool Everyman and Playhouse'], slug: 'x-review-everyman-liverpool' });
  assert.equal(r && r.venue, 'Liverpool Everyman');
});
