// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
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
const { laneAdapters } = require('../../scripts/lib/opening-night-lane/adapters.js');
const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization');

test('unconfigured lane factory sweeps T1 indexes using free requests', async () => {
  const calls = [];
  const index = laneAdapters({ search: async () => [] }).find(a => a.name === 'section-index');
  await index.discover({ show: { title: 'Test', category: 'broadway' }, fetchText: async (url, opts) => {
    calls.push({ url, opts }); return '<main></main>';
  } });
  assert.ok(calls.some(c => c.url === 'https://www.vulture.com/theater/'));
  assert.ok(calls.every(c => c.opts.directOnly === true));
});

test('unconfigured missing T1 at +3h gets one query, then cooldown survives adapter restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-serp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = T0 + 3 * HOUR;
  let queries = 0;
  const seen = new Set(d.defaultLaneMissingOutlets(SHOW).filter(id => id !== 'nytimes').map(id => {
    const o = require('../../data/outlet-registry.json').outlets[id];
    return `https://${o.domain}/test-review`;
  }));
  // Use the canonical registry to remove every other outlet, including domain aliases.
  const missingOutlets = d.laneMissingOutlets({ show: SHOW, seen });
  assert.deepEqual(missingOutlets, ['nytimes']);
  const make = () => laneAdapters({ ledgerDir: dir, now: () => clock, search: async () => { queries++; return []; } }).filter(a => a.phase === 'serp');
  const pass = adapters => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: clock, startedAt: T0,
    adapters, missingOutlets, fetchText: async () => '' });
  await pass(make());
  assert.equal(queries, 1);
  clock += 2 * 60000;
  await pass(make());
  assert.equal(queries, 1);
  clock += 28 * 60000;
  await pass(make());
  assert.equal(queries, 2);
});

test('default targets follow registry tiers and markets; captured domains and explicit empty lists are skipped', async () => {
  const registry = require('../../data/outlet-registry.json').outlets;
  const bw = d.defaultLaneMissingOutlets({ category: 'broadway' });
  const we = d.defaultLaneMissingOutlets({ category: 'west-end' });
  assert.ok(bw.includes('vulture') && bw.includes('cititour') && bw.includes('lighting-and-sound-america'));
  assert.ok(!we.includes('vulture') && we.includes('thestage') && we.includes('artsdesk'));
  assert.ok(!bw.includes('artsdesk') && !bw.includes('chicagotribune'));
  for (const ids of [bw, we]) {
    assert.ok(ids.every(id => registry[id].tier <= 2));
    assert.equal(new Set(ids.map(id => registry[id].domain)).size, ids.length);
    assert.deepEqual(ids.map(id => registry[id].tier), ids.map(id => registry[id].tier).sort());
  }
  assert.deepEqual(d.defaultLaneMissingOutlets({ category: 'off-broadway' }), bw);
  assert.ok(!d.defaultLaneSectionIndexes({ category: 'west-end' }).some(o => o.outletId === 'vulture'));
  assert.ok(d.defaultLaneSectionIndexes({ category: 'west-end' }).some(o => o.outletId === 'guardian'));
  const seen = new Set(['https://www.nytimes.com/2026/10/19/theater/test-review.html', 'https://www.timeout.com/london/theatre/test']);
  const missing = d.laneMissingOutlets({ show: { category: 'west-end' }, seen });
  assert.ok(!missing.includes('nytimes') && !missing.includes('timeout-london'));
  assert.deepEqual(d.laneMissingOutlets({ show: SHOW, seen, adaptersConfig: { missingOutlets: [] } }), []);
  const index = laneAdapters({ search: async () => [], adaptersConfig: { outlets: [] } }).find(a => a.name === 'section-index');
  await index.discover({ show: SHOW, fetchText: async () => assert.fail('explicit empty list must disable index fetching') });
});

test('SERP night budget caps failed searches, persists, and resets for a different night', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-serp-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = T0;
  let calls = 0;
  const make = () => d.serpAdapter({ ledgerDir: dir, now: () => clock, domainFor: id => `${id}.example.com`,
    search: async () => { calls++; throw new Error('provider unavailable'); } });
  const missingOutlets = Array.from({ length: 30 }, (_, i) => `outlet-${i}`);
  for (let i = 0; i < 8; i++) {
    await make().discover({ show: SHOW, night: NIGHT, missingOutlets }).catch(e => assert.match(e.message, /provider unavailable/));
    assert.equal(calls, Math.min((i + 1) * 5, d.SERP_NIGHT_MAX));
    clock += d.SERP_COOLDOWN_MS;
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, `${SHOW.id}-${NIGHT}.serp.json`), 'utf8'));
  assert.equal(saved.length, d.SERP_NIGHT_MAX);
  await make().discover({ show: SHOW, night: '2026-10-19', missingOutlets }).catch(e => assert.match(e.message, /provider unavailable/));
  assert.equal(calls, d.SERP_NIGHT_MAX + 5);
});

