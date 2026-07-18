/**
 * t1-silent-gap.js
 *
 * Pure classifier for the "major-outlet review silently missing from the
 * score" failure class (2026-07-18: The Times/Oresteia sat as an empty
 * paywall stub for 3 days; NYT/Potluck as a bot-stub rejected by the
 * scoreability check — neither was recovered or escalated because the
 * aggregator-gap audit only sees files whose URL an aggregator article
 * lists, and no alert ever fires for a discovered-but-unscoreable file).
 *
 * Inclusion semantics are DELEGATED to the canonical predicate
 * (scripts/lib/review-text-scoreable.js — the same single-source-of-truth
 * validate-data.js and check-review-count-drift.js use), per
 * memory/feedback_includability_predicates_must_be_canonical.md. This module
 * only decides, for a file the canonical predicate says will NOT reach
 * reviews.json, whether that absence is a legitimate editorial exclusion or
 * a silent gap worth recovering/escalating.
 *
 * Kept pure (no fs / no fetch) per the test-extraction rule — the sweep
 * runner (scripts/audit-t1-silent-gaps.js) and the unit test share it.
 */

'use strict';

const { wouldBeIncludedInRebuild, passesFlagFilters, hasValidScore } = require('./review-text-scoreable');
const { isEmptyBodyFile, isRecoverableFlaggedFile } = require('./flagged-recovery');

// Tiers considered "cannot silently miss". 1 = NYT/Times/Guardian class,
// 2 = TheaterMania/Standard/Telegraph class.
const MAJOR_TIER_MAX = 2;

// Re-alert the same file at most once per this many days.
const REALERT_DAYS = 7;

// 'unscored' means "scoreable content, scoring just hasn't run" — give the
// scoring cron this long after the text landed before treating it as a gap
// (the scoring→rebuild chain can lag ~4h; task #178).
const UNSCORED_GRACE_HOURS = 12;

// Ensemble rejection reasons that are editorial verdicts (the review SHOULD
// be excluded) rather than fetch-quality failures (bot stub / garbage text —
// a better fetch could still recover the review).
const EDITORIAL_REJECTIONS = new Set(['not_a_review', 'wrong_production', 'wrong_show']);

// Editorial verdicts: the review is correctly absent from the score. Mirrors
// the exclusion families in review-text-scoreable.js passesFlagFilters —
// everything here is "right review judgment", never "bad fetch".
function hasEditorialExclusion(f) {
  return f.wrongProduction === true || f.wrongShow === true
    || f.isNonReview === true || f.isNotReview === true
    || f.nonReviewFlag === true || f.nonReviewContent === true
    || f.isRoundupArticle === true || f.fabricatedEntry === true
    || f.isSyndicatedDuplicate === true || f.crossOutletDuplicate === true
    || f.wrongAttribution === true || f.suspectedMisattribution === true
    || !!f.duplicateOf || !!f.duplicateTextOf
    || f.humanReviewedWrongProduction === true
    || !!(f.contentVerification && f.contentVerification.wrongArticle === true)
    || EDITORIAL_REJECTIONS.has(f.rejectionReason);
}

// The file's URL points at the WRONG article (discovery mis-attribution) or a
// known-blocked URL — re-fetching the file's own URL can only re-ingest the
// wrong content, and "review missing" is not true (the real review may not
// exist). These are task-#6 Bug-A phantoms, not silent gaps.
const WRONG_URL_INCOMPLETE = new Set(['url_content_mismatch', 'wrong_content', 'scraper_garbage']);
function hasWrongUrlSignal(f) {
  return WRONG_URL_INCOMPLETE.has(f.incompleteReason)
    || f.isBlockedReviewUrl === true
    || f.bwwAggregatorAmbiguous === true;
}

