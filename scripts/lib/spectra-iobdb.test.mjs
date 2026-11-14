// BRO-6493: Spectra (the IOBDB successor) as the OB date enricher's second
// page-validated source. Requires the REAL lib + the enricher's real title
// predicate (CLAUDE.md §15). Fixture strings copy the escaped RSC payload
// shape served by https://www.spectra.theater/explore/venue/<uuid> on
// 2026-11-05 (Lucille Lortel Theatre and St. Ann's Warehouse venue pages).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSpectraProductions,
  parseSpectraVenueName,
  pickSpectraVenueUrl,
  toSpectraVenueUrl,
  matchSpectraProduction,
} = require('./spectra-iobdb.js');
const { titleHeadMatchesShow } = require('../enrich-off-broadway-dates.js');

const rec = (o) => `{\\"id\\":\\"${o.id}\\",\\"productionStartDate\\":${o.start ? `\\"${o.start}\\"` : 'null'},` +
  `\\"productionOpeningDate\\":${o.open ? `\\"${o.open}\\"` : 'null'},\\"productionEndDate\\":${o.end ? `\\"${o.end}\\"` : 'null'},` +
  `\\"productionYear\\":${o.year},\\"tierLevel\\":20,\\"tierDescription\\":\\"${o.tier || 'Off-Broadway'}\\",\\"licenseType\\":null,` +
  `\\"productionName\\":\\"${o.name}\\",\\"brandName\\":\\"${o.brand || o.name}\\",\\"showType\\":\\"Play\\",\\"posterImage\\":null}`;

const VENUE_PAGE = '<html><body><h1>Lucille Lortel Theatre</h1><script>self.__next_f.push([1,"2b:[[\\"$\\",\\"$L34\\",null,{' +
  '\\"buttonsContent\\":[\\"$\\",\\"$L35\\",null,{\\"entityType\\":\\"venue\\",\\"entityId\\":\\"c2b0771d-250d-5c06-9248-d08bc383039e\\",' +
  '\\"entityName\\":\\"Lucille Lortel Theatre\\",\\"authPrompt\\":\\"explain\\"}]}],[\\"$\\",\\"$L37\\",null,{\\"productions\\":[' +
  [
    rec({ id: '42ac7c09-32a5-5df5-98c2-4d5f2dbe0424', start: '2023-04-17', open: '2023-04-27', end: '2023-05-13', year: 2023, name: 'The Knight of the Burning Pestle' }),
    rec({ id: '11111111-2222-5333-8444-555555555555', start: '2024-09-24', open: '2024-09-24', end: '2024-12-22', year: 2024, name: 'Hold On To Me Darling' }),
    rec({ id: '22222222-2222-5333-8444-555555555555', start: '2025-11-07', open: null, end: '2025-12-28', year: 2025, name: 'Gruesome Playground Injuries' }),
    rec({ id: '33333333-2222-5333-8444-555555555555', start: '2023-01-06', open: '2023-01-23', end: '2023-05-06', year: 2023, name: 'Colin Quinn: Long Story Short' }),
    rec({ id: '44444444-2222-5333-8444-555555555555', start: '2024-03-01', open: '2024-03-20', end: '2024-06-01', year: 2024, name: 'Hamlet', tier: 'Broadway' }),
    rec({ id: '55555555-2222-5333-8444-555555555555', start: '2024-03-19', open: '2024-03-28', end: '2024-04-14', year: 2024, name: 'Hamlet 2.0: An Improvised Sequel' }),
  ].join(',') + ']}]]\\n"])</script></body></html>';

const row = (o) => ({ category: 'off-broadway', status: 'closed', ...o });
const opts = (year) => ({ showYear: year, titleMatches: titleHeadMatchesShow });

test('parses every production record from the escaped RSC payload, deduped, with decoded fields', () => {
  const recs = parseSpectraProductions(VENUE_PAGE + VENUE_PAGE); // dup page: ids dedupe
  assert.equal(recs.length, 6);
  const pestle = recs.find((r) => r.name === 'The Knight of the Burning Pestle');
  assert.deepEqual(
    { start: pestle.startDate, open: pestle.openingDate, end: pestle.endDate, year: pestle.year, tier: pestle.tier },
    { start: '2023-04-17', open: '2023-04-27', end: '2023-05-13', year: 2023, tier: 'Off-Broadway' },
  );
  assert.equal(pestle.url, 'https://www.spectra.theater/explore/production/42ac7c09-32a5-5df5-98c2-4d5f2dbe0424');
  assert.equal(recs.find((r) => r.name === 'Gruesome Playground Injuries').openingDate, null);
  assert.equal(parseSpectraVenueName(VENUE_PAGE), 'Lucille Lortel Theatre');
});

test('non-Spectra pages parse to nothing (soft 404, challenge, empty)', () => {
  assert.deepEqual(parseSpectraProductions(''), []);
  assert.deepEqual(parseSpectraProductions('<html><title>Page not found</title></html>'), []);
  assert.equal(parseSpectraVenueName('<html></html>'), null);
});

