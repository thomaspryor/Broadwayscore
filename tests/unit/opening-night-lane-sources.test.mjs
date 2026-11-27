// LIVE-DATA-LANE: reads data/reviews.json (read by the test); data/shows.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6872: every outlet that publishes on time on Broadway opening nights needs a source the lane polls (a feed or a
// section page), or a stated reason it cannot have one. Fails when an on-time outlet has neither.
// structural coverage check (every on-time outlet has a source); pins no review facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const ls = require('../../scripts/lib/opening-night-lane/lane-sources.js');
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const { ALL_FEEDS } = require('../../scripts/lib/rss-discovery.js');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/opening-night-lane/on-time-outlets.json'), 'utf8'));

const BROADWAY = { id: 'x', title: 'X', category: 'broadway' };
const WEST_END = { id: 'y', title: 'Y', category: 'west-end', market: 'west-end' };

test('every outlet in the on-time history snapshot has a polled source or a stated gap', () => {
  assert.ok(fixture.outlets.length >= 30, 'snapshot unexpectedly small');
  const cov = ls.laneSourceCoverage(fixture.outlets.map((o) => o.outletId), BROADWAY);
  assert.deepEqual(cov.missing, [], `on-time outlets with no lane source and no gap reason: ${cov.missing.join(', ')}. `
    + 'Add a feed or section page in scripts/lib/opening-night-lane/lane-sources.js, or a LANE_SOURCE_GAPS reason.');
});

test('live history (when data/reviews.json is present): every on-time outlet has a source or a gap', (t) => {
  const p = (f) => path.join(ROOT, 'data', f);
  if (!fs.existsSync(p('reviews.json')) || !fs.existsSync(p('shows.json'))) { t.skip('no local core data'); return; }
  const raw = JSON.parse(fs.readFileSync(p('reviews.json'), 'utf8'));
  const shows = JSON.parse(fs.readFileSync(p('shows.json'), 'utf8'));
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const outlets = ls.onTimeOutlets(Array.isArray(raw) ? raw : raw.reviews, Array.isArray(shows) ? shows : shows.shows, { since, until });
  const cov = ls.laneSourceCoverage(outlets.map((o) => o.outletId), BROADWAY);
  assert.deepEqual(cov.missing, [], `refresh with: node scripts/lane-on-time-outlets.js --write (missing: ${cov.missing.join(', ')})`);
});

test('an outlet with no source and no gap is reported missing (the check can fail)', () => {
  const cov = ls.laneSourceCoverage(['no-such-outlet-anywhere', 'nytimes', 'talkinbroadway'], BROADWAY);
  assert.deepEqual(cov.missing, ['no-such-outlet-anywhere']);
  assert.ok(cov.covered.nytimes.some((s) => s.startsWith('feed ')));
  assert.match(cov.gaps.talkinbroadway, /own adapter/);
});

test('no gap is stale: a gapped outlet lacks a polled source in at least one market (remove the gap once it has one in all)', () => {
  const ids = Object.keys(ls.LANE_SOURCE_GAPS);
  const markets = [BROADWAY, { category: 'west-end' }];
  const coveredEverywhere = ids.filter((id) => markets.every((m) => ls.laneSourceCoverage([id], m).covered[id]));
  assert.deepEqual(coveredEverywhere, []);
  for (const id of ids) assert.ok(ls.LANE_SOURCE_GAPS[id].length > 20, `${id}: give a checkable reason`);
});

test('onTimeOutlets counts a night only when the review is dated on or before the day after opening', () => {
  const shows = [{ id: 'a', category: 'broadway', openingDate: '2026-10-01' }, { id: 'b', category: 'broadway', openingDate: '2026-10-08' },
    { id: 'c', category: 'west-end', openingDate: '2026-10-08' }];
  const reviews = [
    { showId: 'a', outletId: 'o1', publishDate: '2026-10-02' }, { showId: 'b', outletId: 'o1', publishDate: '2026-10-08T23:00:00Z' },
    { showId: 'a', outletId: 'o2', publishDate: '2026-10-03' }, { showId: 'b', outletId: 'o2', publishDate: '2026-10-09' },
    { showId: 'c', outletId: 'o3', publishDate: '2026-10-08' }, { showId: 'a', outletId: 'o3', publishDate: '2026-10-01' },
    // month-only and long-before-opening dates never count as on time
    { showId: 'a', outletId: 'o4', publishDate: '2026-10' }, { showId: 'b', outletId: 'o4', publishDate: '2026-09-20' },
  ];
  assert.deepEqual(ls.onTimeOutlets(reviews, shows, { since: '2026-01-01', until: '2026-12-31' }), [{ outletId: 'o1', nights: 2 }]);
  assert.deepEqual(ls.onTimeOutlets(reviews, shows, { minNights: 1 }).map((o) => o.outletId), ['o1', 'o2', 'o3']);
});

