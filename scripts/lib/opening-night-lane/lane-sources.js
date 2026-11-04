'use strict';
/**
 * Where the opening-night lane looks for each outlet's review (BRO-6872).
 *
 * The lane polls four kinds of source: aggregators (BWW, DTLI, Show Score, Playbill Verdict), outlet feeds, outlet
 * section pages, and dedicated adapters (Talkin' Broadway). Aggregators list a review hours after it is up, so an outlet
 * that publishes on opening night needs a feed or a section page of its own, or the lane only finds it late or through
 * SERP. Before this file the lane read 19 feeds and 7 tier-1 section pages. Most entries below come from the outlet-listing
 * poller's working feeds and listing pages (scripts/outlet-listing-poller.js OUTLET_STRATEGY_CONFIG). They are copied, not
 * required: requiring the poller would put it and its writers under the lane code hash and the pre-opening freeze.
 *
 * Every outlet that has published on time (on or before the day after opening) on recent Broadway nights must appear in
 * a source here or in LANE_SOURCE_GAPS with a reason. tests/unit/opening-night-lane-sources.test.mjs enforces it against
 * the committed history snapshot (tests/fixtures/opening-night-lane/on-time-outlets.json, refreshed by
 * scripts/lane-on-time-outlets.js) and, when data/reviews.json is present, against live history too.
 */
const { ALL_FEEDS } = require('../rss-discovery');

const REGISTRY = () => require('../../../data/outlet-registry.json').outlets;

function laneMarket(show) {
  return /west[-\s]?end/i.test(`${(show && show.market) || ''} ${(show && show.category) || ''}`) ? 'west-end' : 'broadway';
}

/** An outlet the registry places in London only is West End; everything else (US, NYC, dual, unset) is Broadway. */
function outletInMarket(outletId, market) {
  const o = REGISTRY()[outletId];
  if (!o) return market === 'broadway';
  const londonOnly = o.region === 'london' && !o.isDualMarket;
  return market === 'west-end' ? (londonOnly || !!o.isDualMarket || o.region === 'dual') : !londonOnly;
}

// Explicit section URLs, never inferred from article URLs. Vulture and Variety reuse the sections swept by
// site-search-discovery.js. Tier-1 pages are read for tier-1 outlets the registry places in the show's market.
// Not here: nytimes.com/section/theater (403) and wsj.com/arts-culture (401) refused the runners on 177 of 178 reads
// in the 2026-11-04 replays (and refuse our own user agent too), each holding a pinned slot the rotating pages need.
// Their feeds find the reviews: NYT's Theater RSS and WSJ's Arts & Culture RSS (rss-discovery.js ALL_FEEDS), BRO-6872.
const T1_SECTION_INDEXES = {
  vulture: 'https://www.vulture.com/theater/',
  variety: 'https://variety.com/v/legit/reviews/',
  guardian: 'https://www.theguardian.com/stage',
  newyorker: 'https://www.newyorker.com/culture/the-theatre',
  thestage: 'https://www.thestage.co.uk/reviews',
};

// Section pages for on-time outlets with no usable feed, each probed with a plain fetch on 2026-11-03 (200 and review
// links naming recent shows). The first three are the poller's listing-html pages.
const LANE_SECTION_INDEXES = {
  theatermania: 'https://www.theatermania.com/news/?categories=reviews',
  nytg: 'https://www.newyorktheatreguide.com/reviews/broadway',
  timeout: 'https://www.timeout.com/newyork/theater/new-york-theater-and-broadway-reviews',
  theatrely: 'https://www.theatrely.com/reviews',
  'lighting-and-sound-america': 'http://www.lightingandsoundamerica.com/news/result.asp?src=theatre+in+review',
  'the-100-word-review': 'https://www.the100wordreview.com/broadway',
  independent: 'https://www.the-independent.com/arts-entertainment/theatre-dance/reviews',
  chicagotribune: 'https://www.chicagotribune.com/entertainment/theater/',
};

