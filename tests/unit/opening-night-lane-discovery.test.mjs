// BRO-4783 (epic BRO-4210): the opening-night lane's discovery pass. Real functions, injected fetch, no network.
// The pages below are hand-built in the shape of the real ones, INCLUDING page chrome (nav, footer, rails, ads,
// related stories), because what a pass admits is stamped aggregator-verified and the corpus guards stand down for it.
// Recorded real pages arrive with the rehearsal fixture (BRO-4787).
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

// Raw URLs as the sources publish them, and the canonical keys the pass emits.
const NYT_RAW = 'https://www.nytimes.com/2026/10/19/theater/other-desert-cities-review.html?partner=rss&emc=rss&utm_source=bww';
const NYT = 'https://nytimes.com/2026/10/19/theater/other-desert-cities-review.html';
const VULTURE_RAW = 'http://www.vulture.com/article/other-desert-cities-review.html?utm_source=bww';
const VULTURE = 'https://vulture.com/article/other-desert-cities-review.html';
const VARIETY_RAW = 'https://variety.com/2026/legit/reviews/other-desert-cities-review-1236000000/';
const VARIETY = 'https://variety.com/2026/legit/reviews/other-desert-cities-review-1236000000';
const GUARDIAN_RAW = 'https://www.theguardian.com/stage/2026/oct/19/other-desert-cities-review';
const GUARDIAN = 'https://theguardian.com/stage/2026/oct/19/other-desert-cities-review';

const RR_URL = 'https://www.broadwayworld.com/article/Review-Roundup-OTHER-DESERT-CITIES-Opens-On-Broadway-20261018';
const bwwHome = `<html><body><a href="${RR_URL}">Review Roundup: OTHER DESERT CITIES</a><a href="https://www.broadwayworld.com/article/Review-Roundup-SOMETHING-ELSE-20261010">other</a></body></html>`;
// A roundup page WITH chrome: only the article body's links are reviews.
const bwwRoundup = `<html><body>
  <header><a href="https://www.nytimes.com/section/theater">Theater section</a></header>
  <nav><a href="https://www.theguardian.com/stage">Guardian stage</a></nav>
  <article>
    <a href="${NYT_RAW}">Jesse Green, The New York Times</a>
    <a href="${VULTURE_RAW}">Vulture</a>
    <a href="https://twitter.com/broadwayworld">follow</a>
    <a href="https://www.broadwayworld.com/shows/other-desert-cities">show page</a>
    <a href="https://www.telecharge.com/odc">tickets</a>
    <a href="https://www.broadway.com/shows/other-desert-cities/">buy</a>
    <a href="https://amzn.to/abc123">cast album</a>
    <a href="https://www.nytimes.com/">nytimes home</a>
    <a href="https://feedproxy.google.com/~r/variety/legit/~3/abc/story.html">wrapped</a>
    <a href="https://some-unknown-blog.example.com/2026/10/other-desert-cities-review">A blog nobody has registered</a>
    <a href="https://www.nytimes.com/2026/10/18/theater/other-desert-cities-interview-stockard.html">Stockard Channing interview</a>
    <a href="mailto:tips@example.com">tips</a>
  </article>
  <aside class="related"><a href="https://www.thetimes.com/culture/other-story-review">Related story</a></aside>
  <footer><a href="https://www.washingtonpost.com/about/">WaPo</a></footer>
</body></html>`;

const rss = `<rss><channel>
  <item><title>Review: Other Desert Cities</title><link>${VARIETY_RAW}</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
  <item><title>Review: Some Other Show</title><link>https://variety.com/2026/legit/reviews/other-show-review-1/</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
  <item><title>Other Desert Cities extends through January</title><link>https://variety.com/2026/legit/news/other-desert-cities-extends-2/</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
  <item><title>Other Desert Cities opens tonight: red carpet photos</title><link>https://variety.com/2026/legit/news/other-desert-cities-red-carpet-3/</link><pubDate>Sun, 18 Oct 2026 22:00:00 GMT</pubDate></item>
  <item><title>Other Desert Cities cast on the revival</title><link>https://variety.com/2026/legit/features/other-desert-cities-cast-4/</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
  <item><title>Other Desert Cities: five things to know</title><link>https://variety.com/2026/legit/other-desert-cities-things-to-know-5/</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
</channel></rss>`;

