// BRO-6066 (cutover card 5b): replay of the 2026-10-29 shadow night for A Few Good Men (run 40986210601). The lane scored
// 18 of the 22 reviews the site published. These pages are rebuilt from that night's inputs: the same URLs and the page
// shapes that cost the four (BWW's roundup body behind ticket-deal and podcast <article> cards, Playbill's bare link list
// with no excerpts, WSJ's paywall teaser judged not_a_review, The Independent's /features/ review path, New York Theater
// reachable only through its own feed or the BWW roundup, every Talkin' Broadway index failing). Links and structure
// only; the quotes are placeholders, no article text is copied.
// The real runLaneNight, discovery adapters and inline scoring run; the network and the models are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const inline = require('../../scripts/lib/opening-night-lane/inline-score.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const shadow = require('../../scripts/lib/opening-night-lane-shadow.js');
const { ALL_FEEDS } = require('../../scripts/lib/rss-discovery.js');

const SHOW = { id: 'a-few-good-men-2026', title: 'A Few Good Men', openingDate: '2026-10-29', category: 'broadway' };
const NIGHT = '2026-10-29';
const T0 = Date.parse('2026-10-30T03:00:00Z'); // the first reviews were cited from 03:02Z
const MIN = 60000;

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
  talkinbroadway: ['https://www.talkinbroadway.com/page/world/AFewGoodMen.html', 'Howard Miller'], // BRO-6073, not this card
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

function adapters() {
  // The shadow's list (scripts/opening-night-lane-shadow.js), feeds omitted as there: the lane's default feed list.
  return [
    d.bwwRoundupAdapter(), d.dtliAdapter(), d.showScoreAdapter({ urlMap: {}, allShows: [SHOW] }), d.playbillVerdictAdapter(),
    d.talkinBroadwayAdapter({ now: () => T0 }), d.googleNewsAdapter(), d.rssAdapter({ feeds: undefined }),
    d.sectionIndexAdapter({ outlets: [] }), d.serpAdapter({ search: async () => [] }),
  ];
}

