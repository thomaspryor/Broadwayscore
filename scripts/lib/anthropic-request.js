'use strict';
/**
 * anthropic-request.js (BRO-7527): build a direct Messages-API body for a
 * pinned Claude model, so a pin flip in scripts/lib/models.js does not need a
 * per-caller rewrite. Read the answer with finalResponseText
 * (scripts/lib/anthropic-response-text.js), never content[0].text.
 *
 * Per-model sampling/thinking params come from the ONE table,
 * llm-batch.js claudeSamplingParams. This file adds only what that table does
 * not cover for a plain single-turn call: Haiku 5.5's tokenizer counts the same
 * text as ~1.3x the tokens, so a max_tokens cap tuned on Haiku 4.5 is scaled.
 * Families whose request shape nobody has checked yet throw instead of sending
 * a body that would think through a small max_tokens and return no text.
 *
 * Bodies for models that already worked (Haiku 4.5, Sonnet 4.6, Opus 4.7) are
 * byte-identical to the hand-built ones they replace.
 * (Sonnet 5.x callers now get the same between_tools thinking param the scorer
 * sends, e.g. video-reviews/eval-prompts.js; that is the intended change.)
 */
const { claudeSamplingParams } = require('./llm-batch');

const HAIKU_5 = /^claude-haiku-5/;
const HAIKU_5_TOKEN_FACTOR = 1.3;
const UNCHECKED_SHAPE = /^claude-(opus-5|fable|mythos)/;

/**
 * @param {object} o
 * @param {string} o.model
 * @param {number} o.maxTokens  cap tuned for the Haiku 4.5 tokenizer
 * @param {string} [o.prompt]   single user turn (or pass o.messages)
 * @param {Array}  [o.messages]
 * @param {number} [o.temperature] omit to send none (models that reject it never get it)
 */
function buildMessagesBody({ model, maxTokens, prompt, messages, temperature = null }) {
  if (!model) throw new Error('buildMessagesBody: model is required');
  if (!(maxTokens > 0)) throw new Error('buildMessagesBody: maxTokens must be > 0');
  if (UNCHECKED_SHAPE.test(model)) {
    throw new Error(`buildMessagesBody: no checked request shape for ${model}; add it to llm-batch.js claudeSamplingParams first`);
  }
  return {
    model,
    max_tokens: HAIKU_5.test(model) ? Math.ceil(maxTokens * HAIKU_5_TOKEN_FACTOR) : maxTokens,
    messages: messages || [{ role: 'user', content: prompt }],
    ...claudeSamplingParams(model, temperature),
  };
}

module.exports = { buildMessagesBody, HAIKU_5_TOKEN_FACTOR };
