'use strict';

/**
 * Census listing source for the daily outlet poller (BRO-7076).
 *
 * The outlet census (scripts/outlet-census.js) knows, per outlet, a free source that lists
 * EVERY review the outlet published: a wp-json posts endpoint or a sitemap. The poller's
 * feeds can be short (a 1-3 day RSS window), stale or absent, and one missed run then loses
 * a review for good. This module lets the poller read the census source over its lookback
 * window and feed the items through its OWN matcher, lane rules, guards and review-file
 * writer. It never ingests census gap lines (census matching is looser than the poller's).
 *
 * Rules:
 *   - free kinds only: wp-json, sitemap, sitemap-years, sitemap-dated. Never 'serp' (paid).
 *   - every fetch goes through functions the caller injects (the poller's fetchXmlWithProxyRetry /
 *     fetchViaSitemap), so there is no HTTP client of its own.
 *   - no per-page meta fetch: the slug stands in for a missing headline.
 *   - kill switch: CENSUS_LISTING_DISABLED=1.
 */

const { SOURCES, LONDON_SOURCES } = require('./outlet-census-sources');
const {
  isFeedStale,
  itemReadsAsReview,
  publishedInRunWindow,
  headlineLooksLikeNews,
  parseWpApiPosts,
  parseSitemapXml,
  looksLikeSitemap,
  titleForms,
} = require('./outlet-listing-helpers');

const FREE_KINDS = new Set(['wp-json', 'sitemap', 'sitemap-years', 'sitemap-dated']);
const MAX_WP_PAGES = 8;            // 800 posts per outlet per run
const MAX_SITEMAP_CHILDREN = 40;
const MAX_DATED_SITEMAPS = 70;     // one per day for a 60 day lookback
const DAY_MS = 86400000;

// A round-up lists many reviews; it is never one show's review.
const ROUNDUP_RE = /\b(?:review|reviews|critics?)[\s_-]*(?:round[\s_-]?up|roundup)\b|\bround[\s_-]?up\b|\bcritics[\s_-]+(?:say|verdict|views?)\b|\bwhat[\s_-]+the[\s_-]+critics\b|\breviews?[\s_-]+(?:of|from)[\s_-]+the[\s_-]+week\b/i;

function isDisabled(env = process.env) {
  return /^(1|true)$/i.test(String(env.CENSUS_LISTING_DISABLED || ''));
}

/** The census source for an outlet when it is a free kind the poller may read; else null. */
function censusSourceFor(outletId, { sources = SOURCES, londonSources = LONDON_SOURCES } = {}) {
  // An outlet may be in both tables (NYC and London); take the first one that is a free kind.
  const src = [sources[outletId], londonSources[outletId]].find((c) => c && FREE_KINDS.has(c.kind));
  if (!src) return null;
  const urls = [].concat(src.url || []);
  if (src.kind === 'sitemap' && urls.some((u) => /\.gz(?:$|\?)/i.test(u))) return null; // gzip sitemaps are not read here
  if (src.kind === 'sitemap' && urls.length === 0) return null;
  if (src.kind === 'wp-json' && !src.apiBase) return null;
  return src;
}

/**
 * Why (if at all) the census source should be read for this outlet this run.
 *   no-feed      the poller has no feed or API entry for the outlet
 *   feed-error   the feed fetch threw
 *   stale        the feed's newest matching item is old while the outlet still publishes
 *   short-span   the feed's oldest item is newer than the lookback, so older days are unseen
 *   none         feed is fine, no census source, or kill switch set
 */
function shouldUseCensus({ outletId, hasFeed, health = null, latestReviewDate = null, lookbackDays, now = Date.now(), env = process.env, sources, londonSources }) {
  if (isDisabled(env)) return { use: false, reason: 'none' };
  if (!censusSourceFor(outletId, { sources, londonSources })) return { use: false, reason: 'none' };
  if (!hasFeed) return { use: true, reason: 'no-feed' };
  if (!health) return { use: false, reason: 'none' };
  if (health.error) return { use: true, reason: 'feed-error' };
  if (isFeedStale({ newestFiltered: health.newestFiltered, filteredCount: health.filteredCount, newestAny: health.newestAny, oldestAny: health.oldestAny, latestReviewDate, now })) {
    return { use: true, reason: 'stale' };
  }
  if (health.oldestAny) {
    const oldestMs = Date.parse(health.oldestAny);
    if (!isNaN(oldestMs) && now - oldestMs < lookbackDays * DAY_MS) return { use: true, reason: 'short-span' };
  }
  return { use: false, reason: 'none' };
}