const sectionIndex = `<html><body>
  <nav><a href="/stage/2026/oct/19/other-desert-cities-nav-review">nav link naming the show</a></nav>
  <main>
    <a href="${GUARDIAN_RAW}">Other Desert Cities review: a family at war</a>
    <a href="/stage/2026/oct/19/unrelated-review">An unrelated review</a>
    <a href="/stage/2026/oct/19/other-desert-cities-cast-interview">Other Desert Cities: the cast talk</a>
    <a href="/stage">Stage</a>
  </main>
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
  [GUARDIAN_RAW]: guardianArticle,
});
const allAdapters = () => [
  d.bwwRoundupAdapter(),
  d.rssAdapter({ feeds: [{ url: 'https://variety.com/feed', name: 'Variety Legit', outletId: 'variety' }] }),
  d.sectionIndexAdapter({ outlets: [{ outletId: 'guardian', indexUrl: 'https://www.theguardian.com/stage' }] }),
];
const run = (map, extra = {}) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: allAdapters(), ...pages(map), ...extra });

test('canonicalUrl: one key per article (https, no www, tracking stripped, params sorted, no AMP or trailing slash); wrappers refused', () => {
  assert.equal(d.canonicalUrl(NYT_RAW), NYT);
  assert.equal(d.canonicalUrl('http://WWW.NYTimes.com/2026/10/19/theater/other-desert-cities-review.html/'), NYT);
  assert.equal(d.canonicalUrl('https://nytimes.com/2026/10/19/theater/other-desert-cities-review.html#comments'), NYT);
  assert.equal(d.canonicalUrl('https://nytimes.com/2026/10/19/theater/other-desert-cities-review.html/amp/'), NYT);
  assert.equal(d.canonicalUrl('https://example.com/a?b=2&a=1&utm_campaign=x&fbclid=y'), 'https://example.com/a?a=1&b=2');
  assert.equal(d.canonicalUrl('https://example.com/a?id=7'), 'https://example.com/a?id=7', 'a real parameter survives');
  assert.equal(d.canonicalUrl('https://feedproxy.google.com/~r/variety/legit/~3/abc/story.html'), null);
  assert.equal(d.canonicalUrl('https://news.google.com/rss/articles/CBMi'), null);
  assert.equal(d.canonicalUrl('https://bit.ly/3abc'), null);
  assert.equal(d.canonicalUrl('mailto:a@b.c'), null);
  assert.equal(d.canonicalUrl('not a url'), null);
});

test('extractCitedLinks: article body only; no chrome, social, ticketing, ads, aggregator, wrapper or bare homepage', () => {
  const links = d.extractCitedLinks(bwwRoundup, RR_URL).map((l) => l.url);
  assert.ok(links.includes(NYT) && links.includes(VULTURE));
  for (const bad of ['theguardian.com/stage', 'nytimes.com/section', 'thetimes.com', 'washingtonpost.com', 'twitter.com', 'telecharge', 'broadway.com', 'amzn.to', 'feedproxy']) {
    assert.ok(!links.some((u) => u.includes(bad)), `${bad} is chrome, ads or not a review`);
  }
  assert.ok(!links.includes('https://nytimes.com'), 'a bare homepage is not a review');
  assert.equal(d.extractCitedLinks(bwwRoundup, RR_URL)[0].text, 'Jesse Green, The New York Times');
});

test('nonReviewReason and hasReviewSignal: news, galleries, interviews, tag and author pages out; a title word like "Dead" is fine', () => {
  assert.equal(d.nonReviewReason('https://nytimes.com/2026/10/19/theater/other-desert-cities-review.html'), null);
  assert.equal(d.nonReviewReason('https://variety.com/2026/legit/news/odc-extends/'), 'non-review-path');
  assert.equal(d.nonReviewReason('https://nytimes.com/tag/other-desert-cities'), 'non-review-path');
  assert.equal(d.nonReviewReason('https://nytimes.com/by/author/jesse-green'), 'non-review-path');
  assert.equal(d.nonReviewReason('https://nytimes.com/2026/10/18/theater/other-desert-cities-interview-stockard.html'), 'non-review-slug');
  assert.equal(d.nonReviewReason('https://nytimes.com/'), 'homepage');
  assert.equal(d.nonReviewReason('https://nytimes.com/2026/10/19/theater/dead-outlaw-review.html'), null, 'a show called Dead Outlaw still gets its review');
  assert.equal(d.nonReviewReason('https://nytimes.com/2026/10/19/theater/other-desert-cities-review-photos.html'), null, 'an explicit review signal wins over a news word');
  assert.equal(d.hasReviewSignal('https://x.com/a/odc-review.html', ''), true);
  assert.equal(d.hasReviewSignal('https://x.com/reviews/odc', ''), true);
  assert.equal(d.hasReviewSignal('https://x.com/a/odc.html', 'Review: Other Desert Cities'), true);
  assert.equal(d.hasReviewSignal('https://x.com/a/odc-things-to-know', 'Five things to know'), false);
});

test('extractPublishDate: JSON-LD, meta, itemprop, time tag; offsets normalised, zoneless date-times refused', () => {
  assert.equal(d.extractPublishDate('<script type="application/ld+json">{"datePublished":"2026-10-19T10:00:00Z"}</script>'), '2026-10-19T10:00:00.000Z');
  assert.equal(d.extractPublishDate('<meta property="article:published_time" content="2026-10-19T10:00:00+01:00">'), '2026-10-19T09:00:00.000Z');
  assert.equal(d.extractPublishDate('<meta content="2026-10-19T10:00:00Z" property="article:published_time">'), '2026-10-19T10:00:00.000Z');
  assert.equal(d.extractPublishDate('<meta itemprop="datePublished" content="2026-10-19">'), '2026-10-19');
  assert.equal(d.extractPublishDate('<time datetime="2026-10-19T08:00:00-04:00">Oct 19</time>'), '2026-10-19T12:00:00.000Z');
  assert.equal(d.extractPublishDate('<time datetime="2026-10-19T08:00:00">Oct 19</time>'), '2026-10-19', 'no zone: only the calendar day the outlet wrote is trusted');
  assert.equal(d.extractPublishDate('<meta itemprop="datePublished" content="2024-03-01T10:00:00"><aside><time datetime="2026-10-06T20:00:00Z"></time></aside>'), '2024-03-01', 'the first date source decides; a sidebar date never stands in');
  assert.equal(d.extractPublishDate('<p>no dates here</p>'), null);
  assert.equal(d.extractPublishDate(null), null);
});

test('a full pass admits only real reviews, once each, canonical, from aggregator, feed and section index', async () => {
  const r = await run(baseMap());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.admitted.map((a) => a.key).sort(), [NYT, VULTURE, VARIETY, GUARDIAN].sort());
  const by = Object.fromEntries(r.admitted.map((a) => [a.key, a]));
  assert.equal(by[NYT].reason, 'aggregator-cited');
  assert.equal(by[NYT].adapter, 'bww-roundup');
  assert.equal(by[NYT].outletId, 'nytimes');
  assert.equal(by[VARIETY].reason, 'outlet-index-on-night');
  assert.equal(by[VARIETY].outletId, 'variety');
  assert.equal(by[GUARDIAN].publishDate, '2026-10-19T09:00:00.000Z', 'section-index candidates get their date from the article');
  assert.equal(new Set(r.admitted.map((a) => a.key)).size, r.admitted.length);
  assert.ok(r.admitted.every((a) => a.key === d.canonicalUrl(a.url)), 'the ledger key is the canonical form of the published URL');
  // The news that names the show, dated on the night, never reaches the stamp that turns the guards off.
  const why = (frag) => (r.rejected.find((x) => x.url.includes(frag)) || {}).reason;
  assert.equal(why('other-desert-cities-extends'), 'non-review-path');
  assert.equal(why('red-carpet'), 'non-review-path');
  assert.equal(why('other-desert-cities-cast-4'), 'non-review-path', 'a /features/ story');
  assert.equal(why('things-to-know'), 'not-review-like', 'dated on the night, names the show, no review signal');
  assert.equal(why('cast-interview'), 'non-review-slug');
  assert.equal(why('interview-stockard'), 'non-review-slug');
  assert.ok(!r.admitted.some((a) => /interview|extends|red-carpet|things-to-know|nav-review/.test(a.url)));
  // An unregistered blog on an aggregator page is reported, never ingested blind.
  assert.ok(r.unknownHosts.includes('some-unknown-blog.example.com'));
  assert.equal(why('some-unknown-blog'), 'unknown-outlet-host');
});

test('the same article from several sources, in different URL spellings, is one candidate keeping the aggregator claim', async () => {
  const map = baseMap();
  map['https://variety.com/feed'] = rss.replace(VARIETY_RAW, 'http://nytimes.com/2026/10/19/theater/other-desert-cities-review.html/?partner=rss');
  const r = await run(map);
  const nyt = r.admitted.filter((a) => a.key === NYT);
  assert.equal(nyt.length, 1);
  assert.equal(nyt[0].reason, 'aggregator-cited');
});

test('a URL already on disk or in the ledger is never emitted again, whatever its tracking parameters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4783-'));
  try {
    const first = await run(baseMap());
    d.recordDiscovered(dir, { show: SHOW.id, night: NIGHT, admitted: first.admitted, now: T0 + 2 * HOUR });
    const second = await run(baseMap(), { seen: d.loadSeen(dir, SHOW.id, NIGHT) });
    assert.deepEqual(second.admitted, [], 'second pass over the same pages finds nothing new');
    const events = ledger.readLedger(dir, SHOW.id, NIGHT).events;
    assert.equal(events.length, first.admitted.length);
    assert.ok(events.every((e) => e.stage === 'discovered' && e.meta.url));
    const onDisk = d.loadSeen(dir, SHOW.id, '2026-10-19', [`${NYT}?utm_medium=email`, 'http://www.' + VARIETY.slice('https://'.length) + '/', GUARDIAN_RAW]);
    const third = await run(baseMap(), { seen: onDisk });
    assert.deepEqual(third.admitted.map((a) => a.key), [VULTURE], 'http/https, www, trailing slash and tracking variants of an on-disk URL all count as seen');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a new citation on a later pass is the only thing emitted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4783-'));
  try {
    const first = await run(baseMap());
    d.recordDiscovered(dir, { show: SHOW.id, night: NIGHT, admitted: first.admitted });
    const NEW = 'https://www.newyorker.com/culture/the-theater/other-desert-cities-review';
    const map = baseMap();
    map[RR_URL] = bwwRoundup.replace('</article>', `<a href="${NEW}">Vinson Cunningham, The New Yorker</a></article>`);
    const r = await run(map, { seen: d.loadSeen(dir, SHOW.id, NIGHT) });
    assert.deepEqual(r.admitted.map((a) => a.key), ['https://newyorker.com/culture/the-theater/other-desert-cities-review']);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('one failing source is recorded and the pass carries on', async () => {
  const map = baseMap();
  map['https://www.broadwayworld.com/'] = new Error('503 Cloudflare');
  map['https://variety.com/feed'] = new Error('timeout');
  const r = await run(map);
  assert.equal(r.errors.length, 1, 'the bww adapter threw; the rss adapter swallows its own dead feeds');
  assert.equal(r.errors[0].adapter, 'bww-roundup');
  assert.deepEqual(r.admitted.map((a) => a.key), [GUARDIAN], 'the section index still delivered');
});

test('a hung fetch cannot hang the pass: per-fetch timeout, recorded as an error', async () => {
  const map = baseMap();
  const hang = new Promise(() => {});
  const fetchText = async (url) => (url === 'https://www.broadwayworld.com/' ? hang : pages(map).fetchText(url));
  const started = Date.now();
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: allAdapters(), fetchText, fetchTimeoutMs: 60 });
  assert.ok(Date.now() - started < 2000, 'the pass moved on');
  assert.ok(r.errors.some((e) => e.adapter === 'bww-roundup' && /timed out/.test(e.error)));
  assert.deepEqual(r.admitted.map((a) => a.key).sort(), [VARIETY, GUARDIAN].sort(), 'sources that answered still count; only the hung aggregator is lost');
});

test('an overall deadline stops a slow pass and defers the rest instead of dropping it', async () => {
  const slow = { name: 'slow', phase: 'cheap', async discover() { await new Promise((r) => setTimeout(r, 40)); return []; } };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0, startedAt: T0, adapters: [slow, slow, slow, allAdapters()[0]], ...pages(baseMap()), deadlineMs: 50 });
  assert.equal(r.deadlineHit, true);
});

test('outlet-index finds outside opening night +/- 1 day are rejected with a reason, and dateless ones are checked per article', async () => {
  const map = baseMap();
  map[GUARDIAN_RAW] = '<meta property="article:published_time" content="2026-10-25T10:00:00Z">';
  const r = await run(map);
  assert.ok(r.rejected.some((x) => x.url === GUARDIAN && x.reason === 'outside-night-window'));
  const nodate = baseMap();
  nodate[GUARDIAN_RAW] = '<p>no date on this page</p>';
  const r2 = await run(nodate);
  assert.ok(r2.rejected.some((x) => x.url === GUARDIAN && x.reason === 'no-publish-date'));
});

test('rejections are remembered: final ones are never re-fetched, and the date-check cap rotates through the backlog', async () => {
  const many = Array.from({ length: 6 }, (_, i) => `<a href="/stage/2026/oct/19/other-desert-cities-take-${i}-review">Other Desert Cities review ${i}</a>`).join('');
  const map = baseMap();
  map['https://www.theguardian.com/stage'] = `<html><main>${many}</main></html>`;
  const late = '<meta property="article:published_time" content="2026-10-30T10:00:00Z">';
  for (let i = 0; i < 6; i++) map[`https://www.theguardian.com/stage/2026/oct/19/other-desert-cities-take-${i}-review`] = i < 4 ? late : guardianArticle;
  const memo = { rejected: {} };
  const seen = new Set(); // the caller records what it admitted, as the lane loop does via recordDiscovered
  const adapters = [d.sectionIndexAdapter({ outlets: [{ outletId: 'guardian', indexUrl: 'https://www.theguardian.com/stage' }] })];
  const pass = () => { const p = pages(map); return d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + HOUR, startedAt: T0, adapters, fetchText: p.fetchText, memo, seen, maxDateChecks: 3 }).then((r) => { r.admitted.forEach((a) => seen.add(a.key)); return ({ r, calls: p.calls.filter((u) => u.includes('take-')) }); }); };
  const one = await pass();
  assert.equal(one.calls.length, 3, 'cap of 3 article fetches');
  assert.equal(one.r.deferredDateChecks.length, 3);
  const two = await pass();
  assert.equal(two.calls.length, 3, 'the NEXT three, not the same three again');
  assert.ok(!two.calls.some((u) => one.calls.includes(u)), 'candidates not yet checked go first');
  assert.equal(two.r.deferredDateChecks.length, 0);
  assert.equal(two.r.admitted.length + one.r.admitted.length, 2, 'the two on-night articles were found once the backlog was reached');
  const three = await pass();
  assert.equal(three.calls.length, 0, 'everything decided is remembered: no more article fetches');
});

