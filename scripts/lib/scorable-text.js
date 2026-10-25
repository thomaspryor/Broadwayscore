/**
 * scorable-text.js — canonical "which text would the LLM actually score?" selector.
 *
 * WHY THIS EXISTS (2026-08-02, Notion 3ad637c5-416f-81d0 / task #652):
 * scripts/llm-scoring/index.ts had this logic as a private closure
 * (`getScorableText`). llm-ensemble-score.yml's cascade gate had its OWN
 * hand-rolled, much looser idea of "has scoreable text" inlined as `node -e`:
 *
 *   const hasText = r.fullText && r.fullText.length > 100;
 *
 * That divergence is what starved the cascade. The gate counted 147 unscored
 * reviews; the scorer's real selection chain could only ever act on 1 of them.
 * Because the gate is a STRICT cascade (`UNSCORED == 0` before phases 2/3/4
 * may run), a residue the scorer can never consume pinned the counter above
 * zero forever and Phase 4 (emergency retry) never fired once — 38 reviews sat
 * flagged singleModelEmergency with a retry count of zero.
 *
 * The fix is the standing project rule: one predicate, imported by both sides
 * (memory/feedback_includability_predicates_must_be_canonical.md). index.ts
 * calls selectScorableText() and layers its telemetry on top; the counter CLI
 * calls the same function.
 */

const { EXCERPT_FIELDS } = require('./excerpt-fields');
const { assessTextQuality, qualityOptsFor } = require('./content-quality');

/**
 * Excerpt-bundle floor. MUST equal the `minTextLength` the scorer runs with
 * (scripts/llm-scoring/index.ts sets 50). A higher default here silently
 * excludes 50-99 char excerpt bundles the scorer WOULD score — the counter
 * would hide them and advance the cascade past real work, which is the exact
 * bug this module exists to prevent (Codex verification pass, task #652).
 */
const DEFAULT_MIN_TEXT_LENGTH = 50;

/**
 * Pick the text the LLM would be handed for this review, mirroring the scorer.
 *
 * fullText wins unless content-quality rejects it (garbage, or high-confidence
 * suspicious), in which case we fall through to the deduped excerpt bundle —
 * exactly the order llm-scoring/index.ts uses.
 *
 * @param {Object} data - review-text record
 * @param {Object} [options]
 * @param {string} [options.showTitle] - show title, for content-quality's show-mention check
 * @param {number} [options.minTextLength] - excerpt-bundle floor (default 100)
 * @param {(info: {quality: string, confidence: string, issues: string[]}) => void} [options.onFullTextRejected]
 *   called when fullText exists but content-quality rejected it (telemetry hook
 *   for index.ts's garbageSkips ledger)
 * @returns {{ text: string, isExcerpt: boolean } | null} null when nothing is scoreable
 */
function selectScorableText(data, options) {
  const opts = options || {};
  const minTextLength = opts.minTextLength != null ? opts.minTextLength : DEFAULT_MIN_TEXT_LENGTH;

  if (data && data.fullText && data.fullText.length >= 100) {
    const quality = assessTextQuality(data.fullText, data.showId, opts.showTitle, qualityOptsFor(data));
    const rejected =
      quality.quality === 'garbage' ||
      (quality.quality === 'suspicious' && quality.confidence === 'high');
    if (!rejected) {
      return { text: data.fullText, isExcerpt: false };
    }
    // BRO-4430: text stored before a site-chrome pattern existed (the Tru
    // London Theatre review kept its booking calendar and "Latest News" list)
    // is rejected as multi-show garbage for the chrome alone. Retry once on
    // the stripped text; a text that passed above is never changed.
    const { stripTrailingJunk } = require('./text-cleaning');
    const stripped = stripTrailingJunk(data.fullText);
    if (stripped && stripped !== data.fullText && stripped.length >= 100) {
      const q2 = assessTextQuality(stripped, data.showId, opts.showTitle, qualityOptsFor(data));
      const rejected2 = q2.quality === 'garbage' || (q2.quality === 'suspicious' && q2.confidence === 'high');
      if (!rejected2) return { text: stripped, isExcerpt: false };
    }
    if (typeof opts.onFullTextRejected === 'function') {
      opts.onFullTextRejected(quality);
    }
    // fall through to excerpts
  }

  const excerpts = [];
  for (const field of EXCERPT_FIELDS) {
    const val = data && data[field];
    if (val && !excerpts.includes(val)) excerpts.push(val);
  }
  if (excerpts.length > 0) {
    const combined = excerpts.join('\n\n');
    if (combined.length >= minTextLength) {
      return { text: combined, isExcerpt: true };
    }
  }

  return null;
}

