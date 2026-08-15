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

const { wrongShowCleared, isStaleCvPromotedWrongShow, computeCvIsStale } = require('./review-guards');
const { clearWrongProductionFlags } = require('./wrong-production-clear');

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

/**
 * SELF-CONTRADICTORY CLEAR (tasks #1020 / #1022 / #1023).
 *
 * The two detectors above adjudicate between two DIFFERENT verdicts (a flag vs a
 * contentVerification pass) and therefore need care about which is authoritative
 * and which landed first. This third detector needs neither: it fires when a
 * single file simultaneously asserts an exclusion flag AND its own retraction
 * breadcrumb — "this review is wrong" and "the wrong-ness was cleared" in the
 * same record. That state is invalid on its face regardless of which verdict is
 * correct, so it is a structural invariant, not a judgement call.
 *
 * Observed instances (corpus scan 2026-08-05):
 *   - wrongProduction:true + wrongProductionAutoCleared          — 738 files (#1020)
 *   - wrongShow:true + contentVerificationPromoted + a CV block
 *     that now affirms the review                                —  28 files (#1022)
 *   - wrongAttribution:true + crossOutletVerified:true           —   3 files (#1023)
 *
 * All three arise the same way: a clear ran, then a later pass re-applied the
 * flag WITHOUT retracting the clear breadcrumb (or vice versa). The forward fix
 * for the wrongProduction pair already exists — every re-flag writer now calls
 * review-write-guard.invalidateWrongProductionAutoClear() — but nothing detects
 * the state, so the pre-fix backlog is invisible and a future pair can regress
 * silently. Adding a pair here is one table row.
 *
 * NOT a judgement about which side is stale. Callers decide: the auditor
 * escalates, --fix retracts the breadcrumb (the flag is the live verdict, since
 * the flag setters are the ones that run last).
 */

/**
 * Canonical truthiness for a clear breadcrumb. The wrongProduction auto-clear
 * stamp is written as a STRING by every rebuild path
 * ("rebuild: allowEarlyDate bypasses wrongProduction") but as a BOOLEAN by older
 * writers — 283 string / 445 boolean in corpus. Readers that test `=== true`
 * silently miss the string majority (that was the live bug in
 * scripts/lib/manual-review-fields.js). Every reader must use this.
 *
 * @param {*} v - breadcrumb field value
 * @returns {boolean} true when the breadcrumb is present in any written shape
 */
function hasClearBreadcrumbValue(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.trim() !== '';
  return false;
}

/**
 * (flag, breadcrumb) pairs that must never both be asserted on one record.
 * `extra` is an optional additional condition — used where the breadcrumb alone
 * is not self-refuting and needs corroboration from the record.
 */
const SELF_CLEAR_PAIRS = [
  {
    flag: 'wrongProduction',
    breadcrumb: 'wrongProductionAutoCleared',
    task: '#1020',
    resolution: 'retract-breadcrumb',
  },
  {
    flag: 'wrongShow',
    breadcrumb: 'contentVerificationPromoted',
    task: '#1022',
    // The promotion stamp only contradicts the flag when the CV it was promoted
    // FROM now affirms the review. Without this the stamp is just provenance.
    // NOTE: this is a broad-recall detector for AUDIT/REPORTING purposes only —
    // it is intentionally looser than isStaleCvPromotedWrongShow (accepts
    // medium confidence, doesn't check isFilmTv or cvIsStale), so more files
    // surface here than the resolver is willing to auto-fix. The demote-flag
    // resolution below re-gates through the strict predicate before mutating
    // anything (BRO-168 second-opinion review: two divergent evidentiary bars
    // for the same mutation would silently drift apart over time).
    extra: (f) => {
      const cv = f.contentVerification;
      return !!cv && cv.isValid === true
        && cv.wrongArticle === false && cv.wrongProduction === false;
    },
    // demote-flag (not retract-breadcrumb, BRO-168): contentVerificationPromoted
    // is PROVENANCE for why wrongShow was set true, not a retraction record —
    // retracting only the breadcrumb here left the actual stale exclusion
    // (wrongShow=true) standing forever, which is the bug this pair exists to
    // catch. See demoteStaleWrongShowPromotion below.
    resolution: 'demote-flag',
  },
  {
    flag: 'wrongAttribution',
    breadcrumb: 'crossOutletVerified',
    task: '#1023',
    resolution: 'retract-breadcrumb',
  },
  {
    // The wrongProduction pair's exact twin: rebuild-all-reviews.js (~2607/2619)
    // and reverify-promoted-reviews.js delete wrongShow and stamp this, so flag
    // + stamp together is the same self-contradiction. Found by the /what-else
    // pattern lens after the first three shipped — 25 files, incl. Times UK,
    // The Stage and Independent. Written ONLY as a string and read by nothing,
    // which is why it survived the original sweep.
    flag: 'wrongShow',
    breadcrumb: 'wrongShowAutoCleared',
    task: '#1020',
    resolution: 'retract-breadcrumb',
  },
  {
    // #1023's own cousin, found by the /what-else pattern lens after the
    // crossOutletVerified pair shipped: wrongArticleManualClear (the ACTUAL
    // breadcrumb review-write-guard.js's _wrongArticleCleared() checks for
    // wrongFullText — see CLEAR_BREADCRUMBS.wrongFullText) is the same shape
    // as wrongProductionAutoCleared for wrongProduction. Zero instances in
    // the corpus as of 2026-08-14 (no writer has re-flagged wrongFullText
    // over a stale manual clear yet), but nothing invalidates the breadcrumb
    // the way invalidateWrongProductionAutoClear() does for its sibling, so
    // a future re-flag would reproduce #1023 undetected without this row.
    flag: 'wrongFullText',
    breadcrumb: 'wrongArticleManualClear',
    task: '#1023',
  },
  {
    // wrongAttribution's direct twin of the pair above: a clear path can set
    // wrongArticleManualClear without ever setting crossOutletVerified (the
    // existing wrongAttribution pair only fires when THAT companion note is
    // also present), so this closes the gap for a re-flag that leaves the
    // manual-clear breadcrumb stale but no crossOutletVerified note. Zero
    // instances in the corpus as of 2026-08-14.
    flag: 'wrongAttribution',
    breadcrumb: 'wrongArticleManualClear',
    task: '#1023',
  },
];