// Feeds for on-time outlets that rss-discovery.js does not read. The first block is the listing poller's; the second is
// lane-only (probed 2026-11-03: 200 with items). Adding those to the regular pipeline is a separate change with a backfill.
const LANE_FEEDS = [
  { url: 'https://www.theguardian.com/stage/rss', outletId: 'guardian', name: 'Guardian Stage' },
  { url: 'https://1minutecritic.com/feed', outletId: 'one-minute-critic', name: 'One Minute Critic' },
  { url: 'https://culturesauce.net/feed', outletId: 'culturesauce', name: 'Culture Sauce' },
  { url: 'https://www.thewrap.com/creative-content/theater/feed/', outletId: 'thewrap', name: 'TheWrap Theater' },
  { url: 'https://pagesonstages.com/feed', outletId: 'pages-on-stages', name: 'Pages on Stages' },
  { url: 'https://theaterlife.com/feed', outletId: 'theater-life', name: 'Theater Life' },
  { url: 'https://www.amny.com/category/entertainment/theater/feed/', outletId: 'amny', name: 'amNY Theater' },
  { url: 'https://theaterpizzazz.com/feed/', outletId: 'theater-pizzazz', name: 'Theater Pizzazz' },
  { url: 'https://frontmezzjunkies.com/feed/', outletId: 'frontmezzjunkies', name: 'Front Mezz Junkies' },
  { url: 'https://www.theatrereviews.com/feed/', outletId: 'theatre-reviews-limited', name: 'Theatre Reviews Limited' },
  { url: 'https://therecs.co.uk/feed/', outletId: 'the-recs', name: 'The Recs' },
  { url: 'https://www.stageandcinema.com/feed/', outletId: 'stageandcinema', name: 'Stage and Cinema' },
  { url: 'https://lavocedinewyork.com/feed/', outletId: 'la-voce-di-new-york', name: 'La Voce di New York' },
  { url: 'https://www.theaterscene.net/feed/', outletId: 'theater-scene', name: 'Theater Scene' },
  { url: 'https://thefrontrowcenter.com/feed', outletId: 'front-row-center', name: 'Front Row Center' },
  { url: 'https://thecontending.com/feed/', outletId: 'the-contending', name: 'The Contending' },
  { url: 'https://t2conline.com/feed/', outletId: 'times-square-chronicles', name: 'Times Square Chronicles' },
  { url: 'https://joshatthemovies.com/feed/', outletId: 'josh-at-the-movies', name: 'Josh at the Movies' },
  { url: 'https://newyorknotebook.substack.com/feed', outletId: 'new-york-notebook', name: 'New York Notebook' },
  { url: 'https://www.thedailybeast.com/arc/outboundfeeds/rss/articles/', outletId: 'dailybeast', name: 'The Daily Beast' },
  { url: 'https://mashable.com/feeds/rss/entertainment', outletId: 'mashable', name: 'Mashable Entertainment' },
  { url: 'https://www.interestedbystander.com/feeds/posts/default', outletId: 'the-interested-bystander', name: 'The Interested Bystander' },
  // Blogger feeds probed 2026-11-04 (200, 25 items each), both missed on time in the 2026 shadow replays (A Few Good Men,
  // The Imaginary Invalid). Bob's titles each review with the show alone ("A Few Good Men") and also posts show-named
  // news ("Theater Bulletin: ..."), so its items count as reviews only when the headline is the show title by itself.
  { url: 'https://www.jkstheatrescene.com/feeds/posts/default?alt=rss', outletId: 'jks-theatre-scene', name: "JK's Theatre Scene" },
  { url: 'https://gotham-playgoer.blogspot.com/feeds/posts/default?alt=rss', outletId: 'bobs-theater-blog', name: "Bob's Theater Blog", titledReviews: true },
];

// On-time outlets the lane cannot poll for free, and what finds them instead. A gap needs a reason a reader can check.
const LANE_SOURCE_GAPS = {
  talkinbroadway: "own adapter (talkinBroadwayAdapter probes the site's review index); its feed answers 403",
  'new-york-sun': 'nysun.com answers 429 to datacenter fetches (feed and arts section, probed 2026-11-03); Google News and SERP',
  cititour: 'cititour.com answers 403 to datacenter fetches (feed and section pages, probed 2026-11-03); Playbill Verdict and SERP',
  ew: 'ew.com answers 402 to datacenter fetches (feed and theater section, probed 2026-11-03); Google News and SERP',
  people: 'people.com answers 402 to datacenter fetches (feed and theater section, probed 2026-11-03); Google News and SERP',
  usatoday: 'usatoday.com answers 402 to datacenter fetches (feed and theater section, probed 2026-11-03); BWW roundup and SERP',
  purewow: 'purewow.com has no feed (404, probed 2026-11-03) and no theater section; SERP',
};

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

/**
 * Feeds the lane reads for this show: rss-discovery.js ALL_FEEDS for the market (as before), then LANE_FEEDS for outlets
 * in the market. Extra feeds are fetched direct only (`directOnly`), so a feed that
 * refuses us costs nothing per pass (one the runner cannot reach at all gets a rested paid read, discovery.js
 * PAID_FEED_REST_PASSES); the ALL_FEEDS entries keep the regular fallback chain.
 */