test('SERP adapters run only after 3 hours of lane time and only while a T1/T2 outlet is still missing; the cap reaches the adapter', async () => {
  let serpCalls = 0; let limitSeen = null;
  const serp = { name: 'serp', kind: 'serp', phase: 'serp', async discover({ missingOutlets, limit }) {
    serpCalls++; limitSeen = limit;
    return missingOutlets.map((o) => ({ url: `https://${o}.com/2026/10/19/theater/other-desert-cities-review.html`, title: 'Other Desert Cities review', source: 'outlet-index', publishDate: '2026-10-19', via: 'serp' }));
  } };
  const adapters = [...allAdapters(), serp];
  const at = (offsetMs, missing) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + offsetMs, startedAt: T0, adapters, ...pages(baseMap()), missingOutlets: missing, serpMax: 4 });
  const early = await at(3 * HOUR - 1000, ['newyorker']);
  assert.equal(serpCalls, 0, 'one second short of +3h');
  assert.equal(early.serpRan, false);
  assert.equal((await at(4 * HOUR, [])).serpRan, false);
  assert.equal(serpCalls, 0, 'nothing missing, nothing to search for');
  const late = await at(3 * HOUR, ['newyorker']);
  assert.equal(serpCalls, 1);
  assert.equal(limitSeen, 4, 'the adapter is told the cap so it can limit its searches, not just its results');
  assert.equal(late.serpRan, true);
  assert.ok(late.admitted.some((a) => a.key === 'https://newyorker.com/2026/10/19/theater/other-desert-cities-review.html'));
  assert.equal(d.serpAllowed({ startedAt: T0, now: T0 + 3 * HOUR, missingOutlets: ['x'] }), true);
  assert.equal(d.serpAllowed({ startedAt: T0, now: T0 + 3 * HOUR - 1, missingOutlets: ['x'] }), false);
  assert.equal(d.serpAllowed({ startedAt: 'garbage', now: T0, missingOutlets: ['x'] }), false);
});

