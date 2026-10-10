'use strict';

/**
 * prior-production-citations.js — the ONE predicate for "this citation belongs
 * to an EARLIER production of the same title, not the run we are auditing".
 *
 * Why this module exists (BRO-3928)
 * ---------------------------------
 * audit-show-review-gap.js has always tagged these rows correctly — a missing/
 * flagged/cited-no-URL entry carries `priorRun: true` plus a `priorRunSource`
 * — and it has always REFUSED to ingest them ("N URL(s) not ingested (N
 * prior-production — permanently report-only)"). What it did not do is subtract
 * them from the numbers a human reads.
 *
 * Measured on data/audit/show-review-gap.json at 2026-09-20:
 *   counts.totalMissing = 1864, of which 1429 (77%) were prior-production.
 *   counts.withGap      = 345,  of which only 308 had a current-run gap.
 *   119 of 400 shows with a census verdict carried prior-production candidates;
 *   beetlejuice-2025 published "1 of 74 known reviews live" to the mobile app
 *   and the owner's morning digest when 58 of those 74 were 2018/2019 citations.
 *
 * The damage is not the arithmetic, it is that the signal became unreadable.
 * Every revival reads permanently broken, so:
 *   - the owner's coverage digest (limit 10, sorted by live/candidate ratio)
 *     put "Bull Durham — 0 of 3 known reviews live, 3 excluded (older
 *     production)" above shows with genuine, fixable gaps;
 *   - `--fail-on-gap` keyed off the inflated `withGap`, so switching it on
 *     would have reddened the hourly cron forever — which is why it is wired
 *     into the workflow's inputs and has never once been enabled, and why real
 *     gaps reached no human at all.
 *
 * The fix is not "filter priorRun at each call site" — the codebase already did
 * that in FIVE places (checkpoint.uncollected, computeResidualCounts.uningested
 * and .flaggedOut, the per-show summary line, the WE alert) and missed it in
 * the two that a human actually reads. So: one predicate, exported, used by
 * every counting/verdict surface, with a test that requires() this module
 * rather than restating the rule (CLAUDE.md §15).
 *
 * The rule itself: `priorRun === true` is set by the audit and is the ONLY
 * signal. It is deliberately strict equality — a truthy-but-not-true value
 * (a string reason, a timestamp) would mean the producer changed shape, and
 * silently treating that as "prior production" is how a real current-run gap
 * would get hidden, which is worse than the over-reporting this module fixes.
 * If the producer ever starts writing something else, the counts go UP and
 * somebody investigates; they never go quietly down.
 */

/**
 * Version of the census-candidate rule this module governs.
 *
 * v1 = every missing/flagged/citedNoUrl row was a census candidate.
 * v2 = prior-production citations are not candidates at all (BRO-3928).
 *
 * It lives here rather than in gap-audit-merge because it versions THIS
 * module's rule, and three separate readers need it: the merge (to migrate
 * carried-forward rows), the blast-radius guard (to compare like with like),
 * and the owner's coverage digest (to know whether an excluded citation could
 * possibly be inside a persisted candidate pool). Bump it whenever candidate
 * SELECTION changes, never for formatting.
 */
const CENSUS_SCHEMA = 2;

/**
 * True when a gap entry is a citation from an earlier production of the title.
 * @param {object} entry a `missing` / `flaggedMisses` / `citedNoUrl` row
 */
function isPriorProductionCitation(entry) {
  return !!entry && entry.priorRun === true;
}

/** The subset of a gap list that belongs to the production being audited. */
function currentRunOnly(list) {
  return Array.isArray(list) ? list.filter((e) => !isPriorProductionCitation(e)) : [];
}

/** The subset of a gap list that belongs to an earlier production. */
function priorProductionOnly(list) {
  return Array.isArray(list) ? list.filter(isPriorProductionCitation) : [];
}

/** Count of current-run entries in one gap list. */
function currentRunCount(list) {
  return currentRunOnly(list).length;
}

/** Count of prior-production entries in one gap list. */
function priorProductionCount(list) {
  return priorProductionOnly(list).length;
}

/**
 * The three gap lists on one audit-show-review-gap.js per-show result, split.
 *
 * `missing`       — aggregator cited a URL, no file for it in the show dir
 * `flaggedMisses` — file exists but carries an exclusion verdict
 * `citedNoUrl`    — aggregator named an outlet with no linkable URL
 *
 * Returned counts are the numbers any human-facing surface should use.
 * @param {object} result one per-show result
 */
function splitGapCounts(result) {
  const r = result || {};
  const missing = currentRunCount(r.missing);
  const flaggedMisses = currentRunCount(r.flaggedMisses);
  const citedNoUrl = currentRunCount(r.citedNoUrl);
  const priorMissing = priorProductionCount(r.missing);
  const priorFlagged = priorProductionCount(r.flaggedMisses);
  const priorCitedNoUrl = priorProductionCount(r.citedNoUrl);
  return {
    missing,
    flaggedMisses,
    citedNoUrl,
    total: missing + flaggedMisses + citedNoUrl,
    priorProduction: {
      missing: priorMissing,
      flaggedMisses: priorFlagged,
      citedNoUrl: priorCitedNoUrl,
      total: priorMissing + priorFlagged + priorCitedNoUrl,
    },
  };
}

/**
 * Total current-run gap for one show — the headline "does this show still owe
 * us reviews" number. Zero means the production we are auditing is complete as
 * far as every source knows, however many earlier-production citations exist.
 */
function currentRunGapTotal(result) {
  return splitGapCounts(result).total;
}

/** Total prior-production citations for one show (report-only, never a gap). */
function priorProductionTotal(result) {
  return splitGapCounts(result).priorProduction.total;
}

/**
 * Every URL on a result that is a prior-production citation.
 *
 * Used by the one-shot census migration and by censusVerdictFor to drop these
 * candidates: a census that counts a 2019 review as a candidate for a 2026
 * production can never reach `complete`, so its verdict carries no information.
 */
function priorProductionUrls(result) {
  const r = result || {};
  const urls = new Set();
  for (const key of ['missing', 'flaggedMisses', 'citedNoUrl']) {
    for (const e of priorProductionOnly(r[key])) {
      if (e && e.url) urls.add(e.url);
    }
  }
  return urls;
}

module.exports = {
  CENSUS_SCHEMA,
  isPriorProductionCitation,
  currentRunOnly,
  priorProductionOnly,
  currentRunCount,
  priorProductionCount,
  splitGapCounts,
  currentRunGapTotal,
  priorProductionTotal,
  priorProductionUrls,
};
