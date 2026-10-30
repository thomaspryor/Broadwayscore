// BRO-6066: replay of the 2026-10-22 shadow night for The Imaginary Invalid (run 39873028216). The lane found 11 of the
// 19 reviews the regular pipeline published. These pages are rebuilt from that night's inputs: the same URLs, the same
// page shapes that broke discovery (Playbill's sidebar <article> cards ahead of the roundup body, `/news/` review slugs,
// a Talkin' Broadway review filed under a named page no index lists, a Google News wrapper that only redirects in a
// browser, slow Talkin' Broadway indexes). Links and structure only; no article text is copied.
// BRO-5201: the night runs through the production wiring (driver.wireLaneNight: laneAdapters, inline scoring, the real
// publish path, the review-file writer) against an empty review-texts dir, over several virtual passes. Only the page
// fetch, the scorer and the push are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const driver = require('../../scripts/lib/opening-night-lane/driver.js');
const shadow = require('../../scripts/lib/opening-night-lane-shadow.js');
const grade = require('../../scripts/lib/lane-replay-grade.js');
const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization.js');

const SHOW = { id: 'the-imaginary-invalid-2026', title: 'The Imaginary Invalid', openingDate: '2026-10-22', category: 'broadway' };
const NIGHT = '2026-10-22';
const T0 = Date.parse('2026-10-22T23:00:00Z'); // shadow start, 7pm ET
const MIN = 60000;
const grade_EMBARGO = '2026-10-23T02:00:00Z'; // Broadway default embargo, 10pm ET on opening night

// The 19 reviews on the live site after the night (shadow-report.json). singleticket was published 2026-10-05, before
// opening, so no opening-night source cites it; the bar is the other 18.
const EXPECTED = {
  nysrHacks: 'https://nystagereview.com/2026/10/22/the-imaginary-invalid-hacks-and-quacks/',
  nysrDoctor: 'https://nystagereview.com/2026/10/22/the-imaginary-invalid-just-what-the-doctor-ordered/',
  nytg: 'https://www.newyorktheatreguide.com/reviews/the-imaginary-invalid-broadway-review-bill-irwin-rachel-bloom',
  culturesauce: 'https://culturesauce.com/imaginary-invalid-moliere-broadway-review/',
  nytimes: 'https://www.nytimes.com/2026/10/22/theater/imaginary-invalid-review-bill-irwin-moliere.html',
  nypost: 'https://nypost.com/2026/10/22/entertainment/the-imaginary-invalid-review-unfunny-moliere-revival-on-broadway-makes-you-scream-sacre-bleu/',
  thewrap: 'https://www.thewrap.com/creative-content/theater/the-imaginary-invalid-broadway-review-bill-irwin/',
  nydailynews: 'https://www.nydailynews.com/2026/10/22/broadway-review-imaginary-invalid-a-gross-but-fun-moliere-adaptation/',
  theatrely: 'https://www.theatrely.com/post/the-imaginary-invalid-with-a-starry-cast-hits-broadway-review',
  oneMinute: 'https://1minutecritic.com/imaginary-invalid-bill-irwin-broadway-review/',
  nytheater: 'https://newyorktheater.me/2026/10/22/the-imaginary-invalid-review/',
  deadline: 'https://deadline.com/2026/10/the-imaginary-invalid-broadway-review-bill-irwin-1237169589/',
  wsj: 'https://www.wsj.com/articles/the-imaginary-invalid-review-bill-irwins-hilarious-hypochondriac-ff88aa6b',
  // The seven the lane missed:
  timeout: 'https://www.timeout.com/newyork/news/broadway-review-the-imaginary-invalid-gasps-for-moliere-102326',
  theatermania: 'https://www.theatermania.com/news/review-revival-of-the-imaginary-invalid-is-terminally-short-on-laughs_1857994/',
  tribune: 'https://www.chicagotribune.com/2026/10/22/review-imaginary-invalid-broadway/',
  vulture: 'https://www.vulture.com/article/broadway-review-bill-irwin-rachel-bloom-the-imaginary-invalid.html',
  talkinbroadway: 'https://www.talkinbroadway.com/page/world/TheImaginaryInvalid.html',
  singleticket: 'https://singleticket.substack.com/p/theater-review-the-imaginary-invalid',
};
const E = EXPECTED;
const a = (href, text) => `<a href="${href}">${text}</a>`;

const BWW_RR = 'https://www.broadwayworld.com/article/Review-Roundup-THE-IMAGINARY-INVALID-Opens-on-Broadway-20261022';
const DTLI_PAGE = 'https://didtheylikeit.com/shows/the-imaginary-invalid/';
const PV_ART = 'https://playbill.com/article/reviews-what-do-the-critics-think-of-the-imaginary-invalid-broadway-revival';
const GN = (n) => `https://news.google.com/rss/articles/CBMi-imaginary-${n}?oc=5`;

