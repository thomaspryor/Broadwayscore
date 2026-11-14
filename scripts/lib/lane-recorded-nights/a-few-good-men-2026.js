'use strict';
// BRO-6066 (cutover card 5b): replay of the 2026-10-29 shadow night for A Few Good Men (run 40986210601). The lane scored
// 18 of the 22 reviews the site published. These pages are rebuilt from that night's inputs: the same URLs and the page
// shapes that cost the four (BWW's roundup body behind ticket-deal and podcast <article> cards, Playbill's bare link list
// with no excerpts, WSJ's paywall teaser judged not_a_review, The Independent's /features/ review path, New York Theater
// reachable only through its own feed or the BWW roundup, every Talkin' Broadway index failing). Links and structure
// only; the quotes are placeholders, no article text is copied. BRO-6073 adds the lane's Browserbase route: Talkin'
// Broadway answers only through it (as from CI, where Bright Data and ScrapingBee meet its Cloudflare challenge).
// The real runLaneNight, discovery adapters and inline scoring run; the network and the models are injected. BRO-5201: the
// replay goes through driver.wireLaneNight, the production wiring (adapters from laneAdapters, one routed fetchPage for
// discovery and review fetch, a real publish with no-op push), against an empty review-texts dir.
// Moved out of tests/unit/opening-night-lane-replay-a-few-good-men.test.mjs so the recorded rehearsal
// (scripts/opening-night-lane-rehearse.js --fixture recorded) replays the same night the tests pin (BRO-5201 S4-T3).
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../opening-night-lane/discovery.js');
const inline = require('../opening-night-lane/inline-score.js');
const driver = require('../opening-night-lane/driver.js');
const shadow = require('../opening-night-lane-shadow.js');
const bb = require('../opening-night-lane/browserbase-fetch.js');
const { ALL_FEEDS } = require('../rss-discovery.js');
const grade = require('../lane-replay-grade.js');
const { resolveOutletFromUrl } = require('../review-normalization.js');

const SHOW = { id: 'a-few-good-men-2026', title: 'A Few Good Men', openingDate: '2026-10-29', category: 'broadway' };
const NIGHT = '2026-10-29';
const T0 = Date.parse('2026-10-30T03:00:00Z'); // the first reviews were cited from 03:02Z
const MIN = 60000;
const EMBARGO = '2026-10-30T02:00:00Z'; // Broadway default embargo, 10pm ET on opening night

// The 22 reviews on the live site after the night (shadow-report.json), with the critic each file carries.
const SITE = {
  oneMinute: ['https://1minutecritic.com/a-few-good-men-broadway-revival-review/', 'Matthew Wexler'],
  cititour: ['https://cititour.com/NYC_Broadway/A-Few-Good-Men/1406', 'Brian Scott Lipton'],
  culturesauce: ['https://culturesauce.com/a-few-good-men-2026-bradley-whitford-broadway-review/', 'Thom Geier'],
  timeout: ['https://www.timeout.com/newyork/news/broadway-review-aaron-sorkins-a-few-good-men-103026', 'Adam Feldman'],
  tribune: ['https://www.chicagotribune.com/2026/10/29/review-few-good-men-broadway/', 'Chris Jones'],
  guardian: ['https://www.theguardian.com/stage/2026/oct/30/few-good-men-aaron-sorkin-review', 'Richard Lawson'],
  theatrely: ['https://www.theatrely.com/post/a-few-good-men-brings-sorkin-back-to-broadway-review', 'Joey Sims'],
  deadline: ['https://deadline.com/2026/10/a-few-good-men-broadway-review-1237206959/', 'Greg Evans'],
  ew: ['https://ew.com/a-few-good-men-broadway-review-tom-blyth-turns-up-charisma-tom-cruise-role-12197325', 'Shelby Stivale'],
  nytimes: ['https://www.nytimes.com/2026/10/29/theater/few-good-men-review-whitford-blyth-sorkin.html', 'Alexis Soloski'],
  nytg: ['https://www.newyorktheatreguide.com/reviews/a-few-good-men-broadway-review-tom-blyth-bradley-whitford', 'Amelia Merrill'],
  theatermania: ['https://www.theatermania.com/news/review-a-few-good-men-introduces-us-to-aaron-sorkin-before-he-was-a-brand_1858458/', 'David Gordon'],
  thewrap: ['https://www.thewrap.com/creative-content/theater/a-few-good-men-broadway-review-aaron-sorkin/', 'Robert Hofler'],
  usatoday: ['https://www.usatoday.com/story/entertainment/movies/2026/10/29/a-few-good-men-broadway-tom-blyth-review/92444731007/', 'Patrick Ryan'],
  nysrBernardo: ['https://nystagereview.com/2026/10/29/a-few-good-men-built-to-last/', 'Melissa Rose Bernardo'],
  nysrScheck: ['https://nystagereview.com/2026/10/29/a-few-good-men-could-use-more-ooh-rah/', 'Frank Scheck'],
  nypost: ['https://nypost.com/2026/10/29/entertainment/a-few-good-men-review-aaron-sorkins-mediocre-courtroom-drama-is-back-on-broadway/', 'Johnny Oleksinski'],
  vulture: ['https://www.vulture.com/article/review-few-good-men-broadway-revival-sorkin-whitford.html', 'Sara Holdren'],
  // The four the lane missed on the night:
  wsj: ['https://www.wsj.com/articles/a-few-good-men-review-aaron-sorkins-marines-come-back-to-broadway-b2a4cbca', 'Charles Isherwood'],
  independent: ['https://www.the-independent.com/arts-entertainment/theatre-dance/features/a-few-good-men-broadway-review-bradley-whitford-tom-blyth-b3075938.html', 'Caitlin Hornik'],
  nytheater: ['https://newyorktheater.me/2026/10/29/a-few-good-men-broadway-review/', 'Jonathan Mandell'],
  talkinbroadway: ['https://www.talkinbroadway.com/page/world/AFewGoodMen.html', 'Howard Miller'], // only through Browserbase (BRO-6073)
};
const U = Object.fromEntries(Object.entries(SITE).map(([k, [u]]) => [k, u]));
const CRITIC = new Map(Object.values(SITE).map(([u, c]) => [d.canonicalUrl(u), c]));
const a = (href, text) => `<a href="${href}" target="_blank">${text}</a>`;

