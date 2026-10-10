'use strict';

/**
 * rescore-flagging.js — single source of truth for the OPPOSITE lifecycle
 * transition from rescore-lifecycle.js: raising needsRescore when a review's
 * score no longer reflects its current, includable input (fullText added
 * after an excerpt-based score, or an exclusion flag cleared on a
 * previously-scored review).
 *
 * Card 3c8637c5416f81e99543e5b3c606d79c (#1902): 653 reviews measured with
 * contentTier complete/truncated but llmMetadata.textSource.type=excerpt —
 * scored off an excerpt despite full text now being on disk. 375 of those
 * are safe to flag per isScoreable(); flagging the other 278 would create
 * permanent stuck flags — the invariant stuck-rescore-flag.js exists to
 * guard: needsRescore===true ⟹ isScoreable()===true (the 2026-06-30
 * late-star bug class).
 *
 * isStaleScoreInput() is the single gate every call site shares, so the
 * write-time hook (review-file-writer.js, fullText change) and the
 * flag-clear sites (rebuild-all-reviews.js, wrongProduction auto-clear)
 * agree on exactly one definition of "this score no longer reflects its
 * input" instead of two hand-rolled conditions drifting apart.
 *
 * Scope note: this is the SET side of the detect/set/clear triad —
 * stuck-rescore-flag.js (detect) / rescore-flagging.js (set, this file) /
 * rescore-lifecycle.js (clear). There are ~17 other raw
 * `needsRescore = true` call sites repo-wide with no shared gate; migrating
 * them onto isStaleScoreInput()/markRescoreNeeded() is explicitly deferred
 * to a follow-up card, not done here (see card #1902 correction 2).
 */

const { isScoreable } = require('./is-scoreable');
const { assessFullText } = require('./text-quality');

/**
 * Scored from a fullText the scorer itself judged truncated (a paywall cut),
 * and the file now holds newer text that reads as complete.
 *
 * BRO-4486: the NYT Degenerates review (Critic's Pick) was scored 74 on a
 * paywall-cut copy at 16:46; the 877-word text landed at 18:33 and nothing
 * re-flagged it, because a 'fullText' textSource was always treated as final.
 * Both conditions are required: textFetchedAt is restamped on every collect,
 * and a body that still reads as truncated would re-score into the same
 * 'truncated' verdict and be flagged again after the next fetch.
 */
function isTruncatedScoreNowComplete(data) {
  const src = data && data.llmMetadata && data.llmMetadata.textSource;
  if (!src || src.type !== 'fullText' || src.status !== 'truncated') return false;
  const scoredAt = Date.parse(data.llmMetadata.scoredAt || '');
  const fetchedAt = Date.parse(data.textFetchedAt || '');
  if (!Number.isFinite(scoredAt) || !Number.isFinite(fetchedAt) || fetchedAt <= scoredAt) return false;
  // BRO-4804: judge the new text the way the scorer will (tier-aware), or a
  // footer-ended complete file never reads as "now complete" and stays stale.
  return assessFullText(data.fullText, true, { trustedComplete: data.contentTier === 'complete' }) === 'complete';
}

/**
 * BRO-4804: scored while the scorer called a COMPLETE-tier fullText truncated
 * only because of a page footer (no final punctuation). The prompt then told the
 * ensemble the verdict may be missing and confidence went low. True iff the
 * recorded textSource says truncated AND the canonical predicate agrees the text
 * is complete once contentTier is trusted (assessFullText without vs with
 * trustedComplete), AND the file is safe to requeue.
 */
function isFalseTruncationScore(data, show, filePath) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.assignedScore !== 'number') return false;
  if (data.contentTier !== 'complete' || !data.fullText) return false;
  const src = data.llmMetadata && data.llmMetadata.textSource;
  if (!src || src.type !== 'fullText' || src.status !== 'truncated') return false;
  if (data.needsRescore === true) return false;
  if (data.humanReviewScore != null) return false;
  // push-review-texts restores every protected field on a _locked file, so a rescore is reverted at push
  // and the file would be flagged and paid for again on every pass.
  if (data._locked === true) return false;
  if (data.scoreSource && !isLlmScoreSource(data.scoreSource)) return false;
  // The recorded 'truncated' status is the evidence the scorer hedged; a footer strip may since make the
  // untrusted read complete too, so only the tier-trusted read is required here.
  if (assessFullText(data.fullText, true, { trustedComplete: true }) !== 'complete') return false;
  return isScoreable(data, show, filePath);
}