test('the SERP phase result is capped per pass', async () => {
  const serp = { name: 'serp', phase: 'serp', async discover() { return Array.from({ length: 9 }, (_, i) => ({ url: `https://nytimes.com/2026/10/19/theater/odc-take-${i}-review.html`, title: 'review', source: 'outlet-index', publishDate: '2026-10-19' })); } };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 4 * HOUR, startedAt: T0, adapters: [serp], ...pages({}), missingOutlets: ['x'], serpMax: 3 });
  assert.equal(r.admitted.length, 3);
});

test('DTLI adapter: homepage to show page to cited links, known outlets only', async () => {
  const showPage = 'https://didtheylikeit.com/shows/other-desert-cities/';
  const map = {
    'https://didtheylikeit.com/': `<a href="${showPage}">Other Desert Cities</a><a href="https://didtheylikeit.com/shows/another-show/">Another</a>`,
    [showPage]: `<article><a href="${NYT_RAW}">NYT</a><a href="${GUARDIAN_RAW}">Guardian</a><a href="https://didtheylikeit.com/about">about</a></article><footer><a href="https://www.thetimes.com/x-review">footer</a></footer>`,
  };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + HOUR, startedAt: T0, adapters: [d.dtliAdapter()], ...pages(map) });
  assert.deepEqual(r.admitted.map((a) => a.key).sort(), [NYT, GUARDIAN].sort());
  assert.ok(r.admitted.every((a) => a.adapter === 'dtli' && a.reason === 'aggregator-cited'));
});

