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
const { needsListingConfirmation } = require('./lib/ticket-link-discovery.js');

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
  const { all, listed } = await collectVenueUrls("tron.co.uk", fetchText, 0);
  assert.deepEqual(all, ['https://www.tron.co.uk/shows/antigone/', 'https://www.tron.co.uk/shows/panto/']);
  assert.deepEqual(listed, ['https://www.tron.co.uk/shows/panto/']);
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

test('collectVenueUrls: falls back to the bare host when www. answers nothing', async () => {
  const { fetchText } = fakeSite({
    'https://citz.co.uk/sitemap.xml': '<urlset><url><loc>https://citz.co.uk/whats-on/1984/</loc></url></urlset>',
  });
  const { all } = await collectVenueUrls('citz.co.uk', fetchText, 0);
  assert.deepEqual(all, ['https://citz.co.uk/whats-on/1984/']);
});

// Undated archive page of an earlier run (same title, same venue) must not be
// picked for a revival unless the venue's listing pages still show it.
const rscHamlet = { id: 'hamlet-rsc-regional-2026', title: 'Hamlet', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', category: 'regional', openingDate: '2026-10-01' };
const rscHamletOld = { ...rscHamlet, id: 'hamlet-rsc-regional-2022', openingDate: '2022-04-01', status: 'closed' };

test('needsListingConfirmation: true only for another same-title run at the same venue host', () => {
  assert.equal(needsListingConfirmation([rscHamlet, rscHamletOld], rscHamlet), true);
  assert.equal(needsListingConfirmation([rscHamlet], rscHamlet), false);
  assert.equal(needsListingConfirmation([rscHamlet, { ...rscHamletOld, venue: 'Leeds Playhouse, Leeds' }], rscHamlet), false);
  assert.equal(needsListingConfirmation([rscHamlet, { ...rscHamletOld, title: 'Macbeth' }], rscHamlet), false);
});

test('discoverVenuePage: requireListed rejects a sitemap-only (archived) hit, accepts a listed one', async () => {
  const sitemapOnly = fakeSite({
    'https://www.rsc.org.uk/sitemap.xml': '<urlset><url><loc>https://www.rsc.org.uk/whats-on/hamlet/</loc></url></urlset>',
  });
  assert.equal(await discoverVenuePage(rscHamlet, { fetchText: sitemapOnly.fetchText, gapMs: 0, requireListed: true }), null);
  assert.equal((await discoverVenuePage(rscHamlet, { fetchText: sitemapOnly.fetchText, gapMs: 0 })).url, 'https://www.rsc.org.uk/whats-on/hamlet/');
  const listed = fakeSite({
    'https://www.rsc.org.uk/sitemap.xml': '<urlset><url><loc>https://www.rsc.org.uk/whats-on/hamlet/</loc></url></urlset>',
    'https://www.rsc.org.uk/whats-on/': '<a href="/whats-on/hamlet/">Hamlet</a>',
  });
  assert.equal((await discoverVenuePage(rscHamlet, { fetchText: listed.fetchText, gapMs: 0, requireListed: true })).url, 'https://www.rsc.org.uk/whats-on/hamlet/');
});

// BRO-7668: the theatre's own page becomes officialUrl for open shows with no
// buy button. Drives the real functions with injected fetchers.
const { needsOfficialPage, hubDetailUrl, probeFirstPartyUrl, discoverOfficialPage } = require('./enrich-fallback-ticket-links.js');

test('needsOfficialPage: open, no ticket link, no official link', () => {
  assert.equal(needsOfficialPage({ status: 'open', ticketLinks: [] }), true);
  assert.equal(needsOfficialPage({ status: 'previews' }), true);
  assert.equal(needsOfficialPage({ status: 'open', officialUrl: 'https://x.org' }), false);
  assert.equal(needsOfficialPage({ status: 'open', ticketLinks: [{ url: 'https://x' }] }), false);
  assert.equal(needsOfficialPage({ status: 'closed' }), false);
});

test('probeFirstPartyUrl: upgrades http, keeps the given URL across a box-office redirect', async () => {
  const got = await probeFirstPartyUrl('http://www.arenastage.org', 'Arena Stage, Washington, DC', 1000, stub({
    'https://www.arenastage.org': { status: 302, location: 'https://tickets.arenastage.org/session?x=1' },
    'https://tickets.arenastage.org/session?x=1': { status: 200 },
  }));
  assert.equal(got, 'https://www.arenastage.org');
});

test('probeFirstPartyUrl: a redirect off the theatre site, or a dead page, fails', async () => {
  assert.equal(await probeFirstPartyUrl('https://www.citylit.org', 'City Lit Theater', 1000, stub({
    'https://www.citylit.org': { status: 301, location: 'https://parked-domains.example/x' },
    'https://parked-domains.example/x': { status: 200 },
  })), null);
  assert.equal(await probeFirstPartyUrl('https://www.citylit.org', 'City Lit Theater', 1000, stub({})), null);
  assert.equal(await probeFirstPartyUrl('https://www.bostonglobe.com/x', 'Lyric Stage Company of Boston', 1000, stub({
    'https://www.bostonglobe.com/x': { status: 200 },
  })), null);
});

test('discoverOfficialPage: reads the theatreinX listing website when no evidenceUrl is first-party', async () => {
  const show = {
    id: 'king-hedley-ii-regional-2026', venue: 'City Lit Theater, Chicago, IL',
    evidenceUrls: ['https://www.theatreinchicago.com/king-hedley-ii/13356/'],
  };
  assert.equal(hubDetailUrl(show), 'https://www.theatreinchicago.com/king-hedley-ii/13356/');
  const html = '<div class="post-title"><h2 class="section-title">King Hedley II</h2></div>'
    + "<span class='bodyDetailLink'><a href='http://www.citylit.org' target='_blank'>www.citylit.org</a></span>";
  const fetchText = async (u) => (u === show.evidenceUrls[0] ? html : null);
  const got = await discoverOfficialPage(show, { fetchText, fetchStatusFn: stub({ 'https://www.citylit.org': { status: 200 } }) });
  assert.equal(got, 'https://www.citylit.org');
  // A listing that prints a press or producer link stays unfilled.
  const other = html.replace(/citylit\.org/g, 'chicagoreader.com');
  assert.equal(await discoverOfficialPage(show, { fetchText: async () => other, fetchStatusFn: stub({ 'https://www.chicagoreader.com': { status: 200 } }) }), null);
});

test('discoverOfficialPage: a first-party evidenceUrl needs no listing read', async () => {
  const show = { venue: 'North Coast Repertory Theatre, Solana Beach, CA', evidenceUrls: ['https://northcoastrep.org/production/the-cottage/'] };
  let reads = 0;
  const got = await discoverOfficialPage(show, { fetchText: async () => { reads++; return ''; }, fetchStatusFn: stub({ 'https://northcoastrep.org/production/the-cottage/': { status: 200 } }) });
  assert.equal(got, 'https://northcoastrep.org/production/the-cottage/');
  assert.equal(reads, 0);
});
