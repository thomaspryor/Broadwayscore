'use strict';

/**
 * Pure classification for scripts/triage-review-gap.js (BRO-3153).
 *
 * The opening-night monitor diffs its independent census against ONLY the
 * live prod JSON. When an outlet is absent from prod it declares
 * 'missed-discovery' and starts URL-resolution work (site search, Google
 * News RSS, sitemap.xml) — indistinguishable from ordinary deploy lag, which
 * is the far more common case. On 2026-09-09 (kimberly-akimbo-off-west-end-2026,
 * West End Best Friend) that misdiagnosis ran for ~12 passes (~3h) and two
 * false-alarm rebuild-fast re-dispatches before a pass finally checked the
 * pipeline directly and found the review had been discovered, scored, and
 * committed to the data repo hours earlier — it just hadn't deployed yet.
 *
 * classifyGap() encodes the fix: only when NONE of the three pipeline stages
 * (review-texts, reviews.json, live prod) has ever seen the outlet is a gap
 * actually a missed-discovery. Kept pure and dependency-free (no git, fs, or
 * network) so the precedence rules are unit-testable in isolation
 * (CLAUDE.md rule 15) — all the git/fs/network work lives in the CLI.
 */

/**
 * @param {object} signals
 * @param {boolean} signals.reviewTextsExists - a review-texts file for this
 *   show+outlet exists, locally OR on the data-repo's origin/main.
 * @param {string|null} signals.exclusionRule - explainExclusion()'s verdict
 *   for that file (e.g. 'wrongProduction'), or null if includable/unknown.
 * @param {boolean} signals.inReviewsJson - the outlet appears in reviews.json
 *   (local or the data-repo's origin/main) for this show.
 * @param {boolean} signals.inLiveProd - the outlet appears in the live prod
 *   per-show JSON's review list.
 * @returns {'live-on-prod'|'ingested-but-excluded'|'in-pipeline-awaiting-deploy'|'true-missed-discovery'}
 */
function classifyGap({ reviewTextsExists, exclusionRule, inReviewsJson, inLiveProd }) {
  if (inLiveProd) return 'live-on-prod';
  if (reviewTextsExists && exclusionRule) return 'ingested-but-excluded';
  if (reviewTextsExists || inReviewsJson) return 'in-pipeline-awaiting-deploy';
  return 'true-missed-discovery';
}

function _ts(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * BRO-4098: a review-texts file for the outlet that belongs to a DIFFERENT
 * production of the same title (2018 Northern Stage, Chicago 2016) is not
 * evidence the current production's review was ingested. Counting it made
 * triage answer 'ingested-but-excluded / do NOT start URL resolution' on
 * opening night while the real review was a genuine discovery miss.
 *
 * Signals (text/date only, never URL contents):
 *   - explainExclusion says wrongProduction/wrongShow, unless the file is dated
 *     inside the current run (a dated in-window flag is likely a false positive
 *     worth un-flagging, so it stays ingested-but-excluded)
 *   - a _pending file dated before the show's previewsStartDate (openingDate
 *     if none), or one the promoter skipped as outside the production window
 *
 * @param {{data: object|null, pending: boolean}} file
 * @param {object|null} showRecord
 * @param {string|null} exclusionRule - explainExclusion() verdict for the file
 */
function isOtherProductionFile(file, showRecord, exclusionRule) {
  const data = file && file.data;
  if (!data) return false;
  const start = _ts(showRecord && (showRecord.previewsStartDate || showRecord.openingDate));
  const pub = _ts(data.publishDate);
  const predates = start != null && pub != null && pub < start;
  if (exclusionRule === 'wrongProduction' || exclusionRule === 'wrongShow') {
    return pub == null || start == null || predates;
  }
  if (file.pending) {
    if (predates) return true;
    if (/outside this production's window/i.test(String(data.promoteSkippedReason || ''))) return true;
  }
  return false;
}

/** Only this state justifies starting URL-resolution work (site search, RSS, sitemap). */
function justifiesUrlResolution(state) {
  return state === 'true-missed-discovery';
}

module.exports = { classifyGap, justifiesUrlResolution, isOtherProductionFile };