/** Outlets that have a readable census source but no poller feed or API entry. */
function censusOnlyCandidates(hasFeed, { sources = SOURCES, londonSources = LONDON_SOURCES } = {}) {
  const ids = new Set([...Object.keys(sources), ...Object.keys(londonSources)]);
  return [...ids].filter((id) => !hasFeed(id) && censusSourceFor(id, { sources, londonSources })).sort();
}

/** Title-ish words from a URL's last path segment ("jane-eyre-review_123" -> "jane eyre review"). */
function headlineFromUrl(url) {
  let p = '';
  try { p = new URL(url).pathname; } catch { p = String(url || ''); }
  const seg = p.split('/').filter(Boolean).pop() || '';
  let dec = seg; try { dec = decodeURIComponent(seg); } catch { /* malformed %: keep the raw segment */ }
  return dec.replace(/\.(html?|php|aspx?)$/i, '').replace(/_\d+$/, '').replace(/[-_]+/g, ' ').trim();
}

function datedSitemapUrls(template, step, since, until) {
  // outlet-census.js requires the poller, so it is loaded on use, never at module load.
  return require('../outlet-census').datedSitemapUrls(template, step, since, until).slice(0, MAX_DATED_SITEMAPS);
}

const looksLikePostList = (body) => { try { return Array.isArray(JSON.parse(String(body || '').trim())); } catch { return false; } };

async function wpItems(src, cutoff, { fetchText, log }) {
  const items = [];
  for (let page = 1; page <= MAX_WP_PAGES; page++) {
    const q = new URLSearchParams({ per_page: '100', page: String(page), after: cutoff.toISOString().slice(0, 19), orderby: 'date', order: 'desc', _fields: 'link,date,title,excerpt' });
    if (src.categories) q.set('categories', src.categories.join(','));
    for (const [k, v] of Object.entries(src.params || {})) q.set(k, String(v));
    let body;
    try { body = await fetchText(`${src.apiBase}?${q}`, 'wp-api', looksLikePostList, { proxyRetry: !!src.proxyRetry }); } catch (e) {
      if (page === 1) throw e;
      log(`  [census] wp page ${page} failed: ${e.message}`);
      break;
    }
    const posts = JSON.parse(body);
    if (!Array.isArray(posts) || posts.length === 0) break;
    for (const it of parseWpApiPosts(posts, cutoff)) {
      if (src.linkFilter && !src.linkFilter.test(it.url)) continue;
      items.push(it);
    }
    if (posts.length < 100) break;
  }
  return items;
}

async function sitemapFileItems(url, src, cutoff, { fetchText, log }, depth = 0) {
  const raw = await fetchText(url, 'sitemap', looksLikeSitemap, { proxyRetry: !!src.proxyRetry });
  const xml = raw.replace(/<!\[CDATA\[\s*([^\]]*?)\s*\]\]>/g, '$1').replace(/&amp;/g, '&');
  if (/<sitemapindex/i.test(xml) && depth < 2) {
    const cf = src.childFilter;
    let children = [...xml.matchAll(/<loc>([^<]+)/g)].map((m) => m[1].trim())
      .filter((c) => !cf || (typeof cf === 'function' ? cf(c, cutoff.toISOString().slice(0, 10)) : cf.test(c)));
    // Prefer children that name reviews when the index has any; then cap.
    const reviewKids = children.filter((c) => /review/i.test(c));
    if (reviewKids.length) children = reviewKids;
    const out = [];
    for (const c of children.slice(0, MAX_SITEMAP_CHILDREN)) {
      try { out.push(...await sitemapFileItems(c, src, cutoff, { fetchText, log }, depth + 1)); } catch (e) { log(`  [census] child ${c}: ${e.message}`); }
    }
    return out;
  }
  return parseSitemapXml(xml, cutoff, src.urlFilter);
}

