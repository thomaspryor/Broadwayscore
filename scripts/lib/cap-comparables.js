'use strict';

/**
 * cap-comparables.js — a stand-in capitalization for a commercial show that
 * disclosed none (BRO-5849, owner 2026-10-21: "the intent of this is to GUESS,
 * since otherwise we have NO IDEA"). One definition for two readers: the
 * season totals (src/lib/season-profile.ts) and the recoupment model's
 * fallback (opts.capEstimate, shadow behind --opt=capComparables).
 *
 * The pool is DISCLOSED figures only: a record's own estimate, a nonprofit
 * presenter's figure and an excluded record never feed a guess. A guess is
 * never written to `capitalization`; the model keeps it in a model-only field
 * (modelCapitalizationEstimate) and result.capitalizationEstimate.
 */

const { sourceOpensAsEstimate } = require('./public-source-text');
const { hasNoInvestorsToRepay } = require('./commercial-designations');

/** Fewest comparables a figure rests on. */
const MIN_AVERAGE_SAMPLE = 3;
/** Seasons either side of a show's opening to take comparables from, widened in turn. */
const CAP_ESTIMATE_WINDOWS = [2, 4];

/**
 * @typedef {{ year: number, type: string, isRevival: boolean|null, capitalization: number }} DisclosedCap
 */

function sorted(values) { return [...values].sort((a, b) => a - b); }

