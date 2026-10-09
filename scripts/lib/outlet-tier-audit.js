/**
 * outlet-tier-audit.js — pure helpers behind scripts/audit-outlet-tiers.js
 * (BRO-4907, outlet tier audit 2026-10).
 *
 * Volume metrics are recency-normalized: the corpus grew from ~1,000
 * reviews/year (2015-2019) to 5,500+ in 2026 (regional + West End
 * expansion), so a raw count rewards outlets that happen to be active now.
 * normalizedShare divides an outlet's count in each year by the corpus total
 * for that year, then averages over the outlet's active span. Years where the
 * whole corpus is thin (< MIN_CORPUS_YEAR_TOTAL) are skipped: one review in a
 * 1988 corpus of 8 would otherwise read as a 12% share.
 *
 * Tier resolution mirrors scripts/lib/compute-critic-score.js:
 * src/config/outlet-tiers.json override → data/outlet-registry.json → DEFAULT_TIER.
 */

const path = require('path');

const MIN_CORPUS_YEAR_TOTAL = 100;
const BASELINE_YEARS = [2015, 2019];
const RECENT_FROM = 2022;
const DEFAULT_TIER = 3;

function yearOf(date) {
  if (typeof date !== 'string') return null;
  const m = date.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12) return null;
  return y;
}

