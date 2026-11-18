'use strict';
const { foldDiacritics } = require('../title-match');
/**
 * Simulated opening night (game day) fixture (BRO-7781). Six fictional shows on one night, shaped after the Blue Man
 * Group post-mortem (2026-11-17): what each outlet's pages say, when they say it (virtual ms after the night's T0), the
 * recorded scorer answer for each review, and what the night must end with.
 *
 * Page markup follows the real templates the extractors read: TheaterMania's current template (JSON-LD naming only the
 * posting editor's slug, the visible author area naming the critic; copied from tests/unit/byline-structured-vs-printed),
 * a JSON-LD Person byline, a plain "By" byline paragraph, and an article:published_time meta. Review text is generated
 * filler (nothing copyrighted) long enough for the scorer's 1000-char body gate.
 *
 * Expectations per review:
 *   live        published to the live show JSON with this critic and score
 *   alert       not admitted by the lane; must raise exactly ONE press-night alert (near-miss or gap) naming its URL
 *   manual      a person drops the URL in the manual inbox at `manualAtMs`; it must go live without stopping the lane
 *   watch       a known shape the lane does not handle today (a sibling card's area): reported, never asserted
 *
 * Deterministic: no randomness, no wall clock.
 */
const NIGHT = '2026-11-17';
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-17T22:30:00Z'); // 17:30 ET: before every lane start below

const filler = (show, n) => `${show.title} at the ${show.venue} is the evening's subject. `
  + `${'The staging builds slowly, the cast commits to every bit, and the second act earns its ending. '.repeat(14)}`
  + `${show.cast[0]} leads the company with real wit (sim review ${n}).`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** An outlet article. byline: {kind: 'p'|'jsonld'|'theatermania', name, editorSlug?} */
function articleHtml({ show, headline, byline, publishedIso, n }) {
  const body = `<p>${esc(filler(show, n))}</p><p>${esc(filler(show, n + 100))}</p>`;
  const meta = `<meta property="article:published_time" content="${publishedIso}">`;
  if (byline.kind === 'theatermania') {
    // TheaterMania's template: the JSON-LD author is the POSTING account's slug (editor David Gordon = dgordon), the
    // visible author area names the critic (BRO-7745).
    const ld = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsArticle","headline":${JSON.stringify(headline)},"datePublished":"${publishedIso}","author":{"@id":"https:\\/\\/www.theatermania.com\\/author\\/${byline.editorSlug || 'dgordon'}\\/#author"},"publisher":{"@id":"https:\\/\\/www.theatermania.com\\/#organization"}}]}</script>`;
    const slug = foldDiacritics(byline.name).toLowerCase().replace(/[^a-z]+/g, '-');
    const area = `<section class="author-area d-flex align-items-center mb-4">\n    <a href="https://www.theatermania.com/authors/${slug}" rel="noopener noreferrer"><img class="square-image-author" src="x.jpg" alt="${esc(byline.name)}" /></a><p class="author-name mb-0 me-2 text-decoration-none text-blue"><a id="article-author-tag" class="text-decoration-none text-blue" href="https://www.theatermania.com/authors/${slug}" rel="noopener noreferrer">${esc(byline.name)}</a></p>\n    <span class="me-2 text-blue">|</span>\n    <p id="article-date-tag" class="mb-0">November 17, 2026</p>\n</section>`;
    return `<html><head><title>${esc(headline)}</title>${ld}${meta}</head><body><h1>${esc(headline)}</h1>${area}<div class="news-content">${body}</div><section class="featured-in-this-story my-3"><h4>Featured In This Story</h4></section></body></html>`;
  }
  if (byline.kind === 'jsonld') {
    const ld = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":${JSON.stringify(headline)},"datePublished":"${publishedIso}","author":{"@type":"Person","name":${JSON.stringify(byline.name)}}}</script>`;
    return `<html><head><title>${esc(headline)}</title>${ld}${meta}</head><body><article><h1>${esc(headline)}</h1>${body}</article></body></html>`;
  }
  return `<html><head><title>${esc(headline)}</title>${meta}</head><body><article><h1>${esc(headline)}</h1><p class="byline">By ${esc(byline.name)}</p>${body}</article></body></html>`;
}

