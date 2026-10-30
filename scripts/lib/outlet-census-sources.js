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
 *   serp           site-scoped Google per quarter (paid, ScrapingDog first); title, snippet
 *                  and a URL/snippet/window date. For sites that refuse the census client.
 *   unreadable     no listing this census can read; the report records why.
 */

const wp = (apiBase, extra = {}) => ({ kind: 'wp-json', apiBase, ...extra });
const unreadable = (reason) => ({ kind: 'unreadable', reason });
const serp = (queries, urlFilter, extra = {}) => ({ kind: 'serp', queries, urlFilter, ...extra });

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
    proxyRetry: true, // the yearly sitemaps 403 direct clients; the poller's proxy chain reads them (BRO-6485)
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
  // ── BRO-6485: sitemaps and APIs for the outlets round 1 could not read ──────────
  timeout: {
    kind: 'sitemap', url: 'https://www.timeout.com/sitemap.xml.gz', // gzip index, one child per city
    childFilter: (c) => /timeout\.com\/newyork\//.test(c),
    // /newyork/theater/<show> is usually a listing with an unsigned blurb (BRO-6485: 111 of 119 gaps);
    // it is the show's review only when the page's JSON-LD Review names a critic.
    urlFilter: /timeout\.com\/newyork\/(?:theater\/[^/?#]+$|news\/[^/?#]*review)/, needsMeta: true, sourceSaysReview: true, requireReviewAuthor: true,
  },
  // WordPress.com-hosted blogs: no /wp-json on the site, but the public WP.com REST mirror lists every post.
  'pages-on-stages': wp('https://public-api.wordpress.com/wp/v2/sites/pagesonstages.com/posts', { sourceSaysReview: true }), // a reviews-only blog,
  frontmezzjunkies: wp('https://public-api.wordpress.com/wp/v2/sites/frontmezzjunkies.com/posts', { categories: [42035, 42036], sourceSaysReview: true }), // broadway, off broadway,
  'off-off-online': { kind: 'sitemap', url: 'https://www.offoffonline.com/sitemap.xml', urlFilter: /offoffonline\.com\/offoffonline\/20\d\d\/\d{1,2}\/\d{1,2}\/[^/]+$/, needsMeta: true, sourceSaysReview: true },
  // Sitemaps, wp-json, feeds and section pages all return HTTP 403 to the census client
  // (probed 2026-10-30, BRO-6514), so Slant is enumerated through Google like the others.
  slantmagazine: serp(['site:slantmagazine.com/theater review'], /slantmagazine\.com\/theater\/[^/]+\/?$/),
  // UK paper: only slugs naming a New York house or Broadway can be NYC reviews.
  thestage: { kind: 'sitemap', url: 'https://www.thestage.co.uk/SiteMap_TheStage_index.xml', childFilter: (c) => /Reviews/i.test(c), urlFilter: /thestage\.co\.uk\/reviews\/[^/]*(?:broadway|new-york|nyc|manhattan|brooklyn)/, headlineFromSlug: true, sourceSaysReview: true, requireNycSignal: true },
  'the-interested-bystander': { kind: 'sitemap', url: 'https://www.interestedbystander.com/sitemap.xml', urlFilter: /interestedbystander\.com\/20\d\d\/\d\d\/[^/]*(?:theater|theatre|broadway|musical|play)[^/]*\.html$/, needsMeta: true, sourceSaysReview: true },
  // DTLI is an aggregator: /shows/<show>/<slug>/ is the one URL shape for its own critics' reviews and
  // for its quote pages of other outlets' reviews, and no listing tells them apart (BRO-6485 probe).
  dtli: unreadable('aggregator: its own reviews and its quote pages of other outlets share one URL shape and listing'),
  // Daily Beast: one sitemap per day; no section in the URL, so the slug must look like stage.
  dailybeast: {
    kind: 'sitemap', url: 'https://www.thedailybeast.com/arc/outboundfeeds/sitemap-index?outputType=xml', childConcurrency: 8,
    childFilter: (c, since) => { const m = /\/(\d{4}-\d{2}-\d{2})\?/.exec(c); return !!m && m[1] >= String(since).slice(0, 10); },
    urlFilter: /thedailybeast\.com\/(?:obsessed\/)?[^/?#]*(?:broadway|musical|-play-|-play\/|theater|theatre|revival|on-stage)/, needsMeta: true,
  },
  // ── BRO-6485: site-scoped, quarter-windowed Google (kind 'serp') for outlets whose site,
  // sitemaps and API refuse the census client (HTTP 403 or challenge pages, probed
  // 2026-10-28). sourceSaysReview only where urlFilter is a reviews-only path or the site
  // publishes nothing else; elsewhere the headline must say "review", so recall there is
  // measured over the reviews Google titles as reviews.
  nytimes: serp(['site:nytimes.com theater review'], /nytimes\.com\/\d{4}\/\d{2}\/\d{2}\/theater\//),
  wsj: serp(['site:wsj.com theater review'], /wsj\.com\/(?:articles|arts-culture)\//),
  nypost: serp(['site:nypost.com broadway review'], /nypost\.com\/\d{4}\/\d{2}\/\d{2}\//),
  newyorker: serp(['site:newyorker.com/magazine theatre review'], /newyorker\.com\/magazine\/\d{4}\//),
  ew: serp(['site:ew.com broadway review'], /ew\.com\//),
  observer: serp(['site:observer.com broadway review'], /observer\.com\/\d{4}\/\d{2}\//),
  nydailynews: serp(['site:nydailynews.com broadway review'], /nydailynews\.com\//),
  chicagotribune: serp(['site:chicagotribune.com broadway review'], /chicagotribune\.com\//, { requireNycSignal: true }),
  guardian: serp(['site:theguardian.com/stage broadway review'], /theguardian\.com\/stage\/\d{4}\//, { requireNycSignal: true }),
  usatoday: serp(['site:usatoday.com broadway review'], /usatoday\.com\/story\//, { requireNycSignal: true }),
  latimes: serp(['site:latimes.com broadway review'], /latimes\.com\//, { requireNycSignal: true }),
  washpost: serp(['site:washingtonpost.com/theater-dance broadway'], /washingtonpost\.com\/theater-dance\/\d{4}\//, { requireNycSignal: true }),
  theatrely: serp(['site:theatrely.com/post review'], /theatrely\.com\/post\//),
  'new-york-sun': serp(['site:nysun.com broadway review'], /nysun\.com\/article\//),
  'times-square-chronicles': serp(['site:t2conline.com broadway review'], /t2conline\.com\//),
  'la-voce-di-new-york': serp(['site:lavocedinewyork.com/en broadway review'], /lavocedinewyork\.com\/en\//),
  queerty: serp(['site:queerty.com broadway review'], /queerty\.com\//),
  // Review-only paths: Talkin' Broadway's Broadway (world) and Off-Broadway (ob) columns,
  // Front Row Center and Broadway & Me (review blogs), CitiTour's show pages.
  talkinbroadway: serp(['site:talkinbroadway.com/page/world', 'site:talkinbroadway.com/page/ob'], /talkinbroadway\.com\/page\/(?:world|ob)\//, { sourceSaysReview: true }),
  'front-row-center': serp(['site:thefrontrowcenter.com'], /thefrontrowcenter\.com\/20\d\d\/\d\d\/[^/]+\/?$/, { sourceSaysReview: true }),
  'broadway-and-me': serp(['site:broadwayandme.blogspot.com'], /broadwayandme\.blogspot\.com\/20\d\d\/\d\d\//, { sourceSaysReview: true }),
  cititour: serp(['site:cititour.com/NYC_Broadway', 'site:cititour.com review'], /cititour\.com\/NYC_(?:Broadway|News\/Review)/i, { sourceSaysReview: true }),
  // Its sitemap lists 8.8k opaque story.asp?ID= pages with no section, date or title.
  'lighting-and-sound-america': serp(['site:lightingandsoundamerica.com broadway review'], /lightingandsoundamerica\.com\/news\/story\.asp/i),
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
  // Web-first pieces carry 'theguardian.com', or 'guardian.co.uk' before July 2013 (BRO-6503).
  guardian: { kind: 'guardian-api', tier: 1, publication: /^(the guardian|theguardian\.com|guardian\.co\.uk)$/i, sourceSaysReview: true },
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
