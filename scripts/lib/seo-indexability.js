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
const crypto = require('crypto');

// A snapshot older than this is treated as missing (fail open): the weekly refresh is
// advisory, so a broken secret must not leave stale data deciding noindex forever.
const MAX_SNAPSHOT_AGE_DAYS = 35;
function isStale(generated, now = Date.now()) {
  const t = Date.parse(generated);
  return !Number.isFinite(t) || now - t > MAX_SNAPSHOT_AGE_DAYS * 86400000;
}

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
    const snap = file === LANDINGS_FILE
      ? require('../../data/seo-search-landings.json')
      : JSON.parse(fs.readFileSync(file, 'utf8'));
    const paths = snap.paths;
    set = Array.isArray(paths) && paths.length > 0 && !isStale(snap.generated) ? new Set(paths) : null;
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

const GSC_FILE = path.join(__dirname, '..', '..', 'data', 'seo-gsc-impressions.json');

let _gsc;
/** Map path -> 90-day GSC impressions, or null when the snapshot is missing, unreadable or empty. */
function loadGscImpressions(file = GSC_FILE) {
  if (file === GSC_FILE && _gsc !== undefined) return _gsc;
  let map;
  try {
    const snap = file === GSC_FILE
      ? require('../../data/seo-gsc-impressions.json')
      : JSON.parse(fs.readFileSync(file, 'utf8'));
    const pages = snap.pages;
    map = pages && typeof pages === 'object' && Object.keys(pages).length > 0 && !isStale(snap.generated) ? pages : null;
  } catch {
    map = null;
  }
  if (file === GSC_FILE) _gsc = map;
  return map;
}

function hasGscImpressions(urlPath, gsc = loadGscImpressions()) {
  // Fail open, same as hasSearchLanding: no snapshot means every page counts as seen in search.
  if (!gsc) return true;
  if (!urlPath) return false;
  return (gsc[String(urlPath).replace(/\/+$/, '')] || 0) > 0;
}

// Staged rollout (BRO-5992): the thin rule applies to a frozen 10% cohort of slugs.
// Cohort = sha256("seo-thin-cohort-v1:" + slug) first 8 hex as uint32, mod 100, < 10.
// scripts/seo-thin-cohort.js freezes the list in data/audit/seo-thin-cohort.json; the
// list (not the hash) is what the build reads, so later data changes never move a page in.
const COHORT_PERCENT = 10;
const COHORT_FILE = path.join(__dirname, '..', '..', 'data', 'audit', 'seo-thin-cohort.json');

function cohortBucket(slug, salt = 'seo-thin-cohort-v1') {
  return parseInt(crypto.createHash('sha256').update(`${salt}:${slug}`).digest('hex').slice(0, 8), 16) % 100;
}
function inCohortHash(slug, percent = COHORT_PERCENT) {
  return cohortBucket(slug) < percent;
}

let _cohort;
function loadCohort(file = COHORT_FILE) {
  if (file === COHORT_FILE && _cohort !== undefined) return _cohort;
  let set;
  try {
    const slugs = (file === COHORT_FILE
      ? require('../../data/audit/seo-thin-cohort.json')
      : JSON.parse(fs.readFileSync(file, 'utf8'))).cohortSlugs;
    set = Array.isArray(slugs) && slugs.length > 0 ? new Set(slugs) : null;
  } catch {
    set = null;
  }
  if (file === COHORT_FILE) _cohort = set;
  return set;
}

/** Kill switch for the cohort only: SEO_THIN_COHORT_OFF=1. */
function inFrozenCohort(slug, env = process.env, cohort = loadCohort()) {
  if (env.SEO_THIN_COHORT_OFF === '1' || !cohort) return false;
  return cohort.has(slug);
}

/**
 * Env: SEO_THIN_NOINDEX=1 turns the full rule on for every candidate (overrides the cohort);
 * SEO_THIN_COHORT_OFF=1 disables only the cohort.
 * Show-page decision used by page robots and the sitemap: the full rule when
 * SEO_THIN_NOINDEX=1, otherwise only for a slug in the frozen cohort. Either way
 * the page must still be a candidate (closed, 0 reviews, 0 landings, 0 GSC impressions).
 */
function isThinShowRollout(s, slug, env = process.env) {
  if (!s) return false;
  const enabled = thinRulesEnabled(env) || inFrozenCohort(slug, env);
  return isThinClosedShow(s, enabled);
}

/**
 * Closed show with no critic reviews and no search traffic: placeholder copy only.
 * Search traffic = a PostHog search landing OR GSC impressions (both must be 0).
 * @param {{status?: string, reviewCount?: number, hasSearchLanding?: boolean, hasGscImpressions?: boolean}} s
 */
function isThinClosedShow(s, enabled = thinRulesEnabled()) {
  if (!enabled || !s) return false;
  if (ALWAYS_INDEXABLE_STATUSES.has(s.status)) return false;
  if (s.status !== 'closed') return false;
  if ((s.reviewCount || 0) > 0) return false;
  return !s.hasSearchLanding && !s.hasGscImpressions;
}

/**
 * Critic with a single review (or none) and no search traffic (PostHog landings or GSC impressions).
 * @param {{reviewCount?: number, hasSearchLanding?: boolean, hasGscImpressions?: boolean}} c
 */
function isThinCritic(c, enabled = thinRulesEnabled()) {
  if (!enabled) return false;
  if (!c) return true;
  if (c.hasSearchLanding || c.hasGscImpressions) return false;
  return (c.reviewCount || 0) <= 1;
}

module.exports = {
  thinRulesEnabled, isThinClosedShow, isThinCritic, hasSearchLanding, loadSearchLandings, ALWAYS_INDEXABLE_STATUSES,
  loadGscImpressions, hasGscImpressions, isStale, MAX_SNAPSHOT_AGE_DAYS, cohortBucket, inCohortHash, loadCohort, inFrozenCohort, isThinShowRollout, COHORT_PERCENT,
};
