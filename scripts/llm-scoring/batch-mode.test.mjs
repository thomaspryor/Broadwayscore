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

// ========================================
// PHASE 2 (task #516): extracted stages + batch-runner wiring
// ========================================
//
// scoreReviewFile() is now prepareScoringInput → scoreReview → 
// finalizeScoredFile, and --batch reuses stages 1 and 3 verbatim with the
// models' output arriving from a Batch API instead of a live call. These
// tests pin the extracted stages so a future edit that forks batch away from
// sync fails here.

const { EnsembleReviewScorer } = require('./ensemble-scorer');
const { assembleRequests, outcomesForItem, estimateBatchUsage, buildBatchState, computeInputHash } = require('./batch-runner');
const { SYSTEM_PROMPT_V5, buildPromptV5, PROMPT_VERSION } = require('./config');

/** Scorer with throwaway keys — no constructor makes a network call. */
function makeScorer() {
  return new EnsembleReviewScorer(
    'sk-ant-fake-not-a-real-key',
    'sk-fake-not-a-real-key',
    'fake-gemini-key-not-real',
    undefined, // no OpenRouter → Kimi off, matching the nightly workflow
    { verbose: false }
  );
}

function llmResult(overrides = {}) {
  return {
    scoreable: true,
    bucket: 'Positive',
    score: 75,
    confidence: 'high',
    verdict: 'strong revival',
    keyQuote: 'a considerable pleasure from start to finish, richly acted',
    reasoning: 'Warm notice with real reservations about the book.',
    ...overrides,
  };
}

// validateScoreableText requires a stripped body of >= 1000 chars for a
// non-excerpt, and rejects text whose junk-line ratio is >= 0.5 — so this
// fixture has to be genuinely prose-shaped, not a short repeated stub.
const LONG_REVIEW_TEXT = [
  'The revival that opened on Wednesday night at the Walter Kerr Theatre is a considerable pleasure, and a surprisingly quiet one.',
  'Its creators have resisted almost every temptation to inflate the small, bruised story at its center into something louder.',
  'The performances are uniformly strong, and the direction is clear-eyed even when the book strains for feeling it has not entirely earned.',
  'What lingers afterward is not a showstopper but a series of small silences, and the sense of a family that has run out of things it knows how to say.',
  'There are stretches in the second act where the score recedes so far into the background that the evening threatens to stop moving altogether.',
  'The design is handsome without being showy, all muted browns and kitchen light, and it serves the material better than a splashier production would have.',
  'If the result never quite achieves the transcendence it reaches for, it earns real affection along the way, and that is not nothing on a Broadway stage.',
  'Audiences expecting a conventional musical comedy will be startled by how little the show wants to entertain them in the usual sense.',
  'That restraint is the point, and by the final scene it has accumulated a weight that the noisier musicals down the street rarely manage.',
].join(' ');

function reviewFileFixture(overrides = {}) {
  return {
    showId: 'a-catered-affair-2008',
    showTitle: 'A Catered Affair',
    outletId: 'nytimes',
    outlet: 'The New York Times',
    criticName: 'Ben Brantley',
    publishDate: '2008-04-18',
    category: 'broadway',
    venue: 'Walter Kerr Theatre',
    fullText: LONG_REVIEW_TEXT,
    originalScore: null,
    ...overrides,
  };
}

describe('prepareScoringInput (extracted stage 1)', () => {
  test('produces the prompt input the sync path would have built', () => {
    const scorer = makeScorer();
    const prepared = scorer.prepareScoringInput(reviewFileFixture());

    assert.strictEqual(prepared.ok, true, prepared.failure && prepared.failure.error);
    assert.ok(prepared.prep.scoringInput.text.length >= 50);
    assert.ok(prepared.prep.scoringInput.context.includes('A Catered Affair'));
    // No anchored mode without the pilot flag / anchored market.
    assert.strictEqual(prepared.prep.band, undefined);
    assert.strictEqual(prepared.prep.systemPromptOverride, undefined);
  });

  test('rejects too-short text with the same error scoreReviewFile returned', () => {
    const scorer = makeScorer();
    const prepared = scorer.prepareScoringInput(reviewFileFixture({ fullText: 'Too short.' }));

    assert.strictEqual(prepared.ok, false);
    assert.strictEqual(prepared.failure.success, false);
    assert.strictEqual(prepared.failure.error, 'Review text too short or missing');
  });
});

