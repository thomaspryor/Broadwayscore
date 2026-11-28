'use strict';
/**
 * BRO-3238: the one tier classification rebuild-all-reviews.js writes back to
 * review-text files, shared with the one-off backfill
 * (scripts/migrations/sync-content-tier-reason-2026-10.js) so both compute
 * exactly the same thing.
 *
 * The rebuild used to write contentTier/contentTierReason back ONLY when the
 * tier changed, so a file whose tier was right but whose reason text was from
 * an older classifier kept the stale reason forever (24,003 of 56,444 files
 * on 2026-10-12). invalidTierVerdict() and isGarbageTierReason() in
 * review-guards.js read that reason, so it has to stay current.
 */
const { classifyContentTier } = require('./content-quality');
const { applyPaywallTierOverride } = require('./paywall-completeness');

/**
 * @param {object} data a review-text record
 * @returns {{tierResult: object, tierChanged: boolean, reasonOnlyChanged: boolean}}
 *   tierChanged       stored contentTier is missing or differs: rebuild's full
 *                     write-back (tier, reason, wordCount, paywall fields).
 *   reasonOnlyChanged tier is unchanged but the stored contentTierReason is
 *                     not the current one: write back the reason alone.
 */
function classifyTierWriteBack(data) {
  const tierResult = applyPaywallTierOverride(data, classifyContentTier(data));
  const tierChanged = !data.contentTier || data.contentTier !== tierResult.contentTier;
  const reasonOnlyChanged = !tierChanged
    && (data.contentTierReason ?? null) !== (tierResult.tierReason ?? null);
  return { tierResult, tierChanged, reasonOnlyChanged };
}

/**
 * Mirror a classifyTierWriteBack() result onto an in-memory record the way rebuild-all-reviews.js does (and the
 * way the next rebuild will read the written file): tier, signals, the paywall truncation fields, and the current
 * reason. One function for the rebuild and finalizePullQuote, so a caller holding an un-reclassified file (backfill,
 * live-data test) judges the same record the rebuild does (BRO-8084).
 */
function applyTierResultInMemory(data, tierResult) {
  data.contentTier = tierResult.contentTier;
  // Propagate truncationSignals so classifyIncompleteReason (called next) can
  // use them for routing (e.g., nyt_bot_stub -> bot_blocked not paywall).
  if (tierResult.truncationSignals) data.truncationSignals = tierResult.truncationSignals;
  if (tierResult.paywallOverride) {
    data.textStatus = 'truncated';
    data.textQuality = 'truncated';
    data.isFullReview = false;
  }
  if (tierResult.tierReason !== undefined) data.contentTierReason = tierResult.tierReason;
}

module.exports = { classifyTierWriteBack, applyTierResultInMemory };
