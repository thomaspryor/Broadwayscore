/**
 * Unit tests for the nightly ensemble scorer's --batch mode (task #505).
 *
 * Covers the acceptance criterion: batch-assembly + result-merge + resume
 * logic extracted to scripts/lib/llm-batch.js (CLAUDE.md §15), plus a
 * code-level parity check that a vendor's Batch API result — once unwrapped
 * by llm-batch.js — feeds the SAME parse/rejection pipeline the live
 * synchronous scorers use (scorer.ts / openai-scorer.ts / gemini-scorer.ts
 * `parseBatchResponseV5`), so sync and batch produce identical
 * SimplifiedLLMResult objects for identical model output text.
 *
 * This does NOT submit a real batch to any vendor — that requires a live
 * network round trip that can take minutes to 24h and is out of scope for
 * a fast unit suite. See scripts/llm-scoring/batch-clients.ts for the real
 * submit/poll/fetch implementations and task #505's handoff notes for the
 * live E2E verification plan.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.TS_NODE_PROJECT = new URL('../tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const {
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
} = require('../lib/llm-batch.js');

const { ReviewScorer } = require('./scorer');
const { OpenAIReviewScorer } = require('./openai-scorer');
const { GeminiScorer } = require('./gemini-scorer');
const { GEMINI_CALIBRATION_OFFSET } = require('./config');

const SAMPLE = {
  systemPrompt: 'SYSTEM PROMPT TEXT',
  userPrompt: 'USER PROMPT TEXT',
};

// ========================================
// custom_id
// ========================================

describe('buildCustomId / parseCustomIdIndex', () => {
  test('round-trips indices', () => {
    for (const i of [0, 1, 5, 399]) {
      assert.strictEqual(parseCustomIdIndex(buildCustomId(i)), i);
    }
  });

  test('rejects negative or non-integer indices', () => {
    assert.throws(() => buildCustomId(-1));
    assert.throws(() => buildCustomId(1.5));
  });

  test('parseCustomIdIndex returns null for malformed ids', () => {
    assert.strictEqual(parseCustomIdIndex('not-a-req-id'), null);
    assert.strictEqual(parseCustomIdIndex('req-abc'), null);
    assert.strictEqual(parseCustomIdIndex(''), null);
    assert.strictEqual(parseCustomIdIndex(undefined), null);
  });
});

// ========================================
// Request assembly — parity with sync scorers
// ========================================

describe('buildAnthropicBatchRequest', () => {
  test('matches the sync scoreReviewV5 request shape (scorer.ts:358-379)', () => {
    const req = buildAnthropicBatchRequest({
      customId: 'req-0',
      model: 'claude-sonnet-4-6',
      ...SAMPLE,
    });
    assert.strictEqual(req.custom_id, 'req-0');
    assert.strictEqual(req.params.model, 'claude-sonnet-4-6');
    assert.strictEqual(req.params.max_tokens, 500);
    assert.strictEqual(req.params.temperature, 0.3);
    // Prompt-cache breakpoint must survive into batch mode (CLAUDE.md task
    // note: "keep the system-prompt breakpoint").
    assert.deepStrictEqual(req.params.system, [
      { type: 'text', text: SAMPLE.systemPrompt, cache_control: { type: 'ephemeral' } },
    ]);
    assert.deepStrictEqual(req.params.messages, [{ role: 'user', content: SAMPLE.userPrompt }]);
  });

  test('throws when required fields are missing', () => {
    assert.throws(() => buildAnthropicBatchRequest({ customId: 'req-0' }));
  });
});

describe('buildOpenAIBatchLine', () => {
  test('matches the sync scoreReviewV5 request shape (openai-scorer.ts:314-329)', () => {
    const line = buildOpenAIBatchLine({
      customId: 'req-1',
      model: 'gpt-4o',
      ...SAMPLE,
    });
    assert.strictEqual(line.custom_id, 'req-1');
    assert.strictEqual(line.method, 'POST');
    assert.strictEqual(line.url, '/v1/chat/completions');
    assert.strictEqual(line.body.model, 'gpt-4o');
    assert.strictEqual(line.body.max_tokens, 500);
    assert.strictEqual(line.body.temperature, 0.3);
    assert.deepStrictEqual(line.body.messages, [
      { role: 'system', content: SAMPLE.systemPrompt },
      { role: 'user', content: SAMPLE.userPrompt },
    ]);
  });
});

describe('buildGeminiBatchRequest', () => {
  test('concatenates system+user exactly like gemini-scorer.ts:85-87', () => {
    const req = buildGeminiBatchRequest({ customId: 'req-2', ...SAMPLE });
    assert.strictEqual(req.metadata.key, 'req-2');
    assert.strictEqual(
      req.request.contents[0].parts[0].text,
      `${SAMPLE.systemPrompt}\n\n${SAMPLE.userPrompt}`
    );
    assert.strictEqual(req.request.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.strictEqual(req.request.generationConfig.maxOutputTokens, 500);
  });
});

// ========================================
// Result parsing — realistic vendor envelopes
// ========================================

const V5_JSON = JSON.stringify({
  bucket: 'Positive',
  score: 78,
  confidence: 'high',
  verdict: 'A well-reviewed production.',
  keyQuote: 'A triumphant return to form.',
  reasoning: 'Consistently positive language throughout.',
});

const REJECTION_JSON = JSON.stringify({
  scoreable: false,
  rejection: 'wrong_show',
  reasoning: 'This review discusses a different production entirely.',
});

describe('parseAnthropicBatchResult', () => {
  test('unwraps a succeeded result', () => {
    const entry = {
      custom_id: 'req-0',
      result: {
        type: 'succeeded',
        message: {
          content: [{ type: 'text', text: V5_JSON }],
          usage: { input_tokens: 500, output_tokens: 80, cache_creation_input_tokens: 200, cache_read_input_tokens: 0 },
        },
      },
    };
    const out = parseAnthropicBatchResult(entry);
    assert.strictEqual(out.customId, 'req-0');
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.text, V5_JSON);
    assert.deepStrictEqual(out.usage, { input: 500, output: 80, cacheWrite: 200, cacheRead: 0 });
  });

  test('unwraps errored/canceled/expired as failures', () => {
    assert.strictEqual(
      parseAnthropicBatchResult({ custom_id: 'req-1', result: { type: 'errored', error: { message: 'boom' } } }).success,
      false
    );
    assert.strictEqual(
      parseAnthropicBatchResult({ custom_id: 'req-2', result: { type: 'canceled' } }).error,
      'anthropic_batch_canceled'
    );
    assert.strictEqual(
      parseAnthropicBatchResult({ custom_id: 'req-3', result: { type: 'expired' } }).error,
      'anthropic_batch_expired'
    );
  });
});

describe('parseOpenAIBatchResult', () => {
  test('unwraps a 200 response', () => {
    const line = {
      custom_id: 'req-0',
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: V5_JSON } }],
          usage: { prompt_tokens: 400, completion_tokens: 60 },
        },
      },
    };
    const out = parseOpenAIBatchResult(line);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.text, V5_JSON);
    assert.deepStrictEqual(out.usage, { input: 400, output: 60 });
  });

  test('unwraps a request-level error and an HTTP error status', () => {
    assert.strictEqual(parseOpenAIBatchResult({ custom_id: 'req-1', error: { message: 'rate limited' } }).success, false);
    const httpErr = parseOpenAIBatchResult({
      custom_id: 'req-2',
      response: { status_code: 500, body: { error: { message: 'server error' } } },
    });
    assert.strictEqual(httpErr.success, false);
    assert.strictEqual(httpErr.error, 'server error');
  });

  test('flags missing content', () => {
    const out = parseOpenAIBatchResult({ custom_id: 'req-3', response: { status_code: 200, body: { choices: [{ message: {} }] } } });
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.error, 'no_content_in_response');
  });
});

describe('parseGeminiBatchResult', () => {
  test('unwraps a successful inlined response', () => {
    const entry = {
      key: 'req-0',
      response: {
        candidates: [{ content: { parts: [{ text: V5_JSON }] } }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 50 },
      },
    };
    const out = parseGeminiBatchResult(entry);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.text, V5_JSON);
    assert.deepStrictEqual(out.usage, { input: 300, output: 50 });
  });

  test('flags an error entry and an empty response', () => {
    assert.strictEqual(parseGeminiBatchResult({ key: 'req-1', error: { message: 'quota exceeded' } }).success, false);
    assert.strictEqual(parseGeminiBatchResult({ key: 'req-2', response: { candidates: [] } }).error, 'empty_response');
  });
});

// ========================================
// Merge
// ========================================

describe('mergeVendorResults', () => {
  test('pairs all three vendors by index when everything succeeded', () => {
    const claude = resultsToMap([{ customId: 'req-0', success: true, text: 'c' }]);
    const openai = resultsToMap([{ customId: 'req-0', success: true, text: 'o' }]);
    const gemini = resultsToMap([{ customId: 'req-0', success: true, text: 'g' }]);
    const merged = mergeVendorResults({ claude, openai, gemini }, 1);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].claude.text, 'c');
    assert.strictEqual(merged[0].openai.text, 'o');
    assert.strictEqual(merged[0].gemini.text, 'g');
  });

  test('falls back to null for a vendor missing this custom_id (batch-level failure/expiry)', () => {
    const claude = resultsToMap([{ customId: 'req-0', success: true, text: 'c' }]);
    const openai = resultsToMap([]); // whole OpenAI batch failed/expired
    const gemini = resultsToMap([{ customId: 'req-0', success: true, text: 'g' }]);
    const merged = mergeVendorResults({ claude, openai, gemini }, 1);
    assert.strictEqual(merged[0].openai, null);
    assert.ok(merged[0].claude && merged[0].gemini);
  });

  test('handles a fully missing vendor map (no API key configured)', () => {
    const claude = resultsToMap([{ customId: 'req-0', success: true, text: 'c' }]);
    const merged = mergeVendorResults({ claude, openai: null, gemini: null }, 1);
    assert.strictEqual(merged[0].openai, null);
    assert.strictEqual(merged[0].gemini, null);
  });
});

// ========================================
// Resume / state machine
// ========================================

describe('decideNextAction', () => {
  const now = Date.parse('2026-07-27T04:30:00.000Z');

  test('fresh state (no prior submission) -> submit', () => {
    assert.strictEqual(decideNextAction({ batchState: null, vendorStatuses: {}, now }).action, 'submit');
    assert.strictEqual(decideNextAction({ batchState: {}, vendorStatuses: {}, now }).action, 'submit');
  });

  test('some vendors still processing -> poll', () => {
    const batchState = {
      submittedAt: '2026-07-27T03:00:00.000Z',
      claudeBatchId: 'msgbatch_1',
      openaiBatchId: 'batch_1',
      geminiBatchId: 'batches/1',
    };
    const vendorStatuses = { claude: 'ended', openai: 'in_progress', gemini: 'in_progress' };
    assert.strictEqual(decideNextAction({ batchState, vendorStatuses, now }).action, 'poll');
  });

  test('all submitted vendors terminal -> fetch_and_merge', () => {
    const batchState = {
      submittedAt: '2026-07-27T03:00:00.000Z',
      claudeBatchId: 'msgbatch_1',
      openaiBatchId: 'batch_1',
      geminiBatchId: 'batches/1',
    };
    const vendorStatuses = { claude: 'ended', openai: 'completed', gemini: 'ended' };
    assert.strictEqual(decideNextAction({ batchState, vendorStatuses, now }).action, 'fetch_and_merge');
  });

  test('a vendor that was never submitted (no API key) does not block merge', () => {
    const batchState = { submittedAt: '2026-07-27T03:00:00.000Z', claudeBatchId: 'msgbatch_1', openaiBatchId: 'batch_1' };
    const vendorStatuses = { claude: 'ended', openai: 'completed' };
    assert.strictEqual(decideNextAction({ batchState, vendorStatuses, now }).action, 'fetch_and_merge');
  });

  test('batch older than the 25h grace window forces a merge even if still pending', () => {
    const batchState = { submittedAt: '2026-07-26T00:00:00.000Z', claudeBatchId: 'msgbatch_1', openaiBatchId: 'batch_1', geminiBatchId: 'batches/1' };
    const vendorStatuses = { claude: 'ended', openai: 'in_progress', gemini: 'in_progress' };
    const result = decideNextAction({ batchState, vendorStatuses, now });
    assert.strictEqual(result.action, 'fetch_and_merge');
    assert.strictEqual(result.forced, true);
  });

  test('within the grace window, still-pending vendors keep polling', () => {
    const batchState = { submittedAt: '2026-07-27T04:00:00.000Z', claudeBatchId: 'msgbatch_1', openaiBatchId: 'batch_1', geminiBatchId: 'batches/1' };
    const vendorStatuses = { claude: 'ended', openai: 'in_progress', gemini: 'in_progress' };
    assert.strictEqual(decideNextAction({ batchState, vendorStatuses, now }).action, 'poll');
  });
});

// ========================================
// PARITY: batch envelope unwrap -> same parse pipeline as sync
// ========================================

describe('sync/batch parity — parseBatchResponseV5 on unwrapped batch text', () => {
  test('Claude: batch-unwrapped text parses identically to a direct call', () => {
    const scorer = new ReviewScorer('sk-fake-not-a-real-key');
    const anthropicEntry = {
      custom_id: 'req-0',
      result: { type: 'succeeded', message: { content: [{ type: 'text', text: V5_JSON }], usage: {} } },
    };
    const unwrapped = parseAnthropicBatchResult(anthropicEntry);
    assert.strictEqual(unwrapped.success, true);

    const viaBatch = scorer.parseBatchResponseV5(unwrapped.text);
    const viaDirect = scorer.parseBatchResponseV5(V5_JSON);
    assert.deepStrictEqual(viaBatch, viaDirect);
    assert.strictEqual(viaBatch.result.score, 78);
    assert.strictEqual(viaBatch.result.bucket, 'Positive');
  });

  test('Claude: batch-unwrapped rejection parses identically to a direct call', () => {
    const scorer = new ReviewScorer('sk-fake-not-a-real-key');
    const entry = {
      custom_id: 'req-0',
      result: { type: 'succeeded', message: { content: [{ type: 'text', text: REJECTION_JSON }], usage: {} } },
    };
    const unwrapped = parseAnthropicBatchResult(entry);
    const parsed = scorer.parseBatchResponseV5(unwrapped.text);
    assert.strictEqual(parsed.rejected, true);
    assert.strictEqual(parsed.rejection, 'wrong_show');
  });

  test('OpenAI: batch-unwrapped text parses identically to a direct call', () => {
    const scorer = new OpenAIReviewScorer('sk-fake-not-a-real-key');
    const line = { custom_id: 'req-0', response: { status_code: 200, body: { choices: [{ message: { content: V5_JSON } }] } } };
    const unwrapped = parseOpenAIBatchResult(line);
    const viaBatch = scorer.parseBatchResponseV5(unwrapped.text);
    const viaDirect = scorer.parseBatchResponseV5(V5_JSON);
    assert.deepStrictEqual(viaBatch, viaDirect);
    assert.strictEqual(viaBatch.result.score, 78);
  });

  test('Gemini: batch-unwrapped text applies the same calibration offset as a direct call', () => {
    const scorer = new GeminiScorer('fake-key-not-real');
    const entry = { key: 'req-0', response: { candidates: [{ content: { parts: [{ text: V5_JSON }] } }] } };
    const unwrapped = parseGeminiBatchResult(entry);
    const viaBatch = scorer.parseBatchResponseV5(unwrapped.text);
    const viaDirect = scorer.parseBatchResponseV5(V5_JSON);
    assert.deepStrictEqual(viaBatch, viaDirect);
    // 78 (raw) + calibration offset, clamped [0,100] — same math as
    // validateAndNormalize in gemini-scorer.ts, exercised via the live path.
    const expectedScore = Math.max(0, Math.min(100, Math.round(78 + GEMINI_CALIBRATION_OFFSET)));
    assert.strictEqual(viaBatch.result.score, expectedScore);
  });

  test('OpenAI: batch-unwrapped rejection parses identically to a direct call', () => {
    const scorer = new OpenAIReviewScorer('sk-fake-not-a-real-key');
    const line = { custom_id: 'req-0', response: { status_code: 200, body: { choices: [{ message: { content: REJECTION_JSON } }] } } };
    const unwrapped = parseOpenAIBatchResult(line);
    const viaBatch = scorer.parseBatchResponseV5(unwrapped.text);
    const viaDirect = scorer.parseBatchResponseV5(REJECTION_JSON);
    assert.deepStrictEqual(viaBatch, viaDirect);
    assert.strictEqual(viaBatch.rejected, true);
    assert.strictEqual(viaBatch.rejection, 'wrong_show');
  });

  test('Gemini: batch-unwrapped rejection parses identically to a direct call', () => {
    const scorer = new GeminiScorer('fake-key-not-real');
    const entry = { key: 'req-0', response: { candidates: [{ content: { parts: [{ text: REJECTION_JSON }] } }] } };
    const unwrapped = parseGeminiBatchResult(entry);
    const viaBatch = scorer.parseBatchResponseV5(unwrapped.text);
    const viaDirect = scorer.parseBatchResponseV5(REJECTION_JSON);
    assert.deepStrictEqual(viaBatch, viaDirect);
    assert.strictEqual(viaBatch.rejected, true);
    assert.strictEqual(viaBatch.rejection, 'wrong_show');
  });

  test('malformed JSON: all three vendors fall back to the same extraction pipeline', () => {
    const malformed = '```json\n{"bucket": "Mixed", "score": 55, incomplete';
    const claudeEntry = { custom_id: 'req-0', result: { type: 'succeeded', message: { content: [{ type: 'text', text: malformed }], usage: {} } } };
    const openaiLine = { custom_id: 'req-0', response: { status_code: 200, body: { choices: [{ message: { content: malformed } }] } } };
    const geminiEntry = { key: 'req-0', response: { candidates: [{ content: { parts: [{ text: malformed }] } }] } };

    const claudeScorer = new ReviewScorer('sk-fake-not-a-real-key');
    const openaiScorer = new OpenAIReviewScorer('sk-fake-not-a-real-key');
    const geminiScorer = new GeminiScorer('fake-key-not-real');

    const claudeViaBatch = claudeScorer.parseBatchResponseV5(parseAnthropicBatchResult(claudeEntry).text);
    const claudeViaDirect = claudeScorer.parseBatchResponseV5(malformed);
    assert.deepStrictEqual(claudeViaBatch, claudeViaDirect);

    const openaiViaBatch = openaiScorer.parseBatchResponseV5(parseOpenAIBatchResult(openaiLine).text);
    const openaiViaDirect = openaiScorer.parseBatchResponseV5(malformed);
    assert.deepStrictEqual(openaiViaBatch, openaiViaDirect);

    const geminiViaBatch = geminiScorer.parseBatchResponseV5(parseGeminiBatchResult(geminiEntry).text);
    const geminiViaDirect = geminiScorer.parseBatchResponseV5(malformed);
    assert.deepStrictEqual(geminiViaBatch, geminiViaDirect);
  });

  test('a vendor batch error never reaches the parser — caller must treat as null outcome', () => {
    // Mirrors the sync path's Promise.all().catch(() => null): an errored
    // batch item has no text to parse at all, so mergeVendorResults leaves
    // that leg null and the ensemble combine step treats it as a failed
    // model call, same as a live 5xx after retries are exhausted.
    const erroredEntry = { custom_id: 'req-0', result: { type: 'errored', error: { message: 'overloaded' } } };
    const unwrapped = parseAnthropicBatchResult(erroredEntry);
    assert.strictEqual(unwrapped.success, false);
    assert.strictEqual(unwrapped.text, undefined);
  });
});
