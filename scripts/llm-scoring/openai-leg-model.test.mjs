/**
 * Guard: the scoring pipeline's OpenAI model is ONE pin (models.js
 * SCORING_OPENAI / COMPARATIVE_OPENAI), every OpenAI scoring request is built
 * by ONE function (llm-batch.js openaiChatBody), and every model it can be set
 * to is priced. Owner asked 2026-11-09 to move the leg off gpt-4o (OpenAI
 * retires it 2027-01-14) with an A/B first; this keeps a model swap a
 * one-line change that cannot leave one path (sync, Batch API, comparative)
 * sending a field the new model rejects.
 *
 * History: task #504 (2026-07-26) A/B'd gpt-5.4-mini on n=24 and failed the
 * rule-13 gate (Mixed 29%->0%), so the pins stay gpt-4o until a full-pipeline
 * A/B passes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const models = require('../lib/models.js');
const { openaiChatBody, openaiScoringModels, buildOpenAIBatchLine } = require('../lib/llm-batch.js');

const MSGS = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];

describe('OpenAI scoring pins', () => {
  test('the ensemble leg and the comparative rescore stay on gpt-4o until their A/B passes', () => {
    assert.equal(models.SCORING_OPENAI, 'gpt-4o', 'flip SCORING_OPENAI only with a passing rule-13 A/B (cite its data/audit file here)');
    assert.equal(models.COMPARATIVE_OPENAI, 'gpt-4o', 'comparative-rescore rewrites published scores: it moves only after its own check');
  });

  test('both pins have a request profile', () => {
    for (const m of [models.SCORING_OPENAI, models.COMPARATIVE_OPENAI, models.GPT54_MINI]) {
      assert.ok(openaiScoringModels().includes(m), `${m} has no OPENAI_REQUEST_PROFILES entry`);
    }
  });
  // The ensemble default (= SCORING_OPENAI) is asserted behaviourally in
  // batch-mode.test.mjs, which loads the TypeScript scorer.
});

describe('openaiChatBody (the one builder)', () => {
  test('gpt-4o body: same fields the sync scorer sent before (no reasoning field)', () => {
    assert.deepEqual(openaiChatBody({ model: 'gpt-4o', messages: MSGS, maxTokens: 500, temperature: 0.3 }), {
      model: 'gpt-4o', messages: MSGS, max_completion_tokens: 500, temperature: 0.3,
    });
  });

  test('gpt-5.4-mini body: max_completion_tokens and an explicit reasoning_effort none', () => {
    const b = openaiChatBody({ model: 'gpt-5.4-mini', messages: MSGS });
    assert.equal(b.max_completion_tokens, 500);
    assert.equal(b.reasoning_effort, 'none');
    assert.equal(b.max_tokens, undefined);
  });

  test('every profiled model: never max_tokens', () => {
    for (const model of openaiScoringModels()) {
      const b = openaiChatBody({ model, messages: MSGS });
      assert.equal(b.max_tokens, undefined, model);
      assert.equal(typeof b.max_completion_tokens, 'number', model);
    }
  });

  test('an unknown model fails loudly instead of scoring with untested parameters', () => {
    assert.throws(() => openaiChatBody({ model: 'gpt-4o-typo', messages: MSGS }), /no request profile/);
  });

  test('a Batch API line carries exactly the sync body', () => {
    for (const model of openaiScoringModels()) {
      const line = buildOpenAIBatchLine({ customId: 'c', model, systemPrompt: 's', userPrompt: 'u' });
      assert.deepEqual(line.body, openaiChatBody({ model, messages: MSGS }), model);
    }
  });
});

describe('class guard: no OpenAI scoring call builds its own body', () => {
  // Every file in scripts/llm-scoring that POSTs to OpenAI chat completions for
  // scoring must go through openaiChatBody. Experiment scripts are listed so a
  // new production caller cannot slip in unnoticed.
  const EXPERIMENTS = new Set([
    'comprehensive-experiment.ts', 'model-comparison-experiment.ts', 'multi-model-critique.ts',
    'test-prompt-structural-ab.ts', 'test-prompt-variations.ts', 'test-helen-shaw-fixture.ts', 'sanity-v6-single.mjs',
  ]);
  const files = readdirSync(join(root, 'scripts/llm-scoring')).filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.test\./.test(f));

  test('production scoring files that call chat/completions use openaiChatBody', () => {
    const bad = [];
    for (const f of files) {
      if (EXPERIMENTS.has(f)) continue;
      const src = readFileSync(join(root, 'scripts/llm-scoring', f), 'utf8');
      if (src.includes('api.openai.com/v1/chat/completions') && !src.includes('openaiChatBody(')) bad.push(f);
    }
    assert.deepEqual(bad, [], `build the request body with openaiChatBody (scripts/lib/llm-batch.js): ${bad.join(', ')}`);
  });

  test('red-then-green: the scan does see the known production callers', () => {
    const callers = files.filter((f) => readFileSync(join(root, 'scripts/llm-scoring', f), 'utf8').includes('api.openai.com/v1/chat/completions'));
    assert.ok(callers.includes('openai-scorer.ts'));
    assert.ok(callers.includes('comparative-rescore.ts'));
  });
});
// Per-model pricing (gpt-4o vs gpt-5.4-mini) is covered in tests/unit/llm-cost-cache.test.ts.