/**
 * Detect a record asserting an exclusion flag alongside its own retraction.
 * Human-decided files are exempt: a human ruling legitimately overrides a
 * machine breadcrumb, and re-litigating it is noise.
 *
 * @param {object} file - parsed review-text JSON
 * @returns {null | {selfContradictory: true, flag: string, breadcrumb: string,
 *                   breadcrumbValue: *, task: string}}
 */
function detectSelfContradictoryClear(file) {
  const all = detectAllSelfContradictoryClears(file);
  return all.length ? all[0] : null;
}

/**
 * Every self-contradiction on one record, not just the first. A file can carry
 * more than one (e.g. wrongProduction+autoClear AND wrongAttribution+
 * crossOutletVerified), and a fixer that only ever sees the first would need
 * repeated passes to converge — silently leaving contradictions behind on a
 * single run.
 *
 * @param {object} file - parsed review-text JSON
 * @returns {Array<{selfContradictory: true, flag: string, breadcrumb: string,
 *                  breadcrumbValue: *, task: string}>}
 */
function detectAllSelfContradictoryClears(file) {
  if (!file || typeof file !== 'object') return [];
  if (isHumanDecided(file)) return [];

  const hits = [];
  for (const pair of SELF_CLEAR_PAIRS) {
    if (file[pair.flag] !== true) continue;
    if (!hasClearBreadcrumbValue(file[pair.breadcrumb])) continue;
    if (pair.extra && !pair.extra(file)) continue;
    hits.push({
      selfContradictory: true,
      flag: pair.flag,
      breadcrumb: pair.breadcrumb,
      breadcrumbValue: file[pair.breadcrumb],
      task: pair.task,
      resolution: pair.resolution || 'retract-breadcrumb',
    });
  }
  return hits;
}

/**
 * Resolve a self-contradiction by retracting the stale CLEAR breadcrumb, leaving
 * the flag (and its own provenance) intact. The flag wins because the writers
 * that set exclusion flags are the ones that ran last in every observed case —
 * the breadcrumb is the leftover. Mutates in place; returns the fields removed.
 *
 * @param {object} file - parsed review-text JSON (mutated)
 * @param {object} contradiction - the detectSelfContradictoryClear() result
 * @returns {string[]} field names deleted
 */
function retractStaleClearBreadcrumb(file, contradiction, now = new Date()) {
  if (!file || !contradiction) return [];
  const removed = [];
  for (const field of [contradiction.breadcrumb, `${contradiction.breadcrumb}At`]) {
    if (Object.prototype.hasOwnProperty.call(file, field)) {
      delete file[field];
      removed.push(field);
    }
  }
  if (!removed.length) return removed;

  // Durable proof the deletion was deliberate. Several of these breadcrumbs
  // (wrongProductionAutoCleared, wrongProductionAutoClearedAt,
  // crossOutletVerified) sit in review-write-guard.js PROTECTED_FIELDS, so the
  // push-time restore would treat the removal as data loss and resurrect them —
  // making this a permanent no-op. CLEAR_BREADCRUMBS keys the exception on this
  // stamp, so it MUST be written whenever a breadcrumb is retracted.
  //
  // FIELD-SCOPED on purpose. An "any non-empty string authorizes any deletion"
  // stamp would be a standing bypass: a record retracted once for
  // wrongProductionAutoCleared could later lose an unrelated protected field
  // (crossOutletVerified) to a bad write and the restore would bless it. The
  // stamp lists exactly which fields it covers, and the guard checks membership.
  const covered = new Set([
    ...(Array.isArray(file.clearBreadcrumbRetractedFields) ? file.clearBreadcrumbRetractedFields : []),
    ...removed,
  ]);
  file.clearBreadcrumbRetractedFields = [...covered].sort();
  file.clearBreadcrumbRetracted =
    `retracted stale ${contradiction.breadcrumb}: contradicted live ${contradiction.flag} (${contradiction.task})`;
  file.clearBreadcrumbRetractedAt = now.toISOString().split('T')[0];
  return removed;
}

