/**
 * One place for the index-bloat rules (BRO-5969, SEO audit BRO-5961).
 *
 * 1,853 of 3,796 show URLs had zero reviews and /cast was 58% of the sitemap,
 * with GSC reporting many as "Crawled - currently not indexed". A thin page
 * stays reachable and keeps `follow`, but is noindex and out of the sitemap.
 *
 * The thin rules ship OFF (SEO_THIN_NOINDEX unset): PostHog undercounts search
 * landers 15-30% (no reverse proxy, adblock, late init), so "0 landings" is not
 * yet a safe noindex signal. Flip SEO_THIN_NOINDEX=1 once Search Console
 * impressions are an input too. Until then scripts/seo-thin-candidates.js
 * writes the would-be list to data/audit/.
 *
 * Every rule first asks the search-landing list (data/seo-search-landings.json,
 * refreshed by scripts/seo-search-landings.js from PostHog): a page that had a
 * real search-engine entry in the last 90 days is never made noindex.
 */
const fs = require('fs');
const path = require('path');

const LANDINGS_FILE = path.join(__dirname, '..', '..', 'data', 'seo-search-landings.json');

// Shows that must be indexable before / while they are reviewed.
const ALWAYS_INDEXABLE_STATUSES = new Set(['upcoming', 'announced', 'previews', 'open']);

/** Kill switch, default OFF: with it off every thin check returns false. */
function thinRulesEnabled(env = process.env) {
  return env.SEO_THIN_NOINDEX === '1';
}

let _landings;
function loadSearchLandings(file = LANDINGS_FILE) {
  if (file === LANDINGS_FILE && _landings !== undefined) return _landings;
  let set;
  try {
    // The default list is a static require so Next/webpack bundles it into the
    // sitemap and page renders; a runtime path.join read is not traced.
    const paths = (file === LANDINGS_FILE
      ? require('../../data/seo-search-landings.json')
      : JSON.parse(fs.readFileSync(file, 'utf8'))).paths;
    set = Array.isArray(paths) && paths.length > 0 ? new Set(paths) : null;
  } catch {
    set = null;
  }
  if (file === LANDINGS_FILE) _landings = set;
  return set;
}

function hasSearchLanding(urlPath, landings = loadSearchLandings()) {
  // Fail open: a missing, unreadable or empty list must never noindex the site.
  if (!landings) return true;
  if (!urlPath) return false;
  return landings.has(String(urlPath).replace(/\/+$/, ''));
}

/**
 * Closed show with no critic reviews and no search traffic: placeholder copy only.
 * @param {{status?: string, reviewCount?: number, hasSearchLanding?: boolean}} s
 */
function isThinClosedShow(s, enabled = thinRulesEnabled()) {
  if (!enabled || !s) return false;
  if (ALWAYS_INDEXABLE_STATUSES.has(s.status)) return false;
  if (s.status !== 'closed') return false;
  if ((s.reviewCount || 0) > 0) return false;
  return !s.hasSearchLanding;
}

/**
 * Critic with a single review (or none) and no search traffic.
 * @param {{reviewCount?: number, hasSearchLanding?: boolean}} c
 */
function isThinCritic(c, enabled = thinRulesEnabled()) {
  if (!enabled) return false;
  if (!c) return true;
  if (c.hasSearchLanding) return false;
  return (c.reviewCount || 0) <= 1;
}

module.exports = { thinRulesEnabled, isThinClosedShow, isThinCritic, hasSearchLanding, loadSearchLandings, ALWAYS_INDEXABLE_STATUSES };
