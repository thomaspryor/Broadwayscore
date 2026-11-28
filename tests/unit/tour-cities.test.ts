/**
 * National-tour city pages (BRO-4601 phase 5): slugs, grouping, season label.
 * Calls the real exported functions (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { citySlug, cityStops, seasonLabel } from '../../src/lib/tour-cities';

test('citySlug keeps the state and folds punctuation', () => {
  assert.equal(citySlug('San Francisco, CA'), 'san-francisco-ca');
  assert.equal(citySlug('St. Louis, MO'), 'st-louis-mo');
  assert.equal(citySlug('Winston-Salem, NC'), 'winston-salem-nc');
  assert.equal(citySlug('Washington, DC'), 'washington-dc');
  assert.equal(citySlug('Toronto, ON'), 'toronto-on');
  assert.equal(citySlug('Mexico City, MX'), 'mexico-city-mx');
  assert.equal(citySlug('Montréal, QC'), 'montreal-qc');
  assert.notEqual(citySlug('Portland, OR'), citySlug('Portland, ME'));
});

test('cityStops groups every tour by city in date order, keeping repeat visits', () => {
  const m = cityStops([
    { id: 'b', stops: [{ city: 'Chicago, IL', venue: 'CIBC Theatre', start: '2027-01-05', end: '2027-01-17' }] },
    { id: 'a', stops: [
      { city: 'Chicago, IL', venue: 'Nederlander Theatre', start: '2026-10-13', end: '2026-10-18' },
      { city: 'Milwaukee, WI', venue: 'Marcus Center', start: '2026-10-20', end: '2026-10-25' },
      { city: 'Chicago, IL', venue: 'Nederlander Theatre', start: '2027-03-02', end: '2027-03-07' },
    ] },
  ]);
  assert.deepEqual(Array.from(m.keys()).sort(), ['chicago-il', 'milwaukee-wi']);
  assert.deepEqual(m.get('chicago-il')!.stops.map(s => `${s.showId}@${s.start}`), ['a@2026-10-13', 'b@2027-01-05', 'a@2027-03-02']);
});

test('seasonLabel spans the stops it is given', () => {
  const st = (start: string, end: string) => ({ city: 'X, CA', venue: 'V', start, end });
  assert.equal(seasonLabel([]), '');
  assert.equal(seasonLabel([st('2027-04-06', '2027-04-08')]), '2027');
  assert.equal(seasonLabel([st('2026-10-13', '2026-11-01'), st('2026-12-29', '2027-01-03')]), '2026–27');
  // The latest end wins even when an earlier-starting stop runs longest.
  assert.equal(seasonLabel([st('2026-10-01', '2027-02-01'), st('2026-11-01', '2026-11-05')]), '2026–27');
});

// BRO-8456: a hub lists tours playing its suburbs (Costa Mesa / Segerstrom is LA).
import registry from '../../data/city-hubs.json';
import { hubSuburbMap } from '../../src/lib/tour-cities';

test('hubSuburbMap folds Costa Mesa into the LA hub and Arlington VA into DC, not Arlington TX', () => {
  const m = hubSuburbMap(registry.hubs as Parameters<typeof hubSuburbMap>[0]);
  assert.deepEqual(m.get('costa-mesa-ca'), { slug: 'los-angeles-ca', city: 'Los Angeles, CA' });
  assert.equal(m.get('arlington-va')!.slug, 'washington-dc');
  assert.equal(m.get('arlington-tx'), undefined);
  assert.equal(m.get('los-angeles-ca'), undefined);
});

test('cityStops puts suburb stops under the hub slug', () => {
  const m = hubSuburbMap(registry.hubs as Parameters<typeof hubSuburbMap>[0]);
  const g = cityStops([
    { id: 'bom', stops: [{ city: 'Costa Mesa, CA', venue: 'Segerstrom Hall', start: '2026-12-29', end: '2027-01-03' }] },
    { id: 'jb', stops: [{ city: 'Los Angeles, CA', venue: 'Pantages', start: '2026-12-01', end: '2026-12-13' }] },
  ], m);
  assert.deepEqual(Array.from(g.keys()), ['los-angeles-ca']);
  assert.deepEqual(g.get('los-angeles-ca')!.stops.map(s => s.showId), ['jb', 'bom']);
});

test('class guard: every suburb in the registry resolves to a launched hub page', () => {
  const m = hubSuburbMap(registry.hubs as Parameters<typeof hubSuburbMap>[0]);
  for (const [k, t] of Array.from(m)) assert.ok((registry.hubs as Record<string, { launched?: boolean }>)[t.slug]?.launched, `${k} -> ${t.slug}`);
  assert.ok(m.size >= 40);
});
