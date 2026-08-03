'use strict';

/**
 * coverage-digest.js — plain-English "N of M known reviews live" digest lines
 * for the owner's morning email (Coverage Verdict S3, task #905).
 *
 * Reads the censusVerdict already computed onto a show-review-gap.json result
 * (Coverage Verdict S2, gap-audit-merge.js's censusVerdictFor) — no new
 * network/audit machinery, just formatting a line the owner can act on. Pure
 * (CLAUDE.md §15): tests require() these functions directly.
 *
 * A candidate not yet live is either "being fetched" (still in flight/gap —
 * result.missing entries without priorRun) or "excluded" (result.missing
 * entries WITH priorRun — the older-production class pre-send-check.mjs
 * already treats as report-only, not a current gap).
 */

function excludedReasonLabel(missEntry) {
  if (missEntry && missEntry.priorRun) return 'older production';
  return 'excluded';
}

// Shared computation behind coverageDigestLine/coverageDigestItem — null when
// there's nothing worth reporting (no census yet, or fully live).
function coverageStatus(result) {
  const cv = result && result.censusVerdict;
  if (!cv || cv.verdict === 'no-census-yet') return null;
  const liveCount = Number.isInteger(cv.liveCount) ? cv.liveCount : 0;
  const candidateCount = Number.isInteger(cv.candidateCount) ? cv.candidateCount : 0;
  if (candidateCount === 0 || liveCount >= candidateCount) return null;

  const missing = Array.isArray(result.missing) ? result.missing : [];
  const excluded = missing.filter((m) => m && m.priorRun);
  // `candidateCount` is scoped to THIS run's roundup census (S2); `excluded`
  // is drawn from `result.missing`, a broader all-history citation list (WE
  // + aggregator-article + SERP census, accumulated across every scanner
  // that has ever cited this show) that is NOT a subset of the census
  // candidates. For a long-running or common-shared title (task #907:
  // othello-off-broadway-2026 — Classical Theatre of Harlem's off-Broadway
  // run — carries 54 correctly-flagged priorRun citations from the
  // unrelated 2025 Denzel Washington Broadway production, against only 38
  // current-run census candidates), excluded.length can exceed
  // candidateCount. Investigated: NOT a title-collision census-contamination
  // bug (every one of the 54 carries priorRunSource: 'aggregator-article-date'
  // and points at the 2025 Broadway run's own reviews) — the guard is
  // correctly naming a real different production, so the LINE's total must
  // simply be big enough to hold everything it itemizes, or it reads as
  // nonsense ("0 of 38 known — 54 excluded"). "known" is therefore the total
  // of everything actually accounted for, never less than the census figure.
  const known = Math.max(candidateCount, liveCount + excluded.length);
  const pending = Math.max(0, known - liveCount - excluded.length);

  const parts = [];
  if (pending > 0) parts.push(`${pending} being fetched`);
  if (excluded.length > 0) {
    const byReason = new Map();
    for (const m of excluded) {
      const label = excludedReasonLabel(m);
      byReason.set(label, (byReason.get(label) || 0) + 1);
    }
    for (const [label, count] of byReason) parts.push(`${count} excluded (${label})`);
  }
  return {
    liveCount, candidateCount,
    detail: `${liveCount} of ${known} known reviews live${parts.length ? ` — ${parts.join(', ')}` : ''}`,
  };
}

/**
 * One digest line for a show, or null when there's nothing worth reporting.
 * @param {object} result  one audit-show-review-gap.js result WITH .censusVerdict attached
 * @returns {string|null}
 */
function coverageDigestLine(result) {
  const status = coverageStatus(result);
  if (!status) return null;
  return `${result.title || result.showId}: ${status.detail}`;
}

/**
 * {title, detail} item for the renderNamedDigestBlock snapshot shape
 * (autonomous-email-render.js) — same content as coverageDigestLine, split
 * so the title renders bold and the detail renders as the line below it.
 * @param {object} result
 * @returns {{title:string, detail:string}|null}
 */
function coverageDigestItem(result) {
  const status = coverageStatus(result);
  if (!status) return null;
  return { title: result.title || result.showId, detail: status.detail };
}

// Sort key shared by coverageDigestLines/coverageDigestItems — most
// incomplete (lowest live/candidate ratio) first.
function ratioOf(result) {
  const cv = result.censusVerdict;
  return cv.liveCount / cv.candidateCount;
}

/**
 * Digest lines for every show worth reporting, most-incomplete first, capped
 * at `limit` — a hundred settling opening-week shows must never turn into a
 * hundred-line email.
 * @param {Array} results  show-review-gap.json .results
 * @param {object} [opts] { limit }
 * @returns {string[]}
 */
function coverageDigestLines(results, opts = {}) {
  const { limit = 10 } = opts;
  return (results || [])
    .filter((r) => coverageStatus(r))
    .sort((a, b) => ratioOf(a) - ratioOf(b))
    .slice(0, limit)
    .map(coverageDigestLine);
}

/**
 * {title, detail} items for every show worth reporting, most-incomplete
 * first — feeds a renderNamedDigestBlock snapshot's `items` array directly.
 * @param {Array} results
 * @param {object} [opts] { limit }
 * @returns {Array<{title,detail}>}
 */
function coverageDigestItems(results, opts = {}) {
  const { limit = 10 } = opts;
  return (results || [])
    .filter((r) => coverageStatus(r))
    .sort((a, b) => ratioOf(a) - ratioOf(b))
    .slice(0, limit)
    .map(coverageDigestItem);
}

module.exports = { coverageDigestLine, coverageDigestLines, coverageDigestItem, coverageDigestItems, excludedReasonLabel };