test('SERP refuses corrupt, locked, or unwritable budget storage without spending', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-serp-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${SHOW.id}-${NIGHT}.serp.json`);
  const make = ledgerDir => d.serpAdapter({ ledgerDir, search: async () => assert.fail('must not spend') });
  const args = { show: SHOW, night: NIGHT, missingOutlets: ['nytimes'] };
  for (const content of ['{', '{}', '[{"outletId":"nytimes","at":null}]']) {
    fs.writeFileSync(file, content);
    await assert.rejects(make(dir).discover(args));
  }
  fs.writeFileSync(`${file}.lock`, '');
  await assert.rejects(make(dir).discover(args), /EEXIST/);
  fs.unlinkSync(`${file}.lock`);
  await assert.rejects(make(file).discover(args), /EEXIST|ENOTDIR/);
});

test('SERP provider spend ledger inherits show and outlet attribution', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-serp-spend-'));
  const previous = process.env.SCRAPER_SPEND_LEDGER_PATH;
  process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(dir, 'spend.jsonl');
  t.after(() => {
    if (previous === undefined) delete process.env.SCRAPER_SPEND_LEDGER_PATH;
    else process.env.SCRAPER_SPEND_LEDGER_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { recordBdCall } = require('../../scripts/lib/provider-telemetry');
  const adapter = d.serpAdapter({ ledgerDir: dir, search: async () => {
    recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: true, status: 200 });
    return [];
  } });
  await adapter.discover({ show: SHOW, night: NIGHT, missingOutlets: ['nytimes'] });
  const row = JSON.parse(fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim());
  assert.equal(row.showId, SHOW.id);
  assert.equal(row.outletId, 'nytimes');
});

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
  const WSJ = 'https://wsj.com/articles/the-imaginary-invalid-review-bill-irwins-hilarious-hypochondriac-ff88aa6b';
  assert.equal(d.canonicalUrl(`${WSJ.replace('https://', 'https://www.')}?mod=rss_artsculture`), WSJ, 'the WSJ feed tag does not split one review into two keys');
  assert.equal(d.canonicalUrl(`${WSJ}?reflink=desktopwebshare_permalink&mod=e2tw`), WSJ, 'nor does a WSJ share link');
  assert.equal(d.canonicalUrl('http://www.lightingandsoundamerica.com/news/story.asp?ID=TNQ36D'), 'https://lightingandsoundamerica.com/news/story.asp?ID=TNQ36D', 'the L&SA article id survives');
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
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0, startedAt: T0, adapters: [slow, slow, slow, allAdapters()[0]], ...pages(baseMap()), deadlineMs: 20 });
  assert.equal(r.deadlineHit, true);
});

test('a pass past its deadline still admits what the aggregators cite; only fetch-needing date checks are deferred', async () => {
  // Shadow run 39803830568 (860): slow adapters pushed every pass past 90 s, and the admission loop deferred every
  // candidate, so the lane admitted nothing all night.
  const slow = { name: 'slow', phase: 'cheap', async discover() { await new Promise((r) => setTimeout(r, 80)); return []; } };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [allAdapters()[0], slow], ...pages(baseMap()), deadlineMs: 50 });
  assert.ok(r.admitted.length > 0, 'roundup-cited reviews are admitted although the pass ran over');
  assert.ok(r.admitted.every((a) => a.source === 'aggregator'));
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

// ---- BRO-4820: Show Score, Playbill Verdict, Google News, Talkin' Broadway, SERP, feed dates, memo -------------------

const passWith = (adapters, map, extra = {}) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters, ...pages(map), ...extra });

test('Show Score adapter: "Read more" tiles are aggregator claims, known outlets only, a dead page is an error not an empty result', async () => {
  const page = 'https://www.show-score.com/broadway-shows/other-desert-cities';
  const tiles = `<a href="${NYT_RAW}">Read more</a><a href="https://www.show-score.com/member/x">Read more</a><a href="https://some-unknown-blog.example.com/odc-review">Read more</a>`;
  const r = await passWith([d.showScoreAdapter({ allShows: [{ id: 'x' }] })], { [page]: tiles }, { show: { ...SHOW, category: 'broadway' } });
  assert.deepEqual(r.admitted.map((a) => a.key), [NYT]);
  assert.equal(r.admitted[0].source, 'aggregator');
  assert.deepEqual(r.unknownHosts, ['some-unknown-blog.example.com']);
  const unguarded = pages({ [page]: tiles });
  assert.equal((await d.runDiscoveryPass({ show: { ...SHOW, category: 'broadway' }, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [d.showScoreAdapter()], ...unguarded })).admitted.length, 0, 'no same-title guards, no run');
  assert.equal(unguarded.calls.length, 0);
  const dead = await passWith([d.showScoreAdapter({ allShows: [{ id: 'x' }] })], {}, { show: { ...SHOW, category: 'broadway' } });
  assert.equal(dead.admitted.length, 0);
  assert.equal(dead.errors.length, 1, 'an outage is reported');
  assert.ok(d.NON_REVIEW_HOSTS.includes('show-score.com'), 'the real Show Score host is excluded from cited links');
});

test('Playbill Verdict adapter: category page to this show\'s roundup to the links it cites', async () => {
  const cat = `<a href="/article/read-the-reviews-for-other-desert-cities">Read the Reviews for Other Desert Cities</a><a href="/article/read-the-reviews-for-something-else">Something Else</a>`;
  const art = `<html><head><meta property="article:published_time" content="2026-10-19T10:00:00Z"></head><body><article><a href="${NYT_RAW}">NYT</a><a href="https://www.playbill.com/shows">shows</a></article></body></html>`;
  const map = { 'https://playbill.com/category/the-verdict': cat, 'https://playbill.com/article/read-the-reviews-for-other-desert-cities': art };
  const r = await passWith([d.playbillVerdictAdapter()], map);
  assert.deepEqual(r.admitted.map((a) => a.key), [NYT]);
  const undated = { ...map, 'https://playbill.com/article/read-the-reviews-for-other-desert-cities': art.replace(/<meta[^>]*>/, '') };
  assert.equal((await passWith([d.playbillVerdictAdapter()], undated)).admitted.length, 0, 'an undated roundup is not trusted');
  const old = { ...map, 'https://playbill.com/article/read-the-reviews-for-other-desert-cities': art.replace('2026-10-19', '2019-03-02') };
  assert.equal((await passWith([d.playbillVerdictAdapter()], old)).admitted.length, 0, 'a roundup from another run is not trusted');
  assert.equal((await passWith([d.playbillVerdictAdapter()], { 'https://playbill.com/category/the-verdict': '<a href="/article/read-the-reviews-for-something-else">Something Else</a>' })).admitted.length, 0);
});

const GN_LINK = 'https://news.google.com/rss/articles/CBMiTOKEN?oc=5';
const gnFeed = (link = GN_LINK, title = 'Other Desert Cities review: a family at war', src = 'https://www.nytimes.com') =>
  `<rss><channel><item><title>${title} - The New York Times</title><link>${link}</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate><source url="${src}">The New York Times</source></item></channel></rss>`;
const GN_FEED_URL = 'https://news.google.com/rss/search?q=%22Other+Desert+Cities%22+review&hl=en-US&gl=US&ceid=US%3Aen';

test('BRO-6589: Google News adapter decodes the wrapper over HTTP first; the browser opens only when that fails', async () => {
  const fetched = [];
  const map = { [GN_FEED_URL]: gnFeed(), [GN_LINK]: `<link rel="canonical" href="${NYT_RAW}">` };
  const track = pages(map);
  const fetchText = async (url, o) => { fetched.push(url); return track.fetchText(url, o); };
  const ok = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, ...track, fetchText,
    adapters: [d.googleNewsAdapter({ decodeImpl: async () => NYT_RAW })] });
  assert.deepEqual(ok.admitted.map((a) => a.key), [NYT]);
  assert.ok(!fetched.includes(GN_LINK), 'decoded: the wrapper is never opened');
  // A decode on another host is ignored and the existing browser unwrap still runs.
  fetched.length = 0;
  const off = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, ...track, fetchText,
    adapters: [d.googleNewsAdapter({ decodeImpl: async () => 'https://evil.example.com/odc-review' })] });
  assert.deepEqual(off.admitted.map((a) => a.key), [NYT]);
  assert.ok(fetched.includes(GN_LINK));
});

test('BRO-6589: Google News decodes are capped per pass (count and time) so a hanging Google cannot hold the pass', async () => {
  const track = pages({ [GN_FEED_URL]: gnFeed(), [GN_LINK]: `<link rel="canonical" href="${NYT_RAW}">` });
  let calls = 0;
  const decodeImpl = async () => { calls++; return null; };
  await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, ...track,
    adapters: [d.googleNewsAdapter({ decodeImpl, maxDecode: 0 })] });
  assert.equal(calls, 0, 'count cap');
  let t = 0;
  await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, ...track,
    adapters: [d.googleNewsAdapter({ decodeImpl, decodeBudgetMs: 10, now: () => (t += 100) })] });
  assert.equal(calls, 0, 'time cap: budget already spent before the first item');
});

test('Google News adapter: the wrapper is unwrapped through the item\'s own source host, never emitted itself', async () => {
  const wrapper = `<html><head><link rel="canonical" href="${NYT_RAW}"></head><body>redirecting</body></html>`;
  const r = await passWith([d.googleNewsAdapter()], { [GN_FEED_URL]: gnFeed(), [GN_LINK]: wrapper });
  assert.deepEqual(r.admitted.map((a) => a.key), [NYT]);
  assert.ok(!r.admitted.some((a) => /news\.google\.com/.test(a.url)));
  // A destination on another host, an unparseable page, or several unrelated links all drop the item.
  for (const html of [`<link rel="canonical" href="https://evil.example.com/odc-review">`, '<p>nothing</p>', `<a href="https://nytimes.com/a-review">a</a><a href="https://nytimes.com/b-review">b</a>`]) {
    const bad = await passWith([d.googleNewsAdapter()], { [GN_FEED_URL]: gnFeed(), [GN_LINK]: html });
    assert.equal(bad.admitted.length, 0, html);
  }
  // An unknown publisher is skipped before any wrapper fetch.
  const unknown = pages({ [GN_FEED_URL]: gnFeed(GN_LINK, undefined, 'https://nobody.example.com') });
  const u = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [d.googleNewsAdapter()], ...unknown });
  assert.equal(u.admitted.length, 0);
  assert.ok(!unknown.calls.includes(GN_LINK));
});

test('Google News adapter: resolutions are cached across passes, failures retried a bounded number of times, unwraps capped per pass', async () => {
  const wrapper = `<link rel="canonical" href="${NYT_RAW}">`;
  const adapter = d.googleNewsAdapter();
  const map = pages({ [GN_FEED_URL]: gnFeed(), [GN_LINK]: wrapper });
  for (let i = 0; i < 3; i++) await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [adapter], ...map });
  assert.equal(map.calls.filter((u) => u === GN_LINK).length, 1);
  const failing = d.googleNewsAdapter();
  const f = pages({ [GN_FEED_URL]: gnFeed(), [GN_LINK]: '<p>nothing</p>' });
  for (let i = 0; i < 6; i++) await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [failing], ...f });
  assert.equal(f.calls.filter((u) => u === GN_LINK).length, 3);
  const many = `<rss><channel>${Array.from({ length: 5 }, (_, i) => `<item><title>Other Desert Cities review ${i}</title><link>https://news.google.com/rss/articles/T${i}</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate><source url="https://www.nytimes.com">NYT</source></item>`).join('')}</channel></rss>`;
  const m = pages({ [GN_FEED_URL]: many });
  await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [d.googleNewsAdapter({ maxUnwrap: 2 })], ...m });
  assert.equal(m.calls.filter((u) => u.includes('/articles/T')).length, 2);
});

test('Talkin\' Broadway adapter: dated review pages that name the show, date read from the byline, never the filename', async () => {
  const idx = 'https://www.talkinbroadway.com/page/ob/index.html';
  const home = `<html><body><main><a href="/page/ob/10_19_26.html">Other Desert Cities</a><a href="/page/ob/10_09_26.html">Unrelated Show</a><a href="/page/world/OtherDesertCities.html">Other Desert Cities</a></main></body></html>`;
  const page = (when) => `<html><body><section class='page'><P><B>Theatre Review by <A HREF='mailto:hm@talkinbroadway.com'>Howard Miller</A> - ${when}</B></CENTER><P>text</section></body></html>`;
  const adapters = [d.talkinBroadwayAdapter({ indexUrls: [idx] })];
  const map = { [idx]: home, 'https://www.talkinbroadway.com/page/ob/10_19_26.html': page('October 19, 2026') };
  const r = await passWith(adapters, map);
  assert.deepEqual(r.admitted.map((a) => a.key), ['https://talkinbroadway.com/page/ob/10_19_26.html']);
  assert.equal(r.admitted[0].publishDate, '2026-10-19');
  map['https://www.talkinbroadway.com/page/ob/10_19_26.html'] = page('October 2, 2026');
  assert.ok((await passWith(adapters, map)).rejected.some((x) => x.reason === 'outside-night-window'), 'a filename that looks right does not beat the page date');
  assert.equal(d.extractPublishDate(page('June 5, 2026')), '2026-06-05');
  const down = await passWith(adapters, {});
  assert.equal(down.errors.length, 1, 'every index failing is reported');
});

test('Talkin\' Broadway adapter: a Broadway named page listed on past.html is a candidate; index and past pages are not (School Girls replay 2026-11-04)', async () => {
  const past = 'https://www.talkinbroadway.com/page/world/past.html';
  const list = `<html><body><main><a href="/page/world/SchoolGirls.html">School Girls; Or, The African Mean Girls Play</a><a href="/page/world/index.html">School Girls</a><a href="/page/world/OtherShow.html">Other Show</a></main></body></html>`;
  const show = { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' };
  const a = d.talkinBroadwayAdapter({ indexUrls: [past], now: () => T0 });
  const fetchText = async (url) => { if (url === past) return list; throw Object.assign(new Error('404 not found'), { status: 404 }); };
  const out = await a.discover({ show, fetchText });
  assert.deepEqual(out.map((c) => c.url), ['https://www.talkinbroadway.com/page/world/SchoolGirls.html']);
});

test('SERP adapter: limit caps the searches themselves, results are restricted to the missing outlet\'s host and to this show', async () => {
  const queries = [];
  const search = async (q) => { queries.push(q); const dom = /site:(\S+)/.exec(q)[1];
    return [{ url: `https://${dom}/2026/10/19/odc-review`, title: 'Other Desert Cities review' }, { url: 'https://elsewhere.example.com/odc-review', title: 'Other Desert Cities review' }, { url: `https://${dom}/2026/10/19/x-review`, title: 'Different Show review' }]; };
  const adapter = d.serpAdapter({ search, domainFor: (id) => `${id}.com` });
  const out = await adapter.discover({ show: SHOW, missingOutlets: ['nytimes', 'vulture', 'variety', 'newyorker'], limit: 2 });
  assert.equal(queries.length, 2, 'two searches, not four');
  assert.deepEqual(out.map((c) => c.url), ['https://nytimes.com/2026/10/19/odc-review', 'https://vulture.com/2026/10/19/odc-review']);
  assert.ok(queries[0].includes('site:nytimes.com') && queries[0].includes('"Other Desert Cities"'));
  await assert.rejects(d.serpAdapter({ search: async () => { throw new Error('quota'); }, domainFor: (id) => `${id}.com` }).discover({ show: SHOW, missingOutlets: ['a'], limit: 3 }), /quota/);
  assert.throws(() => d.serpAdapter({}), /search/);
  // End to end: only after +3h, the page date is read from the article.
  const full = (offset) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + offset, startedAt: T0, adapters: [d.serpAdapter({ search, domainFor: (id) => `${id}.com` })], missingOutlets: ['nytimes'], serpMax: 3,
    ...pages({ 'https://nytimes.com/2026/10/19/odc-review': guardianArticle }) });
  assert.equal((await full(2 * HOUR)).serpRan, false);
  assert.equal((await full(3 * HOUR)).admitted.length, 1);
});

