'use strict';
/**
 * Terminal "unextractable" state for aggregator-listed review URLs (BRO-4765).
 *
 * audit-show-review-gap.js --ingest-missing re-fetches every missing aggregator
 * URL each run. A page whose article extraction returns 0 chars (a news post
 * that is not a review, a paywall, an outlet with no extractor pattern) can
 * never succeed, yet each attempt spent scraper credits and the URL stayed in
 * missing[] forever, holding the show's Coverage Verdict at 'incomplete'.
 *
 * The consecutive 0-char count per (show, url) lives in the show's entry in
 * data/audit/gap-audit-checkpoint.json as `zeroChar: { [url]: { n, at, since } }`.
 * After ZERO_CHAR_CAP consecutive 0-char results spanning at least a day the URL is unextractable: it
 * is moved out of missing[] into `unextractable[]` (still in the report), is
 * not re-ingested, and does not count toward the verdict. After
 * RETRY_AFTER_DAYS it gets one more attempt (an extractor pattern may have
 * been added since); a 0-char result sends it straight back to terminal.
 *
 * Only a 0-char result counts. Network errors, timeouts and other failures
 * reset the streak, so a flaky fetch can never mark a good URL unextractable.
 */

const ZERO_CHAR_CAP = 3;
const RETRY_AFTER_DAYS = 30;
const PRUNE_AFTER_DAYS = 120;
const DAY_MS = 86400000;
// The audit runs hourly, so N consecutive failures can span 3 hours. A review that just published can
// sit behind a transient paywall or bot wall for that long, so the streak must also span this long.
const MIN_STREAK_SPAN_MS = DAY_MS;

/**
 * True for an ingestMissingUrl() result that failed because extraction returned 0 chars. `zeroChar` is
 * set from the child's full output (the truncated `reason` can miss the line behind earlier warnings);
 * the reason text is the fallback for results built elsewhere.
 */
function isZeroCharFailure(res) {
  return !!res && res.ok === false && !res.noop
    && (res.zeroChar === true || /Article extraction returned 0 chars/i.test(String(res.reason || '')));
}

/** Streak length for a url, with the retry window applied (an old terminal entry earns one more try). */
function effectiveCount(stored, url, now, cap = ZERO_CHAR_CAP) {
  const e = stored && stored[url];
  if (!e || !Number.isFinite(e.n)) return 0;
  const age = now - (Date.parse(e.at) || 0);
  if (e.n >= cap && age >= RETRY_AFTER_DAYS * DAY_MS) return cap - 1;
  return e.n;
}

function isUnextractable(stored, url, now, cap = ZERO_CHAR_CAP) {
  if (effectiveCount(stored, url, now, cap) < cap) return false;
  const e = stored[url];
  const span = (Date.parse(e.at) || 0) - (Date.parse(e.since || e.at) || 0);
  return span >= MIN_STREAK_SPAN_MS;
}

/** Split missing[] into the URLs still worth attempting and the terminal ones. Pure. */
function partitionUnextractable(missing, stored, now, cap = ZERO_CHAR_CAP) {
  const keep = [];
  const unextractable = [];
  for (const m of missing || []) {
    if (m && m.url && isUnextractable(stored, m.url, now, cap)) {
      unextractable.push({ ...m, zeroCharAttempts: effectiveCount(stored, m.url, now, cap) });
    } else keep.push(m);
  }
  return { missing: keep, unextractable };
}

/**
 * Next stored map after a run's ingest results. A 0-char result extends the
 * streak; any other attempted result (landed, or failed another way) clears it;
 * URLs not attempted this run are untouched. Entries unseen for PRUNE_AFTER_DAYS
 * are dropped. Pure.
 */
function updateZeroCharCounts(stored, ingestResults, now, cap = ZERO_CHAR_CAP) {
  const next = {};
  for (const [url, e] of Object.entries(stored || {})) {
    if (e && now - (Date.parse(e.at) || 0) < PRUNE_AFTER_DAYS * DAY_MS) next[url] = e;
  }
  const at = new Date(now).toISOString();
  for (const res of ingestResults || []) {
    if (!res || !res.url) continue;
    if (isZeroCharFailure(res)) {
      const prev = stored && stored[res.url];
      next[res.url] = { n: effectiveCount(stored, res.url, now, cap) + 1, at, since: (prev && (prev.since || prev.at)) || at };
    }
    else delete next[res.url];
  }
  return next;
}

module.exports = { MIN_STREAK_SPAN_MS, ZERO_CHAR_CAP, RETRY_AFTER_DAYS, isZeroCharFailure, effectiveCount, isUnextractable, partitionUnextractable, updateZeroCharCounts };
