// BRO-4783 (epic BRO-4210): the opening-night lane's discovery pass. Real functions, injected fetch, no network.
// The pages below are hand-built in the shape of the real ones (BWW homepage and Review Roundup, DTLI homepage and
// show page, an RSS feed, a T1 section index); recorded real pages arrive with the rehearsal fixture (BRO-4787).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');

const SHOW = { id: 'other-desert-cities-2026', title: 'Other Desert Cities', openingDate: '2026-10-18' };
const NIGHT = '2026-10-18';
const T0 = Date.parse('2026-10-18T21:00:00Z'); // 5pm ET curtain
const HOUR = 3600000;

const NYT = 'https://www.nytimes.com/2026/10/19/theater/other-desert-cities-review.html';
const VULTURE = 'https://www.vulture.com/article/other-desert-cities-review.html';
const VARIETY = 'https://variety.com/2026/legit/reviews/other-desert-cities-review-1236000000/';
const GUARDIAN = 'https://www.theguardian.com/stage/2026/oct/19/other-desert-cities-review';

const RR_URL = 'https://www.broadwayworld.com/article/Review-Roundup-OTHER-DESERT-CITIES-Opens-On-Broadway-20261018';
const bwwHome = `<html><body><a href="${RR_URL}">Review Roundup: OTHER DESERT CITIES</a><a href="https://www.broadwayworld.com/article/Review-Roundup-SOMETHING-ELSE-20261010">other</a></body></html>`;
const bwwRoundup = `<html><body><article>
  <a href="${NYT}">Jesse Green, The New York Times</a>
  <a href="${VULTURE}?utm_source=bww">Vulture</a>
  <a href="https://twitter.com/broadwayworld">follow</a>
  <a href="https://www.broadwayworld.com/shows/other-desert-cities">show page</a>
  <a href="https://www.telecharge.com/odc">tickets</a>
  <a href="https://www.nytimes.com/">nytimes home</a>
  <a href="mailto:tips@example.com">tips</a>
</article></body></html>`;

const rss = `<rss><channel>
  <item><title>Review: Other Desert Cities</title><link>${VARIETY}</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
  <item><title>Review: Some Other Show</title><link>https://variety.com/2026/legit/reviews/other-show-1/</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
  <item><title>Other Desert Cities extends</title><link>https://variety.com/2026/legit/news/odc-extends-2/</link><pubDate>Wed, 04 Nov 2026 15:00:00 GMT</pubDate></item>
</channel></rss>`;

const sectionIndex = `<html><body>
  <a href="${GUARDIAN}">Other Desert Cities review: a family at war</a>
  <a href="/stage/2026/oct/19/unrelated-review">An unrelated review</a>
  <a href="/stage">Stage</a>
</body></html>`;
const guardianArticle = `<html><head><meta property="article:published_time" content="2026-10-19T10:00:00+01:00"></head><body>review</body></html>`;

function pages(map) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (!(url in map)) throw new Error(`404 ${url}`);
    const v = map[url];
    if (v instanceof Error) throw v;
    return v;
  };
  return { fetchText, calls };
}

const baseMap = () => ({
  'https://www.broadwayworld.com/': bwwHome,
  [RR_URL]: bwwRoundup,
  'https://variety.com/feed': rss,
  'https://www.theguardian.com/stage': sectionIndex,
  [GUARDIAN]: guardianArticle,
});
const allAdapters = () => [
  d.bwwRoundupAdapter(),
  d.rssAdapter({ feeds: [{ url: 'https://variety.com/feed', name: 'Variety Legit', outletId: 'variety' }] }),
  d.sectionIndexAdapter({ outlets: [{ outletId: 'guardian', indexUrl: 'https://www.theguardian.com/stage' }] }),
];
const run = (map, extra = {}) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: allAdapters(), ...pages(map), ...extra });

test('extractCitedLinks: outbound review links only, no social, ticketing, aggregator, bare homepage or mailto', () => {
  const links = d.extractCitedLinks(bwwRoundup, RR_URL);
  assert.deepEqual(links.map((l) => l.url), [NYT, `${VULTURE}?utm_source=bww`]);
  assert.equal(links[0].text, 'Jesse Green, The New York Times');
});

test('extractPublishDate: JSON-LD, meta, itemprop, time tag; offsets normalised, zoneless date-times refused', () => {
  assert.equal(d.extractPublishDate('<script type="application/ld+json">{"datePublished":"2026-10-19T10:00:00Z"}</script>'), '2026-10-19T10:00:00.000Z');
  assert.equal(d.extractPublishDate('<meta property="article:published_time" content="2026-10-19T10:00:00+01:00">'), '2026-10-19T09:00:00.000Z');
  assert.equal(d.extractPublishDate('<meta content="2026-10-19T10:00:00Z" property="article:published_time">'), '2026-10-19T10:00:00.000Z');
  assert.equal(d.extractPublishDate('<meta itemprop="datePublished" content="2026-10-19">'), '2026-10-19');
  assert.equal(d.extractPublishDate('<time datetime="2026-10-19T08:00:00-04:00">Oct 19</time>'), '2026-10-19T12:00:00.000Z');
  assert.equal(d.extractPublishDate('<time datetime="2026-10-19T08:00:00">Oct 19</time>'), null, 'no zone: the instant would depend on the server');
  assert.equal(d.extractPublishDate('<p>no dates here</p>'), null);
  assert.equal(d.extractPublishDate(null), null);
});