test('feed dates: a zoneless RSS date and an Atom <updated> are confirmed against the article page; the server zone never decides', async () => {
  const zoneless = `<rss><channel><item><title>Review: Other Desert Cities</title><link>${VARIETY_RAW}</link><pubDate>Mon, 19 Oct 2026 03:00:00</pubDate></item></channel></rss>`;
  const entries = d.parseFeedEntries(zoneless);
  assert.equal(entries[0].date.publishDate, null);
  assert.equal(entries[0].date.fallbackDate, '2026-10-19');
  assert.equal(entries[0].date.needsDate, true);
  const zoned = d.parseFeedEntries(rss.replace('</channel>', '</channel>'));
  assert.equal(zoned[0].date.publishDate, '2026-10-19T03:00:00.000Z');
  assert.equal(zoned[0].date.needsDate, false);
  const feeds = [{ url: 'https://variety.com/feed', name: 'Variety', outletId: 'variety' }];
  // The page says the review is from last month: the feed's day is overruled.
  const stale = `<meta property="article:published_time" content="2026-09-02T10:00:00Z">`;
  const r = await passWith([d.rssAdapter({ feeds })], { 'https://variety.com/feed': zoneless, [VARIETY_RAW]: stale });
  assert.equal(r.admitted.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'outside-night-window'));
  // A page with no date falls back to the day the feed wrote.
  const ok = await passWith([d.rssAdapter({ feeds })], { 'https://variety.com/feed': zoneless, [VARIETY_RAW]: '<p>no date</p>' });
  assert.equal(ok.admitted.length, 1);
  assert.equal(ok.admitted[0].publishDate, '2026-10-19');
  // Atom: <updated> is the edit time, so it is confirmed too, and the result does not depend on TZ.
  const atom = `<feed><entry><title>Review: Other Desert Cities</title><link rel="alternate" href="${VARIETY_RAW}"/><updated>2026-10-19T03:00:00Z</updated><published>2026-09-01T00:00:00Z</published></entry></feed>`;
  const a = d.parseFeedEntries(atom)[0];
  assert.equal(a.date.needsDate, true);
  assert.equal(a.date.fallbackDate, '2026-09-01', 'the published day is the fallback, not the edit day');
  const onlyPublished = d.parseFeedEntries(atom.replace(/<updated>.*?<\/updated>/, ''))[0];
  assert.equal(onlyPublished.date.publishDate, '2026-09-01T00:00:00.000Z');
});

test('memo persistence: saved after a pass, reloaded by a restarted lane, torn file is an empty memo, ledger untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-memo-'));
  const memo = { rejected: { 'https://a.com/x': { reason: 'outside-night-window', attempts: 1 } } };
  const file = d.saveMemo(dir, SHOW.id, NIGHT, memo);
  assert.ok(file.endsWith('.memo.json') && !file.endsWith('.jsonl'));
  assert.deepEqual(d.loadMemo(dir, SHOW.id, NIGHT), memo);
  fs.writeFileSync(file, '{"rejected": {');
  assert.deepEqual(d.loadMemo(dir, SHOW.id, NIGHT), { rejected: {} });
  assert.deepEqual(d.loadMemo(dir, 'other-show', NIGHT), { rejected: {} });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('lane runner: persists the memo each pass and calls recordDiscovered (restart does not re-fetch a final rejection)', async () => {
  const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-run-'));
  const map = baseMap();
  map[GUARDIAN_RAW] = '<meta property="article:published_time" content="2026-10-25T10:00:00Z">';
  let t = T0;
  const common = () => ({
    show: SHOW, night: NIGHT, ledgerDir: dir, adapters: allAdapters(), ...pages(map), now: () => t, wait: async (ms) => { t += ms; },
    fetchReview: async () => ({ outlet: 'x', criticName: 'Y Z', fullText: 'text '.repeat(200) }), scoreReview: async () => 70,
    publishPorts: { updateReviews: async () => {}, regenShow: async () => ({ missing: [] }), deploy: async () => ({}), fetchLiveShow: async () => ({ rv: [] }) },
    windowMs: 3 * 60 * 1000, passIntervalMs: 2 * 60 * 1000, dryRun: true,
  });
  const first = common();
  await runLaneNight(first).catch(() => {}); // publishing is not what this test is about
  assert.ok(Object.values(d.loadMemo(dir, SHOW.id, NIGHT).rejected).some((m) => m.reason === 'outside-night-window'), 'memo on disk');
  const second = common();
  t = T0;
  await runLaneNight(second).catch(() => {});
  assert.ok(!second.calls.includes(GUARDIAN_RAW), 'the restarted lane did not re-fetch the final rejection');
  assert.ok(d.loadSeen(dir, SHOW.id, NIGHT).size > 0, 'recordDiscovered wrote to the ledger');
});

test('a timed-out date check is deferred without a strike, so a slow outlet is not lost for the night', async () => {
  const memo = { rejected: {} };
  const feeds = [{ url: 'https://variety.com/feed', name: 'Variety', outletId: 'variety' }];
  const zoneless = `<rss><channel><item><title>Review: Other Desert Cities</title><link>${VARIETY_RAW}</link><pubDate>Mon, 19 Oct 2026 03:00:00</pubDate></item></channel></rss>`;
  for (let i = 0; i < 5; i++) {
    const r = await passWith([d.rssAdapter({ feeds })], { 'https://variety.com/feed': zoneless, [VARIETY_RAW]: new Error('fetch timed out after 15000ms: x') }, { memo });
    assert.equal(r.deferredDateChecks.length, 1);
  }
  const ok = await passWith([d.rssAdapter({ feeds })], { 'https://variety.com/feed': zoneless, [VARIETY_RAW]: '<p>x</p>' }, { memo });
  assert.equal(ok.admitted.length, 1, 'still admitted after five timeouts');
});