describe('combineOutcomes (extracted stage 2 tail)', () => {
  test('2-of-3 rejections produce a consensus rejection, not a score', () => {
    const scorer = makeScorer();
    const result = scorer.combineOutcomes([
      { model: 'claude', result: null, rejected: true, rejection: 'wrong_show', rejectionReasoning: 'different play' },
      { model: 'openai', result: null, rejected: true, rejection: 'wrong_show', rejectionReasoning: 'different play' },
      { model: 'gemini', result: llmResult() },
    ]);

    assert.strictEqual(result.rejected, true);
    assert.strictEqual(result.rejection, 'wrong_show');
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.bucket, 'Pan');
    assert.strictEqual(result.source, 'ensemble-unanimous');
  });

  test('a single rejection does NOT reject — it degrades to a 2-model ensemble', () => {
    const scorer = makeScorer();
    const result = scorer.combineOutcomes([
      { model: 'claude', result: llmResult({ score: 74 }) },
      { model: 'openai', result: llmResult({ score: 76 }) },
      { model: 'gemini', result: null, rejected: true, rejection: 'wrong_show', rejectionReasoning: 'x' },
    ]);

    assert.notStrictEqual(result.rejected, true);
    assert.ok(result.score > 0);
  });

  test('band clamps a rogue-high consensus back inside the critic star band', () => {
    const scorer = makeScorer();
    const band = { floor: 20, ceiling: 40, fraction: 0.25 };
    const result = scorer.combineOutcomes(
      [
        { model: 'claude', result: llmResult({ score: 95, bucket: 'Rave' }) },
        { model: 'openai', result: llmResult({ score: 93, bucket: 'Rave' }) },
        { model: 'gemini', result: llmResult({ score: 96, bucket: 'Rave' }) },
      ],
      band
    );

    assert.ok(result.score <= 40, `expected clamp to <=40, got ${result.score}`);
    assert.ok(result.score >= 20);
  });

  test('all legs failed is surfaced, not silently averaged', () => {
    const scorer = makeScorer();
    const result = scorer.combineOutcomes([
      { model: 'claude', result: null, error: 'batch_result_missing' },
      { model: 'openai', result: null, error: 'batch_result_missing' },
      { model: 'gemini', result: null, error: 'batch_result_missing' },
    ]);

    assert.strictEqual(result.allModelsFailed, true);
  });
});

describe('finalizeScoredFile (extracted stage 3)', () => {
  test('builds the ScoredReviewFile the sync path writes', () => {
    const scorer = makeScorer();
    const reviewFile = reviewFileFixture();
    const prepared = scorer.prepareScoringInput(reviewFile);
    assert.strictEqual(prepared.ok, true);

    const ensembleResult = scorer.combineOutcomes([
      { model: 'claude', result: llmResult({ score: 74 }) },
      { model: 'openai', result: llmResult({ score: 76 }) },
      { model: 'gemini', result: llmResult({ score: 75 }) },
    ]);
    const out = scorer.finalizeScoredFile(reviewFile, ensembleResult, prepared.prep);

    assert.strictEqual(out.success, true);
    assert.strictEqual(out.scoredFile.assignedScore, ensembleResult.score);
    assert.strictEqual(out.scoredFile.llmScore.score, ensembleResult.score);
    assert.strictEqual(out.scoredFile.llmMetadata.promptVersion, PROMPT_VERSION);
    assert.ok(out.scoredFile.llmMetadata.model.startsWith('ensemble:'));
    assert.strictEqual(out.scoredFile.ensembleData.claudeScore, 74);
    assert.strictEqual(out.scoredFile.ensembleData.openaiScore, 76);
    assert.strictEqual(out.scoredFile.ensembleData.geminiScore, 75);
    // Original review fields survive the spread.
    assert.strictEqual(out.scoredFile.showId, 'a-catered-affair-2008');
    assert.strictEqual(out.scoredFile.outletId, 'nytimes');
  });

  test('refuses to write a fallback score when every model failed', () => {
    const scorer = makeScorer();
    const reviewFile = reviewFileFixture();
    const prepared = scorer.prepareScoringInput(reviewFile);
    const ensembleResult = scorer.combineOutcomes([
      { model: 'claude', result: null, error: 'batch_result_missing' },
      { model: 'openai', result: null, error: 'batch_result_missing' },
      { model: 'gemini', result: null, error: 'batch_result_missing' },
    ]);

    const out = scorer.finalizeScoredFile(reviewFile, ensembleResult, prepared.prep);
    assert.strictEqual(out.success, false);
    assert.ok(/All ensemble models failed/.test(out.error));
    assert.strictEqual(out.scoredFile, undefined);
  });

  test('passes a consensus rejection straight through for the caller to route', () => {
    const scorer = makeScorer();
    const reviewFile = reviewFileFixture();
    const prepared = scorer.prepareScoringInput(reviewFile);
    const ensembleResult = scorer.combineOutcomes([
      { model: 'claude', result: null, rejected: true, rejection: 'wrong_production', rejectionReasoning: 'a' },
      { model: 'openai', result: null, rejected: true, rejection: 'wrong_production', rejectionReasoning: 'b' },
      { model: 'gemini', result: llmResult() },
    ]);

    const out = scorer.finalizeScoredFile(reviewFile, ensembleResult, prepared.prep);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.rejected, true);
    assert.strictEqual(out.rejection, 'wrong_production');
    assert.strictEqual(out.scoredFile, undefined);
  });
});