/**
 * True for a Theatre Record capsule review: TR-sourced fullText in the
 * 100–999 char band. TR text is verbatim verified review content, and short
 * TR entries are complete print capsules (Mail on Sunday / Sunday Telegraph),
 * structurally equivalent to the curated aggregator excerpts that are exempt
 * from score-input-validator.js's 1000-char body gate. Without this predicate
 * they are permanently unscoreable: too long (≥100) to fall through to the
 * excerpt path above, too short (<1000) for the fullText gate, and
 * EXCERPT_FIELDS has no theatre-record entry (2026-08-10, Notion
 * 3b8637c5-416f-81e9 / trainspotting daily-mail--georgina-brown).
 *
 * Scoped to source === 'theatre-record' ONLY — generalizing to all short
 * fullText would reopen the gate the validator exists for: partial scrapes
 * of long reviews must stay blocked.
 *
 * @param {Object} data - review-text record
 * @returns {boolean}
 */
function isCapsuleReview(data) {
  return !!(
    data &&
    data.source === 'theatre-record' &&
    typeof data.fullText === 'string' &&
    data.fullText.length >= 100 &&
    data.fullText.length < 1000
  );
}

/**
 * BRO-4430: when selectScorableText returned the chrome-stripped form of the
 * stored fullText (a prefix of it), that is the text to quality-check and
 * score. Returns it, or null when the selection is the raw fullText or an
 * excerpt (callers keep fullText as is).
 * @param {object} data   review record
 * @param {string|null} selectedText  selectScorableText(...).text
 * @returns {string|null}
 */
function strippedFullTextSelection(data, selectedText) {
  const full = data && data.fullText;
  if (!full || !selectedText || selectedText === full) return null;
  if (selectedText.length >= full.length) return null;
  return full.startsWith(selectedText) || full.trim().startsWith(selectedText) ? selectedText : null;
}

// BRO-5227: shortest stored partial text worth handing to the scorer. Below
// this the stored text is a page shell (byline block, cookie banner), not
// a piece of the article.
const MIN_SHORT_PARTIAL_CHARS = 300;
const BODY_GATE_CHARS = 1000; // score-input-validator.js's body_too_short floor

/**
 * BRO-5227: a partial copy of a review (300-999 chars of fullText) with no
 * other way to be scored. The owner's call (2026-10-13): a rough score from
 * the part we have beats leaving the review off the site.
 *
 * This reopens, for partials, the gate isCapsuleReview's comment says to keep
 * closed. The scoreability check in the scoring prompt is what keeps it safe:
 * a hand test of 13 current partials against the live V5 prompt (gpt-4o)
 * rejected every listing, casting note, menu tie-in, login wall and
 * off-topic page, refused the ledes cut off before any verdict
 * ("truncated_text"), and scored the two with a verdict (Heated Rivalry 76,
 * Franz & Marie First Night 20). Scores from these are always low confidence
 * (input-builder.ts), so getBestScore takes them as llmScore-lowconf.
 *
 * Files a classifier or a scorer already called non-review, wrong show or
 * wrong production stay out. A junk page that slips through costs one scoring
 * call: the ensemble's rejection sets rejectionReason, which ends the
 * exemption, and BRO-5047's fingerprint stops a retry on the same text.
 * @param {Object} data review-text record
 * @returns {boolean}
 */