/**
 * True iff `data` currently carries a score that was computed on less than
 * the best available text, AND is safe to requeue (isScoreable would accept
 * it — the 278-file guard against permanent stuck flags).
 *
 * Deliberately does NOT take the caller's specific trigger (fullText change
 * vs flag clear) as an input — both triggers just mean "something about
 * eligibility or input changed"; this predicate decides purely from current
 * file state, so every caller agrees on one answer.
 *
 * @param {Object} data - review-text record (already reflecting the
 *   caller's change, e.g. fullText set or wrongProduction cleared)
 * @param {Object} [show] - forwarded to isScoreable
 * @param {string} [filePath] - forwarded to isScoreable
 * @returns {boolean}
 */
function isStaleScoreInput(data, show, filePath) {
  if (!data || typeof data !== 'object') return false;
  // No prior score means "not yet scored" — that's the unscored pipeline's
  // job, not a rescore. Flagging these would reproduce the exact bug the
  // write-time hook must avoid: treating "about to be scored for the first
  // time" as "stale."
  if (typeof data.assignedScore !== 'number') return false;
  // Already scored off the full text — nothing stale about the input, unless
  // that "full text" was a paywall-cut copy and a complete one landed since.
  if (data.llmMetadata?.textSource?.type === 'fullText' && !isTruncatedScoreNowComplete(data)) return false;
  // NOTE: deliberately does NOT exclude ensembleData. An earlier draft of
  // this predicate assumed modern ensemble scoring always selects the best
  // available text at score time, so a later fullText arrival couldn't make
  // it stale. Measured against the real corpus (card #1902 baseline run,
  // 2026-08-26) that assumption was false: 668 of 696 candidates carry
  // ensembleData AND textSource.type==='excerpt' with fullText now on disk —
  // ensemble scoring selects the best text AVAILABLE AT SCORE TIME, and text
  // arriving afterward goes stale exactly like the single-model case.
  // Excluding ensembleData would have suppressed ~96% of the real backlog.
  // Already queued — idempotent no-op for the caller.
  if (data.needsRescore === true) return false;
  // Authoritative non-LLM scores: a human score or a published star/grade
  // extraction wins over the ensemble, so rescoring the excerpt-based LLM
  // score can only waste spend or, via --needs-rescore's bypass of the
  // star-rating skip (llm-scoring/index.ts), override the real rating (the
  // Innocence 2026-04-27 incident).
  if (data.humanReviewScore != null) return false;
  if (data.scoreSource && !isLlmScoreSource(data.scoreSource)) return false;
  // Loop guard (School Girls 2026-09-29 review): when the scorer judges the
  // fullText unusable it still records textSource 'excerpt', so without this
  // every sweep would re-flag the same file after each rescore — one paid
  // 3-model call per sweep, forever. Once a rescore completed with the current
  // text already on disk, only newer text can make the input stale again.
  if (data.rescoreCompletedAt) {
    const completed = Date.parse(data.rescoreCompletedAt);
    const fetched = Date.parse(data.textFetchedAt || '');
    if (!Number.isFinite(fetched) || !Number.isFinite(completed) || completed >= fetched) return false;
  }
  return isScoreable(data, show, filePath);
}

// scoreSource values written by the LLM scorers (llm-scoring/*, anchored-v6
// WE path). Anything else (explicit-rating, guardian-api, *-star-rating,
// human-review, …) is an extracted or human score.
function isLlmScoreSource(scoreSource) {
  const s = String(scoreSource);
  return s.startsWith('llm') || s === 'anchored-v6' || s.startsWith('ensemble');
}

/**
 * Raise the rescore flag, idempotently, with a reason + freshness stamp.
 * Mutates in place and returns the same object (mirrors markRescoreComplete's
 * inline-into-save shape: saveReviewFile(path, markRescoreNeeded(data, ...))).
 *
 * @param {Object} fileData
 * @param {string} reason - short human-readable cause, stored in rescoreReason
 * @param {string} [flaggedAt] - ISO timestamp; defaults to now (injectable for tests)
 * @returns {Object} the same fileData, mutated
 */
function markRescoreNeeded(fileData, reason, flaggedAt) {
  if (!fileData || typeof fileData !== 'object') return fileData;
  if (fileData.needsRescore === true) return fileData; // idempotent — no duplicate stamp
  fileData.needsRescore = true;
  fileData.rescoreReason = reason;
  fileData.rescoreFlaggedAt = flaggedAt || new Date().toISOString();
  return fileData;
}

module.exports = { isFalseTruncationScore, isStaleScoreInput, isTruncatedScoreNowComplete, markRescoreNeeded };
