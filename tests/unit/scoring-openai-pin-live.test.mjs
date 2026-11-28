/**
 * BRO-7341: no OpenAI chat pin may sit on a model with an announced shutdown, every pin must
 * have a request profile, and every script that calls a pin must build its body through
 * llm-batch.js openaiChatBody.
 *
 * Why the last part: gpt-5.x rejects max_tokens and, without reasoning_effort 'none', rejects
 * any temperature but 1 (live 400s, 2026-11-20). Before this card ~25 utility callers built
 * their own gpt-4o body, so flipping the pin in models.js alone would have broken all of them.
 *
 * COMPARATIVE_OPENAI moved only after its own rule-13 A/B
 * (data/audit/comparative-openai-ab-2026-11.json). If a later A/B fails and a pin is held on a
 * retiring id, list it in HELD_ON_RETIRING with the audit file, so the failure says so plainly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const models = require('../../scripts/lib/models.js');
const { MODEL_SHUTDOWNS, ACCEPTED_SHUTDOWNS } = require('../../scripts/lib/research-cost.js');
const { OPENAI_REQUEST_PROFILES } = require('../../scripts/lib/llm-batch.js');

const PINS = ['SCORING_OPENAI', 'COMPARATIVE_OPENAI', 'GPT4O', 'GPT4O_MINI'];
// Pins knowingly held on a retiring id because their A/B failed: { PIN: 'data/audit/<file>' }. Empty since BRO-7341.
const HELD_ON_RETIRING = {};

describe('OpenAI chat pins are live models', () => {
  for (const pin of PINS) {
    test(`${pin} has no announced shutdown`, () => {
      const id = models[pin];
      assert.ok(id, `${pin} missing from models.js`);
      const shutdown = MODEL_SHUTDOWNS[id] || ACCEPTED_SHUTDOWNS[id];
      if (HELD_ON_RETIRING[pin]) {
        assert.ok(shutdown, `${pin} is listed as held but ${id} has no shutdown: drop it from HELD_ON_RETIRING`);
        return;
      }
      assert.equal(shutdown, undefined, `${pin}=${id} shuts down ${shutdown}; move it (A/B first for a scoring pin)`);
    });

    test(`${pin} has an OPENAI_REQUEST_PROFILES entry`, () => {
      assert.ok(OPENAI_REQUEST_PROFILES[models[pin]], `${pin}=${models[pin]} has no request profile in scripts/lib/llm-batch.js`);
    });
  }

  test('the gpt-4o family is registered as shutting down (so the hardcoded-literal guard covers it)', () => {
    assert.equal(MODEL_SHUTDOWNS['gpt-4o'], '2027-01-14');
    assert.equal(MODEL_SHUTDOWNS['gpt-4o-mini'], '2027-01-14');
  });
});

describe('class guard: callers of an OpenAI pin build the body with openaiChatBody', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
    }
  };
  walk(join(root, 'scripts'));
  const pinRe = new RegExp(`\\b(?:${PINS.join('|')})\\b`);
  const callRe = /api\.openai\.com\/v1\/chat\/completions|chat\.completions\.create\(/;
  const offenders = (srcOf) => files
    .filter((f) => !f.endsWith(join('lib', 'models.js')) && !f.endsWith(join('lib', 'research-cost.js')))
    .filter((f) => { const s = srcOf(f); return pinRe.test(s) && callRe.test(s) && !s.includes('openaiChatBody('); })
    .map((f) => relative(root, f));

  test('no script calls chat completions with a pin and a hand-built body', () => {
    const bad = offenders((f) => readFileSync(f, 'utf8'));
    assert.deepEqual(bad, [], `build these bodies with openaiChatBody (scripts/lib/llm-batch.js): ${bad.join(', ')}`);
  });

  test('red-then-green: the scan sees the callers and would flag one without the builder', () => {
    const callers = files.filter((f) => { const s = readFileSync(f, 'utf8'); return pinRe.test(s) && callRe.test(s); });
    assert.ok(callers.length >= 15, `scan found only ${callers.length} pin callers`);
    const target = join(root, 'scripts/lib/content-verifier.js');
    const bad = offenders((f) => {
      const s = readFileSync(f, 'utf8');
      return f === target ? s.replaceAll('openaiChatBody(', 'JSON_BODY(') : s;
    });
    assert.deepEqual(bad, ['scripts/lib/content-verifier.js']);
  });
});
