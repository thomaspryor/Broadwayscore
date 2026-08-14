/**
 * Playbill Verdict discovery + extraction helpers.
 *
 * Shared by scripts/scrape-playbill-verdict.js (batch/scheduled mode) and
 * scripts/opening-night-poller.js (per-show live discovery during an opening
 * window). Both paths hit the same Playbill "The Verdict" category page and
 * extract the same review-link anchors; factoring them here keeps a single
 * source of truth for the link-filter blocklist and the article selector.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { cleanSlugTitle, isVerdictReviewSlug } = require('./show-matching');

const VERDICT_CATEGORY_URL = 'https://playbill.com/category/the-verdict';

// playbill.com/sitemap.xml is a single, ~700-entry, site-WIDE sitemap (no
// index, no pagination — verified live 2026-08-14) mixing every content type
// (articles, productions, venues, galleries) with a real <lastmod>. It is
// NOT a full historical archive: old Verdict roundups fall out of the window
// as unrelated pages elsewhere on the site get touched. Filtering it to
// review-roundup slugs (isVerdictReviewSlug) supplements the category page's
// single-fetch, pre-scroll article list (~27-30 of the 100+ the category
// page shows after infinite-scroll JS the fetcher never executes) with
// articles the category page's first paint missed. Callers should union
// each day's sitemap hits with a persisted accumulator (see
// loadSitemapAccumulator/saveSitemapAccumulator below) since any single
// snapshot can miss an article that scrolls out of the 700-entry window
// before it's ever matched to a show.
const VERDICT_SITEMAP_URL = 'https://playbill.com/sitemap.xml';

function _urlToSlug(url) {
  return (url.split('/article/')[1] || '').replace(/[?#].*$/, '');
}

// Extract `{ url, title, slug }` for every Playbill Verdict article linked on
// the category-page HTML. Tolerates three encodings Playbill has used over
// time: HTML anchors, Markdown links (rendered API output), and bare URLs.
//
// `slug` is the raw URL slug; consumers should prefer matchSlugToShow against
// it (substring search) before falling back to matchTitleToShow against
// `title`. The Pattern-3 title is derived from `cleanSlugTitle`, which strips
// Playbill's recurring verb wrappers (`read-the-reviews-for-`,
// `reviews-what-do-the-critics-think-of-`, etc.). The raw slug→title-case
// fallback used to silently lose every OB roundup whose wrapper defeated
// fuzzy matching (e.g. Animal Wisdom, 2026-05-24 cached page).
function extractArticlesFromCategoryPage(content) {
  const articles = [];
  const seen = new Set();

  // Pattern 1: HTML links - <a href="/article/...">Title</a>
  const htmlPattern = /<a[^>]*href="((?:https:\/\/playbill\.com)?\/article\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = htmlPattern.exec(content)) !== null) {
    let url = match[1];
    if (url.startsWith('/')) url = `https://playbill.com${url}`;
    const title = match[2].trim();
    if (seen.has(url) || title.length < 5 || title.length > 200) continue;
    seen.add(url);
    articles.push({ url, title, slug: _urlToSlug(url) });
  }

  // Pattern 2: Markdown links - [Title](https://playbill.com/article/...)
  const mdPattern = /\[([^\]]+)\]\((https:\/\/playbill\.com\/article\/[^)]+)\)/gi;
  while ((match = mdPattern.exec(content)) !== null) {
    const title = match[1].trim();
    const url = match[2].trim();
    if (seen.has(url) || title.length < 5 || title.length > 200) continue;
    seen.add(url);
    articles.push({ url, title, slug: _urlToSlug(url) });
  }

  // Pattern 3: Bare Playbill article URLs
  const barePattern = /(https:\/\/playbill\.com\/article\/[a-z0-9-]+)/gi;
  while ((match = barePattern.exec(content)) !== null) {
    const url = match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const slug = _urlToSlug(url);
    articles.push({ url, title: cleanSlugTitle(slug) || slug, slug });
  }

  return articles;
}

// Extract `{ url, title, slug, publishDate }` for every /article/ URL in
// playbill.com/sitemap.xml whose slug matches a known Verdict review-wrapper
// pattern (isVerdictReviewSlug — read-the-reviews-for-, reviews-sound-off-on-,
// etc.). Unlike extractArticlesFromCategoryPage, sitemap <loc> entries carry
// no link text, so title is always the cleanSlugTitle best-guess.
function extractArticlesFromSitemap(xml) {
  const articles = [];
  if (!xml) return articles;
  const seen = new Set();
  const urlBlockPattern = /<url>([\s\S]*?)<\/url>/gi;
  let block;
  while ((block = urlBlockPattern.exec(xml)) !== null) {
    const locMatch = block[1].match(/<loc>(https:\/\/playbill\.com\/article\/[a-z0-9-]+)<\/loc>/i);
    if (!locMatch) continue;
    const url = locMatch[1];
    if (seen.has(url)) continue;
    const slug = _urlToSlug(url);
    if (!isVerdictReviewSlug(slug)) continue;
    seen.add(url);
    const lastmodMatch = block[1].match(/<lastmod>([^<]+)<\/lastmod>/i);
    articles.push({
      url,
      title: cleanSlugTitle(slug) || slug,
      slug,
      publishDate: lastmodMatch ? lastmodMatch[1].trim().slice(0, 10) : null,
    });
  }
  return articles;
}

// Persisted cross-day accumulator for sitemap-derived candidates. A single
// sitemap.xml fetch only covers whatever ~700 URLs are in the window at that
// moment (see VERDICT_SITEMAP_URL comment) — a Verdict roundup published
// several days ago may have already scrolled out by the time this runs.
// Union today's sitemap hits into the persisted set so a candidate survives
// until the caller removes it (e.g. once matched to a show and processed).
function loadSitemapAccumulator(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveSitemapAccumulator(statePath, articles) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(articles, null, 2));
  fs.renameSync(tmp, statePath);
}

// Merge freshly-fetched sitemap articles into the persisted accumulator
// (dedup by URL, stamping `firstSeen` on first sight) and persist the union.
// Returns the full accumulated list — callers feed this into their article
// pool alongside the category-page result.
function accumulateSitemapArticles(statePath, freshArticles) {
  const now = new Date().toISOString();
  const existing = loadSitemapAccumulator(statePath);
  const byUrl = new Map(existing.map(a => [a.url, a]));
  for (const a of freshArticles) {
    const prev = byUrl.get(a.url);
    byUrl.set(a.url, { ...a, firstSeen: prev?.firstSeen || now });
  }
  const merged = [...byUrl.values()];
  saveSitemapAccumulator(statePath, merged);
  return merged;
}

// Extract outbound review-link anchors from a Playbill Verdict article HTML.
// Returns `[{ url, outlet, outletDomain, critic, showId }]`. The caller is
// expected to run its own dedup + URL-year validation downstream.
function extractReviewLinksFromArticle(html, showId) {
  const reviews = [];
  const $ = cheerio.load(html);

  // Find all links in the article body
  const articleContent = $('article, .article-content, .article-body, .entry-content, main').first();
  const container = articleContent.length ? articleContent : $.root();

  container.find('a').each((_, el) => {
    const href = $(el).attr('href');
    const linkText = $(el).text().trim();

    if (!href || !linkText) return;

    // Skip non-review links: internal playbill, social media, ads, stores, platforms
    if (href.includes('playbill.com') || href.includes('playbillder.com') ||
        href.includes('playbillstore.com') || href.includes('playbilltravel.com')) return;
    if (href.includes('facebook.com') || href.includes('twitter.com') ||
        href.includes('instagram.com') || href.includes('youtube.com') ||
        href.includes('tiktok.com') || href.includes('threads.net')) return;
    if (href.includes('ticketmaster') || href.includes('telecharge') ||
        href.includes('todaytix') || href.includes('seatgeek')) return;
    if (href.includes('.ffm.to') || href.includes('spotify.com') ||
        href.includes('apple.com') || href.includes('amazon.com')) return;
    if (href.includes('americanrepertorytheater.org') || href.includes('americantheatrewing.org')) return;
    if (href.includes('wikipedia.org') || href.includes('google.com')) return;
    if (href.includes('playbillvault.com')) return;
    if (href.includes('eugeneoneillbroadway.com') || href.includes('2st.com') ||
        href.includes('roundabouttheatre.org') || href.includes('broadwayinhollywood.com') ||
        href.includes('minskoffbroadway.com') || href.includes('shubert.nyc')) return;
    if (href.includes('criterionticketing.com') || href.includes('didtheylikeit.com') ||
        href.includes('broadwaybox.com') || href.includes('nbc.com') ||
        href.includes('yahoo.com') || href.includes('people.com')) return;
    if (href.includes('tidd.ly') || href.includes('bit.ly') || href.includes('tinyurl.com') ||
        href.includes('stubhub') || href.includes('vividseat') ||
        href.includes('broadwaydirect.com') || href.includes('luckyseat.com') ||
        href.includes('rush.todaytix.com') || href.includes('lottery.broadwaydirect.com')) return;
    if (href.length < 20) return;

    // Must look like a review URL (contains a path, not just a domain)
    try {
      const urlObj = new URL(href);
      if (urlObj.pathname === '/' || urlObj.pathname === '') return;
    } catch (e) {
      return;
    }

    const parentText = $(el).parent().text().trim().slice(0, 300);

    let outlet = '';
    try {
      const domain = new URL(href).hostname.replace('www.', '');
      outlet = domain;
    } catch (e) {
      return;
    }

    // Pattern "Outlet (Critic Name)" — strip parenthetical critic name from link text.
    let critic = '';
    const parenMatch = parentText.match(/\(([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\)/);
    if (parenMatch) critic = parenMatch[1];

    const cleanOutlet = (linkText || outlet).replace(/\s*\([^)]+\)\s*$/, '');

    reviews.push({
      url: href,
      outlet: cleanOutlet,
      outletDomain: outlet,
      critic,
      showId,
    });
  });

  // Domain supplement — catch outlets in outlet-registry that the anchor-text walk
  // missed because their href resolved but their LINK TEXT didn't pass the heuristic.
  try {
    const { supplementOutletsFromAnchors } = require('./outlet-domain-supplement');
    const { resolveOutletFromUrl } = require('./review-normalization');
    const existingShape = reviews.map(r => ({ outletId: r.outletDomain ? resolveOutletFromUrl('https://' + r.outletDomain)?.outletId : null }));
    const { added, newReviews } = supplementOutletsFromAnchors({
      html,
      reviews: existingShape,
      showId,
      sourceName: 'playbill-verdict-domain-supplement',
      excludeDomains: ['playbill.com', 'playbillder.com', 'playbillstore.com', 'playbillvault.com'],
      urlTitleCheck: () => true,
      makeStub: (oid, url) => {
        let outletDomain = '';
        try { outletDomain = new URL(url).hostname.replace(/^www\./, ''); } catch {}
        return {
          url,
          outlet: oid,
          outletDomain,
          critic: '',
          showId,
        };
      },
    });
    reviews.push(...newReviews);
    if (added > 0) {
      console.log(`    [Playbill supplement] added ${added} outlet(s) missed by anchor-text walk`);
    }
  } catch (e) {
    console.log(`    [Playbill supplement] error (non-fatal): ${(e.message || '').substring(0, 100)}`);
  }

  return reviews;
}

/**
 * Per-show live discovery: fetch Playbill's Verdict category page, find a
 * matching article for `show`. Returns `{ articleUrl, articleTitle }` or null.
 *
 * Designed for opening-night-poller usage — keeps a small blast radius (one
 * category-page fetch + title match). Accepts an injectable `fetchHtml` for
 * testing; default reads via scripts/lib/scraper's BD→SB→Playwright chain so
 * Cloudflare gating goes through the same providers as other BWW/Playbill
 * fetches the poller already makes.
 */