const pages = {
  'https://www.broadwayworld.com/': `<html><body>${a(BWW_RR, 'Review Roundup: THE IMAGINARY INVALID Opens on Broadway')}</body></html>`,
  [BWW_RR]: `<html><body><nav>${a('https://www.broadwayworld.com/shows/', 'Shows')}</nav><article>
    ${a(E.oneMinute, '1 Minute Critic')} ${a(E.wsj, 'Charles Isherwood, The Wall Street Journal')} ${a(E.nytheater, 'New York Theater')}
  </article><footer>${a('https://www.broadwayworld.com/about', 'about')}</footer></body></html>`,
  'https://didtheylikeit.com/': `<html><body>${a(DTLI_PAGE, 'The Imaginary Invalid')}${a('https://didtheylikeit.com/shows/another-show/', 'Another Show')}</body></html>`,
  [DTLI_PAGE]: `<html><body><header>${a('https://roundabouttheatre.org/production/2026-2027-season/the-imaginary-invalid', 'Tickets')}</header><article>
    ${[E.nytimes, E.theatrely, E.theatermania, E.deadline, E.timeout, E.nypost, E.thewrap, E.nysrHacks, E.nysrDoctor, E.nydailynews, E.nytg, E.culturesauce]
    .map((u) => a(u, 'Read the review')).join('\n')}
  </article></body></html>`,
  'https://playbill.com/category/the-verdict': `<html><body><main>
    <a href="${PV_ART}">Reviews: What Do the Critics Think of The Imaginary Invalid Broadway Revival?</a>
  </main></body></html>`,
  // Playbill puts ten sidebar <article> cards in the page; the roundup body is main .prose, which holds none.
  [PV_ART]: `<html><head><meta property="article:published_time" content="2026-10-23T02:01:00Z"></head><body>
    ${Array.from({ length: 3 }, (_, i) => `<article class="card">${a(`https://playbill.com/article/related-story-${i}`, `Related story ${i}`)}</article>`).join('')}
    <main><h1>Reviews: What Do the Critics Think of The Imaginary Invalid Broadway Revival?</h1><div class="prose">
      ${[E.oneMinute, 'https://cititour.com/NYC_Broadway/The-Imaginary-Invalid/1404', E.culturesauce, E.tribune, E.nytimes, E.nytg, E.nysrHacks, E.nysrDoctor,
    E.nytheater, E.nypost, E.theatermania, E.timeout, E.wsj].map((u) => `<p>${a(u, 'Read the full review')}</p>`).join('\n')}
    </div></main>
    <article class="card">${a('https://playbill.com/article/another-roundup', 'Another roundup')}</article></body></html>`,
  // TB's indexes do not list the review; it is filed as a named page.
  'https://www.talkinbroadway.com/page/ob/index.html': `<html><body>${a('https://www.talkinbroadway.com/page/ob/10_20_26.html', 'Some Other Play')}</body></html>`,
  [E.talkinbroadway]: `<html><head><title>Talkin' Broadway Review: The Imaginary Invalid</title></head><body>
    <nav>${['Broadway', 'Off-Broadway', 'Regional', 'World', 'Columns', 'Archives'].map((x) => a(`https://www.talkinbroadway.com/page/${x.toLowerCase()}/`, x)).join(' | ')}</nav>
    <h1>The Imaginary Invalid</h1><p>Theatre Review by <A HREF='mailto:critic@talkinbroadway.com'>A Critic</A> - October 22, 2026</p>
    <p>The Imaginary Invalid by Moliere. Adapted by Bill Irwin. Directed by Brandon Dirden. Studio 54.</p>
    <p>(Real pages run over 3 KB; verifyTbPage treats anything under 800 bytes as a 404 page. Its byline check reads plain
    "by First Last" text, which the credits line carries; the critic's name sits inside a mailto link.)</p></body></html>`,
};
// Google News: smaller outlets first in feed order, Vulture last. Eight unwraps per pass would never reach it unsorted.
const gnItems = [
  ['nysr', 'https://nystagereview.com', E.nysrHacks], ['nysr', 'https://nystagereview.com', E.nysrDoctor],
  ['nytg', 'https://www.newyorktheatreguide.com', E.nytg], ['culturesauce', 'https://culturesauce.com', E.culturesauce],
  ['stagebuddy', 'https://stagebuddy.com', 'https://stagebuddy.com/theater/theater-review/the-imaginary-invalid-broadway'],
  ['theater-pizzazz', 'https://theaterpizzazz.com', 'https://theaterpizzazz.com/the-imaginary-invalid-broadway-review/'],
  ['theatrely', 'https://www.theatrely.com', E.theatrely], ['one-minute-critic', 'https://1minutecritic.com', E.oneMinute],
  ['nyt-theater', 'https://newyorktheater.me', E.nytheater],
  ['vulture', 'https://www.vulture.com', E.vulture],
];
pages['https://news.google.com/rss/search?' + new URLSearchParams({ q: `"${SHOW.title}" review`, hl: 'en-US', gl: 'US', ceid: 'US:en' })] = `<rss><channel>${gnItems
  .map(([, src], i) => `<item><title>Review: The Imaginary Invalid - ${src}</title><link>${GN(i)}</link><pubDate>Fri, 23 Oct 2026 0${i % 4}:00:00 GMT</pubDate><source url="${src}">x</source></item>`)
  .join('')}</channel></rss>`;
// Opening a wrapper in a browser lands on the publisher; the page it returns is a consent wall with no link to it.
const wrapperTarget = new Map(gnItems.map(([, , u], i) => [GN(i), u]));
const consentWall = '<html><body><form action="https://consent.google.com/save">Before you continue</form></body></html>';

// Every review page the night's sources cite; the lane fetches each once it is admitted. Body text is filler.
const REVIEW_PAGES = new Set([...Object.values(EXPECTED), ...gnItems.map(([, , u]) => u), 'https://cititour.com/NYC_Broadway/The-Imaginary-Invalid/1404']
  .map((u) => d.canonicalUrl(u)));
const FULL = 'The revival leans on its physical comedy and the second act drags under the weight of the doctors. '.repeat(30);

/** The night's pages as the lane's fetchPage sees them. `calls` records discovery reads only (review fetches pass no opts marker). */
function replayFetch({ slowTbIndexMs = 0 } = {}) {
  const calls = [];
  const reviewFetches = [];
  const fetchPage = async (url) => {
    if (wrapperTarget.has(url)) { calls.push(url); return { content: consentWall, finalUrl: wrapperTarget.get(url) }; }
    if (/talkinbroadway\.com\/page\/(ob|bwaybway)\/index\.html$/.test(url) && slowTbIndexMs) await new Promise((r) => setTimeout(r, slowTbIndexMs));
    if (url in pages) { calls.push(url); return { content: pages[url] }; }
    if (REVIEW_PAGES.has(d.canonicalUrl(url))) { reviewFetches.push(url); return { content: FULL }; }
    calls.push(url);
    throw new Error(`404 ${url}`);
  };
  return { fetchPage, calls, reviewFetches };
}

/** Publish ports that keep nothing: the merge runs, the push and the deploy do not, and the lease is held. */
const replayPublishPorts = (now) => ({
  ...shadow.createShadowPublishPorts({ onRows: () => {}, now }), pushData: async () => ({ pushed: false }), isLeased: async () => true,
});

async function replayNight({ passes = 4, everyMin = 2, fetchOpts, site: useSite = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-ii-'));
  let clock = T0;
  const now = () => clock;
  const { fetchPage, calls, reviewFetches } = replayFetch(fetchOpts);
  const reviewTextsDir = path.join(dir, 'review-texts');
  fs.mkdirSync(reviewTextsDir);
  // With `site`, a modelled live site stands behind the publish ports so the night can be graded like a real one.
  const site = useSite ? grade.createReplaySitePorts({ now }) : null;
  const ledgerDir = path.join(dir, 'ledger');
  try {
    const runNight = driver.wireLaneNight({
      show: SHOW, night: NIGHT, openingDate: NIGHT, timeZone: 'America/New_York', ledgerDir,
      // No outlet feeds this night (the shadow ran with none) and no Browserbase: Talkin' Broadway answered directly.
      adaptersConfig: { feeds: [] },
      laneFetch: { fetchPage, close: async () => {} },
      fetchPorts: {
        extractArticle: (html) => html,
        // A distinct critic per page, so no row reads as another's syndicated copy.
        extractMeta: (_html, url) => ({ criticName: `Critic ${d.canonicalUrl(url).length}`, publishDate: NIGHT }),
      },
      scoreText: async (text) => ({ score: text ? 60 : 45, extra: {} }),
      publishPorts: site || replayPublishPorts(now), now, wait: async (ms) => { clock += ms; },
      reviewTextsDir, onDiskUrls: [], onDiskRows: [], showScoreGuards: { urlMap: {}, allShows: [SHOW] }, search: async () => [], decodeImpl: null,
      tuning: { maxPasses: passes, passIntervalMs: everyMin * MIN, startedAt: T0 },
    });
    const res = await runNight();
    // Discovered = scored, plus anything the runner set aside (a syndicated copy) or gave up on.
    const keys = new Set([...res.admitted.map((x) => x.key), ...res.skipped.map((x) => x.key), ...res.failed.map((x) => x.key)]);
    let graded = null;
    if (site) {
      // Graded at +4h after the embargo (the gate needs a capture at least 3h30m after it), from the files on disk now.
      const closedAt = Date.parse(grade_EMBARGO) + 4 * 60 * MIN;
      // The census is what the night's aggregators listed: every expected review but the pre-opening Substack post.
      const censusOutletIds = Object.entries(EXPECTED).filter(([k]) => k !== 'singleticket').map(([, u]) => resolveOutletFromUrl(u)?.outletId).filter(Boolean);
      const rec = grade.replayToPressNightRecord({ show: SHOW, night: NIGHT, live: site.live(), ledgerDir, reviewTextsDir, censusOutletIds, startedAt: T0, closedAt: Math.max(closedAt, clock) });
      graded = grade.gradeReplay(rec, res);
    }
    return { ...res, keys, calls, reviewFetches, graded, live: site ? site.live() : [], reviewFiles: fs.readdirSync(reviewTextsDir) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('replay of 2026-10-22: the lane discovers at least 18 of the 19 published reviews', async () => {
  const r = await replayNight();
  const { keys, errors } = r;
  const found = Object.entries(EXPECTED).filter(([, u]) => keys.has(d.canonicalUrl(u))).map(([k]) => k);
  const missed = Object.keys(EXPECTED).filter((k) => !found.includes(k));
  assert.ok(found.length >= 18, `found ${found.length}/19; missed ${missed.join(', ')}; errors ${JSON.stringify(errors)}`);
  assert.deepEqual(missed, ['singleticket'], 'only the pre-opening Substack post is out of reach');
  // The production path ran (not a dry run): every review was scored, published and written into the empty review-texts dir.
  assert.deepEqual(r.failed, [], 'nothing failed for good');
  assert.ok(r.published.length > 0, 'at least one publish batch'); assert.deepEqual(r.unpublished, [], 'nothing scored was left unpublished');
  assert.ok(r.reviewFiles.length > 0, 'the lane wrote its review files');
});

test('replay: each of the seven outlets the shadow missed comes from the source that fixes it', async () => {
  const { admitted } = await replayNight();
  const by = (u) => admitted.filter((x) => x.key === d.canonicalUrl(u)).map((x) => x.adapter || x.via);
  const via = (u) => admitted.find((x) => x.key === d.canonicalUrl(u)) || {};
  assert.equal(via(E.tribune).via, PV_ART, 'Chicago Tribune is cited only by the Playbill roundup body');
  assert.ok([DTLI_PAGE, PV_ART].includes(via(E.theatermania).via), 'TheaterMania /news/review- link admitted from an aggregator');
  assert.ok([DTLI_PAGE, PV_ART].includes(via(E.timeout).via), 'Time Out /news/broadway-review- link admitted from an aggregator');
  assert.equal(via(E.vulture).via, 'google-news', 'Vulture comes only from Google News, through the browser landing URL');
  assert.equal(via(E.talkinbroadway).via, 'talkin-broadway-named-page');
  assert.ok(by(E.deadline).length && by(E.wsj).length);
});

test('replay: the Playbill roundup sidebar cards are never admitted as reviews', async () => {
  const { keys } = await replayNight({ passes: 1 });
  assert.ok(![...keys].some((k) => k.includes('playbill.com')), [...keys].join('\n'));
});

test('replay: Vulture is unwrapped in the first pass although eight smaller outlets precede it in the feed', async () => {
  const { keys, calls } = await replayNight({ passes: 1 });
  assert.ok(keys.has(d.canonicalUrl(E.vulture)));
  assert.equal(calls.filter((u) => u.startsWith('https://news.google.com/rss/articles/')).length, 8, 'the unwrap cap still holds');
});

test('replay: slow Talkin\' Broadway indexes do not cost the named-page review, and the probe is throttled', async () => {
  const { keys, calls } = await replayNight({ passes: 4, everyMin: 2, fetchOpts: { slowTbIndexMs: 30 } });
  assert.ok(keys.has(d.canonicalUrl(E.talkinbroadway)));
  // Found in the first pass and cached, so the four candidate names are probed once, not once per pass: two misses, then
  // the hit (3 reads), plus the one read the lane makes to score the review.
  assert.equal(calls.filter((u) => u.includes('/page/world/TheImaginaryInvalid')).length, 4, 'two misses, the hit, the scoring fetch; never again');
});

test('replay graded like a press night: same-night completeness PASS (S4-T6)', async () => {
  const r = await replayNight({ site: true });
  assert.ok(r.live.length >= 18, `live rows ${r.live.length}`);
  const g = r.graded;
  assert.equal(g.sameNight.status, 'pass', `same-night: ${g.sameNight.detail}; gates ${JSON.stringify(g.gates.map((x) => [x.name, x.status, x.detail]))}`);
  assert.deepEqual(g.runProblems, []);
});
