/**
 * Sprint 1 smoke: verifies V6 + ensemble + clamp are wired together
 * without making any LLM API calls. NO production import, NO hot path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const { starToBand, buildSystemPromptV6, clampScoreToBand } = require('../../scripts/llm-scoring/config');
const { EnsembleReviewScorer } = require('../../scripts/llm-scoring/ensemble-scorer');

describe('Sprint 1 wiring smoke', () => {
  it('EnsembleReviewScorer class is constructable', () => {
    assert.strictEqual(typeof EnsembleReviewScorer, 'function');
  });
  it('V6 prompt for 5/5 contains [91, 100] band', () => {
    const band = starToBand(5, 5);
    const p = buildSystemPromptV6(band, '5/5');
    assert.ok(p.includes('[91, 100]'), 'expected band in anchored prompt');
    assert.ok(p.includes('5/5'), 'expected raw rating in prompt');
    assert.ok(p.includes('HARD CONSTRAINT'), 'expected HARD CONSTRAINT marker');
  });
  it('V6 prompt for 3.5/4 USA Today (Gardner case)', () => {
    const band = starToBand(3.5, 4);
    const p = buildSystemPromptV6(band, '3.5/4');
    assert.ok(p.includes('[71, 90]'), 'expected 4★ band [71,90] for 3.5/4');
    assert.ok(p.includes('3.5/4'), 'expected raw rating');
  });
  it('V6 unanchored mode has full-range guidance', () => {
    const p = buildSystemPromptV6();
    assert.ok(p.includes('USE THE FULL RANGE'), 'expected full-range header');
    assert.ok(p.includes('96-100'), 'expected 96-100 band described');
    assert.ok(p.includes('do not cap at 95'), 'expected explicit anti-cap');
    assert.ok(p.includes('cannot remember the last time'), 'expected high-end few-shot');
  });
  it('clampScoreToBand bounds correctly', () => {
    const band = starToBand(5, 5);
    assert.strictEqual(clampScoreToBand(105, band), 100);
    assert.strictEqual(clampScoreToBand(70, band), 91);
    assert.strictEqual(clampScoreToBand(95, band), 95);
  });
});