test('stored date is the first performance: Spectra gives the real opening', () => {
  const show = row({ id: 'the-knight-of-the-burning-pestle-off-broadway-2023', title: 'The Knight of the Burning Pestle', previewsStartDate: '2023-04-17', openingDate: '2023-04-17', closingDate: '2023-05-13' });
  const r = matchSpectraProduction(parseSpectraProductions(VENUE_PAGE), show, opts(2023));
  assert.equal(r.ok, true);
  assert.equal(r.record.startDate, '2023-04-17');
  assert.equal(r.record.openingDate, '2023-04-27');
});

test('Spectra start == opening confirms a no-preview run (enricher CONFIRM path)', () => {
  const show = row({ title: 'Hold On To Me Darling', previewsStartDate: '2024-09-24', openingDate: '2024-09-24', closingDate: '2024-12-22' });
  const r = matchSpectraProduction(parseSpectraProductions(VENUE_PAGE), show, opts(2024));
  assert.equal(r.ok, true);
  assert.equal(r.record.startDate, r.record.openingDate);
});

test('a null Spectra opening is never filled in (never guess)', () => {
  const show = row({ title: 'Gruesome Playground Injuries', previewsStartDate: '2025-11-07', openingDate: '2025-11-07', closingDate: '2025-12-28' });
  const r = matchSpectraProduction(parseSpectraProductions(VENUE_PAGE), show, opts(2025));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-opening-date-on-page');
});

test('year must match exactly (a later revival at the same venue is refused)', () => {
  const show = row({ title: 'The Knight of the Burning Pestle', previewsStartDate: '2026-04-17', openingDate: '2026-04-17' });
  assert.equal(matchSpectraProduction(parseSpectraProductions(VENUE_PAGE), show, opts(2026)).reason, 'no-same-year-production');
  assert.equal(matchSpectraProduction([], show, {}).reason, 'no-show-year');
});

test('identity: neither first performance nor closing agrees -> refused; a disagreeing closing vetoes', () => {
  const recs = parseSpectraProductions(VENUE_PAGE);
  const noAnchor = row({ title: 'The Knight of the Burning Pestle', previewsStartDate: '2023-04-10', openingDate: '2023-04-10' });
  assert.equal(matchSpectraProduction(recs, noAnchor, opts(2023)).reason, 'production-identity-unconfirmed');
  const closingOff = row({ title: 'The Knight of the Burning Pestle', previewsStartDate: '2023-04-17', openingDate: '2023-04-17', closingDate: '2023-08-30' });
  assert.equal(matchSpectraProduction(recs, closingOff, opts(2023)).reason, 'production-identity-unconfirmed');
  const closingOnly = row({ title: 'The Knight of the Burning Pestle', previewsStartDate: '2023-04-12', openingDate: '2023-04-12', closingDate: '2023-05-14' });
  assert.equal(matchSpectraProduction(recs, closingOnly, opts(2023)).ok, true);
});

test('short title does not match a longer sibling, and a Broadway-tier record is never taken', () => {
  const show = row({ title: 'Hamlet', previewsStartDate: '2024-03-19', openingDate: '2024-03-19', closingDate: '2024-04-14' });
  const r = matchSpectraProduction(parseSpectraProductions(VENUE_PAGE), show, opts(2024));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-same-year-production'); // "Hamlet 2.0…" fails the title guard; "Hamlet" is Broadway tier
});

test('venue URL pick: only spectra venue pages whose result title names our venue', () => {
  const words = (s) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !['theatre', 'theater'].includes(w)));
  const share = (a, b) => [...words(a)].some((w) => words(b).has(w));
  const serp = [
    { url: 'https://www.spectra.theater/explore/artist/2c67cc8e-51ba-51a4-b9e0-33808a4b79b3', title: 'Ted Rounsaville' },
    { url: 'https://www.spectra.theater/explore/venue/b1069593-7bac-5b66-be24-4ea948a99043', title: 'South Village Theatre' },
    { url: 'https://www.spectra.theater/explore/venue/C2B0771D-250D-5C06-9248-D08BC383039E?x=1', title: 'Lucille Lortel Theatre' },
  ];
  assert.equal(pickSpectraVenueUrl(serp, 'Lucille Lortel Theatre', share), 'https://www.spectra.theater/explore/venue/c2b0771d-250d-5c06-9248-d08bc383039e');
  assert.equal(pickSpectraVenueUrl(serp, 'SoHo Playhouse', share), null);
  assert.equal(toSpectraVenueUrl('https://evil.example/explore/venue/c2b0771d-250d-5c06-9248-d08bc383039e'), null);
});

test('wiring: the enricher requires the lib, routes Spectra misses to audit, and tags confirms :no-previews', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../enrich-off-broadway-dates.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/spectra-iobdb'\)/);
  assert.match(src, /await scrapeSpectraVenuePages\(spectraQueue\)/);
  assert.match(src, /fetchPage\(venueUrl, \{ directOnly: true \}\)/, 'Spectra pages go through fetchPage(), free direct tier');
  assert.match(src, /new: `\$\{entryDateSource\}:no-previews`/);
});
