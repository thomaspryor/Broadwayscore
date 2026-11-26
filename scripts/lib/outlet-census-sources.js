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
  // Slant's sitemaps, wp-json, feeds and section pages all 403 a direct client (probed 2026-10-30,
  // BRO-6514), but the Yoast sitemap index and its post-sitemap children read fine through the
  // poller's proxy chain (BRO-7812, probed 2026-11-19: 33 children, 238 /theater/ URLs). Google
  // (the BRO-6514 answer) returns ~10 results a query, so it could never list a 14-year archive:
  // Dan Rubins's Call Me Izzy review (2025-06-13) sat undiscovered until a reader reported it.
  // Slug stands in for the headline (no paid per-page fetch); the filter keeps /theater/<slug> only,
  // and the headline must still say "review" (sourceSaysReview stays off: the section also holds
  // interviews and festival previews).
  slantmagazine: {
    kind: 'sitemap', url: 'https://www.slantmagazine.com/sitemap_index.xml', proxyRetry: true,
    childFilter: /post-sitemap\d*\.xml/, urlFilter: /slantmagazine\.com\/theater\/[^/]+\/?$/, headlineFromSlug: true,
    ignoreLastmod: true, // sitemap lastmod is bulk-touched: poller arm dates items from the page, not lastmod
    tailChildren: 2, // the poller's census arm reads the newest 2 children only (see sitemapFileItems)
  },
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
  // ── BRO-7816: outlets the BRO-7812 blind-outlet table flagged, probed 2026-11-19 with
  // `outlet-census.js --probe` and the poller's proxy chain (fetchXmlWithProxyRetry). Site-scoped Google
  // (the BRO-6485 answer) returns ~10 results a query, so it could never list an archive; where a
  // sitemap reads, it replaces it. Where none does, the entry below says exactly what the probe saw.
  // NYT: the monthly gzip sitemaps 403 a direct client but read through the proxy chain (1.4MB each);
  // section is in the URL (/YYYY/MM/DD/theater/), so no per-page fetch is needed.
  nytimes: {
    kind: 'sitemap', url: 'https://www.nytimes.com/sitemaps/new/sitemap.xml.gz', proxyRetry: true,
    childFilter: (c, since) => { const m = /sitemap-(\d{4})-(\d{2})\.xml/.exec(c); return !!m && `${m[1]}-${m[2]}` >= String(since).slice(0, 7); },
    urlFilter: /nytimes\.com\/\d{4}\/\d{2}\/\d{2}\/theater\/[^/?#]+\.html$/, headlineFromSlug: true,
    ignoreLastmod: true, // lastmod is bulk-touched on old months (2025-03 file carries 2026-11-19)
  },
  // Washington Post: monthly sitemaps (sitemap.xml.gz index), section in the URL (/theater-dance/ in 2022-23, /entertainment/theater/ since); DC-heavy, so NYC signal required.
  washpost: {
    kind: 'sitemap', url: 'https://www.washingtonpost.com/sitemaps/sitemap.xml.gz', proxyRetry: true,
    childFilter: (c, since) => { const m = /sitemap-(\d{4})-(\d{2})\.xml/.exec(c); return !!m && `${m[1]}-${m[2]}` >= String(since).slice(0, 7); },
    urlFilter: /washingtonpost\.com\/(?:entertainment\/theater|theater-dance)\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/, headlineFromSlug: true, requireNycSignal: true,
    ignoreLastmod: true,
    // Direct fetches of /sitemaps/ hang, and domain-tier-skip.json has Bright Data and ScrapingBee off for the host
    // (learned from paywalled article pages), so only Playwright ran and failed (HTTP2 error). Bright Data reads
    // the sitemaps (probed 2026-11-21: 200, a valid sitemapindex), so this source opts those tiers back in.
    ignoreDomainSkips: ['brightdata', 'scrapingbee'], directTimeoutMs: 15000, childConcurrency: 6,
  },
  // Theatrely: one flat sitemap (2.9k URLs back to 2021-05), reviews under /post/. Reads direct.
  theatrely: { kind: 'sitemap', url: 'https://www.theatrely.com/sitemap.xml', urlFilter: /theatrely\.com\/post\/[^/]+$/, headlineFromSlug: true },
  // Broadway & Me: a Blogger review blog; its two sitemap pages list every post back to 2012. Reads direct.
  'broadway-and-me': { kind: 'sitemap', url: 'https://broadwayandme.blogspot.com/sitemap.xml', urlFilter: /broadwayandme\.blogspot\.com\/20\d\d\/\d\d\/[^/]+\.html$/, headlineFromSlug: true, sourceSaysReview: true },
  // Front Row Center: direct fetches get an sgcaptcha challenge; the proxy chain reads the 4 child sitemaps
  // (about 4k URLs, /YYYY/MM/slug/). A review blog, so every post counts.
  'front-row-center': {
    kind: 'sitemap', url: 'http://thefrontrowcenter.com/sitemap-index-1.xml', proxyRetry: true,
    urlFilter: /thefrontrowcenter\.com\/20\d\d\/\d\d\/[^/]+\/?$/, headlineFromSlug: true, sourceSaysReview: true,
  },
  // WSJ (PARTIAL: about 6% of corpus rows have a slug with no review/theater word and are not listed): monthly sitemaps (sitemap_wsj_en_m<M>_<YYYY>.xml, about 2.7k URLs, 1MB). Reviews are /articles/<slug>-review-...-<hex>
  // or /arts-culture/theater/; the slug is the headline.
  wsj: {
    kind: 'sitemap', url: 'https://www.wsj.com/sitemaps/web/wsj/en/sitemap_wsj_en_index.xml', proxyRetry: true,
    childFilter: (c, since) => { const m = /_m(\d{1,2})_(\d{4})\.xml/.exec(c); return !!m && `${m[2]}-${m[1].padStart(2, '0')}` >= String(since).slice(0, 7); },
    urlFilter: /wsj\.com\/(?:arts-culture\/theater\/|articles\/[^/]*(?:review|broadway|theater|theatre|musical)[^/]*$)/i, headlineFromSlug: true, ignoreLastmod: true,
  },
  // The New Yorker: 60 small monthly sitemaps; theatre reviews are /magazine/YYYY/MM/DD/<slug>-theatre-review, and
  // the capsule reviews /goings-on-about-town/theatre/. PARTIAL: a magazine piece whose slug omits "theatre" (about 1 in 4
  // of the corpus rows) is not listed without a paid page fetch per URL, so recall here reads high.
  newyorker: {
    kind: 'sitemap', url: 'https://www.newyorker.com/sitemap.xml', proxyRetry: true,
    childFilter: (c, since) => { const m = /sitemap-(\d{4})-(\d{2})\.xml/.exec(c); return !!m && `${m[1]}-${m[2]}` >= String(since).slice(0, 7); },
    urlFilter: /newyorker\.com\/(?:magazine\/\d{4}\/\d{2}\/\d{2}\/[^/]*(?:theatre|theater|broadway)[^/]*|goings-on-about-town\/theatre\/[^/]+)$/i, headlineFromSlug: true, ignoreLastmod: true,
  },
  // EW: 13 sitemaps of 20k URLs, no section and no dates, but review slugs name the genre
  // ("real-women-have-curves-review-musical-broadway-11722804"); the 2022-23 reviews sit under /theater/theater-reviews/.
  ew: {
    kind: 'sitemap', url: 'https://ew.com/sitemap.xml', proxyRetry: true,
    tailChildren: 2, // the live poller reads only the newest 2 of 13 big children (each about 20k URLs, proxyRetry)
    urlFilter: /ew\.com\/(?:theater\/[^?#]*[^/?#]+|[^/]*(?:review[^/]*(?:broadway|musical|theater|theatre)|(?:broadway|musical|theater|theatre)[^/]*review)[^/]*)\/?$/i, headlineFromSlug: true, ignoreLastmod: true,
  },
  // USA Today: monthly sitemaps on gannett-cdn.com (about 5k URLs, 2MB; they read direct). The section is unreliable
  // (Broadway reviews sit under /story/entertainment/music/ and /movies/ as well as /theater/), so the slug names the
  // genre; touring and regional coverage is common, so an NYC signal is required.
  usatoday: {
    kind: 'sitemap', url: 'https://www.usatoday.com/web-sitemap-index.xml', proxyRetry: true,
    childFilter: (c, since) => { const m = /web-sitemap-(\d{4})-(\d{2})\.xml/.exec(c); return !!m && `${m[1]}-${m[2]}` >= String(since).slice(0, 7); },
    urlFilter: /usatoday\.com\/story\/(?:entertainment|life)\/(?:theat(?:er|re)\/\d{4}\/\d{2}\/\d{2}\/[^/]+|[^/]+\/\d{4}\/\d{2}\/\d{2}\/[^/]*(?:broadway|theater|theatre|musical)[^/]*)\//i, headlineFromSlug: true, requireNycSignal: true, ignoreLastmod: true,
  },
  // ── Probed and still unreadable (reason = what the probe saw; BRO-7816). ──
  nypost: unreadable('sitemaps are daily (sitemap-YYYY.xml?mm=&dd=, about 1.9k since 2021) and carry the section (/entertainment/), so they are listable, but one paid proxy fetch per day is not run by the census'),
  nydailynews: unreadable('sitemaps are daily (sitemap.xml?yyyy=&mm=&dd=, about 1.9k since 2021) with no section in the URL, so one paid proxy fetch per day is needed and the stage reviews are only found by slug'),
  observer: unreadable('only a two-day news sitemap (observer.com/news-sitemap.xml) in robots.txt; no archive sitemap'),
  chicagotribune: unreadable('sitemap index lists daily sitemaps (10k days since 1999, one paid proxy fetch each); the Chicago paper reviews Broadway touring productions only'),
  guardian: unreadable('robots.txt lists only a news-window sitemap (theguardian.com/sitemaps/news.xml); the Content API lists the archive but needs GUARDIAN_API_KEY (the public test key answers HTTP 401, probed 2026-11-21) and the census job holds none'),
  latimes: unreadable('sitemap index lists 622 numbered sitemaps (sitemap-191412.xml) with no date or section in the names; a Los Angeles paper with few NYC reviews (80 corpus rows)'),
  talkinbroadway: unreadable('Cloudflare challenge on /sitemap.xml that every fetchPage tier fails (probed 2026-11-19), and robots.txt lists no sitemap'),
  cititour: unreadable('no sitemap (robots.txt lists none, /sitemap.xml answers 404); show pages under /NYC_Broadway are reached only by following links'),
  'new-york-sun': unreadable('yearly article sitemaps (/news/articles/sitemap/YYYY/N.xml, 500 URLs a page, about 10 pages a year) read through the proxy chain, but the index lists only page 0 per year and URLs (/article/<slug>) carry no section'),
  'times-square-chronicles': unreadable('sitemap (t2conline.com/sitemap.xml, read direct) lists about 1.2k URLs with no section, a fraction of the archive'),
  'la-voce-di-new-york': serp(['site:lavocedinewyork.com/en broadway review'], /lavocedinewyork\.com\/en\//),
  queerty: serp(['site:queerty.com broadway review'], /queerty\.com\//),
  // Its sitemap lists 8.8k opaque story.asp?ID= pages with no section, date or title (probed 2026-11-19).
  'lighting-and-sound-america': unreadable('sitemap lists 8.8k opaque story.asp?ID= pages with no section, date or title, all lastmod 2008-02-26'),
};

/**
 * London outlets (BRO-6488), census window 2012-09 to now. tier is the registry tier, so
 * `--all --tier=1` runs T1 first. The newspapers' sites refuse this cloud container (egress
 * policy), so they run on CI through cloud-run-script with --emit-items; their sitemap shapes
 * were confirmed from there with --probe before an entry left 'unreadable'.
 */

const LONDON_SOURCES = {
  // The Content API lists every review the Guardian and Observer ran (section stage, tone/reviews).
  // Web-first pieces carry 'theguardian.com', or 'guardian.co.uk' before July 2013 (BRO-6503).
  guardian: { kind: 'guardian-api', tier: 1, pollerReadable: true, publication: /^(the guardian|theguardian\.com|guardian\.co\.uk)$/i, sourceSaysReview: true },
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
  // Some press-night reviews are filed as news (BRO-8348: the-lives-of-others, /london/news/...-review-...-110326).
  'timeout-london': { kind: 'sitemap', tier: 1, url: 'https://www.timeout.com/london/sitemap.xml.gz', urlFilter: /timeout\.com\/london\/(?:theatre\/[^/]+|news\/[^/]*-review-[^/]+)$/, headlineFromSlug: true },
  artsdesk: { kind: 'sitemap', tier: 2, url: 'https://theartsdesk.com/sitemap.xml', urlFilter: /theartsdesk\.com\/theatre\/[^/]+$/, headlineFromSlug: true },
  'london-theatre': { kind: 'sitemap', tier: 2, url: 'https://www.londontheatre.co.uk/www.londontheatre.co.uk-sitemap.xml', urlFilter: /londontheatre\.co\.uk\/reviews\/[^/]+$/, headlineFromSlug: true, sourceSaysReview: true },
  'london-box-office': { kind: 'sitemap', tier: 2, url: 'https://www.londonboxoffice.co.uk/news-sitemap.xml', urlFilter: /londonboxoffice\.co\.uk\/news\/post\/[^/]*review[^/]*$/, headlineFromSlug: true, sourceSaysReview: true },
  thereviewshub: wp('https://www.thereviewshub.com/wp-json/wp/v2/posts', { tier: 2 }),
  'british-theatre': { kind: 'sitemap', tier: 2, url: 'https://www.britishtheatreguide.info/sitemap.xml.gz', urlFilter: /britishtheatreguide\.info\/reviews\/[^/]+$/, headlineFromSlug: true, sourceSaysReview: true },
  britishtheatrecom: { kind: 'sitemap', tier: 2, url: 'https://www.britishtheatre.com/sitemap-posts.xml', urlFilter: /britishtheatre\.com\/posts\/[^/]*review[^/]*\/?$/, headlineFromSlug: true, sourceSaysReview: true },
  'theatre-weekly': wp('https://theatreweekly.com/wp-json/wp/v2/posts', { tier: 3, linkFilter: /review/i, sourceSaysReview: true }),
  'everything-theatre': wp('https://everything-theatre.co.uk/wp-json/wp/v2/posts', { tier: 3, linkFilter: /review/i, sourceSaysReview: true }),
  'all-that-dazzles-uk': { kind: 'sitemap', tier: 3, url: 'https://www.allthatdazzles.co.uk/blog-posts-sitemap.xml', urlFilter: /review/i, headlineFromSlug: true, sourceSaysReview: true },
  'west-end-best-friend': { kind: 'sitemap', tier: 3, url: 'https://www.westendbestfriend.co.uk/sitemap.xml', urlFilter: /westendbestfriend\.co\.uk\/news\/review-[^/]+$/, headlineFromSlug: true, sourceSaysReview: true },
  // BRO-6488 round 2 (probed 2026-11-03): the Standard, Independent and i archive sitemaps,
  // enumerated on CI (the cloud container's egress refuses them). Each is dated by its own period (month or day),
  // and the slug is the headline, so the slug must say "review" (sourceSaysReview unset).
  standard: { kind: 'sitemap-dated', tier: 1, template: 'https://www.standard.co.uk/sitemaps/sitemap-articles-{yyyy}-{mm}.xml', step: 'month',
    urlFilter: /standard\.co\.uk\/(?:(?:culture|go\/london|goingout)\/)?theatre\/[^/?#]+$|standard\.co\.uk\/going-?out\/[^/?#]*(?:theatre|musical)-review[^/?#]*$/, headlineFromSlug: true },
  independent: { kind: 'sitemap-dated', tier: 1, template: 'https://www.independent.co.uk/sitemaps/sitemap-articles-{yyyy}-{mm}-{dd}.xml', step: 'day', concurrency: 8,
    urlFilter: /independent\.co\.uk\/(?:arts-entertainment\/theatre-dance\/(?:reviews\/)?[^/?#]+|independentpremium\/culture\/[^/?#]*review[^/?#]*)$/, headlineFromSlug: true },
  // Daily sitemaps start 2016-04 (the i's site launch); stage reviews sit under /culture/arts/ or bare /culture/.
  'i-paper': { kind: 'sitemap-dated', tier: 1, template: 'https://inews.co.uk/sitemap.xml?yyyy={yyyy}&mm={mm}&dd={dd}', step: 'day', start: '2016-03-01', concurrency: 8,
    urlFilter: /inews\.co\.uk\/culture\/(?:arts\/)?[^/?#]*review[^/?#]*$/, headlineFromSlug: true },
  // Express keeps monthly entertainment sitemaps back to 2012, but they answer HTTP 403 to the
  // census client from CI and from the cloud container (BRO-6488, 2026-11-03).
  'express-uk': { ...unreadable('monthly entertainment sitemaps (/entertainment/YYYYMM.xml) answer HTTP 403 to the census client from CI and the cloud container'), tier: 3 },
  // The theatre section sitemap lists every /theatre/ article (about 4.2k, lastmod back to 2015);
  // reviews from before the 2015 move to /theatre/ (/culture/theatre/...) are not listed. Read
  // from CI (the site refuses the cloud container); lastmod is a soft date.
  telegraph: { kind: 'sitemap', tier: 1, url: 'https://www.telegraph.co.uk/theatre/sitemap.xml', urlFilter: /telegraph\.co\.uk\/theatre\/[^?#]+$/, headlineFromSlug: true },
  'times-uk': { ...unreadable('robots.txt disallows every path to every agent (User-agent: * / Disallow: /; probed from CI 2026-11-03), so the census does not read thetimes.com'), tier: 1 },
  'sunday-times': { ...unreadable('robots.txt disallows every path to every agent (User-agent: * / Disallow: /; probed from CI 2026-11-03), so the census does not read thetimes.com'), tier: 1 },
  financialtimes: { ...unreadable('sitemaps list opaque /content/<uuid> URLs with no section or title (about 1M in window) and the /theatre stream answers HTTP 403'), tier: 1 },
  'daily-mail': { ...unreadable('only a two-day Google News sitemap (no archive sitemap), and robots.txt and the terms forbid automated scraping (probed from CI 2026-11-03)'), tier: 1 },
  'mail-on-sunday': { ...unreadable('only a two-day Google News sitemap (no archive sitemap), and robots.txt and the terms forbid automated scraping (probed from CI 2026-11-03)'), tier: 1 },
  'the-spectator-uk': unreadable('spectator.co.uk now redirects to spectator.com: post sitemaps list about 150k /article/<slug>/ URLs with no section, the theatre critics list is rendered by script, and the WordPress API answers HTTP 401'),
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