// BRO-6066 (The Imaginary Invalid, 2026-10-22): TheaterMania and Time Out file reviews under /news/, so the DTLI and
// Playbill links to them were rejected as news. A cited link stands; an uncited feed find and a roundup stay out.
test('nonReviewReason: an aggregator-cited /news/ link whose slug says review is a review; uncited or roundup is not', () => {
  const tm = 'https://www.theatermania.com/news/review-revival-of-the-imaginary-invalid-is-terminally-short-on-laughs_1857994/';
  const to = 'https://www.timeout.com/newyork/news/broadway-review-the-imaginary-invalid-gasps-for-moliere-102326';
  assert.equal(d.nonReviewReason(tm, { aggregatorCited: true }), null);
  assert.equal(d.nonReviewReason(to, { aggregatorCited: true }), null);
  assert.equal(d.nonReviewReason(tm), 'non-review-path', 'a feed or index find under /news/ is still out');
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/the-imaginary-invalid-reviews-what-critics-say_1/', { aggregatorCited: true }), 'non-review-path');
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/the-imaginary-invalid-extends_2/', { aggregatorCited: true }), 'non-review-path');
  assert.equal(d.nonReviewReason('https://variety.com/2026/legit/tag/review-imaginary/', { aggregatorCited: true }), 'non-review-path', 'only the news segment stands down');
});

test('playbillArticleBody keeps the roundup prose and drops the sidebar <article> cards ahead of it', () => {
  const html = '<article><a href="https://playbill.com/article/other">x</a></article><main><div class="prose"><a href="https://www.chicagotribune.com/2026/10/22/review-x/">r</a></div></main>';
  const body = d.playbillArticleBody(html);
  assert.match(body, /chicagotribune/);
  assert.doesNotMatch(body, /playbill\.com\/article\/other/);
  assert.equal(d.playbillArticleBody('<article>no prose block</article>'), '<article>no prose block</article>', 'no prose block: the whole page, as before');
});

test('fetchTextFrom returns content, or {content, finalUrl} on request, and never forwards withFinalUrl to fetchPage', async () => {
  const seen = [];
  const ft = d.fetchTextFrom(async (url, opts) => { seen.push(opts); return { content: '<p>x</p>', finalUrl: 'https://www.vulture.com/article/x.html' }; });
  assert.equal(await ft('https://news.google.com/rss/articles/a'), '<p>x</p>');
  assert.deepEqual(await ft('https://news.google.com/rss/articles/a', { withFinalUrl: true, preferPlaywright: true }), { content: '<p>x</p>', finalUrl: 'https://www.vulture.com/article/x.html' });
  assert.deepEqual(seen[1], { preferPlaywright: true });
  await assert.rejects(d.fetchTextFrom(async () => ({ content: '' }))('https://a.example/'), /no content/);
});

test('adapters run concurrently but their finds are admitted in adapter order', async () => {
  const mk = (name, delay, url) => ({ name, kind: 'outlet-index', phase: 'cheap',
    discover: async () => { await new Promise((r) => setTimeout(r, delay)); return [{ url, title: 'Other Desert Cities review', source: 'outlet-index', publishDate: '2026-10-18T23:00:00Z', reviewSignalGiven: true, via: name }]; } });
  const started = Date.now();
  const r = await d.runDiscoveryPass({
    show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, fetchText: async () => { throw new Error('404'); },
    adapters: [mk('slow', 60, 'https://www.nytimes.com/2026/10/18/theater/other-desert-cities-review.html'), mk('fast', 5, 'https://variety.com/2026/legit/reviews/other-desert-cities-review-1/')],
    memo: { rejected: {} }, seen: new Set(), timeZone: 'America/New_York',
  });
  assert.ok(Date.now() - started < 110, 'the two adapters overlapped');
  assert.deepEqual(r.admitted.map((x) => x.via), ['slow', 'fast']);
});

test('a /news/ review rejected when a feed saw it first is admitted once an aggregator cites it', async () => {
  const url = 'https://www.theatermania.com/news/review-other-desert-cities-is-a-triumph_1857994/';
  const mk = (cited) => ({ name: cited ? 'dtli' : 'google-news', kind: cited ? 'aggregator' : 'outlet-index', phase: 'cheap',
    discover: async () => [cited
      ? { url, title: 'TheaterMania', source: 'aggregator', aggregatorCited: true, publishDate: null, via: 'https://didtheylikeit.com/shows/odc/' }
      : { url, title: 'Review: Other Desert Cities', source: 'outlet-index', publishDate: '2026-10-18T23:00:00Z', via: 'google-news' }] });
  const memo = { rejected: {} }; const seen = new Set();
  const pass = (adapters, now) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now, startedAt: T0, adapters, memo, seen,
    fetchText: async () => { throw new Error('404'); }, timeZone: 'America/New_York' });
  const p1 = await pass([mk(false)], T0 + 3600000);
  assert.equal(p1.admitted.length, 0);
  assert.equal(memo.rejected[d.canonicalUrl(url)].reason, 'non-review-path');
  const p2 = await pass([mk(true)], T0 + 3720000);
  assert.deepEqual(p2.admitted.map((x) => x.key), [d.canonicalUrl(url)]);
});

test('publisherUrlFromWrapperPage prefers the page canonical over a same-host landing, and refuses a login landing', () => {
  const art = 'https://www.wsj.com/articles/other-desert-cities-review-ff88';
  const page = `<html><head><link rel="canonical" href="${art}"></head></html>`;
  assert.equal(d.publisherUrlFromWrapperPage(page, 'https://www.wsj.com', 'https://www.wsj.com/client/login?target=x'), art);
  assert.equal(d.publisherUrlFromWrapperPage('<html>consent</html>', 'https://www.wsj.com', 'https://www.wsj.com/client/login?target=x'), null);
  assert.equal(d.publisherUrlFromWrapperPage('<html>consent</html>', 'https://www.vulture.com', 'https://www.vulture.com/article/odc-review.html'), 'https://www.vulture.com/article/odc-review.html');
});

test('Talkin\' Broadway: an undated named page does not stop the probe from reaching the dated one', async () => {
  const byline = '<p>The Play by Some Writer. Directed by Jane Director. Theatre Review by Ann Critic</p>' + '<p>filler text for length. </p>'.repeat(40);
  const show = { id: 'odc', title: 'Other Desert Cities', openingDate: '2026-10-18' };
  const tb = require('../../scripts/lib/tb-direct-url.js');
  const [first, , third] = tb.buildTbCandidateUrls(show.title, '2026');
  const map = {
    [first]: `<html><head><title>Other Desert Cities</title></head><body>${byline}</body></html>`,
    [third]: `<html><head><title>Other Desert Cities</title></head><body><p>October 18, 2026</p>${byline}</body></html>`,
  };
  const { fetchText } = pages(map);
  const a = d.talkinBroadwayAdapter({ indexUrls: [], now: () => T0 });
  const out = await a.discover({ show, fetchText });
  assert.deepEqual(out.map((c) => c.url), [third]);
  assert.ok(out[0].publishDate);
});

test('Talkin\' Broadway: every candidate name is fetched in the same probe, so a slow miss cannot starve the real page (BRO-6872)', async () => {
  const byline = '<p>The Play by Some Writer. Directed by Jane Director. Theatre Review by Ann Critic</p>' + '<p>filler text for length. </p>'.repeat(40);
  const show = { id: 'a-few-good-men-2026', title: 'A Few Good Men', openingDate: '2026-10-29' };
  const tb = require('../../scripts/lib/tb-direct-url.js');
  const names = tb.buildTbCandidateUrls(show.title, '2026');
  const real = 'https://www.talkinbroadway.com/page/world/AFewGoodMen.html';
  assert.ok(names.includes(real) && names.indexOf(real) > 0);
  let inFlight = 0; let peak = 0; const asked = [];
  const fetchText = async (url) => {
    asked.push(url); inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    if (url === real) return `<html><head><title>A Few Good Men</title></head><body><p>October 29, 2026</p>${byline}</body></html>`;
    throw new Error('All scraping methods failed');
  };
  const a = d.talkinBroadwayAdapter({ indexUrls: [], now: () => T0 });
  const out = await a.discover({ show, fetchText });
  assert.deepEqual(out.map((c) => c.url), [real]);
  assert.equal(peak, names.length, 'every name of a plain title all fit one batch and are fetched together');
  assert.deepEqual(asked.sort(), [...names].sort());
});