describe('assembleRequests — batch prompts match the sync prompts byte for byte', () => {
  function itemsFor(scorer, reviewFile) {
    const prepared = scorer.prepareScoringInput(reviewFile);
    assert.strictEqual(prepared.ok, true);
    return [{
      filePath: '/tmp/x.json',
      showId: reviewFile.showId,
      outletId: reviewFile.outletId,
      reviewFile,
      prep: prepared.prep,
      priorEmergencyRetryCount: 0,
    }];
  }

  test('all 3 vendors get SYSTEM_PROMPT_V5 + buildPromptV5(text, context)', () => {
    const scorer = makeScorer();
    const reviewFile = reviewFileFixture();
    const items = itemsFor(scorer, reviewFile);
    const expectedUser = buildPromptV5(items[0].prep.scoringInput.text, items[0].prep.scoringInput.context);

    const reqs = assembleRequests(items, {
      geminiEnabled: true,
      claudeModel: 'claude-sonnet-4-6',
      openaiModel: 'gpt-4o',
    });

    assert.strictEqual(reqs.anthropic.length, 1);
    assert.strictEqual(reqs.anthropic[0].custom_id, 'req-0');
    assert.strictEqual(reqs.anthropic[0].params.model, 'claude-sonnet-4-6');
    assert.strictEqual(reqs.anthropic[0].params.system[0].text, SYSTEM_PROMPT_V5);
    assert.strictEqual(reqs.anthropic[0].params.messages[0].content, expectedUser);

    assert.strictEqual(reqs.openai[0].body.model, 'gpt-4o');
    assert.strictEqual(reqs.openai[0].body.messages[0].content, SYSTEM_PROMPT_V5);
    assert.strictEqual(reqs.openai[0].body.messages[1].content, expectedUser);

    // Gemini has no system role — sync concatenates, so batch must too.
    assert.strictEqual(
      reqs.gemini[0].request.contents[0].parts[0].text,
      `${SYSTEM_PROMPT_V5}\n\n${expectedUser}`
    );
  });

  test('geminiEnabled:false emits no Gemini requests', () => {
    const scorer = makeScorer();
    const items = itemsFor(scorer, reviewFileFixture());
    const reqs = assembleRequests(items, {
      geminiEnabled: false,
      claudeModel: 'claude-sonnet-4-6',
      openaiModel: 'gpt-4o',
    });
    assert.strictEqual(reqs.gemini.length, 0);
    assert.strictEqual(reqs.anthropic.length, 1);
    assert.strictEqual(reqs.openai.length, 1);
  });

  test('estimateBatchUsage counts every vendor leg it was handed', () => {
    const scorer = makeScorer();
    const items = itemsFor(scorer, reviewFileFixture());
    const reqs = assembleRequests(items, {
      geminiEnabled: true,
      claudeModel: 'claude-sonnet-4-6',
      openaiModel: 'gpt-4o',
    });
    const usage = estimateBatchUsage(reqs);
    assert.ok(usage.claude.input > 0);
    assert.ok(usage.openai.input > 0);
    assert.ok(usage.gemini.input > 0);
    assert.strictEqual(usage.claude.output, 500); // 1 request × max_tokens
  });
});

