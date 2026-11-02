// The market menu's "N playing now" for a city hub must equal the hub page's
// Now Playing list: local productions plus tour stops playing today (ship-check
// on BRO-6760/6771: the menu counted local productions only, so DC read 6 while
// its hub listed 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMarketStats } from '../../src/lib/data-core';
import { getCityHubShows } from '../../src/lib/data-city-hub';
import { getTourCity } from '../../src/lib/data-tour-cities';

test('hub menu count equals the hub Now Playing list (local + touring)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const stats = getMarketStats();
  for (const [slug, key] of [['chicago-il', 'chicago'], ['washington-dc', 'washingtonDc']] as const) {
    const local = getCityHubShows(slug, today).now.length;
    const touring = (getTourCity(slug, today)?.stops ?? []).filter(s => s.start <= today && today <= s.end).length;
    assert.equal(stats[key].openShows, local + touring, slug);
  }
});