test('Talkin\' Broadway: a dated earlier name wins even when a dated later name answers first (BRO-6872)', async () => {
  const byline = '<p>The Play by Some Writer. Directed by Jane Director. Theatre Review by Ann Critic</p>' + '<p>filler text for length. </p>'.repeat(40);
  const show = { id: 'a-few-good-men-2026', title: 'A Few Good Men', openingDate: '2026-10-29' };
  const names = require('../../scripts/lib/tb-direct-url.js').buildTbCandidateUrls(show.title, '2026');
  const [first, , third] = names;
  const page = `<html><head><title>A Few Good Men</title></head><body><p>October 29, 2026</p>${byline}</body></html>`;
  const fetchText = async (url) => {
    if (url === first) { await new Promise((r) => setTimeout(r, 40)); return page; }
    if (url === third) return page; // answers first
    throw new Error('All scraping methods failed');
  };
  const out = await d.talkinBroadwayAdapter({ indexUrls: [], now: () => T0 }).discover({ show, fetchText });
  assert.deepEqual(out.map((c) => c.url), [first]);
});

test('Talkin\' Broadway: a long name list is fetched in capped batches that rotate across probes (BRO-6872)', async () => {
  const show = { id: 'billy-crystal-860-2026', title: 'Billy Crystal: 860', openingDate: '2026-10-21' };
  const names = require('../../scripts/lib/tb-direct-url.js').buildTbCandidateUrls(show.title, '2026').filter((u) => !/\/index\.html?$/i.test(u));
  assert.ok(names.length > d.TB_PROBE_BATCH, 'this title has more names than one batch');
  let clock = T0; let inFlight = 0; let peak = 0; const asked = [];
  const fetchText = async (url) => { asked.push(url); inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; throw new Error('404'); };
  const a = d.talkinBroadwayAdapter({ indexUrls: [], now: () => clock });
  const probes = Math.ceil(names.length / d.TB_PROBE_BATCH);
  for (let i = 0; i < probes; i++) { await a.discover({ show, fetchText }); clock += 16 * 60 * 1000; }
  assert.equal(peak, d.TB_PROBE_BATCH, 'never more than one batch in flight');
  assert.deepEqual([...new Set(asked)].sort(), [...names].sort(), 'every name is tried within a few probes');
});

test('Talkin\' Broadway: a name list that is not a multiple of the batch wraps and still covers every name (BRO-6872)', async () => {
  const tb = require('../../scripts/lib/tb-direct-url.js');
  const show = ['9 to 5: The Musical', 'Billy Crystal: 860', 'Beaches, A New Musical', 'Oh, Mary!']
    .map((title) => ({ id: 'x', title, openingDate: '2026-10-21' }))
    .find((s) => { const n = tb.buildTbCandidateUrls(s.title, '2026').length; return n > d.TB_PROBE_BATCH && n % d.TB_PROBE_BATCH; });
  assert.ok(show, 'a title whose name count is not a multiple of the batch');
  const names = tb.buildTbCandidateUrls(show.title, '2026').filter((u) => !/\/index\.html?$/i.test(u));
  let clock = T0; const asked = [];
  const fetchText = async (url) => { asked.push(url); throw new Error('404'); };
  const a = d.talkinBroadwayAdapter({ indexUrls: [], now: () => clock });
  for (let i = 0; i < Math.ceil(names.length / d.TB_PROBE_BATCH); i++) { await a.discover({ show, fetchText }); clock += 16 * 60 * 1000; }
  assert.deepEqual([...new Set(asked)].sort(), [...names].sort());
});

test('Talkin\' Broadway: a "Title; Or, Subtitle" show has its bare short-title page in the first batch (School Girls replay 2026-11-04)', async () => {
  const show = { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' };
  const real = 'https://www.talkinbroadway.com/page/world/SchoolGirls.html';
  const asked = [];
  const fetchText = async (url) => { asked.push(url); throw Object.assign(new Error(`404 not found: ${url}`), { status: 404 }); };
  await d.talkinBroadwayAdapter({ indexUrls: [], now: () => T0 }).discover({ show, fetchText });
  assert.equal(asked.length, d.TB_PROBE_BATCH);
  assert.ok(asked.includes(real), `first batch ${asked.join(' ')}`);
});

test('Talkin\' Broadway: a name blocked by the Cloudflare challenge is fetched first at the next probe, up to a cap (School Girls replay 2026-11-04)', async () => {
  const byline = '<p>The Play by Some Writer. Directed by Jane Director. Theatre Review by Ann Critic</p>' + '<p>filler text for length. </p>'.repeat(40);
  const show = { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' };
  const real = 'https://www.talkinbroadway.com/page/world/SchoolGirls.html';
  let blocked = true; let clock = T0; let asked = [];
  const fetchText = async (url) => {
    asked.push(url);
    if (url === real && blocked) throw Object.assign(new Error(`403 still behind the Cloudflare challenge: ${url}`), { status: 403 });
    if (url === real) return `<html><head><title>School Girls</title></head><body><p>September 28, 2026</p>${byline}</body></html>`;
    throw Object.assign(new Error(`404 not found: ${url}`), { status: 404 });
  };
  const a = d.talkinBroadwayAdapter({ indexUrls: [], now: () => clock });
  assert.deepEqual(await a.discover({ show, fetchText }), []);
  clock += 16 * 60 * 1000; asked = [];
  assert.deepEqual(await a.discover({ show, fetchText }), []);
  assert.ok(asked.includes(real), 'the blocked name is asked again at the next probe');
  blocked = false; clock += 16 * 60 * 1000; asked = [];
  const out = await a.discover({ show, fetchText });
  assert.deepEqual(out.map((c) => c.url), [real]);

  // An always-blocked name stops being carried after the cap, so the rotation still reaches every name.
  const b = d.talkinBroadwayAdapter({ indexUrls: [], now: () => clock });
  const counts = new Map();
  const alwaysBlocked = async (url) => { counts.set(url, (counts.get(url) || 0) + 1); throw Object.assign(new Error('403 still behind the Cloudflare challenge'), { status: 403 }); };
  for (let i = 0; i < 12; i++) { await b.discover({ show, fetchText: alwaysBlocked }); clock += 16 * 60 * 1000; }
  const names = require('../../scripts/lib/tb-direct-url.js').buildTbCandidateUrls(show.title, '2026');
  assert.deepEqual([...counts.keys()].sort(), [...names].sort(), 'every name is still tried');
});

test('Talkin\' Broadway: only a blocked fetch is carried; a 404 or a plain failure is not', () => {
  const blockedErr = (status, message = '') => Object.assign(new Error(message), status ? { status } : {});
  assert.equal(d.tbFetchWasBlocked(blockedErr(403, '403 still behind the Cloudflare challenge: x')), true);
  assert.equal(d.tbFetchWasBlocked(blockedErr(429, 'too many')), true);
  assert.equal(d.tbFetchWasBlocked(blockedErr(503, 'unavailable')), true);
  assert.equal(d.tbFetchWasBlocked(blockedErr(0, 'request timed out after 75000ms')), true);
  assert.equal(d.tbFetchWasBlocked(blockedErr(404, '404 not found: x')), false);
  assert.equal(d.tbFetchWasBlocked(blockedErr(0, '404')), false);
  assert.equal(d.tbFetchWasBlocked(blockedErr(0, 'All scraping methods failed')), false);
});

test('section index: every <article> card on an index page is read, not only the first', async () => {
  const card = (slug, t) => `<article><a href="https://www.theguardian.com/stage/2026/oct/18/${slug}">${t}</a></article>`;
  const html = `<html><body><nav><a href="https://www.theguardian.com/stage/2026/oct/18/nav-other-desert-cities">Other Desert Cities nav</a></nav><main>${card('hamlet-review', 'Hamlet review')}${card('other-desert-cities-review', 'Other Desert Cities review')}</main></body></html>`;
  const { fetchText } = pages({ 'https://www.theguardian.com/stage': html });
  const a = d.sectionIndexAdapter({ outlets: [{ outletId: 'guardian', indexUrl: 'https://www.theguardian.com/stage' }] });
  const out = await a.discover({ show: SHOW, fetchText });
  assert.deepEqual(out.map((c) => c.url), ['https://www.theguardian.com/stage/2026/oct/18/other-desert-cities-review']);
});

test('google news searches press titles too, and a press-title-only headline needs a listing word (BRO-5993)', async () => {
  const show = { id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', akaTitles: ['860'], category: 'broadway' };
  const asked = [];
  const item = (title, src) => `<item><title>${title}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(title)}</link><source url="${src}">x</source></item>`;
  const rss = `<rss><channel>${item('Review: 860, Billy Crystal’s grief-stricken Broadway tribute', 'https://www.theatermania.com')}${item('New Balance 860 v15 review', 'https://www.theatermania.com')}</channel></rss>`;
  const fetchText = async (url) => {
    asked.push(url);
    if (url.startsWith('https://news.google.com/rss/search')) return rss;
    return '<a href="https://www.theatermania.com/news/review-860-billy-crystal_1857726/">x</a>';
  };
  const a = d.googleNewsAdapter();
  await a.discover({ show, fetchText });
  const q = new URL(asked[0]).searchParams.get('q');
  assert.equal(q, '"Billy Crystal 860" OR "860" review');
  const unwrapped = asked.filter((u) => u.startsWith('https://news.google.com/rss/articles/')).map((u) => decodeURIComponent(u.split('/articles/')[1]));
  assert.deepEqual(unwrapped, ['Review: 860, Billy Crystal’s grief-stricken Broadway tribute'], 'the running-shoe headline is never unwrapped');
});

test('google news: the New York Sun is searched by site with no "review" word, and its headline-style review is admitted (2026 shadow replays)', async () => {
  const sunUrl = 'https://www.nysun.com/article/republican-family-fireworks-in-other-desert-cities-set-broadway-alight-again';
  const item = (title, src, id) => `<item><title>${title}</title><link>https://news.google.com/rss/articles/${id}</link><pubDate>Mon, 19 Oct 2026 01:00:00 GMT</pubDate><source url="${src}">x</source></item>`;
  const mainRss = '<rss><channel></channel></rss>';
  const siteRss = `<rss><channel>${item('Republican Family Fireworks in ‘Other Desert Cities’ Set Broadway Alight Again - The New York Sun', 'https://www.nysun.com', 'SUN1')}${item('Other Desert Cities review', 'https://www.theatermania.com', 'TM1')}</channel></rss>`;
  const asked = [];
  const map = {};
  const fetchText = async (url) => {
    asked.push(url);
    if (url.startsWith('https://news.google.com/rss/search')) return /site%3Anysun\.com|site:nysun\.com/.test(url) ? siteRss : mainRss;
    if (map[url]) return map[url];
    throw new Error(`404 ${url}`);
  };
  const decodeImpl = async (link) => (link.endsWith('/SUN1') ? sunUrl : null);
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [d.googleNewsAdapter({ decodeImpl })], fetchText });
  const site = asked.find((u) => /site/.test(decodeURIComponent(u)));
  assert.equal(new URL(site).searchParams.get('q'), '"Other Desert Cities" site:nysun.com', 'no "review" word in the site search');
  assert.deepEqual(r.admitted.map((a) => a.url || a.key).filter((u) => /nysun/.test(u)).length, 1, `admitted ${JSON.stringify(r.admitted.map((a) => a.key))} rejected ${JSON.stringify(r.rejected)}`);
  assert.ok(!r.admitted.some((a) => /theatermania/.test(a.key)), 'a site search keeps only that outlet');

  // West End shows do not run it; a failing site search does not fail the adapter.
  asked.length = 0;
  await d.googleNewsAdapter().discover({ show: { ...SHOW, category: 'west-end' }, fetchText });
  assert.ok(!asked.some((u) => /site/.test(decodeURIComponent(u))));
  const flaky = async (url) => { if (/site/.test(decodeURIComponent(url))) throw new Error('429'); return mainRss; };
  assert.deepEqual(await d.googleNewsAdapter().discover({ show: SHOW, fetchText: flaky }), []);
});

test('DTLI sitemap pages: a title the sitemap has no match for falls back to listed word runs of the title', () => {
  const sitemapSlugs = new Set(['860-2', 'billy-crystal.700-sundays-reviews', 'a-few-good-men', 'the-crucible-2']);
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs }, { title: 'Billy Crystal 860' }),
    ['https://didtheylikeit.com/shows/860-2/'], 'only slugs the sitemap lists, never a guessed bare name');
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs }, { title: 'The Crucible Revisited' }),
    ['https://didtheylikeit.com/shows/the-crucible-2/'], 'a leading run works too, longest first');
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs }, { title: 'The Show' }), [], 'a lone "the" never matches');
  const common = new Set(['night', 'night-2', 'two', 'mother', 'mother-2', 'mother-3', 'mother-play']);
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs: common }, { title: 'A Moulin Rouge Night' }), [], 'a one-word run without a digit is never tried');
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs: common }, { title: 'Mother Play Revisited' }),
    ['https://didtheylikeit.com/shows/mother-play/'], 'a multi-word run is tried; the lone common word is not');
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs: new Set(['860-bway']) }, { title: 'Billy Crystal 860' }),
    ['https://didtheylikeit.com/shows/860-bway/'], 'every DTLI suffix the variant rule knows counts as listed');
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs }, { title: 'Hamlet' }), [], 'a one-word title has no runs');
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs: new Set(['2', '2-3', 'death-of', 'of-a']) }, { title: 'Death of a Act 2' }), [],
    'a lone short digit or a run starting or ending on a filler word is never tried');
  assert.deepEqual(d.dtliSitemapPages(null, { title: 'Billy Crystal 860' }), []);
  assert.deepEqual(d.dtliSitemapPages({ candidates: [], sitemapSlugs }, {}), []);
  assert.deepEqual(d.dtliSitemapPages({ candidates: [{ slug: 'a-few-good-men' }], sitemapSlugs }, { title: 'Billy Crystal 860' }),
    ['https://didtheylikeit.com/shows/a-few-good-men/'], 'a real title match is used as before; the fallback only runs without one');
});

