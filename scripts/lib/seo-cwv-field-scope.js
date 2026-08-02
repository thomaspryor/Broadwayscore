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
 * Detection: within one run we fetch several URLs. Origin-fallback records are
 * byte-identical by construction — same lcp, same inp, same cls — because they
 * are literally the same origin measurement. Two genuinely distinct pages do not
 * produce identical CrUX percentiles across all three metrics. So a field triple
 * shared by 2+ URLs in the same run is the origin's; a unique triple is the
 * page's own. PSI's `origin_fallback` boolean is honoured when present, but the
 * inference does not depend on it — it is derived from data we already store,
 * which is why it can be validated against the existing history file.
 *
 * A single-URL run cannot be disambiguated; those return 'unknown', which every
 * caller must treat exactly as it treated un-annotated data before.
 */

'use strict';

/** Key a record by its full field triple — the thing origin fallback duplicates. */
function fieldTripleKey(record) {
  if (!record || record.lcp == null) return null;
  return `${record.lcp}|${record.inp ?? 'n'}|${record.cls ?? 'n'}`;
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

  const counts = new Map();
  for (const r of records) {
    const key = fieldTripleKey(r);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }

  return records.map((r) => {
    // PSI's own marker wins when the fetch layer captured it.
    if (typeof r.originFallback === 'boolean') {
      return { ...r, fieldScope: r.originFallback ? 'origin' : 'url' };
    }
    const key = fieldTripleKey(r);
    if (!key) return { ...r, fieldScope: 'unknown' };
    // One URL in the run tells us nothing: a lone triple is unique either way.
    if (records.length < 2) return { ...r, fieldScope: 'unknown' };
    return { ...r, fieldScope: counts.get(key) > 1 ? 'origin' : 'url' };
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

module.exports = { annotateFieldScope, fieldScopeFor, scopeChanged, fieldTripleKey };
