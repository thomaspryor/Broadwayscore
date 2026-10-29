'use strict';

const { WP_SEARCH_SOURCES } = require('./outlet-ground-truth');

/**
 * Per-outlet enumeration sources for the outlet census (BRO-6481). Each entry names
 * the cheapest source that lists EVERY theater review the outlet published, not just
 * the recent ones the poller reads. Filters are deliberately looser than the poller's
 * (outlet-listing-poller.js OUTLET_STRATEGY_CONFIG): the census exists to find what
 * those filters drop.
 *
 * kinds:
 *   wp-json        WordPress REST posts, optionally one category and a link filter;
 *                  headline/date in the API.
 *   sitemap-years  one sitemap per year, fetched through the poller's fetchViaSitemap;
 *                  URLs and lastmod only (needsMeta or headlineFromSlug).
 *   sitemap        one sitemap (or index) with a URL filter; needsMeta.
 *   unreadable     no listing this census can read; the report records why.
 */

const wp = (apiBase, extra = {}) => ({ kind: 'wp-json', apiBase, ...extra });
const unreadable = (reason) => ({ kind: 'unreadable', reason });

const SOURCES = {
  theatermania: {
    kind: 'wp-json',
    apiBase: 'https://www.theatermania.com/wp-json/wp/v2/news', // custom post type; /posts is empty
    categories: [157], // "reviews" (9k+ posts); checked 2026-10-28
    sourceSaysReview: true,
  },
  vulture: {
    kind: 'sitemap-years',
    urlTemplate: (year) => `https://www.vulture.com/sitemaps/sitemap-${year}.xml`,
    // Every slug that could be a stage review; the page headline decides.
    urlFilter: /review|theater|theatre|broadway|play|musical/i,
    // Article pages 403 direct clients; Vulture slugs carry the title ("theater-review-giant-
    // broadway"), so the slug stands in for the headline and lastmod for a soft date.
    headlineFromSlug: true,
  },
  nytg: {
    kind: 'sitemap',
    url: 'https://www.newyorktheatreguide.com/www.newyorktheatreguide.com-sitemap.xml',
    urlFilter: /\/reviews\/[^/]+$/,
    needsMeta: true,
    sourceSaysReview: true,
  },
  // WordPress outlets found by probing /wp-json on 2026-10-28; ids are each site's own
  // theater or review taxonomy term. sourceSaysReview only where the term is reviews-only;
  // requireNycSignal for outlets that mostly review other markets (LA, Chicago, DC, opera, UK).
  'theater-scene': wp('https://www.theaterscene.net/wp-json/wp/v2/posts'),
  'theater-life': wp('https://theaterlife.com/wp-json/wp/v2/posts', { categories: [2], sourceSaysReview: true }),
  culturesauce: wp('https://culturesauce.net/wp-json/wp/v2/posts', { categories: [14694] }),
  thewrap: wp('https://www.thewrap.com/wp-json/wp/v2/posts', { categories: [284237] }),
  // Exeunt NYC reviews are a custom post type the REST API does not expose.
  'exeunt-magazine': { kind: 'sitemap', url: 'https://exeuntnyc.com/sitemap_index.xml', urlFilter: /exeuntnyc\.com\/reviews\/[^/]+\/?$/, needsMeta: true, sourceSaysReview: true },
  variety: wp('https://variety.com/wp-json/wp/v2/posts', { params: { vertical: 251391 }, linkFilter: /variety\.com\/\d{4}\/legit\/reviews\//, sourceSaysReview: true }),
  deadline: wp('https://deadline.com/wp-json/wp/v2/posts', { params: { vertical: 388755935 } }),
  'hollywood-reporter': wp('https://www.hollywoodreporter.com/wp-json/wp/v2/posts', { categories: [65849] }),
  'one-minute-critic': wp('https://1minutecritic.com/wp-json/wp/v2/posts', { categories: [3], sourceSaysReview: true }),
  'theater-pizzazz': wp('https://theaterpizzazz.com/wp-json/wp/v2/posts', { categories: [73], sourceSaysReview: true }),
  amny: wp('https://www.amny.com/wp-json/wp/v2/posts', { categories: [3690] }),
  'theatre-reviews-limited': wp('https://www.theatrereviews.com/wp-json/wp/v2/posts'),
  stageandcinema: wp('https://stageandcinema.com/wp-json/wp/v2/posts', { categories: [26213], requireNycSignal: true }),
  'the-recs': wp('https://therecs.co.uk/wp-json/wp/v2/posts', { categories: [582], requireNycSignal: true }),
  'the-komisar-scoop': wp('https://www.thekomisarscoop.com/wp-json/wp/v2/posts', { categories: [51] }),
  stagebuddy: wp('https://stagebuddy.com/wp-json/wp/v2/posts', { categories: [14], linkFilter: /stagebuddy\.com\/theater\/theater-review\//, sourceSaysReview: true }),
  'dc-theater-arts': wp('https://dctheaterarts.org/wp-json/wp/v2/posts', { categories: [18], sourceSaysReview: true, requireNycSignal: true }),
  operawire: wp('https://operawire.com/wp-json/wp/v2/posts', { categories: [73], requireNycSignal: true }),
  broadwaynews: { kind: 'sitemap', url: 'https://www.broadwaynews.com/sitemap.xml', urlFilter: /review/i, needsMeta: true },
  // The same WP endpoints and review-URL filters the ground-truth audit reads.
  ...Object.fromEntries(WP_SEARCH_SOURCES.filter((w) => w.market === 'nyc' && w.outletId !== 'theatermania')
    .map((w) => [w.outletId, { kind: 'wp-json', apiBase: w.api, linkFilter: w.linkFilter, sourceSaysReview: true }])),
  // Probed 2026-10-28 from a cloud container: no listing readable without a bot-block bypass,
  // which the census does not attempt. CI runs may reach some of these (see the spec).
  ...Object.fromEntries(['nytimes', 'talkinbroadway', 'wsj', 'nypost', 'ew', 'chicagotribune', 'guardian', 'observer',
    'newyorker', 'nydailynews', 'usatoday', 'latimes'].map((id) => [id, unreadable('site and robots.txt return HTTP 403 to the census client')])),
  ...Object.fromEntries(['theatrely', 'broadway-and-me', 'new-york-sun', 'times-square-chronicles', 'front-row-center']
    .map((id) => [id, unreadable('site answers HTTP 429/503/202 challenge pages to the census client')])),
  ...Object.fromEntries(['la-voce-di-new-york', 'queerty'].map((id) => [id, unreadable('WordPress API has no theater taxonomy and the post stream is 20k+ items')])),
  ...Object.fromEntries(['timeout', 'washpost', 'dailybeast', 'pages-on-stages', 'off-off-online', 'lighting-and-sound-america', 'cititour',
    'frontmezzjunkies', 'slantmagazine', 'thestage', 'the-interested-bystander', 'dtli']
    .map((id) => [id, unreadable('no WordPress API; sitemap enumeration not yet configured')])),
};

/**
 * London outlets (BRO-6488), census window 2012-09 to now. tier is the registry tier, so
 * `--all --tier=1` runs T1 first. The newspapers' sites refuse this cloud container (egress
 * policy), so they run on CI through cloud-run-script with --emit-items; their sitemap shapes
 * were confirmed from there with --probe before an entry left 'unreadable'.
 */
const ciOnly = (tier, reason = 'site refused from the cloud container; enumerate on CI (--probe first)') => ({ kind: 'unreadable', tier, reason });

const LONDON_SOURCES = {
  // The Content API lists every review the Guardian and Observer ran (section stage, tone/reviews).
  guardian: { kind: 'guardian-api', tier: 1, publication: /^the guardian$/i, sourceSaysReview: true },
  observer: { kind: 'guardian-api', tier: 2, publication: /observer/i, sourceSaysReview: true },
  whatsonstage: (() => {
    const w = WP_SEARCH_SOURCES.find((x) => x.outletId === 'whatsonstage');
    // Every news post, not just "-review_" slugs: reviews before about 2020 have bare title
    // slugs (/news/42nd-street-theatre-royal-drury-lane_43290/), so the headline decides.
    // urlId matches the article number the old /london-theatre/reviews/ URLs carried.
    return { kind: 'wp-json', tier: 2, apiBase: w.api, urlId: '_(\\d{4,})(?:\\.html|/)?$' };
  })(),
  // The Stage's review sitemap starts 2021-10; earlier reviews come from the Wayback index
  // (free; web.archive.org is refused here, so the full run is on CI).
  thestage: { kind: 'composite', tier: 1, urlFilter: /thestage\.co\.uk\/(?:long-)?reviews\/(?:reviews\/|20\d\d\/|review\.php\/\d+\/)?[^/?#]+\/?$/, headlineFromSlug: true, sourceSaysReview: true,
    parts: [
      { kind: 'sitemap', url: 'https://www.thestage.co.uk/SiteMap_TheStage_index.xml', childFilter: /Reviews/i },
      { kind: 'cdx', prefixes: ['thestage.co.uk/reviews/', 'thestage.co.uk/long-reviews/'], cdxCanonicalHost: 'www.thestage.co.uk', until: '2022-06-30' },
    ] },
  // Time Out keeps a page per production under /london/theatre/; reviews carry "-review" only
  // from about 2016, so every page is listed and the slug title decides the match.
  'timeout-london': { kind: 'sitemap', tier: 1, url: 'https://www.timeout.com/london/sitemap.xml.gz', urlFilter: /timeout\.com\/london\/theatre\/[^/]+$/, headlineFromSlug: true },
  artsdesk: { kind: 'sitemap', tier: 2, url: 'https://theartsdesk.com/sitemap.xml', urlFilter: /theartsdesk\.com\/theatre\/[^/]+$/, headlineFromSlug: true },
  'london-theatre': { kind: 'sitemap', tier: 2, url: 'https://www.londontheatre.co.uk/www.londontheatre.co.uk-sitemap.xml', urlFilter: /londontheatre\.co\.uk\/reviews\/[^/]+$/, headlineFromSlug: true, sourceSaysReview: true },
  'london-box-office': { kind: 'sitemap', tier: 2, url: 'https://www.londonboxoffice.co.uk/news-sitemap.xml', urlFilter: /londonboxoffice\.co\.uk\/news\/post\/[^/]*review[^/]*$/, headlineFromSlug: true, sourceSaysReview: true },
  thereviewshub: wp('https://www.thereviewshub.com/wp-json/wp/v2/posts', { tier: 2 }),
  'british-theatre': { kind: 'sitemap', tier: 2, url: 'https://www.britishtheatreguide.info/sitemap.xml.gz', urlFilter: /britishtheatreguide\.info\/reviews\/[^/]+$/, headlineFromSlug: true, sourceSaysReview: true },
  britishtheatrecom: { kind: 'sitemap', tier: 2, url: 'https://britishtheatre.com/sitemap-0.xml', urlFilter: /britishtheatre\.com\/posts\/[^/]*review[^/]*\/?$/, headlineFromSlug: true, sourceSaysReview: true },
  'theatre-weekly': wp('https://theatreweekly.com/wp-json/wp/v2/posts', { tier: 3, linkFilter: /review/i, sourceSaysReview: true }),
  'everything-theatre': wp('https://everything-theatre.co.uk/wp-json/wp/v2/posts', { tier: 3, linkFilter: /review/i, sourceSaysReview: true }),
  'all-that-dazzles-uk': { kind: 'sitemap', tier: 3, url: 'https://www.allthatdazzles.co.uk/blog-posts-sitemap.xml', urlFilter: /review/i, headlineFromSlug: true, sourceSaysReview: true },
  'west-end-best-friend': { kind: 'sitemap', tier: 3, url: 'https://www.westendbestfriend.co.uk/sitemap.xml', urlFilter: /westendbestfriend\.co\.uk\/news\/review-[^/]+$/, headlineFromSlug: true, sourceSaysReview: true },
  telegraph: ciOnly(1),
  standard: ciOnly(1),
  'times-uk': ciOnly(1),
  'sunday-times': ciOnly(1),
  financialtimes: ciOnly(1),
  'daily-mail': ciOnly(1),
  'mail-on-sunday': ciOnly(1),
  independent: ciOnly(1),
  'i-paper': ciOnly(1),
  'express-uk': ciOnly(3),
  'the-spectator-uk': ciOnly(2, 'WordPress API needs a login; sitemap_index.xml to probe from CI'),
  londontheatre1: unreadable('site answers an sgcaptcha 202 challenge to the census client'),
  broadwayworld: unreadable('Cloudflare challenge; the BWW reviews pages are read per show by gather-reviews instead'),
};
for (const [id, src] of Object.entries(LONDON_SOURCES)) if (src.kind === 'unreadable' && src.tier == null) LONDON_SOURCES[id] = { ...src, tier: 2 };

/** An ad hoc --source given as JSON: string regexes (urlFilter, linkFilter, childFilter, publication) become RegExp. */
function sourceFromJson(obj) {
  const out = { ...obj };
  for (const k of ['urlFilter', 'linkFilter', 'childFilter', 'publication']) {
    if (typeof out[k] === 'string') out[k] = new RegExp(out[k], 'i');
  }
  return out;
}

module.exports = { SOURCES, LONDON_SOURCES, sourceFromJson };