function monthIndexOf(date) {
  const y = yearOf(date);
  if (y == null) return null;
  return y * 12 + (Number(date.slice(5, 7)) - 1);
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function corpusYearTotals(reviews) {
  const totals = {};
  for (const r of reviews) {
    const y = yearOf(r.publishDate);
    if (y != null) totals[y] = (totals[y] || 0) + 1;
  }
  return totals;
}

function regionOf(category) {
  return category === 'west-end' || category === 'off-west-end' ? 'london' : 'nyc';
}

/**
 * Per-outlet volume stats.
 * @param {object[]} reviews  reviews.json rows ({ outletId, publishDate, showId })
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.categoryByShow] showId → show category
 * @param {Record<number,number>} [opts.yearTotals] precomputed corpus totals
 * @returns {Map<string, object>}
 */
function computeOutletStats(reviews, opts = {}) {
  const yearTotals = opts.yearTotals || corpusYearTotals(reviews);
  const categoryByShow = opts.categoryByShow || {};
  const sumYears = (from, to) => {
    let n = 0;
    for (const [y, c] of Object.entries(yearTotals)) if (+y >= from && +y <= to) n += c;
    return n;
  };
  const baselineTotal = sumYears(BASELINE_YEARS[0], BASELINE_YEARS[1]);
  const recentTotal = sumYears(RECENT_FROM, 9999);

  const groups = new Map();
  for (const r of reviews) {
    const id = (r.outletId || '').toLowerCase().trim();
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }

  const out = new Map();
  for (const [id, rows] of groups) {
    const perYear = {};
    const perMonth = {};
    let first = null;
    let last = null;
    let nyc = 0;
    let london = 0;
    for (const r of rows) {
      if (regionOf(categoryByShow[r.showId]) === 'london') london++; else nyc++;
      const y = yearOf(r.publishDate);
      if (y == null) continue;
      const d = r.publishDate.slice(0, 10);
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;
      perYear[y] = (perYear[y] || 0) + 1;
      const mi = monthIndexOf(r.publishDate);
      perMonth[mi] = (perMonth[mi] || 0) + 1;
    }
    const dated = Object.values(perYear).reduce((a, b) => a + b, 0);
    const yearCounts = Object.values(perYear);

    let medianPerMonth = null;
    if (first) {
      const months = [];
      for (let m = monthIndexOf(first); m <= monthIndexOf(last); m++) months.push(perMonth[m] || 0);
      medianPerMonth = median(months);
    }

    // Average yearly share over the outlet's span (zeros included), skipping
    // thin corpus years.
    let normalizedShare = null;
    if (first) {
      const shares = [];
      for (let y = yearOf(first); y <= yearOf(last); y++) {
        const t = yearTotals[y] || 0;
        if (t < MIN_CORPUS_YEAR_TOTAL) continue;
        shares.push((perYear[y] || 0) / t);
      }
      normalizedShare = shares.length ? mean(shares) : null;
    }

    let baseCount = 0;
    let recentCount = 0;
    for (const [y, c] of Object.entries(perYear)) {
      if (+y >= BASELINE_YEARS[0] && +y <= BASELINE_YEARS[1]) baseCount += c;
      if (+y >= RECENT_FROM) recentCount += c;
    }

    out.set(id, {
      outletId: id,
      total: rows.length,
      dated,
      undated: rows.length - dated,
      first,
      last,
      activeYears: yearCounts.length,
      meanPerYear: mean(yearCounts),
      medianPerYear: median(yearCounts),
      medianPerMonth,
      normalizedShare,
      share2015_19: baselineTotal ? baseCount / baselineTotal : null,
      share2022plus: recentTotal ? recentCount / recentTotal : null,
      count2015_19: baseCount,
      count2022plus: recentCount,
      nycReviews: nyc,
      londonReviews: london,
      perYear,
    });
  }
  return out;
}

/**
 * Current tier for an outlet, same precedence as compute-critic-score.js.
 * @returns {{ nyc: number, london: number, source: 'config'|'registry'|'default' }}
 */
function resolveCurrentTier(outletId, tiersConfig, registry) {
  const pick = (entry) => {
    const base = entry.tier != null ? entry.tier : (entry.tiers && (entry.tiers.nyc ?? entry.tiers.london)) ?? DEFAULT_TIER;
    const t = entry.tiers || {};
    return { nyc: t.nyc != null ? t.nyc : base, london: t.london != null ? t.london : base };
  };
  if (tiersConfig[outletId]) return { ...pick(tiersConfig[outletId]), source: 'config' };
  if (registry[outletId] && (registry[outletId].tier != null || registry[outletId].tiers)) {
    return { ...pick(registry[outletId]), source: 'registry' };
  }
  return { nyc: DEFAULT_TIER, london: DEFAULT_TIER, source: 'default' };
}

/**
 * Apply proposals to a tier config WITHOUT touching the file on disk.
 * proposals: [{ outletId, nyc, london, name? }]. A proposal for an
 * unconfigured outlet adds a config entry (that is what "configure it" means).
 */
function applyProposals(tiersConfig, proposals) {
  const next = JSON.parse(JSON.stringify(tiersConfig));
  for (const p of proposals) {
    const cur = next[p.outletId] || { name: p.name || p.outletId, scoreFormat: 'text_bucket' };
    if (p.nyc === p.london) {
      cur.tier = p.nyc;
      delete cur.tiers;
    } else {
      cur.tier = p.nyc;
      cur.tiers = { nyc: p.nyc, london: p.london };
    }
    next[p.outletId] = cur;
  }
  return next;
}

const SCORER = path.join(__dirname, 'compute-critic-score.js');
const TIERS_FILE = path.join(__dirname, '..', '..', 'src', 'config', 'outlet-tiers.json');

/**
 * Load a fresh computeCriticScore bound to an in-memory tier config. The
 * scorer reads outlet-tiers.json at require time, so we swap the require
 * cache entry for the JSON, re-require the scorer, then restore both. The
 * file on disk is never written.
 */
function loadScorerWithTiers(tiersConfig) {
  const prevJson = require.cache[TIERS_FILE];
  const prevScorer = require.cache[SCORER];
  try {
    require.cache[TIERS_FILE] = {
      id: TIERS_FILE, filename: TIERS_FILE, loaded: true, exports: tiersConfig,
    };
    delete require.cache[SCORER];
    return require(SCORER).computeCriticScore;
  } finally {
    if (prevJson) require.cache[TIERS_FILE] = prevJson; else delete require.cache[TIERS_FILE];
    if (prevScorer) require.cache[SCORER] = prevScorer; else delete require.cache[SCORER];
  }
}

/**
 * Show-level before/after scores for a set of proposals.
 * @returns {Array<{showId, before, after, delta}>} only shows whose score moved
 */
function simulateImpact({ reviews, shows, registry, tiersConfig, proposals }) {
  const before = loadScorerWithTiers(tiersConfig);
  const after = loadScorerWithTiers(applyProposals(tiersConfig, proposals));
  const ids = new Set(proposals.map(p => p.outletId));
  const byShow = new Map();
  for (const r of reviews) {
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  const showById = new Map(shows.map(s => [s.id, s]));
  const moved = [];
  for (const [showId, rows] of byShow) {
    if (!rows.some(r => ids.has((r.outletId || '').toLowerCase()))) continue;
    const show = showById.get(showId) || {};
    const b = before(rows, registry, show.category, show.type);
    const a = after(rows, registry, show.category, show.type);
    if (!b || !a) continue;
    const delta = a.s - b.s;
    if (Math.abs(delta) > 1e-9) moved.push({ showId, category: show.category, before: b.s, after: a.s, delta });
  }
  return moved;
}

module.exports = {
  MIN_CORPUS_YEAR_TOTAL,
  BASELINE_YEARS,
  RECENT_FROM,
  yearOf,
  median,
  mean,
  corpusYearTotals,
  regionOf,
  computeOutletStats,
  resolveCurrentTier,
  applyProposals,
  loadScorerWithTiers,
  simulateImpact,
};