const rssItem = ({ title, url, pubIso }) => `<item><title>${esc(title)}</title><link>${url}</link><pubDate>${new Date(pubIso).toUTCString()}</pubDate><description>${esc(title)}</description></item>`;
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>feed</title>${items.join('')}</channel></rss>`;

// The shows. reviewEmbargoAt set = a confirmed embargo; absent = the market-default guess (BRO-7740).
const SHOWS = [
  { id: 'sim-blue-man-group-holiday-2026', title: 'Blue Man Group “A Holiday Spectacular”', category: 'broadway', venue: 'Marquis Theatre', cast: ['Wendell Blue', 'Otto Cobalt'], reviewEmbargoAt: '2026-11-18T01:00:00Z' },
  { id: 'sim-wonderful-life-radio-2026', title: 'It’s a Wonderful Radio Life: A Live Broadcast', category: 'broadway', venue: 'Lyceum Theatre', cast: ['Harriet Bailey', 'George Potterfield'], reviewEmbargoAt: '2026-11-18T00:30:00Z' },
  { id: 'sim-dollygram-2026', title: 'Dollygram: An Original Musical', category: 'broadway', venue: 'Palace Theatre', cast: ['Marla Jessup', 'Tom Sutter'], reviewEmbargoAt: '2026-11-18T01:30:00Z' },
  { id: 'sim-quiet-harbor-2026', title: 'The Quiet Harbor Keepers', category: 'off-broadway', venue: 'Minetta Lane Theatre', cast: ['Ada Fennimore', 'Rufus Kell'], reviewEmbargoAt: '2026-11-18T00:00:00Z' },
  { id: 'sim-four-critics-special-2026', title: 'A Candlelit Winter Cabaret', category: 'broadway', venue: 'Belasco Theatre', cast: ['Nina Larkspur', 'Jules Ferrante'], reviewEmbargoAt: '2026-11-18T01:00:00Z' },
  // No reviewEmbargoAt: the lane runs on the guessed market-default embargo with the pre-embargo guard (BRO-7740).
  { id: 'sim-guessed-embargo-2026', title: 'The Lighthouse Accord', category: 'broadway', venue: 'Hudson Theatre', cast: ['Cora Whitlock', 'Ines Varga'] },
].map((s) => ({ ...s, openingDate: NIGHT, status: 'open', type: 'play', slug: s.id.replace(/-2026$/, '') }));

const by = Object.fromEntries(SHOWS.map((s) => [s.id, s]));
const iso = (ms) => new Date(ms).toISOString();

/**
 * Reviews. appearsAtMs: absolute ms the outlet's pages first show it. via: where it is listed.
 *   tm-index   TheaterMania's reviews index (section-index adapter, date-checked per article)
 *   feed:<url> an outlet RSS feed the lane polls (lane-sources defaults)
 *   bww        only on the BroadwayWorld Review Roundup (aggregator), which appears at bwwAtMs
 */
function buildReviews(embargoMs) {
  const R = [];
  const add = (r) => { R.push({ n: R.length + 1, ...r }); };
  const bmg = by['sim-blue-man-group-holiday-2026'];
  // BRO-7739: TheaterMania's headline names only the main title, never the quoted subtitle; the critic is in the author
  // area while the JSON-LD names the posting editor (BRO-7745). Must go live as Dan Example.
  add({ show: bmg.id, outletId: 'theatermania', url: 'https://www.theatermania.com/news/review-blue-man-groups-broadway-christmas-show-is-a-sleigh-ride_1860029/', headline: 'Review: Blue Man Group’s Broadway Christmas Show Is a Sleigh Ride', critic: 'Dan Example', byline: { kind: 'theatermania', name: 'Dan Example' }, via: 'tm-index', at: embargoMs(bmg) + 5 * MIN, score: 74, expect: 'live' });
  add({ show: bmg.id, outletId: 'variety', url: 'https://variety.com/2026/legit/reviews/blue-man-group-a-holiday-spectacular-review-1236000001/', headline: '‘Blue Man Group: A Holiday Spectacular’ Review: Paint, Pipes and Tinsel', critic: 'Frank Example', byline: { kind: 'jsonld', name: 'Frank Example' }, via: 'feed:https://variety.com/v/legit/feed/', at: embargoMs(bmg) + 2 * MIN, score: 68, expect: 'live' });

  // Colon subtitle: the strict matcher does not split colons (rss-discovery mainTitleOf), so the outlet headline with
  // the lead only is a near-miss. One alert, then a person adds it through the manual inbox (BRO-7741) mid-night.
  const wl = by['sim-wonderful-life-radio-2026'];
  add({ show: wl.id, outletId: 'nysr', url: 'https://nystagereview.com/2026/11/17/review-its-a-wonderful-radio-life-on-broadway/', headline: 'Review: It’s a Wonderful Radio Life on Broadway', critic: 'Sara Example', byline: { kind: 'p', name: 'Sara Example' }, via: 'feed:https://nystagereview.com/feed/', at: embargoMs(wl) + 4 * MIN, score: 81, expect: 'alert+manual', manualAfterMs: 40 * MIN });
  add({ show: wl.id, outletId: 'nypost', url: 'https://nypost.com/2026/11/17/entertainment/its-a-wonderful-radio-life-a-live-broadcast-review/', headline: '‘It’s a Wonderful Radio Life: A Live Broadcast’ review: a warm hug', critic: 'Johnny Example', byline: { kind: 'p', name: 'Johnny Example' }, via: 'feed:https://nypost.com/entertainment/feed/', at: embargoMs(wl) + 6 * MIN, score: 77, expect: 'live' });

  // Single-word lead ("Dollygram"): near-miss.leadTitle needs 2+ significant words, so the headline that names only the
  // lead raises nothing and is not admitted (watch); the BWW roundup later lists it and the lane admits it from there.
  const dg = by['sim-dollygram-2026'];
  add({ show: dg.id, outletId: 'theatermania', url: 'https://www.theatermania.com/news/review-dollygram-glitters_1860031/', headline: 'Review: Dollygram Glitters on Broadway', critic: 'Pete Example', byline: { kind: 'theatermania', name: 'Pete Example' }, via: 'tm-index+bww', at: embargoMs(dg) + 3 * MIN, bwwAt: embargoMs(dg) + 70 * MIN, score: 63, expect: 'live' });
  add({ show: dg.id, outletId: 'deadline', url: 'https://deadline.com/2026/11/dollygram-an-original-musical-broadway-review-1236200001/', headline: '‘Dollygram: An Original Musical’ Broadway Review', critic: 'Greg Example', byline: { kind: 'jsonld', name: 'Greg Example' }, via: 'feed:https://deadline.com/feed/', at: embargoMs(dg) + 1 * MIN, score: 58, expect: 'live' });

  // Off-Broadway: plain title through an own-outlet feed and a section index.
  const qh = by['sim-quiet-harbor-2026'];
  add({ show: qh.id, outletId: 'nyt-theater', url: 'https://www.newyorktheater.me/2026/11/17/the-quiet-harbor-keepers-review/', headline: 'The Quiet Harbor Keepers Review', critic: 'Jon Example', byline: { kind: 'p', name: 'Jon Example' }, via: 'feed:https://www.newyorktheater.me/feed/', at: embargoMs(qh) + 2 * MIN, score: 72, expect: 'live' });
  add({ show: qh.id, outletId: 'theatrely', url: 'https://www.theatrely.com/post/review-the-quiet-harbor-keepers-off-broadway', headline: 'Review: The Quiet Harbor Keepers', critic: 'Lane Example', byline: { kind: 'p', name: 'Lane Example' }, via: 'index:https://www.theatrely.com/reviews', at: embargoMs(qh) + 8 * MIN, score: 66, expect: 'live' });

  // Four critics on a Broadway special: every review goes live, and the site's score gate (min-reviews.js, 5 on
  // Broadway) must keep the Critic Score off the show JSON. One review is only on the BWW roundup (the outlet's own
  // listing lacks it): the aggregator path.
  const fc = by['sim-four-critics-special-2026'];
  add({ show: fc.id, outletId: 'variety', url: 'https://variety.com/2026/legit/reviews/a-candlelit-winter-cabaret-review-1236000002/', headline: '‘A Candlelit Winter Cabaret’ Review', critic: 'Frank Example', byline: { kind: 'jsonld', name: 'Frank Example' }, via: 'feed:https://variety.com/v/legit/feed/', at: embargoMs(fc) + 2 * MIN, score: 70, expect: 'live' });
  add({ show: fc.id, outletId: 'nypost', url: 'https://nypost.com/2026/11/17/entertainment/a-candlelit-winter-cabaret-review/', headline: '‘A Candlelit Winter Cabaret’ review', critic: 'Johnny Example', byline: { kind: 'p', name: 'Johnny Example' }, via: 'feed:https://nypost.com/entertainment/feed/', at: embargoMs(fc) + 3 * MIN, score: 62, expect: 'live' });
  add({ show: fc.id, outletId: 'theatermania', url: 'https://www.theatermania.com/news/review-a-candlelit-winter-cabaret_1860033/', headline: 'Review: A Candlelit Winter Cabaret', critic: 'Zach Example', byline: { kind: 'theatermania', name: 'Zach Example' }, via: 'tm-index', at: embargoMs(fc) + 4 * MIN, score: 75, expect: 'live' });
  add({ show: fc.id, outletId: 'amny', url: 'https://www.amny.com/entertainment/theater/a-candlelit-winter-cabaret-review-belasco/', headline: 'A Candlelit Winter Cabaret review', critic: 'Matt Example', byline: { kind: 'p', name: 'Matt Example' }, via: 'bww', at: embargoMs(fc) + 5 * MIN, bwwAt: embargoMs(fc) + 50 * MIN, score: 69, expect: 'live' });

  // Guessed embargo: one review drops 3 h before the guess, one 3 h after.
  const ge = by['sim-guessed-embargo-2026'];
  add({ show: ge.id, outletId: 'nypost', url: 'https://nypost.com/2026/11/17/entertainment/the-lighthouse-accord-review-early/', headline: '‘The Lighthouse Accord’ review', critic: 'Johnny Example', byline: { kind: 'p', name: 'Johnny Example' }, via: 'feed:https://nypost.com/entertainment/feed/', at: embargoMs(ge) - 180 * MIN, score: 71, expect: 'live' });
  add({ show: ge.id, outletId: 'variety', url: 'https://variety.com/2026/legit/reviews/the-lighthouse-accord-review-1236000003/', headline: '‘The Lighthouse Accord’ Review: Late but Lit', critic: 'Frank Example', byline: { kind: 'jsonld', name: 'Frank Example' }, via: 'feed:https://variety.com/v/legit/feed/', at: embargoMs(ge) + 180 * MIN, score: 64, expect: 'live' });
  return R;
}

/** Recorded scorer answers (the shape scoreReviewFile returns), keyed by review URL. No model is called. */
function recordedScores(reviews) {
  return Object.fromEntries(reviews.map((r) => [r.url, { assignedScore: r.score, llmScore: { score: r.score, confidence: 'high' }, llmMetadata: { recorded: true, promptVersion: 'sim' }, ensembleData: { models: ['recorded-a', 'recorded-b'], scores: [r.score, r.score] }, scoreSource: 'llm-v6' }]));
}

function bwwRoundupUrl(show) {
  return `https://www.broadwayworld.com/article/Review-Roundup-${foldDiacritics(show.title).replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().replace(/ +/g, '-')}-Opens-On-Broadway-20261117`;
}