test('a full pass discovers every cited review exactly once, from aggregator, feed and section index', async () => {
  const r = await run(baseMap());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.admitted.map((a) => a.url).sort(), [NYT, `${VULTURE}?utm_source=bww`, VARIETY, GUARDIAN].sort());
  const by = Object.fromEntries(r.admitted.map((a) => [a.url, a]));
  assert.equal(by[NYT].reason, 'aggregator-cited');
  assert.equal(by[NYT].adapter, 'bww-roundup');
  assert.equal(by[VARIETY].reason, 'outlet-index-on-night');
  assert.equal(by[VARIETY].outletId, 'variety');
  assert.equal(by[GUARDIAN].publishDate, '2026-10-19T09:00:00.000Z', 'section-index candidates get their date from the article');
  assert.equal(new Set(r.admitted.map((a) => a.key)).size, r.admitted.length);
  // The feed's extension story is two weeks after opening: it names the show, so it is a candidate, and the window rejects it.
  assert.ok(r.rejected.some((x) => x.url.includes('odc-extends') && x.reason === 'outside-night-window'));
});

test('the same URL cited by several sources is emitted once, keeping the aggregator claim', async () => {
  const map = baseMap();
  map['https://variety.com/feed'] = rss.replace(VARIETY, NYT);
  const r = await run(map);
  const nyt = r.admitted.filter((a) => a.url === NYT);
  assert.equal(nyt.length, 1);
  assert.equal(nyt[0].reason, 'aggregator-cited');
});

test('a URL already on disk or already in the ledger is never emitted again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4783-'));
  try {
    const first = await run(baseMap());
    d.recordDiscovered(dir, { show: SHOW.id, night: NIGHT, admitted: first.admitted, now: T0 + 2 * HOUR });
    const seen = d.loadSeen(dir, SHOW.id, NIGHT);
    const second = await run(baseMap(), { seen });
    assert.deepEqual(second.admitted, [], 'second pass over the same pages finds nothing new');
    const events = ledger.readLedger(dir, SHOW.id, NIGHT).events;
    assert.equal(events.length, first.admitted.length);
    assert.ok(events.every((e) => e.stage === 'discovered' && e.meta.url));
    // A fresh night with only the on-disk list: same result without any ledger.
    const onDisk = d.loadSeen(dir, SHOW.id, '2026-10-19', [NYT, VARIETY.replace(/\/$/, ''), GUARDIAN]);
    const third = await run(baseMap(), { seen: onDisk });
    assert.deepEqual(third.admitted.map((a) => a.url), [`${VULTURE}?utm_source=bww`], 'trailing-slash variants of an on-disk URL count as seen');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a new citation on a later pass is the only thing emitted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4783-'));
  try {
    const first = await run(baseMap());
    d.recordDiscovered(dir, { show: SHOW.id, night: NIGHT, admitted: first.admitted });
    const map = baseMap();
    const NEW = 'https://www.newyorker.com/culture/the-theater/other-desert-cities';
    map[RR_URL] = bwwRoundup.replace('</article>', `<a href="${NEW}">Vinson Cunningham, The New Yorker</a></article>`);
    const r = await run(map, { seen: d.loadSeen(dir, SHOW.id, NIGHT) });
    assert.deepEqual(r.admitted.map((a) => a.url), [NEW]);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('one failing source is recorded and the pass carries on', async () => {
  const map = baseMap();
  map['https://www.broadwayworld.com/'] = new Error('503 Cloudflare');
  map['https://variety.com/feed'] = new Error('timeout');
  const r = await run(map);
  assert.equal(r.errors.length, 1, 'the bww adapter threw; the rss adapter swallows its own dead feeds');
  assert.equal(r.errors[0].adapter, 'bww-roundup');
  assert.deepEqual(r.admitted.map((a) => a.url), [GUARDIAN], 'the section index still delivered');
});

test('outlet-index finds outside opening night +/- 1 day are rejected with a reason, and dateless ones are checked per article', async () => {
  const map = baseMap();
  map[GUARDIAN] = `<meta property="article:published_time" content="2026-10-25T10:00:00Z">`;
  const r = await run(map);
  assert.ok(r.rejected.some((x) => x.url === GUARDIAN && x.reason === 'outside-night-window'));
  const nodate = baseMap();
  nodate[GUARDIAN] = '<p>no date on this page</p>';
  const r2 = await run(nodate);
  assert.ok(r2.rejected.some((x) => x.url === GUARDIAN && x.reason === 'no-publish-date'));
});

test('article date checks are capped per pass and the rest are deferred, not dropped', async () => {
  const many = Array.from({ length: 4 }, (_, i) => `<a href="https://www.theguardian.com/stage/2026/oct/19/other-desert-cities-take-${i}">Other Desert Cities take ${i}</a>`).join('');
  const map = baseMap();
  map['https://www.theguardian.com/stage'] = `<html>${many}</html>`;
  for (let i = 0; i < 4; i++) map[`https://www.theguardian.com/stage/2026/oct/19/other-desert-cities-take-${i}`] = guardianArticle;
  const r = await run(map, { maxDateChecks: 2 });
  assert.equal(r.admitted.filter((a) => a.adapter === 'section-index').length, 2);
  assert.equal(r.deferredDateChecks.length, 2);
});

test('SERP adapters run only after 3 hours of lane time and only while a T1/T2 outlet is still missing', async () => {
  let serpCalls = 0;
  const serp = { name: 'serp', kind: 'serp', phase: 'serp', async discover({ missingOutlets }) {
    serpCalls++;
    return missingOutlets.map((o) => ({ url: `https://${o}.example.com/other-desert-cities-review`, source: 'outlet-index', publishDate: '2026-10-19', via: 'serp' }));
  } };
  const adapters = [...allAdapters(), serp];
  const at = (offsetMs, missing) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + offsetMs, startedAt: T0, adapters, ...pages(baseMap()), missingOutlets: missing });
  const early = await at(3 * HOUR - 1000, ['nytimes']);
  assert.equal(serpCalls, 0, 'one second short of +3h');
  assert.equal(early.serpRan, false);
  const nothingMissing = await at(4 * HOUR, []);
  assert.equal(serpCalls, 0, 'nothing missing, nothing to search for');
  assert.equal(nothingMissing.serpRan, false);
  const late = await at(3 * HOUR, ['nytimes']);
  assert.equal(serpCalls, 1);
  assert.equal(late.serpRan, true);
  assert.ok(late.admitted.some((a) => a.url === 'https://nytimes.example.com/other-desert-cities-review'));
  assert.equal(d.serpAllowed({ startedAt: T0, now: T0 + 3 * HOUR, missingOutlets: ['x'] }), true);
  assert.equal(d.serpAllowed({ startedAt: T0, now: T0 + 3 * HOUR - 1, missingOutlets: ['x'] }), false);
  assert.equal(d.serpAllowed({ startedAt: 'garbage', now: T0, missingOutlets: ['x'] }), false);
});