test('the lane never requires the outlet-listing poller (it would join the lane code hash and its freeze)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/opening-night-lane/lane-sources.js'), 'utf8');
  assert.doesNotMatch(src, /require\([^)]*outlet-listing-poller/);
});

test('feeds: ALL_FEEDS keep their fetch chain; added feeds are direct only and never duplicate an outlet', () => {
  const feeds = d.defaultLaneFeeds(BROADWAY);
  const base = new Set(ALL_FEEDS.filter((f) => !f.market || f.market === 'broadway').map((f) => f.url));
  for (const f of feeds) assert.equal(!!f.directOnly, !base.has(f.url), f.url);
  const ids = feeds.filter((f) => f.directOnly).map((f) => f.outletId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('theater-pizzazz') && ids.includes('stageandcinema') && ids.includes('culturesauce'));
});

test('market: a West End night does not poll New York-only sources, a Broadway night does not poll London-only ones', () => {
  const we = d.defaultLaneFeeds(WEST_END).map((f) => f.outletId);
  const bw = d.defaultLaneFeeds(BROADWAY).map((f) => f.outletId);
  assert.ok(!we.includes('theater-pizzazz') && bw.includes('theater-pizzazz'));
  assert.ok(we.includes('the-recs') && bw.includes('the-recs'), 'a dual-market outlet is polled for both');
  const wePages = d.defaultLaneSectionIndexes(WEST_END).map((o) => o.outletId);
  const bwPages = d.defaultLaneSectionIndexes(BROADWAY).map((o) => o.outletId);
  assert.ok(!wePages.includes('theatermania') && bwPages.includes('theatermania'));
  assert.ok(wePages.includes('independent') && !wePages.includes('timeout'));
});

test('tier-1 section pages are pinned: read on every pass while the extra pages rotate', async () => {
  const pages = d.defaultLaneSectionIndexes(BROADWAY);
  const pinned = pages.filter((o) => o.pinned).map((o) => o.indexUrl);
  assert.ok(pinned.length >= 4 && pinned.includes('https://www.vulture.com/theater/'));
  // BRO-6872: the NYT and WSJ section pages refuse the runners (403/401); their feeds stand in, so no pinned slot is spent on them.
  assert.ok(!pinned.some((u) => /nytimes\.com\/section|wsj\.com\/arts-culture/.test(u)), pinned.join(' '));
  const adapter = d.sectionIndexAdapter();
  const seen = new Set();
  for (let p = 0; p < 4; p++) {
    const read = [];
    await adapter.discover({ show: BROADWAY, fetchText: async (u) => { read.push(u); seen.add(u); return '<main></main>'; } });
    assert.ok(read.length <= 12);
    for (const u of pinned) assert.ok(read.includes(u), `pass ${p} skipped ${u}`);
  }
  assert.equal(seen.size, pages.length, 'every extra page is read within a few passes');
});

test('tier-1 section pages keep their old eligibility; extra pages follow the market', () => {
  const pages = d.defaultLaneSectionIndexes(BROADWAY);
  for (const id of ['vulture', 'variety', 'lighting-and-sound-america', 'theatrely', 'nytg', 'timeout']) {
    assert.ok(pages.some((o) => o.outletId === id), id);
  }
});

