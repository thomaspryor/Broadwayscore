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
    const quality = assessTextQuality(data.fullText, data.showId, opts.showTitle);
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
      const q2 = assessTextQuality(stripped, data.showId, opts.showTitle);
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

module.exports = {
  strippedFullTextSelection, selectScorableText, isCapsuleReview, DEFAULT_MIN_TEXT_LENGTH };
