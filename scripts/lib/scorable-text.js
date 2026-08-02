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
const { assessTextQuality } = require('./content-quality');

/** Default floor used by the scorer's `--min-text-length` option. */
const DEFAULT_MIN_TEXT_LENGTH = 100;

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
    const quality = assessTextQuality(data.fullText, data.showId, opts.showTitle);
    const rejected =
      quality.quality === 'garbage' ||
      (quality.quality === 'suspicious' && quality.confidence === 'high');
    if (!rejected) {
      return { text: data.fullText, isExcerpt: false };
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

module.exports = { selectScorableText, DEFAULT_MIN_TEXT_LENGTH };
