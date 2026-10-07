/**
 * DTLI Slug Discovery (runtime)
 *
 * Lightweight version of scripts/discover-dtli-slugs.js for runtime use by
 * the opening-night-poller. The existing script is a batch weekly job that
 * crawls ALL sitemaps to build data/dtli-slug-map.json. This lib serves the
 * opposite need: given ONE show, find its DTLI slug right now.
 *
 * Why this exists: the slug map is refreshed weekly, so newly-opened shows
 * (e.g. Proof, opening today) are NOT in the slug map for up to 7 days. The
 * fallback in scripts/gather-reviews.js::searchDTLI does brittle URL guessing
 * when the slug map misses — that's the DTLI equivalent of the BWW RR SERP gap.
 *
 * Strategy: query DTLI's sitemap index live, scan all show sitemaps in
 * parallel, match slugs against show title/slug/canonical-title. Return best
 * candidate. No Browserbase needed — DTLI isn't Cloudflare-gated. Small XML
 * payloads; typical total fetch ~200-400KB, completes in ~2-4s.
 *
 * Used by: scripts/gather-reviews.js::searchDTLI as a fallback when
 * data/dtli-slug-map.json has no entry for the show AND URL-guessing fails.
 */

const SITEMAP_INDEX_URL = 'https://didtheylikeit.com/sitemap_index.xml';
const SITEMAP_FALLBACK_PREFIX = 'https://didtheylikeit.com/shows-sitemap';
const MAX_FALLBACK_SITEMAPS = 20;
const FETCH_TIMEOUT_MS = 15000;

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for']);

const { foldDiacritics } = require('./title-match');
const { isBroadwayCategory } = require('./venue-classification');

function slugify(text) {
  return foldDiacritics(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tokensFromTitle(title) {
  return foldDiacritics(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t) && t.length > 1);
}

async function httpGetText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    const body = await r.text();
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch all show sitemap URLs from the DTLI index.
 */
async function fetchSitemapList() {
  const idx = await httpGetText(SITEMAP_INDEX_URL);
  if (idx.ok) {
    const urls = [];
    const re = /<loc>(https:\/\/didtheylikeit\.com\/shows-sitemap\d+\.xml)<\/loc>/g;
    let m;
    while ((m = re.exec(idx.body)) !== null) urls.push(m[1]);
    if (urls.length > 0) return urls;
  }
  // Fallback: probe numbered sitemaps directly.
  const urls = [];
  for (let i = 1; i <= MAX_FALLBACK_SITEMAPS; i++) {
    const url = `${SITEMAP_FALLBACK_PREFIX}${i}.xml`;
    const res = await httpGetText(url);
    if (res.ok && res.body && res.body.includes('<loc>')) {
      urls.push(url);
    } else if (i > 5) {
      break;
    }
  }
  return urls;
}

function extractShowSlugs(xml) {
  const slugs = [];
  const re = /<loc>https:\/\/didtheylikeit\.com\/shows\/([^/]+)\/<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] && m[1] !== 'all') slugs.push(m[1]);
  }
  return Array.from(new Set(slugs));
}

/**
 * Fetch all sitemaps in parallel and return the union of show slugs.
 */
async function fetchAllDtliShowSlugs() {
  const sitemapUrls = await fetchSitemapList();
  if (sitemapUrls.length === 0) return [];
  const results = await Promise.all(sitemapUrls.map(httpGetText));
  const slugs = new Set();
  for (const r of results) {
    if (!r.ok || !r.body) continue;
    for (const s of extractShowSlugs(r.body)) slugs.add(s);
  }
  return Array.from(slugs);
}

/**
 * Score a candidate DTLI slug against a show. Higher is better.
 *
 * Signals (in priority order):
 * - Exact match on show.id base (id without trailing year, e.g. "proof-2026" → "proof")
 * - Exact match on slugified title
 * - Every title token appears in the slug
 * - Market suffix preference: -bway for Broadway, -off-broadway, -west-end, -london
 */