function isShortPartialReview(data) {
  if (!data || typeof data.fullText !== 'string') return false;
  const len = data.fullText.trim().length;
  if (len < MIN_SHORT_PARTIAL_CHARS || len >= BODY_GATE_CHARS) return false;
  if (isCapsuleReview(data)) return false;
  // Only text the tier classifier itself called a partial copy of an article
  // (all 20 unscored cases on open shows on 2026-10-13; ~245 files across the
  // whole corpus, ~90 of them unscored). An untiered or 'complete' short text
  // is something else (a page shell, a contact form) and keeps the gate.
  if (data.contentTier !== 'truncated') return false;
  return !(data.wrongShow || data.wrongProduction || data.isNonReview || data.rejectionReason);
}

/**
 * The one answer to "does score-input-validator.js's body_too_short gate
 * apply to this file?". The scorer call sites (scorer.ts, ensemble-scorer.ts)
 * and rescore-lifecycle.js's isBlockedFromRescore must agree, or a file is
 * blocked on one side and re-dispatched on the other (BRO-2985).
 * @param {Object} data review-text record
 * @returns {boolean}
 */
function isExemptFromBodyLengthGate(data) {
  return isCapsuleReview(data) || isShortPartialReview(data);
}

/**
 * BRO-5227: scoreStatus 'TO_BE_CALCULATED' is a placeholder written when a
 * review had nothing to score (mark-uncalculated-reviews.js,
 * score-all-unscored.js). Two ways it stops holding:
 *
 * isToBeCalculatedScored: the file now has a real score: an LLM score, a
 * published rating, or a star rating relayed by an aggregator for an outlet
 * that publishes stars. The marker no longer keeps it off the site
 * (rebuild-helpers getBestScore) and clear-failure-flags.js may clear it.
 * A relayed rating only counts on a London show: every star relay is a UK
 * aggregator, and on a US show it rates the London production
 * (harry-potter-2021/independent--unknown.json: StageDoor's 5/5 for the
 * Palace Theatre run). Callers without the show (clear-failure-flags) pass
 * no category, so a relay alone never clears the marker there.
 *
 * isStaleToBeCalculated: that, OR the file has text the scorer will take.
 * Text alone only lets the file reach the scorer (review-guards
 * explainExclusion, which isScoreable() delegates to); getBestScore keeps
 * honouring the marker until a score exists, because these files often carry
 * a placeholder bucket/assignedScore (Mixed 50/55, no source) that must never
 * reach the site.
 * @param {Object} data review-text record
 * @returns {boolean}
 */
const LONDON_CATEGORIES = new Set(['west-end', 'off-west-end']);

/**
 * @param {Object} data review-text record
 * @param {string} [showCategory] the show's shows.json category
 * @returns {boolean}
 */
function isToBeCalculatedScored(data, showCategory) {
  if (!data || data.scoreStatus !== 'TO_BE_CALCULATED') return false;
  if (data.llmScore && typeof data.llmScore.score === 'number') return true;
  if (data.originalScore) return true;
  if (!data.aggregatorStars || !LONDON_CATEGORIES.has(showCategory)) return false;
  // lazy: score-extractors is heavy and requires several guard modules
  const { KNOWN_STAR_OUTLETS } = require('./score-extractors');
  return KNOWN_STAR_OUTLETS.has(data.outletId);
}

/**
 * @param {Object} data review-text record
 * @param {string} [showCategory] the show's shows.json category
 * @returns {boolean}
 */
function isStaleToBeCalculated(data, showCategory) {
  if (!data || data.scoreStatus !== 'TO_BE_CALCULATED') return false;
  if (isToBeCalculatedScored(data, showCategory)) return true;
  if (typeof data.fullText === 'string' && data.fullText.trim().length >= BODY_GATE_CHARS) return true;
  return isExemptFromBodyLengthGate(data);
}

module.exports = {
  strippedFullTextSelection, selectScorableText, isCapsuleReview, DEFAULT_MIN_TEXT_LENGTH,
  isShortPartialReview, isExemptFromBodyLengthGate, isToBeCalculatedScored, isStaleToBeCalculated, BODY_GATE_CHARS, MIN_SHORT_PARTIAL_CHARS };
