/**
 * Stale-flag contradiction detector (Sprint 3 S3-T3, sprint-plan-t1-retrieval.md).
 *
 * ESCALATE-ONLY. Detects a file-level exclusion flag that a NEWER
 * contentVerification verdict contradicts, and hands the operator the exact
 * clear command. It NEVER clears anything itself — auto-clear stays gated
 * behind the 48h shadow report (S3-T4/T5).
 *
 * THE FAILURE CLASS (Grace Pervades, 2026): a review gets wrongProduction=true
 * from an early/auto flagger, then a later contentVerification run re-reads the
 * text and rules it a valid review of the RIGHT production — but the stale flag
 * still suppresses it from the score, silently, for days. The two verdicts
 * disagree and nothing surfaces the disagreement.
 *
 * CONTRADICTION = an active file-level flag + a contentVerification verdict that
 * (a) says the opposite AND (b) is NEWER than the flag (post-dates the flag's
 * timestamp) AND (c) the file is not human-decided (no manual clear / override /
 * human review — a human ruling always wins over both machine verdicts).
 *
 * Flag coverage:
 *   - wrongProduction  → contradicted when a newer CV says wrongProduction:false
 *                        AND isValid:true (a clean right-production verdict).
 *                        "Newer" is measured ONLY against wrongProductionFlaggedAt
 *                        — the field the wrongProduction setters actually stamp
 *                        (233 files in corpus). The generic `flaggedAt` field is
 *                        NOT used: it is also written by unrelated flows
 *                        (flag-rescore-needed, rebuild metadata), so trusting it
 *                        would both invent contradictions (an old unrelated
 *                        flaggedAt) and suppress real ones (a newer unrelated
 *                        flaggedAt) — ship-check/Codex finding.
 *   - wrongShow        → OUT OF SCOPE. There is NO reliable flag-set timestamp
 *                        for wrongShow in the corpus (wrongShowFlaggedAt does not
 *                        exist; the setters stamp only retry/recovery times), so
 *                        the "newer than flag" test cannot be established safely.
 *                        Rather than fire on the unreliable generic flaggedAt,
 *                        the detector leaves wrongShow to the escalate-only stale
 *                        -flag guards already in review-guards.js.
 *   - duplicateOf      → OUT OF SCOPE: duplicateOf is a cross-file relationship a
 *                        contentVerification verdict never assesses (CV reads one
 *                        file's text, not the pair), so a CV verdict cannot
 *                        contradict it. Escalating it on CV grounds would be pure
 *                        noise. It stays flag-only.
 *
 * The NEWER requirement is strict: if the flag carries no wrongProductionFlaggedAt
 * we cannot prove the CV post-dates it, so we do NOT escalate. An escalate-only
 * detector must stay low-noise — a same-run CV that SET the flag must never read
 * as a contradiction of it.
 *
 * Pure — no I/O. The sweep runner (audit-t1-silent-gaps.js) and the unit test
 * share this module (CLAUDE.md §15).
 */

'use strict';

const { wrongShowCleared } = require('./review-guards');

/**
 * A file whose flag a human has already ruled on — never escalate it. Covers:
 *  - humanReviewScore set (human scored it → decided)
 *  - humanReviewedWrongProduction === true (human CONFIRMED the wrong-production
 *    flag — the flag is human-verified correct, so a machine CV disagreeing is
 *    not an actionable contradiction)
 *  - the 5 manual-clear / override flags (wrongShowCleared covers all of them,
 *    including humanReviewedWrongProduction === false).
 */
function isHumanDecided(f) {
  if (!f) return true;
  if (f.humanReviewScore != null) return true;
  if (f.humanReviewedWrongProduction === true) return true;
  return wrongShowCleared(f);
}

// The wrongProduction flag's own set-time. ONLY wrongProductionFlaggedAt — the
// dedicated field the wrongProduction setters stamp (233 files). Deliberately
// NOT the generic `flaggedAt` (written by unrelated rescore/rebuild flows) nor
// any wrongShow field (no reliable wrongShow set-time exists). Returns null when
// absent → the contradiction cannot be proven newer, so it does not fire.
function flagTimestamp(f) {
  return (f && f.wrongProductionFlaggedAt) || null;
}

// The CV verdict post-dates the flag. Requires BOTH a parseable cv.verifiedAt
// AND a parseable flag timestamp — an unstamped flag can't be proven older, so
// (per the escalate-only low-noise rule) it does not qualify.
function cvIsNewerThanFlag(cv, flagTs) {
  if (!cv || !cv.verifiedAt) return false;
  const v = Date.parse(cv.verifiedAt);
  if (Number.isNaN(v)) return false;
  const f = flagTs ? Date.parse(flagTs) : NaN;
  if (Number.isNaN(f)) return false;
  return v > f;
}

function buildContradiction(flag, file, cv, flaggedAt) {
  const reasoning = cv.reasoning
    || (Array.isArray(cv.issues) && cv.issues.length ? cv.issues[0] : '')
    || '';
  return {
    contradicted: true,
    flag,
    flaggedAt: flaggedAt || null,
    verifiedAt: cv.verifiedAt,
    verifiedBy: cv.verifiedBy || null,
    cvReasoning: String(reasoning),
  };
}