/**
 * Items the census source lists inside the lookback window: [{ url, headline, publishDate, viaCensus }].
 * deps: { fetchText(url, label, isExpected, {proxyRetry}), fetchViaSitemap(outletId, cfg, cutoff, opts), log }.
 */
async function enumerateCensusItems(outletId, cutoff, deps) {
  const src = censusSourceFor(outletId, deps.sourceOverrides);
  if (!src) return [];
  const d = { log: console.log, ...deps };
  let raw = [];
  if (src.kind === 'wp-json') raw = await wpItems(src, cutoff, d);
  else if (src.kind === 'sitemap-years') {
    raw = await d.fetchViaSitemap(outletId, { urlTemplate: src.urlTemplate, urlFilter: src.urlFilter }, cutoff, { proxyRetry: !!src.proxyRetry });
  } else if (src.kind === 'sitemap-dated') {
    const from = src.start && src.start > cutoff.toISOString().slice(0, 10) ? src.start : cutoff.toISOString().slice(0, 10);
    for (const u of datedSitemapUrls(src.template, src.step || 'month', from, src.until)) {
      try { raw.push(...await sitemapFileItems(u, src, cutoff, d, 1)); } catch (e) { d.log(`  [census] ${u}: ${e.message}`); }
    }
  } else {
    for (const u of [].concat(src.url)) raw.push(...await sitemapFileItems(u, src, cutoff, d));
  }
  const seen = new Set();
  return raw.filter((i) => i && i.url && !seen.has(i.url) && seen.add(i.url)).map((i) => ({
    url: i.url,
    headline: i.headline || headlineFromUrl(i.url),
    publishDate: i.publishDate || null,
    viaCensus: true,
  }));
}

/**
 * The census acceptance test for one item against one show, applied on top of the poller's
 * own matching. Census lists hold a whole site, so the bar is higher than for a feed:
 *   - no news headlines and no round-ups;
 *   - the item must read as a review (a loose "review" URL filter also passes "preview"
 *     news, so even reviews-only sources are checked);
 *   - a dated item must fall in the show's run window, so a fringe "Wicked Fridays" review
 *     is not filed under a long-running "Wicked".
 */
function censusItemAccepted(item, show) {
  const text = `${item.headline || ''} ${(() => { try { return new URL(item.url).pathname; } catch { return item.url || ''; } })()}`;
  if (ROUNDUP_RE.test(text)) return false;
  if (headlineLooksLikeNews(item.headline)) return false;
  if (!itemReadsAsReview(item, show)) return false;
  if (item.publishDate && !publishedInRunWindow(show, item.publishDate)) return false;
  return true;
}

const slugWords = (x) => ` ${String(x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * Title-led census match. The poller's page check needs a cast or creative credit, or a venue only
 * this show uses, on the page. A review's own slug that spells out a distinctive title
 * ("review-million-dollar-quartet-arts-at-marble-arch") is the same strength of proof for a show whose
 * row has no cast yet. Bar: a title of 2+ words and 10+ letters, spelled whole in the slug or
 * headline, and no OTHER show in the pool spelled there too. The caller still requires the page to
 * name the title and the item to pass censusItemAccepted.
 */
function censusTitleOnly(item, show, pool) {
  if (!item.publishDate) return false; // title-only proof needs a listing date: an undated archive URL could be a prior production
  let path = '';
  try { path = new URL(item.url).pathname; } catch { path = String(item.url || ''); }
  const hay = slugWords(`${item.headline || ''} ${path}`);
  const longForms = (sh) => titleForms(sh).map((f) => slugWords(f)).filter((f) => f.trim().split(' ').length >= 2 && f.trim().length >= 10);
  const mine = longForms(show);
  if (!mine.some((f) => hay.includes(f))) return false;
  return !pool.some((o) => o.id !== show.id && longForms(o).some((f) => hay.includes(f) && !mine.some((m) => m.includes(f) || f.includes(m))));
}

module.exports = {
  censusTitleOnly,
  FREE_KINDS, ROUNDUP_RE, isDisabled, censusSourceFor, shouldUseCensus, censusOnlyCandidates,
  headlineFromUrl, datedSitemapUrls, enumerateCensusItems, censusItemAccepted,
};