test('rss: regular and direct-only feeds rotate in separate windows of 12, so added feeds never raise paid fetches per pass', async () => {
  const feeds = Array.from({ length: 50 }, (_, i) => ({ url: `https://f${i}.example/feed`, outletId: `o${i}`, ...(i % 2 ? { directOnly: true } : {}) }));
  const adapter = d.rssAdapter({ feeds });
  const read = new Map();
  let regularThisPass = 0;
  const fetchText = async (u, opts) => { read.set(u, opts); if (!opts) regularThisPass++; return '<rss><channel></channel></rss>'; };
  for (let p = 0; p < 3; p++) {
    regularThisPass = 0;
    await adapter.discover({ show: BROADWAY, fetchText });
    assert.ok(regularThisPass <= 12, `pass ${p}: ${regularThisPass} regular feeds`);
  }
  assert.equal(read.size, 50);
  assert.deepEqual(read.get('https://f1.example/feed'), { directOnly: true });
  assert.equal(read.get('https://f0.example/feed'), undefined);
});

test('section index: more pages than one pass reads are all read in turn, side by side, direct only', async () => {
  const outlets = Array.from({ length: 15 }, (_, i) => ({ outletId: `o${i}`, indexUrl: `https://p${i}.example/reviews` }));
  const adapter = d.sectionIndexAdapter({ outlets });
  const read = []; let inflight = 0; let peak = 0;
  const fetchText = async (u, opts) => {
    assert.deepEqual(opts, { directOnly: true });
    inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--;
    read.push(u);
    return u === 'https://p13.example/reviews' ? '<main><a href="/x-review">X review</a></main>' : '<main></main>';
  };
  const first = await adapter.discover({ show: BROADWAY, fetchText });
  assert.equal(read.length, 12);
  assert.ok(peak > 1, 'pages are fetched side by side');
  const second = await adapter.discover({ show: BROADWAY, fetchText });
  assert.equal(new Set(read).size, 15);
  assert.deepEqual([...first, ...second].map((c) => c.url), ['https://p13.example/x-review']);
});

test('copied poller URLs have not drifted from scripts/outlet-listing-poller.js (fix the copy in lane-sources.js)', () => {
  // The test may require the poller: tests are outside the lane code hash, lane-sources.js is not.
  const { OUTLET_STRATEGY_CONFIG: poller } = require('../../scripts/outlet-listing-poller.js');
  const drift = [];
  for (const f of ls.LANE_FEEDS) {
    const p = poller[f.outletId];
    if (p && p.strategy === 'rss' && p.url && p.url !== f.url) drift.push(`${f.outletId}: poller ${p.url}, lane ${f.url}`);
  }
  for (const [id, url] of Object.entries(ls.LANE_SECTION_INDEXES)) {
    const p = poller[id];
    if (p && p.strategy === 'listing-html' && p.url && p.url !== url) drift.push(`${id}: poller ${p.url}, lane ${url}`);
  }
  assert.deepEqual(drift, []);
});

test('NYT and WSJ are found through feeds: WSJ Arts & Culture (where its theater reviews are filed), not Lifestyle', () => {
  const wsj = ALL_FEEDS.filter((f) => f.outletId === 'wsj').map((f) => f.url);
  assert.deepEqual(wsj, ['https://feeds.content.dowjones.io/public/rss/RSSArtsCulture']);
  const cov = ls.laneSourceCoverage(['wsj', 'nytimes'], BROADWAY);
  assert.deepEqual(cov.missing, []);
  assert.ok(cov.covered.wsj.some((s) => s.startsWith('feed ') && s.includes('RSSArtsCulture')), JSON.stringify(cov.covered.wsj));
  assert.ok(cov.covered.nytimes.some((s) => s.startsWith('feed ')), JSON.stringify(cov.covered.nytimes));
});

test('NYT on a West End night has a polled feed, no gap (BRO-8125: its Theater feed was Broadway-only)', () => {
  const cov = ls.laneSourceCoverage(['nytimes'], { category: 'west-end' });
  assert.deepEqual(cov.missing, []);
  assert.equal(cov.gaps.nytimes, undefined);
  assert.ok(cov.covered.nytimes.some((x) => x.startsWith('feed ')), JSON.stringify(cov.covered.nytimes));
});