async function replay(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6066-afgm-'));
  let clock = T0;
  const now = () => clock;
  const scorerCalls = [];
  const scoring = inline.createInlineScoring({
    show: SHOW, night: NIGHT, ledgerDir: path.join(dir, 'ledger'), now,
    fetchPage: async (url) => ({ content: /wsj\.com/.test(url) ? TEASER : FULL }), extractArticle: (html) => html,
    extractMeta: (_html, url) => ({ criticName: CRITIC.get(d.canonicalUrl(url)) || null, publishDate: NIGHT }),
    // The models: WSJ's teaser is not a review; the excerpt and every full review score.
    scoreText: async (text, ctx) => {
      scorerCalls.push({ url: ctx.url, tier: ctx.contentTier, chars: text.length });
      if (/wsj\.com/.test(ctx.url) && text) return { rejected: true, rejection: 'not_a_review' };
      return { score: text ? 60 : 45, extra: {} };
    },
  });
  try {
    const res = await runLaneNight({
      show: SHOW, night: NIGHT, openingDate: NIGHT, timeZone: 'America/New_York', ledgerDir: path.join(dir, 'ledger'), dryRun: true,
      maxPasses: opts.passes || 8, startedAt: T0, adapters: adapters(), fetchText: nightFetch(opts),
      fetchReview: scoring.fetchReview, scoreReview: scoring.scoreReview,
      publishPorts: shadow.createShadowPublishPorts({ onRows: () => {}, now }), now, wait: async (ms) => { clock += ms; },
    });
    return { ...res, scored: new Map(res.admitted.map((x) => [x.key, x])), scorerCalls, dir };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const has = (r, k) => r.scored.has(d.canonicalUrl(U[k]));

test('replay of 2026-10-29: the lane scores 21 of the 22 published reviews; only Talkin\' Broadway (BRO-6073) is out of reach', async () => {
  const r = await replay();
  const missed = Object.keys(SITE).filter((k) => !has(r, k));
  assert.deepEqual(missed, ['talkinbroadway'], `missed ${missed.join(', ')}; failed ${JSON.stringify(r.failed)}; errors ${JSON.stringify(r.errors.filter((e) => e.adapter !== 'talkin-broadway'))}`);
  assert.equal(r.scored.size, 21);
  assert.deepEqual(r.failed, [], 'nothing failed for good');
});

test('WSJ: the paywall teaser judged not_a_review waits for BWW\'s excerpt (Playbill prints none) and is scored from it once', async () => {
  const r = await replay({ bwwFromPass: 3 });
  assert.ok(has(r, 'wsj'));
  const wsj = r.scorerCalls.filter((c) => /wsj\.com/.test(c.url));
  // One model call on the teaser, then none while no excerpt exists, then one on the excerpt.
  assert.deepEqual(wsj.map((c) => c.tier), ['complete', 'excerpt']);
  assert.equal(wsj[1].chars, 0, 'the excerpt is the only text');
});

test('WSJ with no aggregator excerpt all night is still a failure for good, not a score from the teaser', async () => {
  const r = await replay({ bwwFromPass: 99, passes: 14 }); // five tries on the 30 s, 2, 5, 10 min backoff: about 18 minutes
  assert.ok(!has(r, 'wsj'));
  const f = r.failed.find((x) => x.key.includes('wsj.com'));
  assert.ok(f, JSON.stringify(r.failed));
  assert.match(f.reason, /paywall teaser \(not_a_review\); waiting for an aggregator excerpt/);
  assert.equal(r.scorerCalls.filter((c) => /wsj\.com/.test(c.url)).length, 1, 'the teaser is judged once, never re-sent to the models');
});

test('The Independent\'s /features/ review is admitted; the shared rule with domain-filters.js still refuses a features interview or round-up', async () => {
  const r = await replay();
  assert.ok(has(r, 'independent'));
  const { isBlockedReviewUrl } = require('../../scripts/lib/domain-filters.js');
  for (const u of [U.independent]) {
    assert.equal(d.nonReviewReason(d.canonicalUrl(u), { aggregatorCited: true }), null);
    assert.equal(isBlockedReviewUrl(u), false, 'the regular pipeline agrees');
  }
  for (const u of ['https://www.the-independent.com/arts-entertainment/theatre-dance/features/aaron-sorkin-interview-b3075000.html',
    'https://www.the-independent.com/arts-entertainment/theatre-dance/features/a-few-good-men-review-round-up-b3075001.html']) {
    assert.equal(d.nonReviewReason(u, { aggregatorCited: true }), 'non-review-path', u);
    assert.equal(isBlockedReviewUrl(u), true, u);
  }
});

test('New York Theater comes from its own feed when no BWW roundup is found all night (the regular pipeline\'s source)', async () => {
  const r = await replay({ bwwFromPass: 99 });
  const ny = r.admitted.find((x) => x.key === d.canonicalUrl(U.nytheater));
  assert.ok(ny, 'discovered through the feed');
  assert.equal(ny.via, 'NY Theater');
  const off = await replay({ bwwFromPass: 99, feeds: false });
  assert.ok(!has(off, 'nytheater'), 'with neither source it is not found: the feed is what finds it');
});

test('the lane reads the regular pipeline\'s feed list by default, every feed within two passes despite the per-pass cap', async () => {
  const feeds = d.defaultLaneFeeds(SHOW);
  assert.ok(feeds.some((f) => f.url === NYT_FEED));
  assert.ok(feeds.every((f) => ALL_FEEDS.some((x) => x.url === f.url)), 'no second list');
  assert.ok(!feeds.some((f) => /whatsonstage|standard\.co\.uk|theatreweekly/.test(f.url)), 'West End feeds are not read for a Broadway show');
  const asked = new Set();
  const adapter = d.rssAdapter();
  for (let i = 0; i < 2; i++) await adapter.discover({ show: SHOW, fetchText: async (u) => { asked.add(u); return '<rss></rss>'; } });
  assert.deepEqual([...asked].sort(), feeds.map((f) => f.url).sort());
});

test('BWW roundup: the cited reviews are read from the story body, not the deal and podcast cards; an unreadable layout is an error', async () => {
  const links = d.extractCitedLinks(d.bwwRoundupBody(bwwPage), BWW_RR);
  assert.equal(links.length, 20);
  assert.ok(links.every((l) => l.excerpt && l.excerpt.includes('placeholder quote')), 'each review keeps its BWW excerpt');
  assert.ok(!links.some((l) => l.url.includes('broadwaypodcastnetwork')));
  // The night's layout through the old scope: one podcast link. The adapter now says so instead of returning nothing.
  assert.deepEqual(d.extractCitedLinks(bwwPage, BWW_RR).map((l) => l.url), [d.canonicalUrl(PODCAST)]);
  const cardsOnly = bwwPage.replace(/<div class="disnep-area">[\s\S]*?<\/div>/, '');
  const fetchText = nightFetch({ bwwFromPass: 1, bwwLayout: cardsOnly });
  await assert.rejects(d.bwwRoundupAdapter().discover({ show: SHOW, fetchText }), /no review on a known outlet/);
});

// Ship-check findings (2026-10-30 review panel).
function wsjScoring({ page, url = U.wsj, now }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6066-teaser-'));
  const calls = [];
  const sc = inline.createInlineScoring({
    show: SHOW, night: NIGHT, ledgerDir: dir, now,
    fetchPage: async () => ({ content: page }), extractArticle: (html) => html, extractMeta: () => ({ criticName: 'Charles Isherwood' }),
    scoreText: async (text, ctx) => { calls.push(ctx.contentTier); return text ? { rejected: true, rejection: 'not_a_review' } : { score: 45, extra: {} }; },
  });
  return { sc, calls, dir, url };
}
const EXCERPT = { bwwExcerpt: `Charles Isherwood, ${quote('wsj')}` };

test('a teaser wait counts one attempt per try, and an excerpt seen while the score is backing off is kept', async () => {
  let t = T0;
  const { sc, calls, dir, url } = wsjScoring({ page: TEASER, now: () => t });
  try {
    const row = () => ({ url, fullText: TEASER, showId: SHOW.id });
    const got = await sc.fetchReview({ url });
    await assert.rejects(sc.scoreReview(row(), got), (e) => e.name === 'LaneRetryError' && /attempt 1\/5/.test(e.message));
    const recs = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.includes('failures'))), 'utf8').trim().split('\n');
    assert.equal(recs.length, 1, 'one failure record per try, not two');
    // Five seconds later (inside the 30 s backoff) BWW cites it with a quote: the fetch is cached, the score still waits...
    t += 5000;
    await assert.rejects(sc.fetchReview({ url, excerpts: EXCERPT }), (e) => e.name === 'LaneRetryError');
    // ...and the next try, with no aggregator re-citing it, still has the quote.
    t += 60000;
    const again = await sc.fetchReview({ url });
    const res = await sc.scoreReview(row(), again);
    assert.equal(res.score, 45);
    assert.deepEqual(calls, ['complete', 'excerpt'], 'the teaser went to the models once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('not_a_review stays a verdict for a full-length paywall page and for a short page whose URL is not a review', async () => {
  for (const [page, url] of [[FULL.slice(0, 2600), U.wsj], [TEASER, 'https://www.wsj.com/articles/aaron-sorkin-on-bringing-a-few-good-men-back-b2a4cbcb']]) {
    const { sc, dir } = wsjScoring({ page, url, now: () => T0 });
    try {
      const got = await sc.fetchReview({ url, excerpts: EXCERPT });
      await assert.rejects(sc.scoreReview({ url, fullText: page, showId: SHOW.id }, got), (e) => e.permanent === true && /not_a_review/.test(e.message), url);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a card <article> nested inside the BWW story body does not stand in for the roundup', () => {
  const nested = bwwPage.replace('<div class="disnep-area">', `<div class="disnep-area"><article class="ad">${a(U.vulture, 'Promoted')}</article>`);
  const links = d.storyCitedLinks(nested, BWW_RR, '.disnep-area');
  assert.equal(links.length, 20);
});
