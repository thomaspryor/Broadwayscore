// Unit tests for scripts/lib/research-cost.js (BRO-4990).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { researchCallCost, countSearchCalls, ratesFor, WEB_SEARCH_CALL_USD } = require('../../scripts/lib/research-cost');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe('researchCallCost', () => {
  it('bills web search calls on top of tokens (the old estimate dropped them)', () => {
    // Real o4-mini usage from the BRO-4990 smoke run on "six".
    const c = researchCallCost({ input_tokens: 69928, output_tokens: 8986 }, 'o4-mini', 22);
    close(c.tokens, (69928 * 1.10 + 8986 * 4.40) / 1e6);
    close(c.search, 22 * WEB_SEARCH_CALL_USD);
    close(c.total, c.tokens + c.search);
  });

  it('bills cached input at the cached rate', () => {
    const c = researchCallCost({ input_tokens: 1e6, output_tokens: 0, input_tokens_details: { cached_tokens: 4e5 } }, 'gpt-5.4-mini');
    close(c.total, 0.6 * 0.75 + 0.4 * 0.075);
  });

  it('prices dated snapshots like their alias and unknown models at the top rate', () => {
    assert.deepEqual(ratesFor('gpt-5.4-mini-2026-03-17'), ratesFor('gpt-5.4-mini'));
    assert.ok(ratesFor('some-new-model').input >= ratesFor('o3-deep-research').input);
  });
});

describe('countSearchCalls', () => {
  it('counts web_search_call items only', () => {
    assert.equal(countSearchCalls([{ type: 'web_search_call' }, { type: 'reasoning' }, { type: 'message' }, { type: 'web_search_call' }]), 2);
    assert.equal(countSearchCalls(undefined), 0);
  });
});

describe('modelShutdownStatus', () => {
  const { modelShutdownStatus } = require('../../scripts/lib/research-cost');
  it('warns inside 30 days, refuses on/after the date, passes unknown-shutdown models', () => {
    assert.equal(modelShutdownStatus('o4-mini', '2026-09-01').status, 'ok');
    assert.equal(modelShutdownStatus('o4-mini', '2026-10-10').status, 'warn');
    assert.equal(modelShutdownStatus('o4-mini-2025-04-16', '2026-10-10').status, 'warn');
    assert.equal(modelShutdownStatus('o4-mini', '2026-10-23').status, 'dead');
    assert.equal(modelShutdownStatus('o4-mini-deep-research', '2026-10-10').status, 'dead');
    assert.equal(modelShutdownStatus('gpt-5.4-mini', '2026-10-10').status, 'ok');
  });

  // Date-independent: a model with ANY announced shutdown must not be the
  // default or a dispatch choice, so the next retirement fails here when
  // MODEL_SHUTDOWNS is updated, not in a Saturday cron after the cutoff.
  it('the script default and workflow choices have no announced shutdown', async () => {
    const fs = await import('node:fs');
    const { MODEL_SHUTDOWNS } = require('../../scripts/lib/research-cost');
    const root = new URL('../../', import.meta.url);
    const script = fs.readFileSync(new URL('scripts/deep-research-commercial.js', root), 'utf8');
    const def = script.match(/const DEFAULT_MODEL = '([^']+)'/);
    assert.ok(def, 'DEFAULT_MODEL constant not found');
    const wf = fs.readFileSync(new URL('.github/workflows/deep-research-commercial.yml', root), 'utf8');
    const options = [...wf.matchAll(/^\s+- '([^']+)'$/gm)].map(m => m[1]);
    assert.ok(options.includes(def[1]), 'workflow choices must include the script default');
    for (const m of [def[1], ...options]) {
      assert.equal(modelShutdownStatus(m, '1970-01-01').shutdown, null, `${m} has a shutdown date in MODEL_SHUTDOWNS`);
    }
    assert.ok(Object.keys(MODEL_SHUTDOWNS).length > 0);
  });
});