test('last 10 Broadway openings (when data/reviews.json is present): every on-time outlet in each final set has a source or a gap (BRO-7199)', (t) => {
  const p = (f) => path.join(ROOT, 'data', f);
  if (!fs.existsSync(p('reviews.json')) || !fs.existsSync(p('shows.json'))) { t.skip('no local core data'); return; }
  const { perShow } = require('../../scripts/lane-on-time-outlets.js');
  let reviews = JSON.parse(fs.readFileSync(p('reviews.json'), 'utf8'));
  let shows = JSON.parse(fs.readFileSync(p('shows.json'), 'utf8'));
  reviews = Array.isArray(reviews) ? reviews : (reviews.reviews || Object.values(reviews));
  shows = Array.isArray(shows) ? shows : (shows.shows || Object.values(shows));
  const log = console.log; const lines = []; console.log = (m) => lines.push(m);
  let code; try { code = perShow(reviews, shows, { count: 10, until: new Date().toISOString().slice(0, 10) }); } finally { console.log = log; }
  assert.equal(code, 0, `on-time outlets with no lane source:\n${lines.filter((l) => /ON TIME/.test(l)).join('\n')}`);
});

// BRO-7601: the 2026-11-15 Downstate WSJ review was held ~3h as a paywall teaser. The lane's WSJ cookie fetch answered 401, the paid
// tiers returned the teaser, and nothing logged-in was tried. The lane now reads WSJ through its Browserbase session with the
// subscriber cookies injected whenever the free cookie tier does not return the full page.
const bbf = require('../../scripts/lib/opening-night-lane/browserbase-fetch.js');
const WSJ = 'https://www.wsj.com/articles/downstate-review-a-disturbingly-human-drama-on-broadway-2d6ef23c';
const FULL = `<html><body><article>${'A full WSJ review paragraph. '.repeat(120)}</article></body></html>`;
const TEASER = '<html><body><article>Teaser only.</article></body></html>';
const KEYS = { BROWSERBASE_API_KEY: 'k', BROWSERBASE_PROJECT_ID: 'p' };

function wsjLane({ cookieFetch, bbHtml = FULL, cookies = [{ name: 'a', value: 'b', domain: '.wsj.com' }] }) {
  const st = { fetchPageCalls: [], injected: [], pagesRead: [] };
  const context = { addCookies: async (c) => { st.injected.push(...c); }, newPage: async () => ({ close: async () => {} }) };
  const browser = { isConnected: () => true, on() {}, close: async () => {}, contexts: () => [context] };
  const browserbase = bbf.createBrowserbaseFetcher({
    env: KEYS, createSession: async () => ({ id: 'sess1aaaa', connectUrl: 'wss://bb/1' }), connect: async () => browser,
    readPage: async (_p, url) => { st.pagesRead.push(url); return { status: 200, finalUrl: url, html: bbHtml, challenge: false }; },
    cookiesFor: () => cookies,
  });
  const fetchPage = async (url, opts) => { st.fetchPageCalls.push(opts || {}); return cookieFetch(url, opts); };
  const lane = bbf.laneFetchPage({ fetchPage, browserbase, isFullPage: (html) => html.length > 2000 });
  return { lane, st };
}

test('BRO-7601: WSJ cookie fetch 401 -> the full review is read through logged-in Browserbase, no paid tier spent', async () => {
  const { lane, st } = wsjLane({ cookieFetch: async () => { throw Object.assign(new Error('HTTP 401'), { status: 401 }); } });
  const r = await lane(WSJ);
  assert.equal(r.content, FULL);
  assert.equal(r.via, 'browserbase');
  assert.deepEqual(st.pagesRead, [WSJ]);
  assert.equal(st.injected.length, 1, 'subscriber cookies injected into the session');
  assert.ok(st.fetchPageCalls.every((o) => Array.isArray(o.tiers) && o.tiers.join() === 'cookies-plain'), 'only the free cookie tier ran before Browserbase');
});

test('BRO-7601: a cookie-tier teaser also goes to Browserbase; a full cookie-tier page does not', async () => {
  const a = wsjLane({ cookieFetch: async () => ({ content: TEASER, source: 'Cookie-plain' }) });
  assert.equal((await a.lane(WSJ)).content, FULL);
  const b = wsjLane({ cookieFetch: async () => ({ content: FULL, source: 'Cookie-plain' }) });
  assert.equal((await b.lane(WSJ)).content, FULL);
  assert.deepEqual(b.st.pagesRead, [], 'no Browserbase session spent when the free tier already gave the review');
});