function laneFeeds(show) {
  const market = laneMarket(show);
  const base = ALL_FEEDS.filter((f) => !f.market || f.market === market)
    .map((f) => ({ url: f.url, outletId: f.outletId, name: f.name, ...(f.reviewsOnly ? { reviewsOnly: true } : {}) }));
  const haveOutlet = new Set(base.map((f) => f.outletId));
  const haveUrl = new Set(base.map((f) => f.url));
  for (const f of LANE_FEEDS) {
    if (haveOutlet.has(f.outletId) || haveUrl.has(f.url) || !outletInMarket(f.outletId, market)) continue;
    haveOutlet.add(f.outletId); haveUrl.add(f.url);
    base.push({ url: f.url, outletId: f.outletId, name: f.name, directOnly: true, ...(f.titledReviews ? { titledReviews: true } : {}) });
  }
  return base;
}

/** Section pages for this show: tier-1 pages for eligible tier-1 outlets, then LANE_SECTION_INDEXES for outlets in the market. */
function laneSectionIndexes(show, { eligibleT1 } = {}) {
  const market = laneMarket(show);
  const registry = REGISTRY();
  const out = Object.entries(T1_SECTION_INDEXES)
    .filter(([id]) => (eligibleT1 ? eligibleT1.has(id) : outletInMarket(id, market)) && registry[id] && registry[id].tier === 1)
    .map(([outletId, indexUrl]) => ({ outletId, indexUrl, pinned: true }));
  const have = new Set(out.map((o) => o.outletId));
  for (const [outletId, indexUrl] of Object.entries(LANE_SECTION_INDEXES)) {
    if (have.has(outletId) || !outletInMarket(outletId, market)) continue;
    have.add(outletId);
    out.push({ outletId, indexUrl });
  }
  return out;
}

/**
 * For each outlet id: the lane sources that can find it on the night ('feed', 'section-index'), or its gap reason.
 * A feed or page counts for an outlet when its outlet id matches or its host is the outlet's registry domain.
 */
function laneSourceCoverage(outletIds, show = { category: 'broadway' }) {
  const registry = REGISTRY();
  const feeds = laneFeeds(show);
  const pages = laneSectionIndexes(show);
  const result = { covered: {}, gaps: {}, missing: [] };
  for (const id of outletIds) {
    const domain = registry[id] && registry[id].domain && registry[id].domain.replace(/^www\./, '');
    const hits = (list, urlKey, kind) => list.filter((s) => s.outletId === id || (domain && hostOf(s[urlKey]) === domain)).map((s) => `${kind} ${s[urlKey]}`);
    const sources = [...hits(feeds, 'url', 'feed'), ...hits(pages, 'indexUrl', 'section-index')];
    if (sources.length) result.covered[id] = sources;
    else if (LANE_SOURCE_GAPS[id]) result.gaps[id] = LANE_SOURCE_GAPS[id];
    else result.missing.push(id);
  }
  return result;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Outlets whose review went up on time (publish date from the day before to the day after opening) on at least `minNights` Broadway
 * openings in [since, until]. Pure: reviews.json rows and shows.json shows in, sorted [{ outletId, nights }] out.
 */
function onTimeOutlets(reviews, shows, { since, until, minNights = 2, category = 'broadway' } = {}) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const nights = new Map();
  for (const r of reviews) {
    const show = byId.get(r.showId);
    if (!show || show.category !== category || !show.openingDate || !r.publishDate || !r.outletId) continue;
    const night = String(show.openingDate).slice(0, 10);
    if ((since && night < since) || (until && night > until)) continue;
    const day = String(r.publishDate).slice(0, 10);
    // Day precision only: a month-only date ('2026-10') would compare as on time. Before the night minus a day is a
    // feature or a wrong date, not an opening-night review.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const nightPlus1 = new Date(Date.parse(night) + DAY_MS).toISOString().slice(0, 10);
    const nightMinus1 = new Date(Date.parse(night) - DAY_MS).toISOString().slice(0, 10);
    if (day > nightPlus1 || day < nightMinus1) continue;
    if (!nights.has(r.outletId)) nights.set(r.outletId, new Set());
    nights.get(r.outletId).add(show.id);
  }
  return [...nights].map(([outletId, ids]) => ({ outletId, nights: ids.size }))
    .filter((o) => o.nights >= minNights)
    .sort((a, b) => b.nights - a.nights || a.outletId.localeCompare(b.outletId));
}

module.exports = {
  onTimeOutlets,
  T1_SECTION_INDEXES, LANE_SECTION_INDEXES, LANE_FEEDS, LANE_SOURCE_GAPS,
  laneMarket, outletInMarket, laneFeeds, laneSectionIndexes, laneSourceCoverage,
};