/**
 * Every page the night serves, as a function of the virtual clock: page(url, tMs) -> html | undefined (404).
 * Contract (simulated-opening-night.js): a URL this returns undefined for at EVERY time is treated as an unmodelled
 * source and answered with an empty page (a quiet night). To stage a dead link, serve it at some time or add it to the
 * night's dead-source handling there; returning undefined forever is not a dead link.
 * @param {object} args shows, reviews
 */
function buildPages({ shows, reviews }) {
  const showOf = Object.fromEntries(shows.map((s) => [s.id, s]));
  const visible = (r, t) => t >= r.at;
  const article = new Map(reviews.map((r) => [r.url, r]));
  const feeds = new Map();
  for (const r of reviews) {
    const m = /^feed:(.+)$/.exec(r.via);
    if (m) { if (!feeds.has(m[1])) feeds.set(m[1], []); feeds.get(m[1]).push(r); }
  }
  const indexes = new Map();
  for (const r of reviews) {
    const m = /^index:(.+)$/.exec(r.via);
    if (m) { if (!indexes.has(m[1])) indexes.set(m[1], []); indexes.get(m[1]).push(r); }
  }
  const tm = reviews.filter((r) => /^tm-index/.test(r.via));
  const bww = reviews.filter((r) => /bww/.test(r.via));
  const anchor = (r) => `<div class="post"><a href="${r.url}">${esc(r.headline)}</a></div>`;
  return (url, t) => {
    const r = article.get(url);
    if (r) return visible(r, t) ? articleHtml({ show: showOf[r.show], headline: r.headline, byline: r.byline, publishedIso: iso(r.at), n: r.n }) : undefined;
    if (feeds.has(url)) {
      const items = feeds.get(url).filter((x) => visible(x, t)).map((x) => rssItem({ title: x.headline, url: x.url, pubIso: iso(x.at) }));
      // A non-review item every feed carries: news about one of tonight's shows must not be admitted.
      items.push(rssItem({ title: `${shows[0].title} extends through January`, url: url.replace(/feed\/?$/, '') + '2026/11/17/news/extension-news/', pubIso: '2026-11-17T20:00:00Z' }));
      return rss(items);
    }
    if (indexes.has(url)) return `<html><body><main>${indexes.get(url).filter((x) => visible(x, t)).map(anchor).join('')}</main></body></html>`;
    if (url === 'https://www.theatermania.com/news/?categories=reviews') {
      return `<html><body><nav><a href="https://www.theatermania.com/news/">News</a></nav><main>${tm.filter((x) => visible(x, t)).map(anchor).join('')}<div class="post"><a href="https://www.theatermania.com/news/review-some-other-show_1859000/">Review: Some Other Show</a></div></main></body></html>`;
    }
    if (url === 'https://www.broadwayworld.com/') {
      const open = shows.filter((s) => bww.some((x) => x.show === s.id && t >= x.bwwAt));
      return `<html><body>${open.map((s) => `<a href="${bwwRoundupUrl(s)}">Review Roundup: ${esc(s.title.toUpperCase())}</a>`).join('')}<a href="https://www.broadwayworld.com/article/Review-Roundup-ANOTHER-SHOW-Opens-On-Broadway-20261110">Review Roundup: ANOTHER SHOW</a></body></html>`;
    }
    for (const s of shows) {
      if (url !== bwwRoundupUrl(s)) continue;
      const listed = bww.filter((x) => x.show === s.id && t >= x.bwwAt);
      if (!listed.length) return undefined;
      // A roundup cites every review out by then, including ones the lane found elsewhere (dedupe by canonical key).
      const cites = reviews.filter((x) => x.show === s.id && visible(x, t));
      return `<html><body><nav><a href="https://www.broadwayworld.com/">BWW</a></nav><article>${cites.map((x) => `<p><b>${esc(x.critic)}, ${esc(x.outletId)}:</b> <a href="${x.url}">Read the review</a></p>`).join('')}</article></body></html>`;
    }
    if (url === 'https://playbill.com/category/the-verdict') return '<html><body><a href="https://playbill.com/article/the-verdict-another-show">The Verdict: Another Show</a></body></html>';
    if (url.startsWith('https://news.google.com/rss/search')) return rss([]);
    return undefined;
  };
}

function buildGameDay() {
  const embargo = (s) => Date.parse(require('../opening-night-lane/lane-only-markets').embargoForNight(s, NIGHT)); // reviewEmbargoAt, else the market-default guess
  const reviews = buildReviews(embargo);
  return { night: NIGHT, t0: T0, shows: SHOWS, reviews, scores: recordedScores(reviews), page: buildPages({ shows: SHOWS, reviews }), embargo };
}

module.exports = { NIGHT, T0, MIN, SHOWS, buildGameDay, articleHtml, bwwRoundupUrl };
