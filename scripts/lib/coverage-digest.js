'use strict';

const { CENSUS_SCHEMA } = require('./prior-production-citations');

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
  // correctly naming a real different production.
  //
  // The fix does NOT inflate `candidateCount` to "make room" for the
  // overflow (an earlier version of this fix did — ship-check finding,
  // task #907: that reported "0 of 54 known reviews live" for Othello,
  // falsely implying those 54 unrelated-production reviews were part of
  // THIS show's known pool). `candidateCount` stays exactly what the census
  // actually found.
  //
  // There is no signal in the data for WHICH excluded citations (if any)
  // genuinely belong to this run's census candidates vs an unrelated
  // production sharing the title — only the aggregate count is available.
  // Splitting the list at an arbitrary array index to "make the arithmetic
  // fit" would misattribute specific citations to one bucket or the other
  // with no basis. So this is a binary call: if `excluded` plausibly fits
  // within what's left of the known census total, treat it as normal
  // (unchanged — the common case, e.g. The Car Man's 1 excluded of 14). If
  // it doesn't fit AT ALL (Othello: 54 > the 38 total there is to fit
  // within), the whole list is reported as its own explicitly-unrelated
  // clause instead of folded into the same "N excluded" tally a reader would
  // otherwise take as a subset of "known".
  // Is a given excluded (prior-production) citation INSIDE this show's
  // candidate pool? It decides whether the citation consumes one of the
  // un-live candidate slots or merely sits alongside them.
  //
  // Since BRO-3928's follow-through, censusVerdictFor refuses to admit a
  // prior-production citation as a candidate at all, so for any verdict the
  // current rule produced the answer is "outside" by construction — no
  // guessing, and `excluded` must NOT be subtracted from "being fetched"
  // (doing so understates the real, actionable work, the opposite of what
  // this digest is for).
  //
  // Older verdicts keep the original fit-or-overflow heuristic unchanged.
  // An earlier cut of this decided membership by matching excluded URLs
  // against the persisted `candidates` list; that was withdrawn (Codex
  // adversarial review) because `candidateCount` is a DISTINCT-OUTLET count
  // while a URL match counts URLs, so one excluded outlet publishing two URLs
  // consumed two outlet slots and could report "0 being fetched" over a real
  // gap — and because a partial candidate list read as authoritative. The
  // legacy path is reachable only for rows the next merge has not migrated
  // yet, so the safe choice is the behaviour those rows were written under.
  const remaining = Math.max(0, candidateCount - liveCount);
  const outsideByConstruction = cv.censusSchema >= CENSUS_SCHEMA;
  const insidePool = (outsideByConstruction || excluded.length > remaining) ? [] : excluded;
  const outsidePool = insidePool.length ? [] : excluded;
  const pending = Math.max(0, remaining - insidePool.length);

  const tally = (rows) => {
    const byReason = new Map();
    for (const m of rows) {
      const label = excludedReasonLabel(m);
      byReason.set(label, (byReason.get(label) || 0) + 1);
    }
    return byReason;
  };

  const parts = [];
  if (pending > 0) parts.push(`${pending} being fetched`);
  for (const [label, count] of tally(insidePool)) parts.push(`${count} excluded (${label})`);

  let detail = `${liveCount} of ${candidateCount} known reviews live${parts.length ? ` — ${parts.join(', ')}` : ''}`;
  if (outsidePool.length > 0) {
    const outside = [...tally(outsidePool)].map(([label, count]) => `${count} (${label})`);
    detail += ` — separately, ${outside.join(', ')} on file from outside this run's candidate pool`;
  }
  return { liveCount, candidateCount, detail };
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
