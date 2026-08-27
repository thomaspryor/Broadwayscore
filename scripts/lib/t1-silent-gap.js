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
 * (scripts/lib/review-guards.js isIncludableForRebuild + hasValidScore — the
 * same single-source-of-truth validate-data.js and check-review-count-drift.js
 * use), per memory/feedback_includability_predicates_must_be_canonical.md. This
 * module only decides, for a file the canonical predicate says will NOT reach
 * reviews.json, whether that absence is a legitimate editorial exclusion or
 * a silent gap worth recovering/escalating.
 *
 * Kept pure (no fs / no fetch) per the test-extraction rule — the sweep
 * runner (scripts/audit-t1-silent-gaps.js) and the unit test share it.
 */

'use strict';

const { isEmptyBodyFile, isRecoverableFlaggedFile } = require('./flagged-recovery');
const { isRoundupPageAsReview, isIncludableForRebuild, hasValidScore, hasAggregatorExcerpt } = require('./review-guards');

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
// the exclusion families in review-guards.js isIncludableForRebuild —
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
    // showNotMentioned without an aggregator excerpt = the show name isn't in the
    // fetched text (likely wrong content) → correct absence. The deleted mirror
    // suppressed this in passesFlagFilters; isIncludableForRebuild does NOT model
    // it (documented context-dependent omission), so restore it here or a
    // showNotMentioned file with text-but-no-score would falsely escalate as
    // 'unscored' (ship-check finding, S1-T5). Excerpt present ⇒ real content ⇒ not excluded.
    || (f.showNotMentioned === true && !hasAggregatorExcerpt(f))
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
  // deploy lag at worst, never a gap. SCORED axis = isIncludableForRebuild
  // (flag/context filters) AND hasValidScore (score-presence half). No filePath
  // here (pure classifier) → duplicateOf falls back to unconditional skip, which
  // matches the deleted mirror's passesFlagFilters behavior.
  if (isIncludableForRebuild(file, show) && hasValidScore(file)) return null;

  // Editorial verdicts and wrong-URL phantoms are correct absences regardless
  // of which branch below they'd land in.
  if (hasEditorialExclusion(file) || hasWrongUrlSignal(file)) return null;

  // Page-as-review artifacts: a roundup/aggregate page (playbill
  // what-are-the-reviews, WOS/BWW/Stage roundups) ingested under the host's
  // own outletId is never a first-party review — "review missing" is not
  // true, and re-ingesting its URL can only re-fetch the roundup page
  // (2026-07-19: shifters playbill--unknown husk emailed a CRITICAL alert).
  if (isRoundupPageAsReview(file)) return null;

  if (isIncludableForRebuild(file, show)) {
    // Includable content (flags + context clean), but no valid score yet.
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

// Self-heal-before-paging policy for 'unscored' gaps (2026-07-21: the sweep
// emailed the operator `gh workflow run "LLM Ensemble Score Reviews" ...` as
// the fix — a command the sweep can dispatch itself). One scoring dispatch
// per show per DISPATCH_RETRY_HOURS; the gap only emails once a dispatch
// that old has failed to heal it.
const DISPATCH_RETRY_HOURS = 6;

/**
 * Should the sweep dispatch a scoring run for this show now?
 * @param {string|null} lastDispatchAt ISO timestamp of the sweep's previous
 *                                     scoring dispatch for this show (null = never)
 * @param {Date} now
 */
function shouldDispatchScoring(lastDispatchAt, now) {
  if (!lastDispatchAt) return true;
  const last = Date.parse(lastDispatchAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= DISPATCH_RETRY_HOURS * 3600000;
}

/**
 * Should an 'unscored' gap page the operator? Only after self-heal had its
 * chance: a scoring dispatch happened at least DISPATCH_RETRY_HOURS ago and
 * the gap still classifies. Never-dispatched or freshly-dispatched gaps stay
 * out of the email (they are recorded in the report either way).
 *
 * A PRESENT-but-unparseable stamp escalates (returns true): treating garbage
 * as "never dispatched" here while shouldDispatchScoring treats it as
 * "dispatch now" would re-dispatch forever with zero operator visibility
 * (ship-check finding). One email + one re-dispatch, and a successful
 * dispatch overwrites the corrupt stamp.
 * @param {string|null} lastDispatchAt
 * @param {Date} now
 */
function shouldEmailUnscoredGap(lastDispatchAt, now) {
  if (!lastDispatchAt) return false;
  const last = Date.parse(lastDispatchAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= DISPATCH_RETRY_HOURS * 3600000;
}

// --- Gap-card lifecycle (BRO-341) ---------------------------------------
//
// classifySilentGap() above is a per-run classifier: it tells the sweep
// whether a FILE is a gap right now. It has no memory of a previously-filed
// card, so the sweep (audit-t1-silent-gaps.js) had nothing to check a card's
// underlying condition against once opened — every gap card, once created,
// stayed open forever even after the file was collected/scored or turned out
// to be a correct editorial absence (2026-08-14 triage: #936/#1019/#1027/
// #1070 sat open after the review was collected; #839/#1141 sat open despite
// carrying terminal isNonReview/isRoundupArticle/wrongProduction flags whose
// own suggested fix command could never succeed).
//
// The functions below give the sweep a within-run dedupe (dedupeGapCards), a
// canonical per-file identity for reporting (gapCardKey), a cross-path
// duplicate check (otherAlertPathKey), and a terminal-state classification
// (classifyGapCardState) so it can:
//   - collapse several candidate files for the same show+outlet to ONE card
//     per run instead of one per file (byline-explosion clusters), and skip
//     dispatching down one alert path when the OTHER path already tracks the
//     identical file — the actual root cause of the #1070/#1114 and
//     #1082/#1179 exact-duplicate pairs (filed once via the near-opening
//     'gap:' path, once via the >24h 'backstop:' path, on different runs), and
//   - resolveCondition() a previously-open card the moment its file's state
//     turns terminal, instead of leaving it open forever.

const GAP_CARD_STATE = {
  OPEN: 'open',
  COLLECTED: 'collected',
  NO_REVIEW: 'no-review',
  DUPLICATE: 'duplicate',
};

// Canonical, stable identity string for one show+outlet+file gap card.
// NOT currently constructed by any production code path — dedupeGapCards()
// below groups on a plain `${showId}/${outletId}` key directly (gapCardKey's
// own output includes `file`, so it couldn't group multiple files onto one
// outlet if used there), and neither alert-dispatch path in
// audit-t1-silent-gaps.js uses it as the routeAlert() conditionKey either:
// the near-opening ('gap:showId/file') and >24h backstop
// ('backstop:showId/file') paths keep their own native, unmigrated prefixes,
// because routeAlert()'s ledger cooldown AND its cross-system Linear dedupe
// (findLinearDuplicate → a plain substring search for `[conditionKey:<key>]`
// inside EXISTING card bodies) both key off the exact conditionKey string.
// Every gap card filed before this fix has its old prefix baked verbatim
// into its Linear issue body — switching the dispatched conditionKey format
// would make every already-open gap invisible to both dedupe mechanisms on
// the very next run (ledger sees "no record", Linear search finds no
// substring match), so the first post-deploy pass over any real corpus
// would re-file a duplicate card for every single currently-open gap —
// exactly the bug this fix exists to close. (Caught in review before ship:
// see otherAlertPathKey() below, which handles the actual near-opening/
// backstop duplicate case without renaming the key.) gapCardKey() is kept as
// the canonical per-file identity primitive (BRO-341's acceptance criteria
// calls for a tested "dedupe key") for reporting/future use — it is exported
// and unit-tested, just not yet wired into a live dispatch or grouping path.
function gapCardKey({ showId, outletId, file }) {
  return `t1gap:${showId}/${outletId}/${file}`;
}

// Given the conditionKey prefix one alert path is ABOUT to dispatch under
// ('gap' or 'backstop'), returns the OTHER path's native conditionKey for
// the identical show+file. audit-t1-silent-gaps.js checks whether that key
// is already 'open' in the alert-router ledger before dispatching — the
// actual fix for the #1070/#1114 and #1082/#1179 duplicate pairs: those were
// filed once via the urgent 'gap:' path and once via the >24h 'backstop:'
// path for the identical file, on different runs (so same-run dedupe alone
// can't catch it).
function otherAlertPathKey(showId, file, thisPathPrefix) {
  const otherPrefix = thisPathPrefix === 'gap' ? 'backstop' : 'gap';
  return `${otherPrefix}:${showId}/${file}`;
}

/**
 * Per-file terminal classification for an existing (or would-be) gap card.
 * Unlike classifySilentGap (which only answers "is this a gap right now"),
 * this names WHY a file that WAS a gap no longer is one, so a caller can
 * decide whether to resolveCondition() a previously-filed card.
 *
 * Returns:
 *   'collected' — the outlet now reaches the composite score (this file
 *                 became scoreable, or another file for the same outlet
 *                 did). A previously-open card should close: the review
 *                 arrived.
 *   'no-review'  — the classifier's own editorial/roundup/wrong-URL
 *                 exclusion fired: this file's absence is a correct
 *                 editorial verdict (isNonReview, isRoundupArticle,
 *                 wrongProduction, wrongShow, duplicateOf, …), not a fetch
 *                 failure. No command can recover a review that was never
 *                 published. A previously-open card should close: the
 *                 "gap" was never a real one. Content-garbage
 *                 (contentTier: 'invalid') files fall in this bucket too —
 *                 classifySilentGap already treats them as un-actionable
 *                 (re-ingesting the same URL can only re-fetch garbage), so
 *                 a stale card for one should close the same way.
 *   'open'      — still a live, unresolved gap (empty-body / unscored /
 *                 rejected-unscoreable). A previously-open card should stay
 *                 open.
 *   null        — not T1/T2-gap-eligible at all (wrong tier, or a fresh file
 *                 still inside the unscored grace window) — there is
 *                 nothing for a card to track either way.
 *
 * @param {object} args same shape as classifySilentGap's args.
 */
function classifyGapCardState({ file, show, tier, outletScored, now }) {
  if (!file || typeof file !== 'object') return null;
  if (tier == null || tier > MAJOR_TIER_MAX) return null;
  if (outletScored) return GAP_CARD_STATE.COLLECTED;
  if (isIncludableForRebuild(file, show) && hasValidScore(file)) return GAP_CARD_STATE.COLLECTED;
  if (hasEditorialExclusion(file) || hasWrongUrlSignal(file)) return GAP_CARD_STATE.NO_REVIEW;
  if (isRoundupPageAsReview(file)) return GAP_CARD_STATE.NO_REVIEW;
  const gap = classifySilentGap({ file, show, tier, outletScored, now });
  if (gap) return GAP_CARD_STATE.OPEN;
  // classifySilentGap's own final branch excludes contentTier:'invalid' from
  // ever counting as a recoverable empty-body gap — mirror that exclusion
  // here as a terminal state rather than plain "not eligible" so a stale
  // card for a file that was later reclassified as garbage still closes.
  if (file.contentTier === 'invalid') return GAP_CARD_STATE.NO_REVIEW;
  return null;
}

/**
 * Collapse a run's open gaps to one card per show+outlet. A byline-explosion
 * cluster (or any outlet with several candidate files) can leave more than
 * one file classifying as an open gap for the SAME outlet in a single run —
 * without this, each file mints its own card for what is, from the owner's
 * perspective, one missing review.
 *
 * `gaps` items need at minimum { showId, outletId, file }; a `url` field is
 * used for primary selection when present, and all extra fields are
 * preserved on output. Duplicates carry cardState: 'duplicate' and
 * duplicateOfFile pointing at the kept file, so a caller can still
 * report/log them without dispatching a second card.
 *
 * Primary selection is deterministic, not scan-order-dependent: a candidate
 * with a usable `url` (an actionable fix command) is always preferred over
 * one without, and ties break on filename. Without this, whichever file
 * `fs.readdirSync()` happened to return first would win — a URL-less file
 * could become primary while a directly-fixable sibling gets silently
 * dropped as a duplicate, and a later directory re-scan (a sibling file
 * added/removed) could flip which file is primary from run to run, which
 * would leave the PREVIOUS primary's card open forever (still a real gap,
 * just no longer the one being tracked) while filing a new card for the new
 * primary — review finding, BRO-341.
 *
 * @param {Array<object>} gaps
 * @returns {{ primary: Array<object>, duplicates: Array<object> }}
 */
function dedupeGapCards(gaps) {
  const groups = new Map(); // show+outlet key -> all gaps in that group
  for (const g of gaps || []) {
    const key = `${g.showId}/${g.outletId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const primary = [];
  const duplicates = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => {
      const aHasUrl = a.url ? 1 : 0;
      const bHasUrl = b.url ? 1 : 0;
      if (aHasUrl !== bHasUrl) return bHasUrl - aHasUrl;
      return String(a.file).localeCompare(String(b.file));
    });
    const [best, ...rest] = sorted;
    primary.push(best);
    for (const g of rest) {
      duplicates.push({ ...g, cardState: GAP_CARD_STATE.DUPLICATE, duplicateOfFile: best.file });
    }
  }
  return { primary, duplicates };
}

module.exports = {
  classifySilentGap,
  shouldAlertGap,
  shouldDispatchScoring,
  shouldEmailUnscoredGap,
  MAJOR_TIER_MAX,
  REALERT_DAYS,
  UNSCORED_GRACE_HOURS,
  DISPATCH_RETRY_HOURS,
  GAP_CARD_STATE,
  gapCardKey,
  otherAlertPathKey,
  classifyGapCardState,
  dedupeGapCards,
};