test('BRO-7601: Browserbase off or refusing -> WSJ uses the normal fetchPage chain as before', async () => {
  for (const env of [{}, KEYS]) {
    const st = { calls: [] };
    const browserbase = bbf.createBrowserbaseFetcher({ env, createSession: async () => { throw new Error('refused'); }, connect: async () => { throw new Error('no'); }, readPage: async () => ({}) });
    const lane = bbf.laneFetchPage({ fetchPage: async (u, o) => { st.calls.push(o || {}); if (o && o.tiers) throw new Error('HTTP 401'); return { content: TEASER }; }, browserbase, isFullPage: () => false });
    assert.equal((await lane(WSJ)).content, TEASER);
    assert.equal(st.calls[st.calls.length - 1].tiers, undefined, 'last call is the unrestricted chain');
  }
});

test('BRO-7601 review: a browser error falls through to the old chain; no cookies means no session; WSJ never warms up for TB', async () => {
  // error in the browser read -> old chain
  const st = { calls: [], sessions: 0 };
  const ctx = { addCookies: async () => {}, newPage: async () => ({ close: async () => {} }) };
  const browser = { isConnected: () => true, on() {}, close: async () => {}, contexts: () => [ctx] };
  const mk = (cookies, read) => bbf.createBrowserbaseFetcher({ env: KEYS, createSession: async () => { st.sessions++; return { id: 's1aaaaaaa', connectUrl: 'x' }; }, connect: async () => browser, readPage: read, cookiesFor: () => cookies });
  const C = [{ name: 'a', value: 'b', domain: '.wsj.com' }];
  const fp = async (u, o) => { st.calls.push(o || {}); if (o && o.tiers) throw new Error('401'); return { content: TEASER }; };
  const lane = bbf.laneFetchPage({ fetchPage: fp, browserbase: mk(C, async () => ({ status: 403, html: '', challenge: true })), isFullPage: () => false });
  assert.equal((await lane(WSJ)).content, TEASER, 'a challenge in the browser still reaches the old chain');
  // no cookies -> no session billed
  st.sessions = 0;
  const lane2 = bbf.laneFetchPage({ fetchPage: fp, browserbase: mk([], async () => ({ status: 200, html: FULL })), isFullPage: () => false });
  assert.equal((await lane2(WSJ)).content, TEASER);
  assert.equal(st.sessions, 0);
  // a WSJ read first does not mark the session cleared for TB: the next TB fetches still queue behind one warm-up page
  const events = [];
  const tb = 'https://www.talkinbroadway.com/page/world/X.html';
  const f = mk(C, async (_p, url) => { events.push(`start ${url}`); await new Promise((r) => setTimeout(r, 15)); events.push(`end ${url}`); return { status: 200, finalUrl: url, html: 'x', challenge: false }; });
  await f.fetch(WSJ);
  events.length = 0;
  await Promise.all([f.fetch(tb + '?1'), f.fetch(tb + '?2')]);
  assert.equal(events[1], `end ${tb}?1`, events.join(' | '));
});

// BRO-7779 ship-check: a feed the lane reads every press night is a live outlet. The registry marked Reclining Standards
// defunct while its feed was added, so text-gap-classify.js filed its missing texts as PRINT_OR_DEFUNCT.
test('no lane feed or section index reads an outlet the registry calls defunct', () => {
  const ls = require('../../scripts/lib/opening-night-lane/lane-sources.js');
  const reg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../data/outlet-registry.json'), 'utf8'));
  const outlets = reg.outlets || reg;
  const ids = [...ls.LANE_FEEDS.map((f) => f.outletId), ...Object.keys(ls.LANE_SECTION_INDEXES)];
  const defunct = ids.filter((id) => outlets[id] && outlets[id].accessModel === 'defunct');
  assert.deepEqual(defunct, [], 'set accessModel to free/metered/paywalled in data/outlet-registry.json, or drop the source');
});