test('the SERP phase is capped per pass', async () => {
  const serp = { name: 'serp', phase: 'serp', async discover() { return Array.from({ length: 9 }, (_, i) => ({ url: `https://a${i}.example.com/odc-review`, source: 'outlet-index', publishDate: '2026-10-19' })); } };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 4 * HOUR, startedAt: T0, adapters: [serp], ...pages({}), missingOutlets: ['x'], serpMax: 3 });
  assert.equal(r.admitted.length, 3);
});

test('DTLI adapter: homepage to show page to cited links', async () => {
  const showPage = 'https://didtheylikeit.com/shows/other-desert-cities/';
  const map = {
    'https://didtheylikeit.com/': `<a href="${showPage}">Other Desert Cities</a><a href="https://didtheylikeit.com/shows/another-show/">Another</a>`,
    [showPage]: `<a href="${NYT}">NYT</a><a href="${GUARDIAN}">Guardian</a><a href="https://didtheylikeit.com/about">about</a>`,
  };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + HOUR, startedAt: T0, adapters: [d.dtliAdapter()], ...pages(map) });
  assert.deepEqual(r.admitted.map((a) => a.url).sort(), [NYT, GUARDIAN].sort());
  assert.ok(r.admitted.every((a) => a.adapter === 'dtli' && a.reason === 'aggregator-cited'));
});

test('a show that no source mentions yields an empty, error-free pass', async () => {
  const quiet = { id: 'quiet-2026', title: 'Quiet Little Thing', openingDate: NIGHT };
  const r = await d.runDiscoveryPass({ show: quiet, night: NIGHT, now: T0, startedAt: T0, adapters: allAdapters(), ...pages(baseMap()) });
  assert.deepEqual(r, { admitted: [], rejected: [], errors: [], deferredDateChecks: [], serpRan: false });
});

test('runDiscoveryPass: refuses a missing title or fetch instead of silently finding nothing', async () => {
  await assert.rejects(d.runDiscoveryPass({ show: {}, night: NIGHT, fetchText: async () => '' }), /show\.title/);
  await assert.rejects(d.runDiscoveryPass({ show: SHOW, night: NIGHT }), /fetchText/);
});
