import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { resolveMetro, metroCountry } = require('./venue-metro.js');
const { REGIONAL_FEEDER_VENUES } = require('./aggregator-candidate-extract.js');
const table = JSON.parse(fs.readFileSync(new URL('../../data/venue-metros.json', import.meta.url), 'utf8'));

test('table has >=40 venues covering six UK hubs plus Chicago, DC and LA', () => {
  assert.ok(table.venues.length >= 40, `only ${table.venues.length} venues`);
  const metros = new Set(table.venues.map((v) => v.metro));
  for (const m of ['manchester-uk', 'stratford-upon-avon-uk', 'leeds-uk', 'bristol-uk', 'chichester-uk', 'glasgow-uk',
    'chicago-il', 'washington-dc', 'los-angeles-ca']) assert.ok(metros.has(m), `missing ${m}`);
});

test('every venue points at a declared metro; aliases are unique across metros', () => {
  const seen = new Map();
  for (const v of table.venues) {
    assert.ok(table.metros[v.metro], `${v.venue}: unknown metro ${v.metro}`);
    for (const a of v.aliases) {
      assert.ok(!seen.has(a) || seen.get(a) === v.metro, `alias "${a}" maps to two metros`);
      seen.set(a, v.metro);
    }
  }
});

test('resolveMetro: UK and US venue strings', () => {
  const cases = {
    'Royal Exchange Theatre, Manchester': 'manchester-uk',
    'Royal Shakespeare Theatre, Stratford-upon-Avon': 'stratford-upon-avon-uk',
    'Citizens Theatre': 'glasgow-uk',
    'Goodman Theatre, Chicago, IL': 'chicago-il',
    'Mandell Weiss Theatre, La Jolla Playhouse, San Diego, CA': 'san-diego-ca',
    'Shakespeare Theatre Company (Harman Hall), Washington, DC': 'washington-dc',
    'Ahmanson Theatre, Los Angeles, CA': 'los-angeles-ca',
    'Unlisted Hall, Evanston, IL': 'chicago-il', // trailing-city fallback
  };
  for (const [venue, metro] of Object.entries(cases)) assert.equal(resolveMetro(venue), metro, venue);
  assert.equal(metroCountry('manchester-uk'), 'UK');
  assert.equal(metroCountry('chicago-il'), 'US');
});

test('resolveMetro: non-regional and empty venues resolve null', () => {
  for (const v of ['North American Tour', 'U.S. National Tour (Chicago, Los Angeles, Boston)', 'Regional Tryouts (Arlington, VA 2020; Millburn, NJ 2024)', 'Lyceum Theatre, New York', 'Gershwin Theatre', '', null, undefined]) {
    assert.equal(resolveMetro(v), null, String(v));
  }
});

test('every REGIONAL_FEEDER_VENUES city resolves to a metro (table cannot drift from the feeder list)', () => {
  const bad = REGIONAL_FEEDER_VENUES.filter((f) => !resolveMetro(`Some Hall, ${f.city}`)).map((f) => f.city);
  assert.deepEqual([...new Set(bad)], []);
});

test('every existing regional show resolves, or is a known multi-city entry', () => {
  const p = new URL('../../data/shows.json', import.meta.url);
  if (!fs.existsSync(p)) return;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const unmapped = shows
    .filter((s) => s.market === 'regional' && !resolveMetro(s.venue) && !/\b(?:tour|tryouts)\b/i.test(s.venue || ''))
    .map((s) => `${s.id}: ${s.venue}`);
  assert.deepEqual(unmapped, []);
});

test('regional add path stamps city (promoter + Guardian trigger share buildRegionalShowEntry)', () => {
  const { buildRegionalShowEntry } = require('../promote-ob-venue-candidates.js');
  const base = { title: 'Test Show', slug: 'test-show', articlePublishedAt: '2026-10-01T10:00:00Z', source: 'guardian-review', discoveredAt: '2026-10-01' };
  assert.equal(buildRegionalShowEntry({ ...base, venue: 'Royal Exchange Theatre' }).city, 'manchester-uk');
  assert.equal(buildRegionalShowEntry({ ...base, source: 'bww-roundup', venue: 'Goodman Theatre' }).city, 'chicago-il');
});

test('a stored show.city never disagrees with the venue table', () => {
  const p = new URL('../../data/shows.json', import.meta.url);
  if (!fs.existsSync(p)) return;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const bad = shows.filter((s) => s.market === 'regional' && s.city && resolveMetro(s.venue) !== s.city).map((s) => s.id);
  assert.deepEqual(bad, []);
});

test('false positives from adversarial review resolve null or to the right metro', () => {
  const nul = ['Some Hall, Birmingham, AL', 'Some Hall, Arlington, TX', 'Courtyard Theatre, Stratford', 'Some Hall, Stratford, CT',
    'Cambridge Arts Theatre, Cambridge', 'Palace Theatre, Manchester, NH', 'Home for Contemporary Theatre and Art', 'Curve at the Barbican',
    'Albert Theatre, Huddersfield', 'Royal Shakespeare Company, Garrick Theatre', 'Pan Alley Theatre, London',
    'Richard B. Fisher Center for the Performing Arts, Annandale-on-Hudson, NY', 'Goodman Theatre / Guthrie Theater'];
  for (const v of nul) assert.equal(resolveMetro(v), null, v);
  assert.equal(resolveMetro('Some Hall, Birmingham, UK'), 'birmingham-uk');
  assert.equal(resolveMetro('Some Hall, Arlington, VA'), 'washington-dc');
  assert.equal(resolveMetro('HOME, Manchester'), 'manchester-uk');
  assert.equal(resolveMetro('Albert Theatre, Chicago, IL'), 'chicago-il');
  assert.equal(resolveMetro('Royal Shakespeare Company, Stratford-upon-Avon'), 'stratford-upon-avon-uk');
});
