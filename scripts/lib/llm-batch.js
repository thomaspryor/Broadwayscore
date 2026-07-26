/**
 * Pure batch-assembly / result-merge / resume logic for the nightly ensemble
 * scorer's --batch mode (task #505). No network calls, no filesystem, no
 * Date.now() — every timestamp/status is injected so this stays fully
 * unit-testable and safe to require() from both scripts/llm-scoring/*.ts
 * (via ts-node's CommonJS interop) and tests/*.mjs.
 *
 * Vendor batch endpoints (Anthropic Message Batches, OpenAI Batches, Gemini
 * batch mode) are NOT called here — that lives in
 * scripts/llm-scoring/batch-clients.ts. This module only knows how to shape
 * a request envelope and unwrap a result envelope per vendor, and how to
 * merge three vendors' results back into one array keyed by request index.
 *
 * custom_id scheme: opaque `req-<index>` strings, not showId/outletId —
 * Anthropic's custom_id has a 64-char pattern-constrained format and real
 * showId/outletId slugs (e.g. "trainspotting-the-musical-west-end-2026")
 * can exceed that combined. The real identity (showId/outletId/filePath)
 * lives in the caller's manifest array at the same index, persisted
 * alongside batch IDs in scoring-progress.json for resume.
 */

'use strict';

const REQUEST_ID_PREFIX = 'req-';

function buildCustomId(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`buildCustomId: index must be a non-negative integer, got ${index}`);
  }
  return `${REQUEST_ID_PREFIX}${index}`;
}