function scoreSlug(slug, show) {
  const s = slug.toLowerCase();
  const idBase = show.id.replace(/-\d{4}$/, '').toLowerCase();
  const titleSlug = slugify(show.title);
  const titleNoArticle = slugify(show.title.replace(/^(the|a|an)\s+/i, ''));
  const titleTokens = tokensFromTitle(show.title);

  let score = 0;
  let why = [];

  // Market suffix match (strong signal when present)
  const isBroadway = isBroadwayCategory(show);
  const isOffBroadway = show.category === 'off-broadway';
  const isLondon = show.category === 'west-end' || show.category === 'off-west-end';

  // Broadway: match -bway or -broadway BUT NOT -off-broadway.
  // (Negative lookbehind can't be used here in a cross-engine-safe way, so
  // check -off-broadway first as a disqualifier for the broadway bonus.)
  const isOffBroadwaySuffix = /-off-broadway$/.test(s);
  const isBroadwaySuffix = !isOffBroadwaySuffix && /-(bway|broadway)$/.test(s);
  const isLondonSuffix = /-(west-end|london)$/.test(s);

  if (isBroadway && isBroadwaySuffix) { score += 4; why.push('market:bway'); }
  else if (isOffBroadway && isOffBroadwaySuffix) { score += 4; why.push('market:ob'); }
  else if (isLondon && isLondonSuffix) { score += 4; why.push('market:london'); }

  // Market MISMATCH penalty — prevents e.g. hamlet-broadway being matched to an
  // off-Broadway Hamlet show. These shows genuinely live at different URLs.
  if (isOffBroadway && isBroadwaySuffix) { score -= 8; why.push('market-mismatch:ob-got-bway'); }
  else if (isBroadway && isOffBroadwaySuffix) { score -= 8; why.push('market-mismatch:bway-got-ob'); }
  else if (isLondon && (isBroadwaySuffix || isOffBroadwaySuffix)) { score -= 8; why.push('market-mismatch:london-got-us'); }
  else if ((isBroadway || isOffBroadway) && isLondonSuffix) { score -= 8; why.push('market-mismatch:us-got-london'); }

  // Strip market suffix for core matching. Order matters — check -off-broadway
  // before -broadway so the longer suffix wins.
  const coreSlug = s
    .replace(/-off-broadway$/, '')
    .replace(/-(bway|broadway|west-end|london)$/, '');

  // Exact base match (highest)
  if (coreSlug === idBase || s === idBase) { score += 12; why.push('exact:idBase'); }
  else if (coreSlug === titleSlug || s === titleSlug) { score += 11; why.push('exact:titleSlug'); }
  else if (coreSlug === titleNoArticle || s === titleNoArticle) { score += 10; why.push('exact:titleNoArticle'); }
  else {
    // Token overlap — every title token appears in slug
    const missing = titleTokens.filter(t => !s.includes(t));
    if (titleTokens.length > 0 && missing.length === 0) {
      score += 6; why.push('tokens:all');
    } else if (titleTokens.length >= 4 && missing.length === 1) {
      score += 3; why.push('tokens:most');
    }
  }

  // Penalize numeric suffix mismatch — e.g. "proof-2" matches Proof-2022 but not 2026
  // Keep as neutral signal unless a clear year-based collision is detected; the
  // validateBWWRoundupYear-style check happens at the caller side once the page is fetched.

  return { score, why };
}

/**
 * Primary entry point: find the DTLI slug for a given show.
 *
 * @param {object} show - { id, slug, title, category }
 * @param {object} [opts]
 * @param {function} [opts.fetchSlugs] - override for testing; returns string[]
 * @returns {Promise<{ slug: string|null, url: string|null, candidates: Array }>}
 */
async function discoverDtliSlug(show, opts = {}) {
  const fetchSlugs = opts.fetchSlugs || fetchAllDtliShowSlugs;
  const slugs = await fetchSlugs();
  // Threshold 10 = must have exact core-match OR token-match with market-preference.
  // Token-only matches (+6) without any other signal aren't confident enough to
  // bypass slug-map — slug-map is still primary; live discovery is a fallback.
  const scored = slugs
    .map(slug => ({ slug, ...scoreSlug(slug, show) }))
    .filter(c => c.score >= 10)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    slug: best?.slug || null,
    url: best ? `https://didtheylikeit.com/shows/${best.slug}/` : null,
    candidates: scored.slice(0, 5),
  };
}

module.exports = {
  discoverDtliSlug,
  fetchAllDtliShowSlugs,
  extractShowSlugs,
  scoreSlug,
  tokensFromTitle,
  slugify,
};
