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

module.exports = { SOURCES };