/**
 * Detect a stale-flag contradiction on one review file. Returns the
 * contradiction descriptor, or null when there is nothing to escalate.
 *
 * @param {object} file - parsed review-text JSON
 * @returns {null | {contradicted: true, flag: string, flaggedAt: string|null,
 *                   verifiedAt: string, verifiedBy: string|null, cvReasoning: string}}
 */
function detectFlagContradiction(file) {
  if (!file || typeof file !== 'object') return null;
  if (isHumanDecided(file)) return null;

  const cv = file.contentVerification;
  if (!cv || !cv.verifiedAt) return null;

  const flagTs = flagTimestamp(file);

  // wrongProduction: a newer CV (post-dating wrongProductionFlaggedAt) says it's
  // a valid, right-production review. This is the Grace Pervades stale-flag class.
  if (file.wrongProduction === true
      && cv.wrongProduction === false && cv.isValid === true
      && cvIsNewerThanFlag(cv, flagTs)) {
    return buildContradiction('wrongProduction', file, cv, flagTs);
  }

  // wrongShow + duplicateOf: out of scope (no reliable flag-set timestamp / CV
  // can't assess duplication) — see module header. Not a contradiction here.
  return null;
}

/**
 * The exact operator fix command for a contradiction. Escalate-only: it points
 * at the show-scoped stale-flag clearer (LLM-predicate gated, --apply required)
 * and names the specific file so the operator verifies the right one cleared.
 *
 * @param {string} showId
 * @param {string} fileName
 * @param {string} flag - 'wrongProduction' | 'wrongShow'
 */
function contradictionFixCommand(showId, fileName, flag) {
  if (flag === 'wrongShow') {
    return `node scripts/clear-stale-wrong-production-flags.js --show=${showId} --llm --apply   ` +
      `# a newer CV contradicts the stale wrongShow flag on ${fileName}; verify + run LOCALLY`;
  }
  return `node scripts/clear-stale-wrong-production-flags.js --show=${showId} --llm --apply   ` +
    `# a newer CV contradicts the stale wrongProduction flag on ${fileName}; verify + run LOCALLY`;
}

// Re-alert dedupe — same shape as t1-silent-gap.shouldAlertGap. One ACTION per
// show+file per this many days.
const CONTRADICTION_REALERT_DAYS = 7;

function shouldAlertContradiction(lastAlertedAt, now, days = CONTRADICTION_REALERT_DAYS) {
  if (!lastAlertedAt) return true;
  const last = Date.parse(lastAlertedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= days * 24 * 60 * 60 * 1000;
}

/**
 * Timestamp-free flag-vs-CV contradiction check (#651, Notion 3ad637c5).
 *
 * detectFlagContradiction() above requires a stamped wrongProductionFlaggedAt
 * and a CV verifiedAt strictly newer than it — deliberately narrow, and it
 * explicitly punts on wrongShow/isRoundupArticle because no reliable flag-set
 * timestamp exists for them. That ordering requirement is exactly why the
 * pipeline-health audit's cheap detector (10 files across 34 shows opened in
 * the last 30 days, 3 of 5 judged were confirmed false positives — JCS
 * sarah-crompton, Heathers zafar-arif, Tender artsdesk) had never been
 * computed anywhere as a standing check: it doesn't need "newer than," only
 * "currently disagrees." A long-substantial review the pipeline still
 * excludes while its own most recent full-text CV pass affirms it, at high
 * confidence, is worth a human look regardless of which verdict landed on
 * disk first — CV is not authoritative over the exclusion flags (both can be
 * wrong), it's just cheap, high-recall bait for a human triage pass.
 *
 * @param {object} file - parsed review-text JSON
 * @returns {null | {contradicted: true, flag: string, cvReasoning: string, wordCount: number}}
 */
function detectCvFlagContradiction(file) {
  if (!file || typeof file !== 'object') return null;
  if (isHumanDecided(file)) return null;

  const cv = file.contentVerification;
  if (!cv || cv.isValid !== true || cv.confidence !== 'high') return null;

  const wordCount = file.textWordCount ?? file.wordCount ?? 0;
  if (wordCount <= 300) return null;

  const flag = file.wrongProduction === true ? 'wrongProduction'
    : file.wrongShow === true ? 'wrongShow'
    : file.isRoundupArticle === true ? 'isRoundupArticle'
    : null;
  if (!flag) return null;

  const reasoning = cv.reasoning
    || (Array.isArray(cv.issues) && cv.issues.length ? cv.issues[0] : '')
    || '';
  return { contradicted: true, flag, cvReasoning: String(reasoning), wordCount };
}

module.exports = {
  detectFlagContradiction,
  detectCvFlagContradiction,
  contradictionFixCommand,
  shouldAlertContradiction,
  isHumanDecided,
  flagTimestamp,
  cvIsNewerThanFlag,
  CONTRADICTION_REALERT_DAYS,
};