/**
 * Resolve the wrongShow + contentVerificationPromoted self-contradiction
 * (#1022, BRO-168) by demoting the STALE flag, not retracting the breadcrumb.
 *
 * retractStaleClearBreadcrumb() above is correct for pairs where the
 * breadcrumb really is a CLEAR record (wrongProductionAutoCleared,
 * crossOutletVerified, wrongShowAutoCleared) — there the flag is the live,
 * later-written verdict and the breadcrumb is the leftover. contentVerification
 * Promoted is NOT that kind of breadcrumb: it is the PROVENANCE for why
 * wrongShow got set to true in the first place, not a retraction of it. When
 * the file's own current contentVerification block affirms the review is
 * valid, the PROMOTION is what's stale — retracting only the breadcrumb (the
 * old behavior) left wrongShow=true standing and the review silently excluded
 * forever. BRO-168 found 28 files this way, including NYT, Variety and WSJ
 * reviews with zero new evidence of wrong-show content.
 *
 * Re-gates through isStaleCvPromotedWrongShow — the SAME strict predicate the
 * rebuild-loop self-heal uses — rather than trusting the SELF_CLEAR_PAIRS
 * `extra()` match alone. `extra()` is a broad-recall audit detector (accepts
 * medium confidence, doesn't check isFilmTv or CV staleness); firing this
 * mutation off that looser bar would un-suppress reviews on weaker evidence
 * than the automated self-heal itself requires (BRO-168 second-opinion
 * review). Returns false (no-op) when the strict predicate disagrees — the
 * file stays flagged for a slower/manual pass instead.
 *
 * Reuses clearWrongProductionFlags(wrongShowOnly) for the same reasons every
 * other wrongShow clearer does (review-write-guard PROTECTED_FIELDS parity,
 * embedded contentVerification correction so the next rebuild doesn't
 * re-promote it). The CV's own reasoning is captured BEFORE calling
 * clearWrongProductionFlags — that helper overwrites contentVerification.
 * reasoning in place with a generic "Superseded by X recovery" wrapper, and
 * unlike a stale-CV recovery, the CV here is NOT stale: it's the fresh verdict
 * that justifies the demotion, so its own reasoning is restored afterward
 * (same "restore the LLM's own reasoning" call already made in
 * scripts/reverify-promoted-reviews.js).
 *
 * @param {object} file - parsed review-text JSON (mutated in place)
 * @param {object} contradiction - the detectAllSelfContradictoryClears() entry
 *   for this file (flag: 'wrongShow', breadcrumb: 'contentVerificationPromoted')
 * @param {Date} [now] - injectable clock for tests
 * @returns {boolean} true when the flag was demoted, false when the strict
 *   predicate declined (contradiction reported but not auto-fixed)
 */
function demoteStaleWrongShowPromotion(file, contradiction, now = new Date()) {
  if (!file || !contradiction) return false;
  if (contradiction.flag !== 'wrongShow' || contradiction.breadcrumb !== 'contentVerificationPromoted') return false;
  if (!isStaleCvPromotedWrongShow(file, computeCvIsStale(file))) return false;

  const freshReasoning = file.contentVerification && file.contentVerification.reasoning;

  clearWrongProductionFlags(file, {
    source: 'flag-contradiction.js#1022',
    reason: 'own current contentVerification affirms valid — stale CV-promotion never demoted (BRO-168)',
    wrongShowOnly: true,
  });

  if (freshReasoning && file.contentVerification) {
    file.contentVerification.reasoning = freshReasoning;
  }
  delete file.contentVerificationPromoted;

  // Redundant with wrongShowOverride (set by clearWrongProductionFlags above)
  // but matches the double-stamp convention reverify-promoted-reviews.js
  // already established for this exact recovery shape.
  file.wrongShowAutoCleared = 'flag-contradiction.js#1022 (BRO-168): own contentVerification affirms valid, promotion stamp was stale';
  file.wrongShowAutoClearedAt = now.toISOString().split('T')[0];

  return true;
}

module.exports = {
  detectFlagContradiction,
  detectCvFlagContradiction,
  detectSelfContradictoryClear,
  detectAllSelfContradictoryClears,
  retractStaleClearBreadcrumb,
  demoteStaleWrongShowPromotion,
  hasClearBreadcrumbValue,
  contradictionFixCommand,
  shouldAlertContradiction,
  isHumanDecided,
  flagTimestamp,
  cvIsNewerThanFlag,
  SELF_CLEAR_PAIRS,
  CONTRADICTION_REALERT_DAYS,
};
