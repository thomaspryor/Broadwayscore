// BRO-6872: every outlet that publishes on time on Broadway opening nights needs a source the lane polls (a feed or a
// section page), or a stated reason it cannot have one. Fails when an on-time outlet has neither.
// TESTS-VS-DERIVED-DATA-EXEMPT: structural coverage check (every on-time outlet has a source); pins no review facts.
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

test('no gap is stale: a gapped outlet has no polled source (remove the gap once it has one)', () => {
  const ids = Object.keys(ls.LANE_SOURCE_GAPS);
  const cov = ls.laneSourceCoverage(ids, BROADWAY);
  assert.deepEqual(Object.keys(cov.covered), []);
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
  assert.ok(pinned.length >= 5 && pinned.includes('https://www.nytimes.com/section/theater'));
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
  for (const id of ['nytimes', 'vulture', 'variety', 'lighting-and-sound-america', 'theatrely', 'nytg', 'timeout']) {
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