// Cousins of the Reclining Standards case (2026-11-18): la-excites, next-magazine, popbytes and 12thnight were all marked
// defunct while still publishing, so collect-review-texts.js skipped SERP discovery for their reviews. Live data.
test('live history: no outlet the registry calls defunct published a review in the last 120 days', (t) => {
  const p = path.join(import.meta.dirname, '../../data/reviews.json');
  if (!fs.existsSync(p)) return t.skip('data/reviews.json not present');
  const reg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../data/outlet-registry.json'), 'utf8'));
  const outlets = reg.outlets || reg;
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const live = new Set();
  for (const x of (Array.isArray(r) ? r : r.reviews)) {
    const o = outlets[x.outletId];
    if (o && o.accessModel === 'defunct' && String(x.publishDate || '') >= since) live.add(x.outletId);
  }
  assert.deepEqual([...live].sort(), [], 'still publishing: set accessModel to free/metered/paywalled in data/outlet-registry.json');
});

// BRO-8396: Stage Buddy reviewed It's A Wonderful Life: A Live Radio Play (opened 2026-11-23) on 11-24 with no lane source.
// Its site feed is now a lane feed; the items below are the feed's own shape (2026-11-27): reviews under /theater-review/,
// headlines the show title alone, features under /theater-feature/.
const SB_FEED_URL = 'https://stagebuddy.com/feed';
const SB_SHOW = { id: 'its-a-wonderful-life-a-live-radio-play-2026', title: 'It’s A Wonderful Life: A Live Radio Play', category: 'broadway' };
const SB_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>StageBuddy.com</title><link>https://stagebuddy.com</link>
<item><title>It&#8217;s A Wonderful Life: A Live Radio Play</title><link>https://stagebuddy.com/theater/theater-review/wonderful-life-live-radio-play</link><pubDate>Mon, 24 Nov 2026 15:00:00 +0000</pubDate></item>
<item><title>A Few Good Men</title><link>https://stagebuddy.com/theater/theater-review/a-few-good-men</link><pubDate>Fri, 14 Nov 2026 15:00:00 +0000</pubDate></item>
<item><title>Broadway Eats: Timothy Matthew Flores</title><link>https://stagebuddy.com/theater/theater-feature/broadway-eats-timothy-matthew-flores</link><pubDate>Mon, 10 Nov 2026 15:00:00 +0000</pubDate></item>
</channel></rss>`;

test('BRO-8396: a Broadway night reads the Stage Buddy feed and finds its review of the show', async () => {
  const feed = ls.laneFeeds(SB_SHOW).find((f) => f.url === SB_FEED_URL);
  assert.ok(feed && feed.outletId === 'stagebuddy' && feed.directOnly, 'Stage Buddy feed is a direct lane feed on Broadway nights');
  assert.ok(!ls.laneFeeds({ ...SB_SHOW, category: 'west-end', market: 'west-end' }).some((f) => f.url === SB_FEED_URL), 'not on a West End night');
  const out = await d.rssAdapter({ feeds: [feed] })
    .discover({ show: SB_SHOW, fetchText: async (u) => { if (u !== SB_FEED_URL) throw new Error('404'); return SB_FEED; } });
  assert.deepEqual(out.filter((c) => c.source === 'outlet-index').map((c) => [c.url, c.outletId]),
    [['https://stagebuddy.com/theater/theater-review/wonderful-life-live-radio-play', 'stagebuddy']]);
  assert.ok(d.hasReviewSignal(out[0].url, out[0].title), 'the /theater-review/ path is the review signal');
});

test('BRO-8396: a Stage Buddy feature naming the show carries no review signal (the poller page-confirms; the lane needs the path)', async () => {
  const feed = ls.laneFeeds(SB_SHOW).find((f) => f.url === SB_FEED_URL);
  const FEATURE = SB_FEED.replace('broadway-eats-timothy-matthew-flores', 'broadway-eats-wonderful-life-cast')
    .replace('Broadway Eats: Timothy Matthew Flores', 'Broadway Eats: the cast of It&#8217;s A Wonderful Life: A Live Radio Play');
  const out = await d.rssAdapter({ feeds: [feed] })
    .discover({ show: SB_SHOW, fetchText: async () => FEATURE });
  const feature = out.find((c) => /theater-feature/.test(c.url || ''));
  assert.ok(feature, 'the feature names the show, so it is a candidate like any whole-site feed item');
  assert.ok(!feature.reviewSignalGiven, 'a feature is never vouched for as a review');
  assert.ok(!d.hasReviewSignal(feature.url, feature.title), 'no review word in a /theater-feature/ path or headline');
});
