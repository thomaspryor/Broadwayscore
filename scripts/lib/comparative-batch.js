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
const { CLAUDE_SONNET } = require('./models');
const { parseComparativeResponse } = require('./comparative-band');

const COMPARATIVE_PARAMS = Object.freeze({
  claudeModel: CLAUDE_SONNET,
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
        thinkingConfig: require('./llm-batch').geminiThinkingOff(COMPARATIVE_PARAMS.geminiModel), // BRO-7511: 3.x rejects thinkingBudget
      },
    },
  };
}

const crypto = require('crypto');
const STATE_MAX_AGE_MS = 24 * 3600 * 1000;

/** Key a prompt by content: answers and in-flight batches survive a changed prompt set. */
function promptKey(prompt) {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 20);
}

/** Map vendor results (custom id = index into `keys`) to key -> text; failures are omitted. */
function resultsByKey(keys, results) {
  const out = new Map();
  for (const r of results || []) {
    const i = indexOfCustomId(r.customId);
    if (i >= 0 && i < keys.length && r.success && r.text) out.set(keys[i], r.text);
  }
  return out;
}

const fresh = (at, now) => {
  const age = now - Date.parse(at || '');
  return Number.isFinite(age) && age >= 0 && age < STATE_MAX_AGE_MS;
};

/**
 * Per-vendor state: { inflight?: {id, keys[], submittedAt}, answers: {key: {text, at}} }.
 * `text` is '' when the vendor's batch ended without a usable answer for that prompt
 * (a TERMINAL failure: that vendor stops blocking the group, as in the sync path).
 */
function usableInflight(v, now = Date.now()) {
  return v && v.inflight && v.inflight.id && fresh(v.inflight.submittedAt, now) ? v.inflight : null;
}

/** Prompt keys with no fresh recorded answer (and not covered by a usable in-flight batch). */
function missingKeys(v, keys, now = Date.now()) {
  const inflight = usableInflight(v, now);
  const covered = new Set(inflight ? inflight.keys : []);
  return keys.filter((k) => !(v && v.answers && v.answers[k] && fresh(v.answers[k].at, now)) && !covered.has(k));
}

/**
 * What is stored for an answer: only the ids, scores and warmth ranks the scorer reads.
 * The state file is committed to the public repo, and a model's free-text `reasoning`
 * can quote review text, so it is dropped here. Unparseable replies become '' (terminal).
 */
function storableAnswer(text) {
  const parsed = parseComparativeResponse(text || '', []);
  const rows = Object.entries(parsed).map(([id, o]) => ({ id, score: o.score, warmthRank: o.warmthRank }));
  return rows.length ? JSON.stringify(rows) : '';
}

/** Record a terminal batch: every requested key gets its answer or '' (terminal failure). Returns new vendor state. */
function recordTerminal(v, inflightKeys, textsByKey, now = Date.now()) {
  const answers = { ...((v && v.answers) || {}) };
  for (const k of inflightKeys) answers[k] = { text: storableAnswer(textsByKey.get(k)), at: new Date(now).toISOString() };
  return { answers };
}

/** Consecutive runs a vendor may fail to SUBMIT before its missing prompts are recorded as terminal failures. */
const MAX_SUBMIT_FAILURES = 3;

/** Drop expired answers and ones for prompts no longer wanted. */
function pruneAnswers(v, wantedKeys, now = Date.now()) {
  const want = new Set(wantedKeys);
  const answers = {};
  for (const [k, a] of Object.entries((v && v.answers) || {})) if (want.has(k) && fresh(a.at, now)) answers[k] = a;
  return { ...(v || {}), answers };
}

/**
 * A group is only scored when EVERY vendor has a terminal answer record for its
 * prompt (text or terminal failure). A vendor still in flight defers the group;
 * one that ended without an answer does not block it (sync-path parity).
 */
function allVendorsRecorded(stateByVendor, key, now = Date.now()) {
  const vendors = Object.keys(stateByVendor || {});
  return vendors.length > 0 && vendors.every((n) => {
    const a = stateByVendor[n] && stateByVendor[n].answers && stateByVendor[n].answers[key];
    return !!a && fresh(a.at, now);
  });
}

module.exports = {
  COMPARATIVE_PARAMS, customId, indexOfCustomId,
  buildAnthropicRequest, buildOpenAIRequest, buildGeminiRequest,
  promptKey, resultsByKey, usableInflight, missingKeys, recordTerminal, pruneAnswers,
  allVendorsRecorded, STATE_MAX_AGE_MS, storableAnswer, MAX_SUBMIT_FAILURES,
};
