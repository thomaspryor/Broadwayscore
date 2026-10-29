/**
 * City hub sectioning + local-critic stat (BRO-6517). Calls the real exports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionHubShows, hubPhase, CLOSED_LIMIT, RECENT_DAYS } from '../../src/lib/city-hub';
import { outletMetro, localCriticStat } from '../../src/lib/outlet-metro';
import { citySlug } from '../../src/lib/tour-cities';

const TODAY = '2026-10-29';
const show = (id: string, o: Record<string, unknown> = {}) => ({ id, city: 'chicago-il', ...o });

test('hub slug is the citySlug of Chicago, IL', () => {
  assert.equal(citySlug('Chicago, IL'), 'chicago-il');
});

test('hubPhase splits now / soon / closed', () => {
  assert.equal(hubPhase({ id: 'a', status: 'open', openingDate: '2026-09-01', closingDate: '2026-12-01' }, TODAY), 'now');
  assert.equal(hubPhase({ id: 'a', status: 'previews', openingDate: '2026-11-15' }, TODAY), 'now');
  assert.equal(hubPhase({ id: 'a', status: 'closed', openingDate: '2026-06-29', closingDate: '2026-08-16' }, TODAY), 'closed');
  assert.equal(hubPhase({ id: 'a', status: 'open', openingDate: '2026-01-01', closingDate: '2026-10-01' }, TODAY), 'closed');
});

test('only the requested metro is listed', () => {
  const s = sectionHubShows([show('c', { status: 'open', openingDate: '2026-10-01' }), show('dc', { city: 'washington-dc', status: 'open' }), { id: 'nocity', status: 'open' }], 'chicago-il', TODAY);
  assert.deepEqual(s.now.map(x => x.id), ['c']);
});

test('closed shows: recent capped at CLOSED_LIMIT, the rest and anything older than a year go to archive', () => {
  const many = Array.from({ length: CLOSED_LIMIT + 3 }, (_, i) =>
    show(`r${String(i).padStart(2, '0')}`, { status: 'closed', openingDate: '2026-03-01', closingDate: `2026-04-${String(i + 1).padStart(2, '0')}` }));
  const old = show('old', { status: 'closed', openingDate: '2024-01-01', closingDate: '2024-02-01' });
  const s = sectionHubShows([...many, old], 'chicago-il', TODAY);
  assert.equal(s.closedRecent.length, CLOSED_LIMIT);
  assert.equal(s.closedRecent[0].id, `r${String(CLOSED_LIMIT + 2).padStart(2, '0')}`); // latest close first
  assert.equal(s.archive.length, 3 + 1);
  assert.ok(s.archive.some(x => x.id === 'old'));
  assert.equal(RECENT_DAYS, 365);
});

test('outletMetro prefers metro, falls back to region, null otherwise', () => {
  assert.equal(outletMetro({ metro: 'chicago-il' }), 'chicago-il');
  assert.equal(outletMetro({ region: 'chicago' }), 'chicago-il');
  assert.equal(outletMetro({ region: 'washington-dc' }), 'washington-dc');
  assert.equal(outletMetro({ region: 'london' }), null);
  assert.equal(outletMetro(undefined), null);
});

test('localCriticStat counts and averages only local outlets', () => {
  const reg = { chicagotribune: { region: 'chicago' }, 'chicago-theater-beat': { metro: 'chicago-il' }, nytimes: {} };
  const r = (outletId: string, reviewScore: number) => ({ outletId, reviewScore });
  const st = localCriticStat([r('chicagotribune', 80), r('chicago-theater-beat', 70), r('nytimes', 100), r('chicagotribune', 90)], reg, 'chicago-il');
  // two critics at one outlet count once: (85 + 70) / 2
  assert.deepEqual(st, { count: 2, average: 78 });
  assert.deepEqual(localCriticStat([r('nytimes', 90)], reg, 'chicago-il'), { count: 0, average: null });
});

test('every Chicago-tagged outlet in the real registry resolves to chicago-il', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const outlets = require('../../data/outlet-registry.json').outlets as Record<string, { metro?: string; region?: string }>;
  const chi = Object.entries(outlets).filter(([, v]) => outletMetro(v) === 'chicago-il').map(([k]) => k);
  for (const id of ['chicagotribune', 'chicago-sun-times', 'chicago-reader', 'daily-herald', 'chicago-theater-beat']) {
    assert.ok(chi.includes(id), `${id} should be a Chicago outlet`);
  }
  assert.ok(chi.length >= 17);
});