test('hostSignalsReview: a review-only outlet titled with the show alone counts; another host, or no show title, does not (BRO-6872)', () => {
  const SG = 'School Girls; Or, The African Mean Girls Play';
  assert.equal(d.hostSignalsReview('https://theaterpizzazz.com/school-girls-or-the-african-mean-girls-play-delightful/', 'SCHOOL GIRLS; OR, THE AFRICAN MEAN GIRLS PLAY: DELIGHTFUL', SG), true);
  assert.equal(d.hostSignalsReview('https://www.theaterpizzazz.com/finally-waiting-for-lefty-has-arrived/', 'FINALLY: WAITING FOR LEFTY HAS ARRIVED', 'Waiting for Lefty'), true, 'www and an all-caps headline');
  assert.equal(d.hostSignalsReview('https://theaterpizzazz.com/finally-waiting-for-lefty-has-arrived/', 'FINALLY: WAITING FOR LEFTY HAS ARRIVED', 'Other Desert Cities'), false, 'another show');
  assert.equal(d.hostSignalsReview('https://theaterpizzazz.com/finally-waiting-for-lefty-has-arrived/', 'FINALLY: WAITING FOR LEFTY HAS ARRIVED', ''), false, 'no show title');
  assert.equal(d.hostSignalsReview('https://variety.com/2026/legit/waiting-for-lefty-has-arrived/', 'Waiting for Lefty has arrived', 'Waiting for Lefty'), false, 'not a review-only host');
  assert.equal(d.hostSignalsReview('https://thefrontrowcenter.com/2026/11/waiting-for-lefty/', 'Waiting For Lefty', 'Waiting for Lefty'), true);
  assert.equal(d.hasReviewSignal('https://theaterpizzazz.com/finally-waiting-for-lefty-has-arrived/', 'FINALLY: WAITING FOR LEFTY HAS ARRIVED'), false, 'the review-word check alone still refuses it');
});

test('a pass admits a review-only outlet\'s show-titled post with no review word, from any source; news on another host stays out (BRO-6872)', async () => {
  const PZ = 'https://theaterpizzazz.com/other-desert-cities-a-family-at-war/';
  const NEWS = 'https://variety.com/2026/legit/other-desert-cities-a-family-at-war/';
  const item = (t, u) => `<rss><channel><item><title>${t}</title><link>${u}</link><pubDate>Mon, 19 Oct 2026 02:00:00 GMT</pubDate></item></channel></rss>`;
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0,
    adapters: [d.rssAdapter({ feeds: [{ url: 'https://theaterpizzazz.com/feed/', name: 'Theater Pizzazz', outletId: 'theater-pizzazz' }, { url: 'https://variety.com/feed', name: 'Variety', outletId: 'variety' }] })],
    ...pages({ 'https://theaterpizzazz.com/feed/': item('OTHER DESERT CITIES: A FAMILY AT WAR', PZ), 'https://variety.com/feed': item('Other Desert Cities: a family at war', NEWS) }) });
  assert.deepEqual(r.admitted.map((a) => a.key), [d.canonicalUrl(PZ)]);
  assert.equal((r.rejected.find((x) => x.url === d.canonicalUrl(NEWS)) || {}).reason, 'not-review-like');
});

// BRO-6872: Lighting & Sound America serves every story as /news/story.asp?ID=..., so the generic index sweep's links were
// all refused as a /news/ path, and its story pages carry no date extractPublishDate reads. Card shape of the real
// "theatre in review" index (2026-11-04): the date sits in its own table above the headline, inside the card's row.
const LSA_INDEX = 'http://www.lightingandsoundamerica.com/news/result.asp?src=theatre+in+review';
const lsaCard = (id, date, title, venue) => `<tr><td class="relative" colspan="5"><table align="right"><tr><td><p class="newsfillernobottom"><font>(${date})</font></p></td></tr></table>`
  + `<p class="newsfiller"><font><a href="story.asp?ID=${id}"><b>Theatre in Review: <i>${title}</i> (${venue})</b></a></font></p>`
  + `<table><tr><td><a href="story.asp?ID=${id}"><img alt="Theatre in Review: ${title}"></a></td></tr></table><p>Excerpt ...<a href="story.asp?ID=${id}"><img alt="More"></a></p></td></tr>`;
