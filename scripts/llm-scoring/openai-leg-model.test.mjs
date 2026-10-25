/**
 * Guard: the ensemble's OpenAI leg model must be registered in
 * scripts/lib/models.js AND have a matching cost.ts pricing entry — prevents
 * silent price-table drift when the model is swapped again.
 *
 * Task #504 (2026-07-26): gpt-4o was removed from OpenAI's current pricing
 * page, so gpt-5.4-mini (70% cheaper) was evaluated as a replacement. The A/B
 * (n=24 real reviews via the real OpenAIReviewScorer.scoreReviewV5 path)
 * FAILED the rule-13 gate hard: Mixed bucket collapsed 29%->0%, max bucket
 * shift 29.2pp (limit 5pp) — gpt-5.4-mini polarizes scores away from the
 * middle instead of behaving like a cheaper gpt-4o. The ensemble default
 * stays gpt-4o; GPT54_MINI is registered + priced so `--openai-model=` can
 * re-test it once the V5 prompt is recalibrated, without drifting the cost
 * table silently in the meantime.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const { GPT4O, GPT54_MINI } = require('../lib/models.js');

describe('ensemble OpenAI leg model is registered + priced', () => {
  test('models.js GPT4O is the current ensemble default', () => {
    assert.equal(GPT4O, 'gpt-4o');
  });

  test('models.js GPT54_MINI is registered (available for --openai-model= re-testing)', () => {
    assert.equal(GPT54_MINI, 'gpt-5.4-mini');
  });

  test('ensemble-scorer.ts defaults the OpenAI leg to models.js GPT4O', () => {
    const src = readFileSync(join(root, 'scripts/llm-scoring/ensemble-scorer.ts'), 'utf8');
    assert.ok(src.includes("require('../lib/models')"),
      'ensemble-scorer.ts should import from scripts/lib/models.js, not hardcode the model string');
    assert.ok(/openaiModel:\s*options\.openaiModel\s*\|\|\s*GPT4O\b/.test(src),
      'ensemble-scorer.ts default openaiModel should fall back to the canonical GPT4O constant — gpt-5.4-mini failed its A/B, do not flip this without a new passing A/B');
  });

  test('cost.ts has pricing entries for both the current default and the candidate model', () => {
    const src = readFileSync(join(root, 'scripts/llm-scoring/cost.ts'), 'utf8');
    assert.ok(/\bopenai:\s*\{/.test(src),
      'cost.ts should carry the gpt-4o pricing row (current ensemble default)');
    assert.ok(src.includes("'openai-gpt54-mini'"),
      'cost.ts should carry a pricing row keyed for gpt-5.4-mini — otherwise a future re-test silently uses stale/wrong pricing');
    assert.ok(/openaiPricing\(modelName\?/.test(src) || src.includes('function openaiPricing'),
      'cost.ts should select pricing by the configured OpenAI model name, not a single hardcoded row');
  });

  test('OpenAI scoring calls use max_completion_tokens, not max_tokens (gpt-5.4-mini rejects max_tokens)', () => {
    const src = readFileSync(join(root, 'scripts/llm-scoring/openai-scorer.ts'), 'utf8');
    assert.ok(!/\bmax_tokens\s*:/.test(src),
      'openai-scorer.ts must not send max_tokens — gpt-5.4-mini returns HTTP 400 unsupported_parameter');
    assert.ok(/\bmax_completion_tokens\s*:/.test(src),
      'openai-scorer.ts should send max_completion_tokens (works for gpt-4o/-mini and gpt-5.4-mini alike)');
  });
});