async function searchPlaybillVerdict(show, opts = {}) {
  if (!show || !show.title) return null;

  const { matchTitleToShow, matchSlugToShow } = require('./show-matching');

  let fetchHtml = opts.fetchHtml;
  if (!fetchHtml) {
    const { fetchPage } = require('./scraper');
    fetchHtml = async (url) => {
      const r = await fetchPage(url, { skipVerify: true });
      return (r && r.content) || '';
    };
  }

  const html = await fetchHtml(VERDICT_CATEGORY_URL);
  if (!html) return null;

  // No size gate here — an empty/broken fetch produces zero articles from
  // extractArticlesFromCategoryPage, which the next check rejects. The size
  // gate in scrape-playbill-verdict.js (>500B) is a batch-mode zero-data
  // guard; the per-show path just fails open and moves on.
  const articles = extractArticlesFromCategoryPage(html);
  if (articles.length === 0) return null;

  // Accept both high- and medium-confidence matches here. The batch Playbill
  // scraper (scrape-playbill-verdict.js) rejects medium because it matches
  // every article against 700+ shows and medium gets false positives at that
  // fan-out. Per-show polling fans out against exactly one show, so a
  // medium-confidence match on a long article title like "Reviews: What Do
  // the Critics Think of Beaches on Broadway?" is the expected hit, not noise.
  // Downstream extractReviewLinksFromArticle validates further by producing
  // zero links if the article doesn't actually cover this show.
  for (const article of articles) {
    // Try slug-substring match first. Catches OB roundup slugs (e.g.
    // `read-reviews-for-heather-christians-animal-wisdom`) whose Playbill verb
    // wrappers defeat fuzzy title matching even at single-show fan-out.
    const slugMatch = article.slug ? matchSlugToShow(article.slug, [show]) : null;
    if (slugMatch) {
      return { articleUrl: article.url, articleTitle: article.title };
    }
    const match = matchTitleToShow(article.title, [show]);
    if (match && (match.confidence === 'high' || match.confidence === 'medium')) {
      return { articleUrl: article.url, articleTitle: article.title };
    }
  }
  return null;
}

module.exports = {
  VERDICT_CATEGORY_URL,
  VERDICT_SITEMAP_URL,
  extractArticlesFromCategoryPage,
  extractArticlesFromSitemap,
  loadSitemapAccumulator,
  saveSitemapAccumulator,
  accumulateSitemapArticles,
  extractReviewLinksFromArticle,
  searchPlaybillVerdict,
};
