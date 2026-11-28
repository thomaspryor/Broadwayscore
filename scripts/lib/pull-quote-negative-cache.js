'use strict';
/**
 * Failure memory for scripts/extract-pull-quotes.js (BRO-7535).
 *
 * A review whose LLM pull-quote extraction was finally rejected (NONE, not in
 * text, hedge after retry, bad length after retry, ...) used to get no stamp,
 * so every run re-asked Gemini about the same ~1,100 reviews (2 calls each):
 * about 40-55K requests a day and 70% of the Google bill.
 *
 * On a final rejection the extractor stamps the review file with a hash of
 * what the LLM judged (fullText plus assignedScore, since the score sets the
 * verdict line in the prompt and the hedge guard) and the prompt version.
 * Later runs skip it while both are unchanged. A changed fullText (refetch,
 * heal), a new or changed score, or a prompt/guard version change re-queues
 * it; --overwrite ignores the stamp.
 *
 * Pure functions only: required by the extractor and by
 * scripts/tests/extract-pull-quotes-negative-cache.test.mjs.
 */
const crypto = require('crypto');

const STAMP_FIELDS = Object.freeze({
  at: 'llmPullQuoteRejectedAt',
  reason: 'llmPullQuoteRejectReason',
  inputHash: 'llmPullQuoteRejectInputHash',
  promptVersion: 'llmPullQuoteRejectPromptVersion',
});

// Bump when a guard in scripts/lib/pull-quote-guards.js changes what counts as
// an acceptable quote, so earlier rejections get one fresh look.
const GUARD_VERSION = 1;

function sha(text, len) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, len);
}

function fullTextHash(fullText) {
  return sha(fullText, 16);
}

function normScore(score) {
  return typeof score === 'number' && !Number.isNaN(score) ? String(score) : 'none';
}

/** Hash of everything the extraction depends on besides the prompt: text and score. */
function judgedInputHash(fullText, score) {
  return sha(`${String(fullText == null ? '' : fullText)}\n#score=${normScore(score)}`, 16);
}

/** Version string: changes whenever the system prompt text or GUARD_VERSION changes. */
function promptVersionFor(systemPrompt) {
  return `g${GUARD_VERSION}-${sha(systemPrompt, 12)}`;
}

/** Fields to merge into the review file after a final rejection. */
function buildRejectionStamp({ fullText, score, reason, promptVersion, now }) {
  return {
    [STAMP_FIELDS.at]: (now instanceof Date ? now : new Date()).toISOString(),
    [STAMP_FIELDS.reason]: String(reason || 'rejected'),
    [STAMP_FIELDS.inputHash]: judgedInputHash(fullText, score),
    [STAMP_FIELDS.promptVersion]: promptVersion,
  };
}

/**
 * True when this review was already judged and rejected on the same fullText
 * and assignedScore with the same prompt version, so asking the LLM again would repeat the
 * same answer and cost money.
 */
function shouldSkipForPriorRejection(data, { promptVersion, overwrite } = {}) {
  if (overwrite) return false;
  if (!data || !data[STAMP_FIELDS.at]) return false;
  if (!promptVersion || data[STAMP_FIELDS.promptVersion] !== promptVersion) return false;
  return data[STAMP_FIELDS.inputHash] === judgedInputHash(data.fullText, data.assignedScore);
}

/**
 * Run-level tripwire: many LLM calls and nothing persisted (no quote written,
 * no rejection stamped) means the run is burning money in a loop again.
 */
function wastedRunTripwire({ llmCalls, written, stamped }, threshold = 100) {
  const persisted = (written || 0) + (stamped || 0);
  if ((llmCalls || 0) >= threshold && persisted === 0) {
    return `${llmCalls} LLM calls, 0 quotes written and 0 rejections stamped: either the extractor is re-asking the same reviews or every stamp write was quarantined by safeWriteReview (BRO-7535)`;
  }
  return null;
}

module.exports = {
  STAMP_FIELDS,
  GUARD_VERSION,
  fullTextHash,
  judgedInputHash,
  promptVersionFor,
  buildRejectionStamp,
  shouldSkipForPriorRejection,
  wastedRunTripwire,
};