function median(values) {
  const v = sorted(values);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Linear-interpolated percentile (p in 0..1) of a non-empty list. */
function percentile(values, p) {
  const v = sorted(values);
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/** The comparables behind a figure: same type, and same original/revival status when known. */
function comparablePool(disclosed, year, type, isRevival) {
  const near = (d, w) => d.type === type && Math.abs(d.year - year) <= w;
  for (const w of CAP_ESTIMATE_WINDOWS) {
    const pool = disclosed.filter((d) => near(d, w) && (isRevival === null || d.isRevival === isRevival));
    if (pool.length >= MIN_AVERAGE_SAMPLE) return pool;
  }
  const widest = disclosed.filter((d) => near(d, CAP_ESTIMATE_WINDOWS[CAP_ESTIMATE_WINDOWS.length - 1]));
  return widest.length >= MIN_AVERAGE_SAMPLE ? widest : null;
}

/**
 * The median disclosed figure of shows of the same type and the same
 * original/revival status opening within CAP_ESTIMATE_WINDOWS seasons, then the
 * same type at the widest window. null with too few to go on. Season totals use
 * the median alone; no show is labelled with it.
 * @param {DisclosedCap[]} disclosed
 * @returns {number|null}
 */
function estimateCapitalization(disclosed, year, type, isRevival) {
  const pool = comparablePool(disclosed, year, type, isRevival);
  return pool ? median(pool.map((d) => d.capitalization)) : null;
}

/**
 * The model's guess: the pool median, with the pool's P10 and P90 as its
 * range. The value is clamped into that range, so one outlier pool cannot push
 * a show outside what its comparables spanned.
 * @returns {{ value: number, low: number, high: number, n: number }|null}
 */
function capitalizationComparable(disclosed, year, type, isRevival) {
  const pool = comparablePool(disclosed, year, type, isRevival);
  if (!pool) return null;
  const caps = pool.map((d) => d.capitalization);
  const low = percentile(caps, 0.1);
  const high = percentile(caps, 0.9);
  const value = Math.min(high, Math.max(low, median(caps)));
  return { value: Math.round(value), low: Math.round(low), high: Math.round(high), n: pool.length };
}

/** A capitalization figure the record states as fact (not our own estimate, not a ceiling-only guess). */
function isDisclosedCapitalization(comm) {
  return typeof comm?.capitalization === 'number' && comm.capitalization > 0
    && comm.isEstimate?.capitalization !== true && !sourceOpensAsEstimate(comm.capitalizationSource);
}

function seasonYearOf(openingDate) {
  const d = new Date(openingDate);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/**
 * A per-show estimator over the disclosed pool of commercial records.
 * Mirrors buildSeasonProfiles: commercial productions only (no nonprofit
 * presenter), disclosed figures only.
 * @param {Array<object>} shows shows.json records
 * @param {Record<string, object>} commercialShows commercial.json `shows`
 * @param {(comm: object) => boolean} [isExcluded] records to leave out of the pool (default: no investors to repay, as the season totals)
 * @returns {(show: object, comm: object) => ({ value: number, low: number, high: number, n: number }|null)}
 */
function makeCapEstimator(shows, commercialShows, isExcluded = hasNoInvestorsToRepay) {
  const bySlug = new Map();
  for (const s of shows) { if (s.slug) bySlug.set(s.slug, s); if (s.id) bySlug.set(s.id, s); }
  /** @type {DisclosedCap[]} */
  const disclosed = [];
  const continuations = continuationIds(shows.filter((s) => s.slug && commercialShows?.[s.slug]).map((s) => ({
    id: s.slug, openingDate: s.openingDate, capitalization: commercialShows[s.slug].capitalization, capitalizationSource: commercialShows[s.slug].capitalizationSource,
  })));
  for (const [key, comm] of Object.entries(commercialShows || {})) {
    if (!comm || comm.nonprofitOrg || isExcluded(comm) || !isDisclosedCapitalization(comm) || continuations.has(key)) continue;
    const show = bySlug.get(key) || bySlug.get(comm.slug) || bySlug.get(key.replace(/-\d{4}$/, ''));
    const year = show && seasonYearOf(show.openingDate);
    if (year === null || !show) continue;
    disclosed.push({ year, type: show.type || '', isRevival: typeof show.isRevival === 'boolean' ? show.isRevival : null, capitalization: comm.capitalization });
  }
  return (show, comm) => {
    if (!show || comm?.nonprofitOrg) return null;
    const year = seasonYearOf(show.openingDate);
    if (year === null) return null;
    return capitalizationComparable(disclosed, year, show.type || '', typeof show.isRevival === 'boolean' ? show.isRevival : null);
  };
}

/**
 * opts for one record's model run: with opts.capComparables on and an
 * opts.capEstimator, a record with no capitalization gets opts.capEstimate.
 * Any other record's opts come back unchanged.
 */
function optsWithCapEstimate(opts, show, comm) {
  if (!opts || !opts.capComparables || typeof opts.capEstimator !== 'function' || comm?.capitalization) return opts;
  const est = opts.capEstimator(show, comm);
  return est ? { ...opts, capEstimate: est } : opts;
}

/**
 * Ids of productions that run on capital already counted for an earlier
 * production of the same title: same id stem (beetlejuice-2022 / -2019), the
 * same capitalization figure, and a source that says it continued that
 * production. Counting both puts one raise in the totals twice (BRO-6360).
 * One definition for buildSeasonProfiles, getSeasonStats, the headline stats
 * and the comparables pool.
 * @param {Array<{id?: string|null, openingDate?: string|null, capitalization?: number|null, capitalizationSource?: string|null}>} entries
 * @returns {Set<string>}
 */
function continuationIds(entries) {
  const stem = (id) => id.replace(/-\d{4}$/, '');
  const out = new Set();
  for (const e of entries) {
    if (!e.id || !e.openingDate || typeof e.capitalization !== 'number' || e.capitalization <= 0) continue;
    if (!/\bcontinu(ed|es|ation|ing)\b/i.test(e.capitalizationSource || '')) continue;
    if (entries.some((o) => o !== e && o.id && o.openingDate && stem(o.id) === stem(e.id)
      && o.openingDate < e.openingDate && o.capitalization === e.capitalization)) out.add(e.id);
  }
  return out;
}

module.exports = {
  continuationIds,
  optsWithCapEstimate,
  MIN_AVERAGE_SAMPLE, CAP_ESTIMATE_WINDOWS,
  estimateCapitalization, capitalizationComparable, isDisclosedCapitalization, makeCapEstimator, percentile,
};
