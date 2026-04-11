/**
 * Pull Quote Guards — pure decision helpers for extract-pull-quotes.js.
 *
 * Extracted per CLAUDE.md §15 (Test Extraction Pattern): never copy logic
 * into test files; require the real function.
 */

// Sentences that start with a hedging connector — "But", "Yet", "Still",
// "Though", "Although", "However", "Despite", "While" — usually introduce
// a reservation or caveat. When the surrounding review is positive overall,
// picking one of these as the pull quote makes the critic look ambivalent
// even when they weren't. NYT critics especially structure reviews with a
// middle-paragraph caveat before a positive closer — the LLM reliably picks
// the caveat as "most quotable".
const HEDGE_OPENER_RE = /^\s*(but|yet|still|though|although|however|despite|while)\b/i;

// Mid-sentence pivots like ", but", ", yet", ", though" on a positive review
// almost always swing the reader from praise to reservation. E.g. Helen Shaw
// on Giant: "I found Lithgow's performance a fascinating study in monstrosity,
// but I found myself more engaged by the conversations I've had since seeing
// 'Giant'" — reads as a withdrawal of endorsement on a 77-scoring review.
const MID_SENTENCE_PIVOT_RE = /,\s+(but|yet|though|although|however|despite)\b/i;

/**
 * Does this sentence open with a hedge word? Case-insensitive, tolerates
 * leading quote marks (some LLM responses are wrapped in quotes the caller
 * didn't strip).
 */
function isHedgeOpener(quote) {
  if (!quote || typeof quote !== 'string') return false;
  // Strip leading straight/curly quotes so '"But..."' still trips the guard.
  const cleaned = quote.replace(/^[\s"\u201C\u2018'`]+/, '');
  return HEDGE_OPENER_RE.test(cleaned);
}

/**
 * Does this sentence contain a mid-sentence reservation pivot?
 */
function hasMidSentencePivot(quote) {
  if (!quote || typeof quote !== 'string') return false;
  return MID_SENTENCE_PIVOT_RE.test(quote);
}

/**
 * Should we reject this quote as misaligned with the review's verdict?
 *
 * Rule: if the review's overall score is positive (>= 70) and the quote
 * opens with a hedging connector, it's almost always a middle-paragraph
 * reservation rather than the critic's endorsement. Reject so the caller
 * can retry with a stronger hint.
 *
 * For mixed (40-69) and negative (< 40) reviews, hedge openers are often
 * legitimate ("Still, the show never finds its footing") so we don't block.
 *
 * `score` can be null/undefined — in that case we don't have a verdict
 * signal and we let the quote through (old behavior).
 */
function shouldRejectAsReservation(quote, score) {
  if (score == null) return false;
  if (typeof score !== 'number' || Number.isNaN(score)) return false;
  if (score < 70) return false;
  if (isHedgeOpener(quote)) return true;
  if (hasMidSentencePivot(quote)) return true;
  return false;
}

module.exports = {
  HEDGE_OPENER_RE,
  MID_SENTENCE_PIVOT_RE,
  isHedgeOpener,
  hasMidSentencePivot,
  shouldRejectAsReservation,
};