// Playbill: a bare list, "<p><u><a>Outlet (Critic)</a></u></p>", no quotes, inside main .prose, sidebar <article> cards around it.
// It cites 20: not New York Theater, not Talkin' Broadway.
const PV_ART = 'https://playbill.com/article/reviews-what-do-the-critics-think-of-the-broadway-revival-of-a-few-good-men';
const PLAYBILL_CITES = ['oneMinute', 'cititour', 'culturesauce', 'tribune', 'deadline', 'ew', 'guardian', 'independent', 'nytimes', 'nytg',
  'nysrBernardo', 'nysrScheck', 'nypost', 'theatermania', 'timeout', 'theatrely', 'wsj', 'thewrap', 'usatoday', 'vulture'];
const playbillPage = `<html><head><meta property="article:published_time" content="2026-10-30T03:00:00Z"></head><body>
  <article class="card">${a('https://playbill.com/article/related-story', 'Related story')}</article>
  <main><h1>Reviews: What Do the Critics Think of the Broadway Revival of A Few Good Men?</h1><div class="prose">
  ${PLAYBILL_CITES.map((k) => `<p><u>${a(U[k], `Outlet (${SITE[k][1]})`)}</u></p>`).join('\n')}
  </div></main></body></html>`;

// BWW: the roundup body is <div class="disnep-area"> inside <main>; the page's only <article> elements are a ticket-deal card
// and a podcast card, so "the first <article>" read one podcast link (it is in the night's rejection memo). Each critic's
// entry is "<p>Critic, <a>Outlet:</a> quote</p>". It cites 20: New York Theater, not Talkin' Broadway or Cititour.
const BWW_RR = 'https://www.broadwayworld.com/article/Review-Roundup-A-FEW-GOOD-MEN-Opens-On-Broadway-with-Tom-Blyth-Bradley-Whitford-and-More-20261029';
const PODCAST = 'https://broadwaypodcastnetwork.com/podcasts/finding-fire-island/5-pantry-girls-firefighters/17';
const BWW_CITES = ['nytimes', 'wsj', 'vulture', 'guardian', 'culturesauce', 'timeout', 'oneMinute', 'thewrap', 'usatoday', 'ew', 'independent',
  'theatermania', 'theatrely', 'nytg', 'deadline', 'nysrBernardo', 'nysrScheck', 'tribune', 'nypost', 'nytheater'];