test('a show that no source mentions yields an empty, error-free pass', async () => {
  const quiet = { id: 'quiet-2026', title: 'Quiet Little Thing', openingDate: NIGHT };
  const r = await d.runDiscoveryPass({ show: quiet, night: NIGHT, now: T0, startedAt: T0, adapters: allAdapters(), ...pages(baseMap()) });
  assert.deepEqual(r, { admitted: [], rejected: [], unknownHosts: [], errors: [], deferredDateChecks: [], serpRan: false, deadlineHit: false });
});

test('runDiscoveryPass: refuses a missing title or fetch instead of silently finding nothing', async () => {
  await assert.rejects(d.runDiscoveryPass({ show: {}, night: NIGHT, fetchText: async () => '' }), /show\.title/);
  await assert.rejects(d.runDiscoveryPass({ show: SHOW, night: NIGHT }), /fetchText/);
});

test('admitted reviews carry the URL as the outlet published it (key is the canonical form), so the normal pipeline dedupes them', async () => {
  const r = await run(baseMap());
  const g = r.admitted.find((a) => a.key === GUARDIAN);
  assert.equal(g.url, GUARDIAN_RAW);
  const n = r.admitted.find((a) => a.key === NYT);
  assert.ok(n.url.includes('nytimes.com') && n.key === NYT);
});