const lsaPage = (cards) => `<html><body><table><tr><td><a href="/MediaKit2026.pdf">Media kit</a></td></tr>${cards.join('')}</table><a href="story.asp?ID=NEWS01">Other Desert Cities star joins tour</a></body></html>`;

test('L&SA: its index review is admitted on time with the card date, despite the /news/story.asp path', async () => {
  const html = lsaPage([lsaCard('-K88YDJ', '11/2/2026', 'Specky Clark', 'Irish Arts Center'), lsaCard('TNQ36D', '10/18/2026', 'Other Desert Cities', 'Hayes Theater')]);
  const fetched = [];
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0,
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'lighting-and-sound-america', indexUrl: LSA_INDEX }] })],
    fetchText: async (u) => { fetched.push(u); if (u === LSA_INDEX) return html; throw new Error(`404 ${u}`); } });
  assert.deepEqual(r.admitted.map((a) => [a.key, a.publishDate, a.outletId]), [['https://lightingandsoundamerica.com/news/story.asp?ID=TNQ36D', '2026-10-18', 'lighting-and-sound-america']]);
  assert.deepEqual(fetched, [LSA_INDEX], 'dated from the index card: no story-page date check');
  assert.equal(r.rejected.length, 0, 'the non-review headline naming the show is never offered');
});

test('L&SA: a review dated weeks before the night is not admitted, and the path pass is for the parser only', async () => {
  const html = lsaPage([lsaCard('OLD123', '9/1/2026', 'Other Desert Cities', 'Hayes Theater')]);
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0,
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'lighting-and-sound-america', indexUrl: LSA_INDEX }] })], fetchText: async () => html });
  assert.equal(r.admitted.length, 0);
  assert.equal(d.nonReviewReason('http://www.lightingandsoundamerica.com/news/story.asp?ID=TNQ36D'), 'non-review-path');
  assert.equal(d.nonReviewReason('http://www.lightingandsoundamerica.com/news/story.asp?ID=TNQ36D', { outletListed: true }), null);
  assert.equal(d.nonReviewReason('https://x.example.com/photos/story', { outletListed: true }), 'non-review-path', 'only the news segment stands down');
});

test('own-host section index and feed finds are vetted to their outlet: TheaterMania and amNY /news/ reviews pass', async () => {
  const TM_INDEX = 'https://www.theatermania.com/news/?categories=reviews';
  const TM = 'https://www.theatermania.com/news/review-other-desert-cities-returns-to-broadway_1830001/';
  const TM_NEWS = 'https://www.theatermania.com/news/other-desert-cities-extends-run_1830002/';
  const AMNY_FEED = 'https://www.amny.com/category/entertainment/theater/feed/';
  const AMNY = 'https://www.amny.com/news/review-other-desert-cities-broadway/';
  const dated = '<html><head><meta property="article:published_time" content="2026-10-18T23:00:00Z"></head><body>x</body></html>';
  const feed = `<?xml version="1.0"?><rss><channel><item><title>Review: Other Desert Cities</title><link>${AMNY}</link><pubDate>Sun, 18 Oct 2026 23:30:00 GMT</pubDate></item></channel></rss>`;
  const pagesMap = { [TM_INDEX]: `<main><a href="${TM}">Review: Other Desert Cities returns</a><a href="${TM_NEWS}">Other Desert Cities extends run</a></main>`, [AMNY_FEED]: feed, [TM]: dated };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0,
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'theatermania', indexUrl: TM_INDEX }] }), d.rssAdapter({ feeds: [{ url: AMNY_FEED, outletId: 'amny', name: 'amNY Theater' }] })],
    fetchText: async (u) => { if (pagesMap[u]) return pagesMap[u]; throw new Error(`404 ${u}`); } });
  assert.deepEqual(r.admitted.map((a) => a.key).sort(), [d.canonicalUrl(AMNY), d.canonicalUrl(TM)].sort());
  assert.equal((r.rejected.find((x) => x.url === d.canonicalUrl(TM_NEWS)) || {}).reason, 'non-review-path', 'a /news/ slug that does not lead with the review stays refused');
});

// Guard (BRO-6872): every lane index and feed outlet must show one real review URL of its (reviews.json, 2026-11-04) passing
// the path gate the way its adapter offers it. A new source without a sample fails here, so a source whose every review the
// gate refuses (TheaterMania 309/309, L&SA 101/101 before this) cannot be added silently again.
const LANE_SOURCE_SAMPLE_REVIEW = {
  theatermania: 'https://www.theatermania.com/news/review-a-dental-lab-technician-wrestles-with-questions-of-career-and-family-in-off-beat-a-good-day-to-me-not-to-you_1721265/',
  nytg: 'https://www.newyorktheatreguide.com/reviews/review-of-a-soldiers-play-starring-david-alan-grier-blair-underwood-on-broadway',
  timeout: 'https://www.timeout.com/newyork/news/broadway-review-aaron-sorkins-a-few-good-men-103026',
  theatrely: 'https://www.theatrely.com/post/a-dolls-house-a-directors-choice-review',
  'lighting-and-sound-america': 'http://www.lightingandsoundamerica.com/news/story.asp?ID=TMZ190',
  'the-100-word-review': 'https://www.the100wordreview.com/billy-crystals-860-at-the-imperial-theatre',
  independent: 'https://www.the-independent.com/arts-entertainment/theatre-dance/reviews/billy-crystal-860-broadway-review-b3070230.html',
  chicagotribune: 'http://www.chicagotribune.com/entertainment/theater/broadway/sc-ent-band-together-broadway-review-0814-story.html',
  guardian: 'https://www.theguardian.com/stage/2026/nov/02/the-lives-of-others-review-keira-knightley-brings-star-power-to-robert-ickes-stasi-drama',
  'one-minute-critic': 'https://1minutecritic.com/anne-washburn-anon-review-mcc-theater/',
  culturesauce: 'https://culturesauce.com/dolls-house-jessica-chastain-jamie-lloyd-broadway-review/',
  thewrap: 'https://www.thewrap.com/act-one-theater-review-tony-shalhoub',
  'pages-on-stages': 'https://pagesonstages.com/2026/10/29/the-imaginary-invalid/',
  'theater-life': 'https://theaterlife.com/a-good-day-to-me-not-to-you-1-2/',
  amny: 'https://www.amny.com/news/review-la-cage-aux-folles-at-encores/',
  'theater-pizzazz': 'https://www.theaterpizzazz.com/noises-off-review/',
  frontmezzjunkies: 'https://frontmezzjunkies.com/2026/03/30/a-story-that-still-demands-to-be-heard-joe-turners-come-and-gone-begins-broadway-previews/',
  'theatre-reviews-limited': 'https://www.theatrereviews.com/broadway-review-1776-at-roundabouts-american-airlines-theatre-through-sunday-january-8-2023/',
  'the-recs': 'https://therecs.co.uk/the-hunger-games-on-stage/',
  stageandcinema: 'https://stageandcinema.com/2026/10/30/all-the-worlds-a-stage-signature-review/',
  'la-voce-di-new-york': 'https://lavocedinewyork.com/en/new-york/2026/10/19/in-other-desert-cities-a-family-grapples-with-speaking-the-unspeakable/',
  'theater-scene': 'https://theaterscene.com/Bandstand-review.html',
  'front-row-center': 'https://thefrontrowcenter.com/2026/10/copperfield-the-new-musical/',
  'the-contending': 'https://thecontending.com/jonathan-spectors-brilliant-new-play-birthright-belongs-on-broadway/',
  'times-square-chronicles': 'https://t2conline.com/the-whoopi-monologues-review-five-extraordinary-women-prove-whoopi-goldbergs-words-are-timeless/',
  'josh-at-the-movies': 'https://joshatthemovies.com/2026/10/31/theater-review-a-ghost-in-your-ear/',
  'new-york-notebook': 'https://newyorknotebook.substack.com/p/oedipus',
  dailybeast: 'https://www.thedailybeast.com/jersey-boys-refuse-to-grow-up-review-of-gettin-the-band-back-together',
  mashable: 'https://mashable.com/article/be-more-chill-review-broadway',
  'the-interested-bystander': 'https://www.interestedbystander.com/2026/07/theater-review-walk-on-moon-is-old.html',
  'jks-theatre-scene': 'https://www.jkstheatrescene.com/2026/10/review-few-good-men.html',
  'bobs-theater-blog': 'https://gotham-playgoer.blogspot.com/2026/10/a-few-good-men.html',
};
test('guard: every lane index and feed outlet has a real review URL the path gate admits as its adapter offers it', () => {
  const ls = require('../../scripts/lib/opening-night-lane/lane-sources.js');
  const ids = new Set([...Object.keys(ls.LANE_SECTION_INDEXES), ...ls.LANE_FEEDS.map((f) => f.outletId)]);
  for (const id of ids) {
    const url = LANE_SOURCE_SAMPLE_REVIEW[id];
    assert.ok(url, `lane source ${id} has no sample review URL: add one from reviews.json and check the gate admits it`);
    const outletListed = Object.prototype.hasOwnProperty.call(d.SECTION_INDEX_PARSERS, id);
    // As the adapters and runDiscoveryPass apply it: vetted only for the source's own outlet (same host as the feed or
    // index page, or a host the registry maps to that outlet) and a host the registry resolves.
    const feed = ls.LANE_FEEDS.find((f) => f.outletId === id);
    const sourceUrl = ls.LANE_SECTION_INDEXES[id] || (feed && feed.url);
    const own = new URL(url).hostname.replace(/^www\./, '') === new URL(sourceUrl).hostname.replace(/^www\./, '') || (resolveOutletFromUrl(url) || {}).outletId === id;
    const vettedOutlet = own && !!resolveOutletFromUrl(url);
    assert.equal(d.nonReviewReason(url, { vettedOutlet, outletListed }), null, `${id}: ${url} (vetted ${vettedOutlet})`);
  }
});