describe('outcomesForItem — vendor rows become ModelOutcomes', () => {
  const scorer = makeScorer();
  const goodBody = JSON.stringify({
    scoreable: true,
    bucket: 'Positive',
    score: 75,
    confidence: 'high',
    verdict: 'strong revival',
    keyQuote: 'a considerable pleasure from start to finish',
    reasoning: 'Warm notice.',
  });

  test('a successful row parses through each scorer parseBatchResponseV5', () => {
    const row = {
      index: 0,
      customId: 'req-0',
      claude: { customId: 'req-0', success: true, text: goodBody, usage: { input: 10, output: 5, cacheWrite: 2, cacheRead: 3 } },
      openai: { customId: 'req-0', success: true, text: goodBody, usage: { input: 11, output: 6 } },
      gemini: { customId: 'req-0', success: true, text: goodBody, usage: { input: 12, output: 7 } },
    };
    const { outcomes, usage } = outcomesForItem(row, scorer, true);

    assert.strictEqual(outcomes.length, 3);
    for (const o of outcomes) {
      assert.ok(o.result, `${o.model} should have parsed a result (${o.error})`);
      assert.strictEqual(o.result.bucket, 'Positive');
    }
    assert.strictEqual(usage.claude.input, 10);
    assert.strictEqual(usage.claude.cacheRead, 3);
    assert.strictEqual(usage.openai.output, 6);
    assert.strictEqual(usage.gemini.input, 12);
  });

  test('a missing vendor leg degrades to a null-result outcome, not a throw', () => {
    const row = {
      index: 0,
      customId: 'req-0',
      claude: { customId: 'req-0', success: true, text: goodBody, usage: { input: 1, output: 1 } },
      openai: null,
      gemini: { customId: 'req-0', success: false, error: 'gemini_quota' },
    };
    const { outcomes } = outcomesForItem(row, scorer, true);

    const byModel = Object.fromEntries(outcomes.map((o) => [o.model, o]));
    assert.ok(byModel.claude.result);
    assert.strictEqual(byModel.openai.result, null);
    assert.strictEqual(byModel.openai.error, 'batch_result_missing');
    assert.strictEqual(byModel.gemini.result, null);
    assert.strictEqual(byModel.gemini.error, 'gemini_quota');
  });

  test('a rejection in the model text becomes a rejected outcome, not a score', () => {
    const rejectionBody = JSON.stringify({
      scoreable: false,
      rejection: 'wrong_show',
      reasoning: 'This review is about a different production entirely.',
    });
    const row = {
      index: 0,
      customId: 'req-0',
      claude: { customId: 'req-0', success: true, text: rejectionBody, usage: { input: 1, output: 1 } },
      openai: { customId: 'req-0', success: true, text: rejectionBody, usage: { input: 1, output: 1 } },
      gemini: null,
    };
    const { outcomes } = outcomesForItem(row, scorer, true);
    const byModel = Object.fromEntries(outcomes.map((o) => [o.model, o]));

    assert.strictEqual(byModel.claude.rejected, true);
    assert.strictEqual(byModel.claude.rejection, 'wrong_show');
    assert.strictEqual(byModel.claude.result, null);

    // ...and the ensemble turns 2 rejections into a consensus rejection.
    const combined = scorer.combineOutcomes(outcomes);
    assert.strictEqual(combined.rejected, true);
    assert.strictEqual(combined.rejection, 'wrong_show');
  });

  test('geminiEnabled:false omits the gemini leg entirely (2-model ensemble)', () => {
    const row = {
      index: 0,
      customId: 'req-0',
      claude: { customId: 'req-0', success: true, text: goodBody, usage: { input: 1, output: 1 } },
      openai: { customId: 'req-0', success: true, text: goodBody, usage: { input: 1, output: 1 } },
      gemini: null,
    };
    const { outcomes } = outcomesForItem(row, scorer, false);
    assert.strictEqual(outcomes.length, 2);
    assert.ok(!outcomes.some((o) => o.model === 'gemini'));
  });
});