test('an aggregator citation overrides an earlier index-only rejection of the same URL', async () => {
  const memo = { rejected: { [NYT]: { reason: 'not-review-like', attempts: 1 } } };
  const r = await run(baseMap(), { memo });
  assert.ok(r.admitted.some((a) => a.key === NYT));
  const memo2 = { rejected: { [NYT]: { reason: 'non-review-slug', attempts: 1 } } };
  assert.ok(!(await run(baseMap(), { memo: memo2 })).admitted.some((a) => a.key === NYT), 'a rejection about the URL itself stands');
});

test('the deadline caps every fetch inside an adapter, not just the gaps between adapters', async () => {
  const slow = async () => { await new Promise((res) => setTimeout(res, 60)); return '<html></html>'; };
  const started = Date.now();
  await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0, startedAt: T0, adapters: [d.rssAdapter({ feeds: Array.from({ length: 12 }, (_, i) => ({ url: `https://f${i}.example.com/rss`, outletId: 'x' })) })], fetchText: slow, deadlineMs: 100, fetchTimeoutMs: 5000 });
  assert.ok(Date.now() - started < 400, 'twelve 60ms feeds stop near the 100ms deadline');
});

test('star words in a slug are not review signals unless they are a rating', () => {
  assert.equal(d.hasReviewSignal('https://x.com/2026/star-wars-musical-opens', ''), false);
  assert.equal(d.hasReviewSignal('https://x.com/2026/odc-4-stars', ''), true);
});