const quote = (k) => `placeholder quote standing in for the critic's own sentence about the revival, entry ${k}.`;
const bwwPage = `<html><body>
  <aside><article class="bww-tm-deal-card">${a('https://www.broadwayworld.com/shows/deals', 'Deals')}</article></aside>
  <article class="bpn-episode-list__featured">${a(PODCAST, '5. Pantry Girls &amp; Firefighters')}</article>
  <main class="inner-page"><div class="container"><div class="row"><div class="col-lg-7"><div class="nobreak"><div class="disnep-area">
  ${BWW_CITES.map((k) => `<p><img src="https://cloudimages.broadwayworld.com/x.png">${SITE[k][1]}, ${a(U[k], 'Outlet:')} ${quote(k)}</p>`).join('\n')}
  </div></div></div></div></div></main></body></html>`;

const NYT_FEED = 'https://www.newyorktheater.me/feed/';
const nyTheaterFeed = `<rss><channel><item><title>A Few Good Men Broadway Review: Sorkin's courtroom drama returns</title>
  <link>${U.nytheater}</link><pubDate>Thu, 29 Oct 2026 23:40:00 -0400</pubDate></item></channel></rss>`;

/** The night's network, per pass: BWW's homepage links the roundup only from `bwwFromPass` on (Playbill came first). */
function nightFetch({ bwwFromPass = 3, feeds = true, bwwLayout = bwwPage } = {}) {
  let pass = 0;
  const fetchText = async (url) => {
    if (url === 'https://www.broadwayworld.com/') {
      pass++;
      return `<html><body>${pass >= bwwFromPass ? a(BWW_RR, 'Review Roundup: A FEW GOOD MEN Opens On Broadway with Tom Blyth, Bradley Whitford and More') : ''}</body></html>`;
    }
    if (url === BWW_RR) return bwwLayout;
    if (url === 'https://playbill.com/category/the-verdict') return `<html><body><main>${a(PV_ART, 'Reviews: What Do the Critics Think of the Broadway Revival of A Few Good Men?')}</main></body></html>`;
    if (url === PV_ART) return playbillPage;
    if (feeds && url === NYT_FEED) return nyTheaterFeed;
    if (url.startsWith('https://news.google.com/rss/search')) return '<rss><channel></channel></rss>';
    throw new Error(`404 ${url}`); // DTLI timed out, every Talkin' Broadway index failed, the other feeds had nothing
  };
  return fetchText;
}

// The pages the lane fetched. WSJ served its paywall teaser: past the scorer's 1000-char body gate (the night's one fetch
// went straight to the scorer) but under WSJ's 2500-char floor for a complete review. Every other outlet a full review.
const TEASER = 'A Few Good Men review: Aaron Sorkin\'s Marines come back to Broadway. Subscribe to continue reading. '.repeat(13);
const FULL = 'The revival plays the courtroom drama straight, and the performances carry it through the second act. '.repeat(30);

// Talkin' Broadway's named page as a browser reads it once the challenge clears; its other names are not filed (404).
const TB_PAGE = `<html><head><title>Talkin' Broadway Review: A Few Good Men</title></head><body><h1>A Few Good Men</h1>
  <p>Theatre Review by Howard Miller - October 29, 2026</p><p>${FULL}</p></body></html>`;

/** A Browserbase double: one fake browser whose pages serve Talkin' Broadway; every URL it reads is recorded. */
function fakeBrowserbase() {
  const reads = [];
  let sessions = 0;
  const browser = { isConnected: () => true, on: () => {}, close: async () => {}, contexts: () => [{ newPage: async () => ({ close: async () => {} }) }] };
  const fetcher = bb.createBrowserbaseFetcher({
    env: { BROWSERBASE_API_KEY: 'k', BROWSERBASE_PROJECT_ID: 'p' },
    createSession: async () => { sessions++; return { id: `s${sessions}`, connectUrl: 'wss://fake' }; },
    connect: async () => browser,
    readPage: async (_page, url) => {
      reads.push(url);
      const hit = d.canonicalUrl(url) === d.canonicalUrl(U.talkinbroadway);
      return { status: hit ? 200 : 404, finalUrl: url, html: hit ? TB_PAGE : '<html><body>Not Found</body></html>', challenge: false };
    },
  });
  return { fetcher, reads, sessions: () => sessions };
}

/** The lane's fetchPage on the night: the review pages (WSJ's teaser, every other outlet in full) and the discovery pages. */
function nightPages(opts) {
  const night = nightFetch(opts);
  return async (url) => {
    if (/talkinbroadway\.com/.test(url)) throw new Error(`Cloudflare challenge ${url}`);
    if (CRITIC.has(d.canonicalUrl(url))) return { content: /wsj\.com/.test(url) ? TEASER : FULL };
    return { content: await night(url) };
  };
}

