'use strict';

// BRO-7772: the "SEO: health" row fired on "13% indexed (4/30)" because the index
// sample was a uniform shuffle over every show slug. ~1,400 of ~6,100 slugs are
// regional pages and ~1,500 are West End pages that Google has not crawled yet
// ("URL is unknown to Google"), so most samples were those pages and the rate
// said nothing about the NYC pages the site lives on. The sample is now quota
// stratified by category, coverage is tallied per category, and the digest row
// judges the CORE categories (broadway, off-broadway). Other categories stay in
// the snapshot as information.

const CORE_CATEGORIES = ['broadway', 'off-broadway'];
// Quotas sum to 30 (each inspection is a sequential API call; see check-seo-health.js).
const SAMPLE_QUOTAS = { broadway: 12, 'off-broadway': 8, 'west-end': 4, 'off-west-end': 2, regional: 4 };
const CORE_MIN_RATE = 0.5;
const LIVE_STATUSES = new Set(['open', 'previews']);

function pickRandom(list, n, rand) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** Returns [{ url, category }] sampled by SAMPLE_QUOTAS; an empty bucket's quota is dropped. */
function sampleIndexCoverageUrls(shows, host, { quotas = SAMPLE_QUOTAS, rand = Math.random } = {}) {
  const buckets = new Map();
  for (const s of Array.isArray(shows) ? shows : []) {
    if (!s || typeof s.slug !== 'string' || !s.slug) continue;
    const cat = typeof s.category === 'string' && s.category ? s.category : 'unknown';
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat).push({ slug: s.slug, live: LIVE_STATUSES.has(s.status) });
  }
  const out = [];
  for (const [cat, n] of Object.entries(quotas)) {
    let list = buckets.get(cat) || [];
    // Core pages are the ones that should be indexed: ~2,800 of ~3,000 are closed historical
    // shows Google deprioritizes. Sample live shows first, top up from the rest.
    if (CORE_CATEGORIES.includes(cat)) {
      const live = list.filter((x) => x.live);
      list = live.length >= n ? live : live.concat(pickRandom(list.filter((x) => !x.live), n - live.length, rand));
    }
    for (const { slug } of pickRandom(list, n, rand)) out.push({ url: `${host}/show/${slug}`, category: cat });
  }
  return out;
}

/** Folds per-URL results into { category: { indexed, total } }. */
function tallyByCategory(results) {
  const by = {};
  for (const r of results) {
    const c = r.category || 'unknown';
    by[c] = by[c] || { indexed: 0, total: 0 };
    by[c].total++;
    if (r.indexed) by[c].indexed++;
  }
  return by;
}

/**
 * The digest row's verdict. With byCategory: warn only when the core categories
 * together fall below CORE_MIN_RATE. Legacy snapshots (no byCategory) keep the old
 * all-sample rule until the next SEO run rewrites them.
 */
function indexCoverageVerdict(cov) {
  if (!cov) return { warn: false };
  const pct = (i, t) => `${((i / t) * 100).toFixed(0)}% indexed (${i}/${t})`;
  if (cov.byCategory) {
    let indexed = 0, total = 0;
    for (const c of CORE_CATEGORIES) {
      indexed += (cov.byCategory[c] || {}).indexed || 0;
      total += (cov.byCategory[c] || {}).total || 0;
    }
    if (total > 0) {
      return indexed / total < CORE_MIN_RATE ? { warn: true, message: `${pct(indexed, total)} of sampled Broadway/Off-Broadway pages` } : { warn: false };
    }
    // No core page was inspected (all failed, or fallback sample): never read that as healthy.
  }
  if (cov.total > 0 && cov.indexed / cov.total < CORE_MIN_RATE) return { warn: true, message: pct(cov.indexed, cov.total) };
  return { warn: false };
}

/** One-line summary for Discord/console: overall rate plus the core rate the digest row judges. */
function describeIndexCoverage(cov) {
  const all = `${cov.rate}% (${cov.indexed}/${cov.total})`;
  if (!cov.byCategory) return all;
  let i = 0, t = 0;
  for (const c of CORE_CATEGORIES) { i += (cov.byCategory[c] || {}).indexed || 0; t += (cov.byCategory[c] || {}).total || 0; }
  return t > 0 ? `${all}; Broadway/Off-Broadway ${Math.round((i / t) * 100)}% (${i}/${t})` : all;
}

module.exports = { describeIndexCoverage, LIVE_STATUSES, CORE_CATEGORIES, SAMPLE_QUOTAS, CORE_MIN_RATE, sampleIndexCoverageUrls, tallyByCategory, indexCoverageVerdict };
