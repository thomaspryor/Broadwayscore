/**
 * Pure request builders for the comparative within-band rescore's Batch API
 * path (BRO-7523). The sync callers in llm-scoring/comparative-core.ts read
 * their model ids and sampling params from COMPARATIVE_PARAMS, and the batch
 * builders below read the same constants, so a batched call is the same
 * request at half price (same model, same prompt, same temperature).
 * The comparative prompt is one user message (no system prompt), unlike
 * llm-batch.js's scoring builders, so these do not reuse those.
 */
const { openaiChatBody } = require('./llm-batch');

const COMPARATIVE_PARAMS = Object.freeze({
  claudeModel: 'claude-sonnet-4-6',
  geminiModel: 'gemini-2.5-flash',
  maxTokens: 2000,
  temperature: 0.3,
});

const customId = (i) => `cmp-${i}`;
const indexOfCustomId = (id) => {
  const m = /^cmp-(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : -1;
};

function buildAnthropicRequest(i, prompt) {
  return {
    custom_id: customId(i),
    params: {
      model: COMPARATIVE_PARAMS.claudeModel,
      max_tokens: COMPARATIVE_PARAMS.maxTokens,
      temperature: COMPARATIVE_PARAMS.temperature,
      messages: [{ role: 'user', content: prompt }],
    },
  };
}

function buildOpenAIRequest(i, prompt, model) {
  return {
    custom_id: customId(i),
    method: 'POST',
    url: '/v1/chat/completions',
    body: openaiChatBody({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: COMPARATIVE_PARAMS.maxTokens,
      temperature: COMPARATIVE_PARAMS.temperature,
    }),
  };
}

function buildGeminiRequest(i, prompt) {
  return {
    metadata: { key: customId(i) },
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: COMPARATIVE_PARAMS.temperature,
        maxOutputTokens: COMPARATIVE_PARAMS.maxTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  };
}

/** Map vendor results ({customId, success, text}) back to prompt -> text. */
function resultsByPrompt(prompts, results) {
  const out = new Map();
  for (const r of results || []) {
    const i = indexOfCustomId(r.customId);
    if (i >= 0 && i < prompts.length && r.success && r.text) out.set(prompts[i], r.text);
  }
  return out;
}

/**
 * Batch only the scheduled, non-urgent run. Any manual dispatch (a per-show
 * opening-night rescore) stays sync; DISABLE_BATCH_SCORING=1 forces sync.
 */
function shouldBatchComparative({ eventName, chain, disabled }) {
  return eventName === 'schedule' && chain !== 'true' && disabled !== '1';
}

module.exports = {
  COMPARATIVE_PARAMS, customId, indexOfCustomId,
  buildAnthropicRequest, buildOpenAIRequest, buildGeminiRequest,
  resultsByPrompt, shouldBatchComparative,
};
