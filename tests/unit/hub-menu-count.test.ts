// LIVE-DATA-LANE: reads data/site-image-versions.json (untracked core data); data/grosses.json (untracked core data); data/audience-buzz.json (untracked core data); +7 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// The market menu's "N playing now" for a city hub must equal the hub page's
// Now Playing list: local productions plus tour stops playing today (ship-check
// on BRO-6760/6771: the menu counted local productions only, so DC read 6 while
// its hub listed 7).
import test from 'node:test';
import assert from 'node:assert/strict';

// Production runs with the regional flag on (the menu and the hub both need it);
// set it before the data modules load, as tour-hub.test.ts does for 'tour'.
process.env.NEXT_PUBLIC_FEATURES = 'regional,tour';

test('hub menu count equals the hub Now Playing list (local + touring)', async () => {
  const { getMarketStats } = await import('../../src/lib/data-core');
  const { getCityHubShows } = await import('../../src/lib/data-city-hub');
  const { getTourCity } = await import('../../src/lib/data-tour-cities');
  const today = new Date().toISOString().slice(0, 10);
  const stats = getMarketStats();
  for (const slug of Object.keys(stats.hubs)) {
    const local = getCityHubShows(slug, today).now.length;
    const touring = (getTourCity(slug, today)?.stops ?? []).filter(s => s.start <= today && today <= s.end).length;
    assert.equal(stats.hubs[slug].openShows, local + touring, slug);
  }
});