function parseCustomIdIndex(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(REQUEST_ID_PREFIX)) return null;
  const n = Number(customId.slice(REQUEST_ID_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ========================================
// ANTHROPIC (Message Batches API)
// ========================================

/**
 * Shape matches the live sync call at scripts/llm-scoring/scorer.ts
 * scoreReviewV5 (max_tokens: 500, temperature: 0.3, system cache_control
 * breakpoint) so batch and sync produce byte-identical requests.
 */
function buildAnthropicBatchRequest({ customId, model, systemPrompt, userPrompt, maxTokens = 500, temperature = 0.3 }) {
  if (!customId || !model || !systemPrompt || !userPrompt) {
    throw new Error('buildAnthropicBatchRequest: customId, model, systemPrompt, userPrompt are required');
  }
  return {
    custom_id: customId,
    params: {
      model,
      max_tokens: maxTokens,
      temperature,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    },
  };
}

/**
 * Unwrap one line of the Anthropic batch results .jsonl
 * (MessageBatchIndividualResponse: { custom_id, result: {type, message|error} }).
 */
function parseAnthropicBatchResult(entry) {
  const customId = entry && entry.custom_id;
  const result = (entry && entry.result) || {};
  if (result.type === 'succeeded') {
    const message = result.message || {};
    const textBlock = (message.content || []).find((c) => c.type === 'text');
    const usage = message.usage || {};
    return {
      customId,
      success: true,
      text: textBlock ? textBlock.text : '',
      usage: {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
      },
    };
  }
  if (result.type === 'errored') {
    const err = result.error || {};
    return { customId, success: false, error: err.message || err.type || 'anthropic_batch_errored' };
  }
  if (result.type === 'canceled') return { customId, success: false, error: 'anthropic_batch_canceled' };
  if (result.type === 'expired') return { customId, success: false, error: 'anthropic_batch_expired' };
  return { customId, success: false, error: `anthropic_batch_unknown_result_type:${result.type}` };
}

// ========================================
// OPENAI (Batch API)
// ========================================

/** One line of the JSONL file uploaded to POST /v1/files (purpose=batch). */
function buildOpenAIBatchLine({ customId, model, systemPrompt, userPrompt, maxTokens = 500, temperature = 0.3 }) {
  if (!customId || !model || !systemPrompt || !userPrompt) {
    throw new Error('buildOpenAIBatchLine: customId, model, systemPrompt, userPrompt are required');
  }
  return {
    custom_id: customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
    },
  };
}

/** Unwrap one line of the OpenAI batch output file. */
function parseOpenAIBatchResult(line) {
  const customId = line && line.custom_id;
  if (line && line.error) {
    return { customId, success: false, error: line.error.message || String(line.error) };
  }
  const response = (line && line.response) || {};
  if (response.status_code && response.status_code >= 300) {
    const bodyErr = response.body && response.body.error;
    return { customId, success: false, error: (bodyErr && bodyErr.message) || `openai_batch_http_${response.status_code}` };
  }
  const body = response.body || {};
  const choice = (body.choices || [])[0] || {};
  const content = choice.message && choice.message.content;
  const usage = body.usage || {};
  return {
    customId,
    success: !!content,
    text: content || '',
    error: content ? undefined : 'no_content_in_response',
    usage: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
  };
}

// ========================================
// GEMINI (batch mode)
// ========================================
// NOTE: Google's Gemini Developer API batch mode is newer and its exact wire
// format is less battle-tested in this codebase than Anthropic's/OpenAI's
// (no prior call sites existed for any of the three before this task). The
// shapes below match the documented batchGenerateContent contract as of
// 2026-07-26 but have NOT been verified against a live submit+poll+fetch
// round trip. Confirm against a real small batch before enabling in the
// nightly cron.

/**
 * Gemini has no separate system role for inline batch requests — mirror
 * gemini-scorer.ts:85-87's `systemPrompt + '\n\n' + userPrompt` concatenation
 * exactly, or the batch leg would score on a different prompt than sync.
 */
function buildGeminiBatchRequest({ customId, systemPrompt, userPrompt, temperature = 0.3, maxOutputTokens = 500 }) {
  if (!customId || !systemPrompt || !userPrompt) {
    throw new Error('buildGeminiBatchRequest: customId, systemPrompt, userPrompt are required');
  }
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  return {
    metadata: { key: customId },
    request: {
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      generationConfig: {
        temperature,
        topP: 0.8,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  };
}

/** Unwrap one entry of the Gemini batch results (inlinedResponses[]). */
function parseGeminiBatchResult(entry) {
  const customId = (entry && entry.key) || (entry && entry.metadata && entry.metadata.key);
  if (entry && entry.error) {
    return { customId, success: false, error: entry.error.message || String(entry.error) };
  }
  const response = (entry && entry.response) || {};
  const candidate = (response.candidates || [])[0] || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  const usage = response.usageMetadata || {};
  return {
    customId,
    success: !!text,
    text,
    error: text ? undefined : 'empty_response',
    usage: { input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0 },
  };
}

// ========================================
// MERGE
// ========================================

function resultsToMap(results) {
  const map = new Map();
  for (const r of results || []) {
    if (r && r.customId) map.set(r.customId, r);
  }
  return map;
}

/**
 * For each of the `itemCount` submitted requests, pair up whatever each
 * vendor returned (or null if that vendor's batch failed/expired/never
 * returned this custom_id — same "missing outcome" shape the sync path's
 * Promise.all().catch(() => null) produces).
 */
function mergeVendorResults({ claude, openai, gemini }, itemCount) {
  const merged = [];
  for (let i = 0; i < itemCount; i++) {
    const customId = buildCustomId(i);
    merged.push({
      index: i,
      customId,
      claude: (claude && claude.get(customId)) || null,
      openai: (openai && openai.get(customId)) || null,
      gemini: (gemini && gemini.get(customId)) || null,
    });
  }
  return merged;
}

// ========================================
// RESUME / STATE MACHINE
// ========================================

const TERMINAL_STATUSES = new Set(['ended', 'completed', 'failed', 'expired']);

/**
 * Pure decision function for what the next scheduled run should do with a
 * (possibly in-flight) batch. `now` (ms epoch) and `vendorStatuses` are
 * injected — the caller is responsible for fetching live statuses first.
 *
 * batchState shape (persisted under scoring-progress.json's `batch` key):
 *   { submittedAt: ISO string, claudeBatchId?, openaiBatchId?, geminiBatchId? }
 * vendorStatuses shape: { claude?: string, openai?: string, gemini?: string }
 *   — vendor-native status strings (Anthropic: in_progress/canceling/ended;
 *   OpenAI: validating/in_progress/finalizing/completed/failed/expired/
 *   cancelled; Gemini: an operation's done:true/false mapped by the caller
 *   to 'ended'/'in_progress' before calling this function).
 */
function decideNextAction({ batchState, vendorStatuses, now }) {
  if (!batchState || !batchState.submittedAt) {
    return { action: 'submit' };
  }
  const vendors = ['claude', 'openai', 'gemini'];
  const allTerminal = vendors.every((v) => {
    const hasVendor = !!batchState[`${v}BatchId`];
    if (!hasVendor) return true; // vendor wasn't submitted (e.g. no API key) — not blocking
    const status = vendorStatuses && vendorStatuses[v];
    return !!status && TERMINAL_STATUSES.has(status);
  });
  if (allTerminal) {
    return { action: 'fetch_and_merge' };
  }
  const submittedMs = Date.parse(batchState.submittedAt);
  const ageMs = Number.isFinite(submittedMs) ? now - submittedMs : 0;
  // Vendors auto-expire batches at 24h; give a 1h grace margin for clock
  // skew / late status propagation before forcing a merge on whatever
  // vendors DID finish (missing vendors fall back to null in the ensemble,
  // same as a live rate-limit-exhausted model in sync mode).
  const FORCE_MERGE_AFTER_MS = 25 * 60 * 60 * 1000;
  if (ageMs > FORCE_MERGE_AFTER_MS) {
    return { action: 'fetch_and_merge', forced: true, reason: 'batch age exceeded 25h grace window' };
  }
  return { action: 'poll' };
}

module.exports = {
  buildCustomId,
  parseCustomIdIndex,
  buildAnthropicBatchRequest,
  parseAnthropicBatchResult,
  buildOpenAIBatchLine,
  parseOpenAIBatchResult,
  buildGeminiBatchRequest,
  parseGeminiBatchResult,
  resultsToMap,
  mergeVendorResults,
  decideNextAction,
  TERMINAL_STATUSES,
};