describe('buildBatchState — resume manifest', () => {
  test('records index → identity for every submitted item', () => {
    const scorer = makeScorer();
    const items = [0, 1, 2].map((n) => {
      const reviewFile = reviewFileFixture({ outletId: `outlet-${n}` });
      const prepared = scorer.prepareScoringInput(reviewFile);
      return {
        filePath: `/data/review-texts/a-catered-affair-2008/outlet-${n}.json`,
        showId: reviewFile.showId,
        outletId: reviewFile.outletId,
        reviewFile,
        prep: prepared.prep,
        priorEmergencyRetryCount: 0,
      };
    });

    const state = buildBatchState(
      items,
      { claudeBatchId: 'msgbatch_x', openaiBatchId: 'batch_y', geminiBatchId: 'batches/z' },
      { claudeModel: 'claude-sonnet-4-6', openaiModel: 'gpt-4o', geminiModel: 'gemini-2.5-flash' },
      '2026-07-26T04:00:00.000Z'
    );

    assert.strictEqual(state.itemCount, 3);
    assert.strictEqual(state.manifest.length, 3);
    assert.strictEqual(state.manifest[1].index, 1);
    assert.strictEqual(state.manifest[1].showId, 'a-catered-affair-2008');
    assert.strictEqual(state.manifest[1].outletId, 'outlet-1');
    assert.strictEqual(state.manifest[1].filePath, '/data/review-texts/a-catered-affair-2008/outlet-1.json');
    // Provenance fingerprint — the resume path refuses to merge without it.
    assert.match(state.manifest[1].inputHash, /^[0-9a-f]{32}$/);
    assert.strictEqual(state.promptVersion, PROMPT_VERSION);
    assert.strictEqual(state.submittedAt, '2026-07-26T04:00:00.000Z');
    // The prep (which embeds full review text) must NOT be persisted.
    assert.ok(!JSON.stringify(state).includes(LONG_REVIEW_TEXT.slice(0, 40)));
  });

  test('decideNextAction resubmits only when there is no prior state', () => {
    const state = buildBatchState([], { claudeBatchId: 'a' }, { claudeModel: 'c', openaiModel: 'o' }, '2026-07-26T04:00:00.000Z');
    const now = Date.parse('2026-07-26T04:05:00.000Z');
    assert.strictEqual(decideNextAction({ batchState: null, vendorStatuses: {}, now }).action, 'submit');
    assert.strictEqual(decideNextAction({ batchState: state, vendorStatuses: { claude: 'in_progress' }, now }).action, 'poll');
    assert.strictEqual(decideNextAction({ batchState: state, vendorStatuses: { claude: 'ended' }, now }).action, 'fetch_and_merge');
  });
});


describe('resume provenance guards (task #516 ship-check)', () => {
  test('buildBatchState stores manifest paths RELATIVE to the repo root', () => {
    // The state file is committed to the public repo. Absolute paths would leak
    // the local username and would not resolve on the CI checkout that resumes.
    const scorer = makeScorer();
    const reviewFile = reviewFileFixture();
    const prepared = scorer.prepareScoringInput(reviewFile);
    const items = [{
      filePath: '/Users/someone/Broadwayscore/data/review-texts/a-catered-affair-2008/nytimes.json',
      showId: reviewFile.showId,
      outletId: reviewFile.outletId,
      reviewFile,
      prep: prepared.prep,
      priorEmergencyRetryCount: 0,
    }];

    const state = buildBatchState(
      items, { claudeBatchId: 'a' }, { claudeModel: 'c', openaiModel: 'o' },
      '2026-07-26T04:00:00.000Z', '/Users/someone/Broadwayscore'
    );

    assert.strictEqual(state.manifest[0].filePath, 'data/review-texts/a-catered-affair-2008/nytimes.json');
    assert.ok(!JSON.stringify(state).includes('/Users/'));
  });

  test('computeInputHash changes when the review text changes', () => {
    const scorer = makeScorer();
    const a = scorer.prepareScoringInput(reviewFileFixture());
    const b = scorer.prepareScoringInput(
      reviewFileFixture({ fullText: LONG_REVIEW_TEXT + ' A late paragraph added by a re-scrape after submission.' })
    );
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.notStrictEqual(computeInputHash(a.prep), computeInputHash(b.prep));
  });

  test('computeInputHash is stable for identical input', () => {
    const scorer = makeScorer();
    const a = scorer.prepareScoringInput(reviewFileFixture());
    const b = scorer.prepareScoringInput(reviewFileFixture());
    assert.strictEqual(computeInputHash(a.prep), computeInputHash(b.prep));
  });

  test('computeInputHash covers the anchored-V6 system prompt, not just the text', () => {
    // A star rating added mid-flight flips the file into anchored mode: the
    // models never saw the V6 band prompt, so the stored output must not be
    // stamped anchored-v6. Differing hashes are what make the merge refuse.
    const scorer = makeScorer();
    const plain = scorer.prepareScoringInput(reviewFileFixture());
    const withBand = {
      ...plain.prep,
      band: { floor: 20, ceiling: 40, fraction: 0.25 },
      systemPromptOverride: 'V6 SYSTEM PROMPT WITH A HARD BAND CONSTRAINT',
    };
    assert.notStrictEqual(computeInputHash(plain.prep), computeInputHash(withBand));
  });
});
