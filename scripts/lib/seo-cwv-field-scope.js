/**
 * Tell page-level CrUX field data apart from PSI's silent origin fallback.
 *
 * PageSpeed Insights returns `loadingExperience` for every URL, but the block is
 * page-level ONLY when that URL has enough CrUX samples. When it doesn't, PSI
 * substitutes the ORIGIN's field data and the response shape is identical — no
 * error, no marker in the metrics themselves. check-seo-health.js stored that
 * number as if it were the page's, which produced three real defects:
 *
 *   1. Misattribution. Card #419 alerted "field LCP 2512ms over 2500ms on
 *      /west-end". For weeks /west-end genuinely did have page-level data
 *      (2485 / 2512 / 2275 while the other four URLs all read the shared origin
 *      value), so that one was right — but on 2026-08-02 /west-end dropped below
 *      the CrUX sampling floor and started reporting the origin's 1467ms. The
 *      metric looked like an 808ms improvement; nothing about the page changed.
 *   2. Phantom regressions. cwv_lcp_regression compares this week's lcp against
 *      last week's with a 500ms delta. A scope flip in either direction clears
 *      that bar on its own, so the alert fires for a measurement swap.
 *   3. Alert storms. One origin-level breach is attached to every origin-scoped
 *      URL, so a single site-wide number escalates N pages to `error` (N CRITICAL
 *      cards) for one root cause.
 *
 * HOW SCOPE IS DECIDED, strongest signal first:
 *
 *   1. PSI's own `origin_fallback` boolean, when the fetch layer captured it.
 *      This is evidence, not inference, and always wins.
 *   2. Otherwise, inference from the run's own shape. Origin-fallback records are
 *      byte-identical by construction — same lcp, same inp, same cls — because
 *      they are literally the same origin measurement. So the ONE most common
 *      field triple in a run is the origin's, and everything else is page-level.
 *
 * The inference is a heuristic and is deliberately conservative, because a false
 * 'origin' is not harmless: it makes a later real page regression look like a
 * scope switch, which check-seo-health.js then skips. Three guards bound that:
 *
 *   - Strict plurality, one winner. Only the single most common triple can be the
 *     origin. Two distinct repeated triples cannot both be "the origin" — a tie
 *     means we cannot tell, so nobody is origin. (The old rule marked every
 *     repeated triple as origin, which let a run carry two contradictory
 *     "origin" values and picked whichever came first.)
 *   - Minimum cohort. Under MIN_COHORT records the run is too small to read a
 *     plurality from, so everything stays 'unknown'. This also covers the
 *     partial-result case: check-seo-health.js omits URLs whose PSI call failed
 *     and breaks the whole loop on a 429, so `records` is not guaranteed to be
 *     the full audited set.
 *   - Per-origin grouping. Triples are only compared between URLs on the same
 *     host. Today CWV_PAGES is single-host, but adding a www/preview/second
 *     property would otherwise make equal values across hosts read as one origin.
 *
 * Known residual risk: two same-host pages whose page-level percentiles coincide
 * exactly on all three metrics AND outnumber the real origin group would be
 * misread. Validated against every week in data/audit/seo-performance-history.json
 * that has CWV data — in each, exactly one triple repeats and it is a 3-of-5 or
 * better plurality, so no historical week is misclassified.
 *
 * 'unknown' means "cannot tell", and every caller must treat it exactly as it
 * treated un-annotated data before this file existed.
 */

'use strict';

// Below this many records in a run, a plurality is not meaningful — a 1-of-2
// "most common" triple says nothing. Real runs audit 5 URLs.
const MIN_COHORT = 3;

/**
 * Key a record by its field metrics — the thing origin fallback duplicates.
 * Uses whatever field metrics are present rather than requiring LCP: PSI can
 * return CLS/INP without LCP, and treating that as "no field data" made the
 * record 'unknown' and leaked per-page CLS/INP warnings for an origin number.
 */
function fieldTripleKey(record) {
  if (!record) return null;
  const { lcp, inp, cls } = record;
  if (lcp == null && inp == null && cls == null) return null;
  return `${lcp ?? 'n'}|${inp ?? 'n'}|${cls ?? 'n'}`;
}

/** Origin (scheme + host) of a record's URL; null if unparseable. */
function urlOrigin(record) {
  try {
    return new URL(record.url).origin;
  } catch {
    return null;
  }
}

/**
 * Annotate each CWV record with `fieldScope`: 'url' | 'origin' | 'unknown'.
 * Returns new objects; the input array is not mutated.
 *
 * @param {Array<object>} records CWV records from one run (url, lcp, inp, cls, …)
 * @returns {Array<object>} same records plus fieldScope
 */
function annotateFieldScope(records) {
  if (!Array.isArray(records) || records.length === 0) return [];

  // Count triples per host, so equal values on different properties are never
  // read as one shared origin measurement.
  const countsByOrigin = new Map();
  for (const r of records) {
    const key = fieldTripleKey(r);
    const origin = urlOrigin(r);
    if (!key || !origin) continue;
    if (!countsByOrigin.has(origin)) countsByOrigin.set(origin, new Map());
    const counts = countsByOrigin.get(origin);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  // Per host, the single most common triple — only if it is a strict plurality
  // over a large enough cohort. Ties resolve to "cannot tell", not to a guess.
  const originKeyByHost = new Map();
  for (const [origin, counts] of countsByOrigin) {
    const cohort = [...counts.values()].reduce((a, b) => a + b, 0);
    if (cohort < MIN_COHORT) continue;
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [topKey, topCount] = ranked[0];
    if (topCount < 2) continue;
    if (ranked.length > 1 && ranked[1][1] === topCount) continue; // tie → undecidable
    originKeyByHost.set(origin, topKey);
  }

  return records.map((r) => {
    // PSI's own marker wins when the fetch layer captured it.
    if (typeof r.originFallback === 'boolean') {
      return { ...r, fieldScope: r.originFallback ? 'origin' : 'url' };
    }
    const key = fieldTripleKey(r);
    const origin = urlOrigin(r);
    if (!key || !origin) return { ...r, fieldScope: 'unknown' };
    if (!originKeyByHost.has(origin)) return { ...r, fieldScope: 'unknown' };
    return { ...r, fieldScope: originKeyByHost.get(origin) === key ? 'origin' : 'url' };
  });
}

/**
 * Scope for one URL inside a run, without re-annotating at every call site.
 * @returns {'url'|'origin'|'unknown'}
 */
function fieldScopeFor(records, url) {
  const annotated = annotateFieldScope(records);
  return annotated.find((r) => r.url === url)?.fieldScope ?? 'unknown';
}

/**
 * True when two samples of the same URL are not comparable because the
 * measurement swapped between page-level and origin-level. Unknown scope stays
 * comparable — that is the pre-existing behaviour and must not change.
 */
function scopeChanged(scopeA, scopeB) {
  if (!scopeA || !scopeB) return false;
  if (scopeA === 'unknown' || scopeB === 'unknown') return false;
  return scopeA !== scopeB;
}

module.exports = { annotateFieldScope, fieldScopeFor, scopeChanged, fieldTripleKey, MIN_COHORT };