test('a Google News sighting of an L&SA story first keeps the parser\'s listing claim, and a stale path memo is re-judged', async () => {
  const STORY = 'http://www.lightingandsoundamerica.com/news/story.asp?ID=TNQ36D';
  const html = lsaPage([lsaCard('TNQ36D', '10/18/2026', 'Other Desert Cities', 'Hayes Theater')]);
  const gn = { name: 'google-news', kind: 'outlet-index', phase: 'cheap', discover: async () => [{ url: STORY, title: 'Theatre in Review: Other Desert Cities', source: 'outlet-index', publishDate: null, needsDate: true, vettedOutlet: true }] };
  const lsa = d.sectionIndexAdapter({ outlets: [{ outletId: 'lighting-and-sound-america', indexUrl: LSA_INDEX }] });
  const fetchText = async (u) => { if (u === LSA_INDEX) return html; throw new Error(`404 ${u}`); };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [gn, lsa], fetchText });
  assert.deepEqual(r.admitted.map((a) => [a.key, a.publishDate]), [['https://lightingandsoundamerica.com/news/story.asp?ID=TNQ36D', '2026-10-18']]);
  const memo = { rejected: { 'https://lightingandsoundamerica.com/news/story.asp?ID=TNQ36D': { reason: 'non-review-path', attempts: 1 } } };
  const again = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [lsa], fetchText, memo });
  assert.equal(again.admitted.length, 1, 'a rejection written before the parser existed does not stand for the night');
});

test('vetted /news/ slugs that recap or round up are still refused', () => {
  for (const u of ['https://www.theatermania.com/news/review-the-year-in-theater-2026_1/', 'https://www.theatermania.com/news/review-of-the-week-broadway-openings_2/', 'https://www.amny.com/news/review-recap-podcast/']) {
    assert.equal(d.nonReviewReason(u, { vettedOutlet: true }), 'non-review-path', u);
  }
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/review-other-desert-cities_3/', { vettedOutlet: true }), null);
});

test('a feed item on a sister host the registry maps to the feed\'s outlet is that outlet\'s own item', async () => {
  const FEED = 'https://culturesauce.net/feed';
  const ITEM = 'https://culturesauce.com/other-desert-cities-broadway-review/';
  const xml = `<?xml version="1.0"?><rss><channel><item><title>Other Desert Cities</title><link>${ITEM}</link><pubDate>Sun, 18 Oct 2026 23:30:00 GMT</pubDate></item></channel></rss>`;
  const out = await d.rssAdapter({ feeds: [{ url: FEED, outletId: 'culturesauce', name: 'Culture Sauce' }] }).discover({ show: SHOW, fetchText: async () => xml });
  assert.equal(out[0].outletId, 'culturesauce');
  assert.equal(out[0].vettedOutlet, true);
});

test("Bob's Theater Blog: a post headed with the show title alone is a review; a show-named bulletin is not", async () => {
  const FEED = 'https://gotham-playgoer.blogspot.com/feeds/posts/default?alt=rss';
  const REVIEW = 'https://gotham-playgoer.blogspot.com/2026/10/other-desert-cities.html';
  const BULLETIN = 'https://gotham-playgoer.blogspot.com/2026/10/theater-bulletin-other-desert-cities-extends.html';
  const it = (title, link) => `<item><title>${title}</title><link>${link}</link><pubDate>Sun, 18 Oct 2026 23:30:00 GMT</pubDate></item>`;
  const xml = `<?xml version="1.0"?><rss><channel>${it('Other Desert Cities', REVIEW)}${it('Theater Bulletin: &quot;Other Desert Cities&quot; Extends', BULLETIN)}</channel></rss>`;
  const ls = require('../../scripts/lib/opening-night-lane/lane-sources.js');
  const feed = ls.laneFeeds({ title: 'Other Desert Cities', category: 'broadway' }).find((f) => f.outletId === 'bobs-theater-blog');
  assert.ok(feed && feed.titledReviews, 'the lane reads the feed with the show-title rule');
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, adapters: [d.rssAdapter({ feeds: [feed] })], fetchText: async () => xml });
  assert.deepEqual(r.admitted.map((a) => a.key), [d.canonicalUrl(REVIEW)]);
  assert.ok(r.rejected.some((x) => x.url === d.canonicalUrl(BULLETIN)), 'the bulletin is refused');
  assert.equal(FEED, feed.url);
});

test('BRO-6872: Google News items dated outside the night window are never decoded, so they cannot use up the budget', async () => {
  const OLD = 'https://news.google.com/rss/articles/CBMiOLD?oc=5';
  const UNDATED = 'https://news.google.com/rss/articles/CBMiUNDATED?oc=5';
  const item = (link, date, title) => `<item><title>${title} - The New York Times</title><link>${link}</link>${date ? `<pubDate>${date}</pubDate>` : ''}<source url="https://www.nytimes.com">The New York Times</source></item>`;
  // The 2011 production's review comes first in Google's order, as the 2017 Variety review did for School Girls.
  const feed = `<rss><channel>${item(OLD, 'Tue, 11 Jan 2011 03:00:00 GMT', 'Other Desert Cities review: 2011')}${item(GN_LINK, 'Mon, 19 Oct 2026 03:00:00 GMT', 'Other Desert Cities review: a family at war')}${item(UNDATED, null, 'Other Desert Cities review: undated')}</channel></rss>`;
  const decoded = [];
  const decodeImpl = async (link) => { decoded.push(link); return link === GN_LINK ? NYT_RAW : null; };
  const track = pages({ [GN_FEED_URL]: feed });
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, ...track,
    adapters: [d.googleNewsAdapter({ decodeImpl, maxDecode: 1, maxUnwrap: 0 })] });
  assert.deepEqual(r.admitted.map((a) => a.key), [NYT]);
  assert.deepEqual(decoded, [GN_LINK], 'the 2011 item is skipped and the one decode goes to the night\'s review');
  // No night (direct adapter use): nothing is skipped; an undated item is never skipped.
  const all = [];
  await d.googleNewsAdapter({ decodeImpl: async (l) => { all.push(l); return null; }, maxUnwrap: 0, maxDecode: 5 }).discover({ show: SHOW, fetchText: track.fetchText });
  assert.deepEqual(all.sort(), [GN_LINK, OLD, UNDATED].sort());
  const dated = [];
  await d.googleNewsAdapter({ decodeImpl: async (l) => { dated.push(l); return null; }, maxUnwrap: 0, maxDecode: 5 }).discover({ show: SHOW, night: NIGHT, fetchText: track.fetchText });
  assert.deepEqual(dated.sort(), [GN_LINK, UNDATED].sort());
});

test('BRO-6872: an old Google date no longer claims a URL, so a feed sighting of the same review in the window is admitted', async () => {
  const gn = `<rss><channel><item><title>Other Desert Cities review - The New York Times</title><link>${GN_LINK}</link><pubDate>Tue, 11 Jan 2011 03:00:00 GMT</pubDate><source url="https://www.nytimes.com">The New York Times</source></item></channel></rss>`;
  const feed = `<rss><channel><item><title>Review: Other Desert Cities</title><link>${NYT_RAW}</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item></channel></rss>`;
  const FEED = 'https://rss.nytimes.com/services/xml/rss/nyt/Theater.xml';
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, ...pages({ [GN_FEED_URL]: gn, [FEED]: feed }),
    adapters: [d.googleNewsAdapter({ decodeImpl: async () => NYT_RAW, maxUnwrap: 0, maxDecode: 5 }), d.rssAdapter({ feeds: [{ url: FEED, outletId: 'nytimes', name: 'NYT' }] })] });
  assert.deepEqual(r.admitted.map((a) => a.key), [NYT], JSON.stringify(r.rejected));
});
