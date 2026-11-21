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
 * Current tier for an outlet, same precedence and falsy semantics as
 * compute-critic-score.js: per region, config (tiers[region] ?? tier) ||
 * registry (tiers[region] ?? tier) || DEFAULT_TIER. A config entry with no
 * usable tier falls through to the registry exactly as the scorer does.
 * @returns {{ nyc: number, london: number, source: 'config'|'registry'|'default' }}
 */
function resolveCurrentTier(outletId, tiersConfig, registry) {
  const cfg = tiersConfig[outletId];
  const reg = registry[outletId];
  const regional = (entry, region) => {
    if (!entry) return undefined;
    if (entry.tiers && entry.tiers[region] != null) return entry.tiers[region];
    return entry.tier;
  };
  const sources = new Set();
  const pick = (region) => {
    const o = regional(cfg, region);
    if (o) { sources.add('config'); return o; }
    const r = regional(reg, region);
    if (r) { sources.add('registry'); return r; }
    sources.add('default');
    return DEFAULT_TIER;
  };
  const nyc = pick('nyc');
  const london = pick('london');
  const source = sources.has('config') ? 'config' : sources.has('registry') ? 'registry' : 'default';
  return { nyc, london, source };
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

const CONSENSUS_MIN_PEERS = 3;
const CROSSOVER_MIN_REVIEWS = 3;

const normCritic = (name) => (name || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Evidence signals that do not depend on volume (BRO-4907 deep pass).
 *  - pickup: on shows Show Score lists critic reviews for, the share of this
 *    outlet's reviews that Show Score also lists. Aggregators curate who
 *    counts, so a high pickup rate is outside evidence of standing.
 *  - consensus: each scored review against the mean of OTHER outlets'
 *    T1/T2 reviews of the same show (needs CONSENSUS_MIN_PEERS). mad is the
 *    mean absolute gap, bias the mean signed gap (positive = kinder).
 *  - crossover: share of the outlet's named critics who also have
 *    CROSSOVER_MIN_REVIEWS+ reviews at a different T1/T2 outlet (any period).
 * Pickup only uses shows whose Show Score list is complete, and every signal
 * counts a show+outlet pair once.
 * @param {object} p
 * @param {object[]} p.reviews
 * @param {Record<string,object>} [p.showScoreShows] show-score.json .shows
 * @param {(name:string)=>string} [p.normalizeOutlet] Show Score name → outlet id
 * @param {Record<string,string>} [p.categoryByShow]
 * @param {(outletId:string, region:'nyc'|'london')=>number} p.tierOf
 * @returns {Map<string, object>}
 */
function computeQualitySignals({ reviews, showScoreShows = {}, normalizeOutlet = (x) => x, categoryByShow = {}, tierOf }) {
  const idOf = (r) => (r.outletId || '').toLowerCase().trim();
  const regionFor = (showId) => regionOf(categoryByShow[showId]);
  const isTop = (outletId, showId) => tierOf(outletId, regionFor(showId)) <= 2;
  const normCache = new Map();
  const norm = (name) => {
    if (!normCache.has(name)) normCache.set(name, normalizeOutlet(name));
    return normCache.get(name);
  };

  // Only shows whose Show Score list is complete: a truncated list measures
  // display order, not coverage.
  const ssListed = new Map();
  for (const [showId, s] of Object.entries(showScoreShows)) {
    if (!s || !Array.isArray(s.criticReviews) || !s.criticReviews.length) continue;
    if (typeof s.criticReviewCount === 'number' && s.criticReviews.length < s.criticReviewCount) continue;
    ssListed.set(showId, new Set(s.criticReviews.map(c => norm(c.outlet))));
  }

  // One entry per show+outlet (duplicate rows would double-count), score = mean.
  const byShow = new Map();
  for (const r of reviews) {
    const id = idOf(r);
    if (!id) continue;
    if (!byShow.has(r.showId)) byShow.set(r.showId, new Map());
    const outlets = byShow.get(r.showId);
    if (!outlets.has(id)) outlets.set(id, []);
    if (typeof r.assignedScore === 'number') outlets.get(id).push(r.assignedScore);
  }

  // critic → outlets where they have CROSSOVER_MIN_REVIEWS+ reviews, T1/T2 only
  const criticOutletCounts = new Map();
  for (const r of reviews) {
    const c = normCritic(r.criticName);
    if (!c) continue;
    const key = `${c}|${idOf(r)}`;
    criticOutletCounts.set(key, (criticOutletCounts.get(key) || 0) + 1);
  }
  const topOutletsByCritic = new Map();
  for (const r of reviews) {
    const c = normCritic(r.criticName);
    if (!c || !isTop(idOf(r), r.showId)) continue;
    if ((criticOutletCounts.get(`${c}|${idOf(r)}`) || 0) < CROSSOVER_MIN_REVIEWS) continue;
    if (!topOutletsByCritic.has(c)) topOutletsByCritic.set(c, new Set());
    topOutletsByCritic.get(c).add(idOf(r));
  }
  const criticsByOutlet = new Map();
  for (const r of reviews) {
    const c = normCritic(r.criticName);
    if (!c) continue;
    if (!criticsByOutlet.has(idOf(r))) criticsByOutlet.set(idOf(r), new Set());
    criticsByOutlet.get(idOf(r)).add(c);
  }

  const acc = new Map();
  const get = (id) => {
    if (!acc.has(id)) acc.set(id, { eligible: 0, listed: 0, gaps: [] });
    return acc.get(id);
  };
  for (const [showId, outlets] of byShow) {
    const listed = ssListed.get(showId);
    const scored = [...outlets].filter(([, sc]) => sc.length).map(([id, sc]) => [id, mean(sc)]);
    for (const [id, sc] of outlets) {
      const a = get(id);
      if (listed) {
        a.eligible++;
        if (listed.has(id)) a.listed++;
      }
      if (!sc.length) continue;
      const peers = scored.filter(([pid]) => pid !== id && isTop(pid, showId));
      if (peers.length < CONSENSUS_MIN_PEERS) continue;
      a.gaps.push(mean(sc) - mean(peers.map(([, v]) => v)));
    }
  }

  const out = new Map();
  for (const [id, a] of acc) {
    const critics = [...(criticsByOutlet.get(id) || [])];
    const crossed = critics.filter(c => [...(topOutletsByCritic.get(c) || [])].some(o => o !== id));
    out.set(id, {
      outletId: id,
      showScoreEligible: a.eligible,
      showScoreListed: a.listed,
      pickupRate: a.eligible ? a.listed / a.eligible : null,
      consensusN: a.gaps.length,
      consensusMad: a.gaps.length ? mean(a.gaps.map(Math.abs)) : null,
      consensusBias: a.gaps.length ? mean(a.gaps) : null,
      distinctCritics: critics.length,
      crossoverCritics: crossed.length,
      crossoverShare: critics.length ? crossed.length / critics.length : null,
    });
  }
  return out;
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
    if (!rows.some(r => ids.has((r.outletId || '').toLowerCase().trim()))) continue;
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
  computeQualitySignals,
  resolveCurrentTier,
  applyProposals,
  loadScorerWithTiers,
  simulateImpact,
};