/** Publish ports that keep nothing: the merge runs, the push and the deploy do not, and the lease is held. */
const replayPublishPorts = (now) => ({
  ...shadow.createShadowPublishPorts({ onRows: () => {}, now }), pushData: async () => ({ pushed: false }), isLeased: async () => true,
});

async function replay(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6066-afgm-'));
  let clock = T0;
  const now = () => clock;
  const scorerCalls = [];
  // Talkin' Broadway only answers through Browserbase; without it (opts.noBrowserbase) its every fetch fails, as on the night.
  const browserbase = opts.noBrowserbase ? null : fakeBrowserbase();
  const laneFetch = { fetchPage: bb.laneFetchPage({ fetchPage: nightPages(opts), browserbase: browserbase && browserbase.fetcher }), close: async () => {} };
  const reviewTextsDir = path.join(dir, 'review-texts');
  fs.mkdirSync(reviewTextsDir);
  // With opts.site, a modelled live site stands behind the publish ports so the night can be graded like a real one.
  const site = opts.site ? grade.createReplaySitePorts({ now }) : null;
  const ledgerDir = path.join(dir, 'ledger');
  try {
    const runNight = driver.wireLaneNight({
      show: SHOW, night: NIGHT, openingDate: NIGHT, timeZone: 'America/New_York', ledgerDir, adaptersConfig: {},
      laneFetch, fetchPorts: {
        extractArticle: (html) => html,
        extractMeta: (_html, url) => ({ criticName: CRITIC.get(d.canonicalUrl(url)) || null, publishDate: NIGHT }),
      },
      // The models: WSJ's teaser is not a review; the excerpt and every full review score.
      // opts.scoreText (BRO-6623): a scorer shaped like the production one (inline.ensembleScoreText) instead of the bare score.
      scoreText: async (text, ctx) => {
        scorerCalls.push({ url: ctx.url, tier: ctx.contentTier, chars: text.length });
        if (/wsj\.com/.test(ctx.url) && text) return { rejected: true, rejection: 'not_a_review' };
        return opts.scoreText ? opts.scoreText(text, ctx) : { score: text ? 60 : 45, extra: {} };
      },
      publishPorts: site || replayPublishPorts(now), now, wait: async (ms) => { clock += ms; },
      reviewTextsDir, onDiskUrls: [], onDiskRows: [], showScoreGuards: { urlMap: {}, allShows: [SHOW] }, search: async () => [], decodeImpl: null,
      tuning: { maxPasses: opts.passes || 8, startedAt: T0 },
    });
    const res = await runNight();
    let graded = null;
    if (site) {
      // The census is what the night's aggregators listed (Playbill's and BWW's roundups); graded at embargo +4h.
      const censusOutletIds = [...new Set([...PLAYBILL_CITES, ...BWW_CITES])].map((k) => resolveOutletFromUrl(U[k])?.outletId).filter(Boolean);
      const closedAt = Math.max(Date.parse(EMBARGO) + 4 * 60 * MIN, clock);
      const rec = grade.replayToPressNightRecord({ show: SHOW, night: NIGHT, live: site.live(), ledgerDir, reviewTextsDir, censusOutletIds, startedAt: T0, closedAt });
      graded = grade.gradeReplay(rec, res);
    }
    const out = { ...res, scored: new Map(res.admitted.map((x) => [x.key, x])), scorerCalls, dir, browserbase, graded, live: site ? site.live() : [], reviewFiles: fs.readdirSync(reviewTextsDir) };
    // opts.inspect (BRO-6623): read the night's written review files before the temp dir goes.
    if (opts.inspect) out.inspected = await opts.inspect({ reviewTextsDir, show: SHOW, live: out.live });
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { d, inline, driver, shadow, bb, grade, SHOW, NIGHT, T0, MIN, EMBARGO, SITE, U, CRITIC, a, PV_ART, PLAYBILL_CITES, playbillPage, BWW_RR, PODCAST, BWW_CITES, quote, bwwPage, NYT_FEED, nyTheaterFeed, nightFetch, TEASER, FULL, TB_PAGE, fakeBrowserbase, nightPages, replayPublishPorts, replay, ALL_FEEDS, resolveOutletFromUrl };
