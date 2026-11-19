import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Requiring the script must NOT trigger a live sweep (require.main guard).
const { probeUrl, isVenueSiteHost } = require('./enrich-fallback-ticket-links.js');

function stub(map) {
  return async (url) => map[url] || { status: 404 };
}

test('probeUrl: 2xx on allowlisted platform host passes', async () => {
  const ok = await probeUrl('https://www.todaytix.com/nyc/shows/1-foo', 1000, stub({
    'https://www.todaytix.com/nyc/shows/1-foo': { status: 200 },
  }));
  assert.equal(ok, true);
});

test('probeUrl: 2xx on non-allowlisted host fails (redirect landed off-allowlist)', async () => {
  const ok = await probeUrl('https://www.todaytix.com/x', 1000, stub({
    'https://www.todaytix.com/x': { status: 302, location: 'https://random-landing.com/promo' },
    'https://random-landing.com/promo': { status: 200 },
  }));
  assert.equal(ok, false);
});

test('probeUrl: follows redirect chain to allowlisted 2xx', async () => {
  const ok = await probeUrl('https://todaytix.com/x', 1000, stub({
    'https://todaytix.com/x': { status: 301, location: 'https://www.todaytix.com/x' },
    'https://www.todaytix.com/x': { status: 200 },
  }));
  assert.equal(ok, true);
});

test('probeUrl: 403 passes only for first-party venue sites', async () => {
  const venue403 = await probeUrl('https://www.marylebonetheatre.com/productions/x', 1000, stub({
    'https://www.marylebonetheatre.com/productions/x': { status: 403 },
  }));
  assert.equal(venue403, true);
  const platform403 = await probeUrl('https://www.todaytix.com/x', 1000, stub({
    'https://www.todaytix.com/x': { status: 403 },
  }));
  assert.equal(platform403, false);
});

test('probeUrl: 404/410/5xx and redirect loops fail', async () => {
  assert.equal(await probeUrl('https://www.todaytix.com/gone', 1000, stub({
    'https://www.todaytix.com/gone': { status: 404 },
  })), false);
  assert.equal(await probeUrl('https://www.todaytix.com/err', 1000, stub({
    'https://www.todaytix.com/err': { status: 500 },
  })), false);
  // Infinite 301 loop exhausts the 4-hop cap
  assert.equal(await probeUrl('https://www.todaytix.com/a', 1000, stub({
    'https://www.todaytix.com/a': { status: 301, location: 'https://www.todaytix.com/b' },
    'https://www.todaytix.com/b': { status: 301, location: 'https://www.todaytix.com/a' },
  })), false);
});

test('probeUrl: malformed and non-https URLs fail without throwing', async () => {
  assert.equal(await probeUrl('not a url', 1000), false);
  assert.equal(await probeUrl('http://www.todaytix.com/x', 1000), false);
});

test('isVenueSiteHost matches venue domains and subdomains only', () => {
  assert.equal(isVenueSiteHost('https://www.bam.org/theater/2026/x'), true);
  assert.equal(isVenueSiteHost('https://tickets.marylebonetheatre.com/shop'), true);
  assert.equal(isVenueSiteHost('https://www.todaytix.com/x'), false);
  assert.equal(isVenueSiteHost('https://evil-bam.org.attacker.com/x'), false);
});

// The live-network smoke test lives in enrich-fallback-ticket-links-live.test.mjs,
// which runs in test.yml's continue-on-error network-dependent step — never in
// this blocking batch (second-opinion review: third-party flake must not gate
// every push to main).

// BRO-7368: the free venue-host crawl, driven through an injected fetchText.
const { collectVenueUrls, discoverVenuePage } = require('./enrich-fallback-ticket-links.js');

function fakeSite(pages) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (!(url in pages)) throw new Error('Direct fetch failed: 404');
    return pages[url];
  };
  return { fetchText, calls };
}

test('collectVenueUrls: robots Sitemap -> index -> show shard, plus listing links, bounded reads', async () => {
  const { fetchText, calls } = fakeSite({
    'https://www.tron.co.uk/robots.txt': 'User-agent: *\nSitemap: https://www.tron.co.uk/sitemap.xml\n',
    'https://www.tron.co.uk/sitemap.xml': '<sitemapindex><sitemap><loc>https://www.tron.co.uk/post-sitemap.xml</loc></sitemap>'
      + '<sitemap><loc>https://www.tron.co.uk/shows-sitemap.xml</loc></sitemap></sitemapindex>',
    'https://www.tron.co.uk/shows-sitemap.xml': '<urlset><url><loc>https://www.tron.co.uk/shows/antigone/</loc></url></urlset>',
    'https://www.tron.co.uk/': '<a href="/shows/panto/">p</a>',
  });
  const urls = await collectVenueUrls("tron.co.uk", fetchText, 0);
  assert.deepEqual(urls, ['https://www.tron.co.uk/shows/antigone/', 'https://www.tron.co.uk/shows/panto/']);
  assert.ok(!calls.includes('https://www.tron.co.uk/post-sitemap.xml'), 'editorial shard skipped');
  assert.ok(calls.length <= 8);
});

test('discoverVenuePage: picks the show page and crawls a shared venue host once', async () => {
  const { fetchText, calls } = fakeSite({
    'https://www.tron.co.uk/sitemap.xml': '<urlset><url><loc>https://www.tron.co.uk/shows/antigone/</loc></url></urlset>',
  });
  const cache = new Map();
  const antigone = { id: 'antigone-tron-regional-2026', title: 'Antigone', venue: 'Tron Theatre, Glasgow', category: 'regional', openingDate: '2026-09-22' };
  const pick = await discoverVenuePage(antigone, { cache, fetchText, gapMs: 0 });
  assert.deepEqual(pick, { url: 'https://www.tron.co.uk/shows/antigone/', platform: 'Venue Box Office' });
  const before = calls.length;
  assert.equal(await discoverVenuePage({ ...antigone, title: "Medea" }, { cache, fetchText, gapMs: 0 }), null);
  assert.equal(calls.length, before, 'second show at the same host reuses the crawl');
  assert.equal(await discoverVenuePage({ title: 'X', venue: 'Unknown Hall' }, { cache, fetchText }), null);
});

test('collectVenueUrls: waits gapMs between consecutive reads of one host', async () => {
  const stamps = [];
  const fetchText = async () => { stamps.push(Date.now()); throw new Error('404'); };
  await collectVenueUrls('tron.co.uk', fetchText, 40);
  assert.ok(stamps.length >= 3);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 35, `gap ${i} was ${stamps[i] - stamps[i - 1]}ms`);
});