/**
 * Classify one dir file. Returns null when there is nothing to escalate,
 * else { type, recoverable }.
 *
 * type:
 *   'empty-body'           — no usable text/stars/score; re-ingest from the
 *                            file's own URL may heal it (recoverable=true
 *                            while merge-safe and under the shared retry cap)
 *   'rejected-unscoreable' — scoreability/garbage rejection (bot-stub or
 *                            truncation class); needs a better fetch, so
 *                            report + alert only
 *   'unscored'             — scoreable content but the scoring pipeline never
 *                            produced a score; fix = dispatch scoring
 *
 * @param {object} args
 * @param {object} args.file            parsed review-text JSON
 * @param {object} [args.show]          shows.json entry (stale-flag heuristics
 *                                      in the canonical predicate use it)
 * @param {number} args.tier            outlet tier (getTier(outletId, {showCategory}))
 * @param {boolean} args.outletScored   this outlet already has an entry that
 *                                      will reach reviews.json for the show
 * @param {Date} [args.now]             clock for the unscored grace window
 * @returns {null | {type: string, recoverable: boolean}}
 */
function classifySilentGap({ file, show, tier, outletScored, now }) {
  if (!file || typeof file !== 'object') return null;
  if (tier == null || tier > MAJOR_TIER_MAX) return null;
  if (outletScored) return null;

  // Canonical: this file will contribute a reviews.json entry — rebuild or
  // deploy lag at worst, never a gap.
  if (wouldBeIncludedInRebuild(file, show)) return null;

  // Editorial verdicts and wrong-URL phantoms are correct absences regardless
  // of which branch below they'd land in.
  if (hasEditorialExclusion(file) || hasWrongUrlSignal(file)) return null;

  if (passesFlagFilters(file, show)) {
    // Includable content, but no valid score yet.
    if (isEmptyBodyFile(file)) {
      return { type: 'empty-body', recoverable: isRecoverableFlaggedFile(file) };
    }
    const fetchedAt = Date.parse(file.textFetchedAt || '');
    if (!Number.isNaN(fetchedAt) && now instanceof Date
        && now.getTime() - fetchedAt < UNSCORED_GRACE_HOURS * 3600000) {
      return null; // fresh text — scoring cron hasn't had its window yet
    }
    return { type: 'unscored', recoverable: false };
  }

  // Flag-excluded by the canonical predicate; only fetch-quality states
  // escalate (editorial/wrong-URL exclusions already returned null above).
  if (file.rejectedAt) {
    // Scoreability/garbage rejection (e.g. rejectedBy: ensemble-scoreability-
    // check on an NYT bot stub). rejectionReason for editorial verdicts is
    // filtered above; absent/garbage_text means the TEXT was bad, not the review.
    return { type: 'rejected-unscoreable', recoverable: false };
  }

  // Empty stubs excluded only by content tier (contentTier 'stub'/'invalid'
  // with no editorial flag) are the paywall-stub class. Report them even when
  // auto-recovery can't run (retry cap exhausted, paywall) — a cap-exhausted
  // T1 stub is exactly the "human must run the local cookie ingest" case, and
  // returning null here made both thestage stubs vanish from the audit while
  // still unresolved (2026-07-18). Guards on this branch:
  //  - contentTier 'invalid' is content-garbage, not a paywall stub — a
  //    cookie re-ingest of its own URL can only re-fetch garbage, so it is
  //    not an actionable gap (ship-check finding: 'invalid' is NOT covered
  //    by hasEditorialExclusion above and would otherwise alert here).
  //  - a textless stub that already carries a valid score path (e.g.
  //    originalScore from first-party page stars — stage-star-svg) scores at
  //    rebuild time and is NOT a gap; isEmptyBodyFile only checks fullText/
  //    aggregatorStars/assignedScore, so use the canonical score predicate.
  if (file.contentTier !== 'invalid' && isEmptyBodyFile(file) && !hasValidScore(file)) {
    return { type: 'empty-body', recoverable: isRecoverableFlaggedFile(file) };
  }

  return null;
}

/**
 * Alert dedupe: should this gap email now?
 * @param {string|null} lastAlertedAt ISO timestamp of the previous alert for
 *                                    this show/file key (null = never)
 * @param {Date} now
 */
function shouldAlertGap(lastAlertedAt, now) {
  if (!lastAlertedAt) return true;
  const last = Date.parse(lastAlertedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= REALERT_DAYS * 24 * 60 * 60 * 1000;
}

module.exports = { classifySilentGap, shouldAlertGap, MAJOR_TIER_MAX, REALERT_DAYS, UNSCORED_GRACE_HOURS };
