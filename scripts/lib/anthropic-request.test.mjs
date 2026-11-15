// BRO-7527: per-model Messages-API bodies, and the class guard that keeps
// thinking-by-default pins away from first-block reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildMessagesBody } = require('./anthropic-request.js');
const models = require('./models.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('4.x bodies are byte-identical to the hand-built ones they replaced', () => {
  for (const model of [models.CLAUDE_HAIKU, models.CLAUDE_SONNET, models.CLAUDE_OPUS]) {
    assert.equal(
      JSON.stringify(buildMessagesBody({ model, maxTokens: 400, prompt: 'p' })),
      JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: 'p' }] }),
    );
  }
  // temperature is still sent to a model that accepts it
  assert.equal(buildMessagesBody({ model: models.CLAUDE_HAIKU, maxTokens: 10, prompt: 'p', temperature: 0.1 }).temperature, 0.1);
});

test('Haiku 5.5: no temperature, thinking off, cap scaled for the bigger tokenizer', () => {
  const b = buildMessagesBody({ model: models.CLAUDE_HAIKU_5, maxTokens: 400, prompt: 'p', temperature: 0.1 });
  assert.equal(b.temperature, undefined);
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.equal(b.max_tokens, 520);
  assert.equal(b.output_config, undefined);
});

test('families with no checked shape throw instead of sending a body that thinks', () => {
  for (const model of ['claude-opus-5-5', 'claude-fable-5-2']) {
    assert.throws(() => buildMessagesBody({ model, maxTokens: 400, prompt: 'p' }), /no checked request shape/);
  }
  assert.throws(() => buildMessagesBody({ model: models.CLAUDE_HAIKU, maxTokens: 0, prompt: 'p' }));
});

// Class guard: a model that thinks by default can put a thinking block first,
// so content[0].text is undefined and the caller silently gets ''. Any script
// that calls the Messages API and names a models.js pin whose value is such a
// model must read the answer with finalResponseText (anthropic-response-text.js).
// Flipping a pin (e.g. CLAUDE_HAIKU or VERIFIER_HAIKU to Haiku 5.5) turns every
// unconverted caller red here.
test('no first-block reads in callers of thinking-by-default pins', () => {
  const THINKS = /^claude-(haiku-5|sonnet-5|opus-5|fable|mythos)/;
  const pins = Object.entries(models).filter(([, v]) => typeof v === 'string' && THINKS.test(v)).map(([k]) => k);
  assert.ok(pins.includes('CLAUDE_HAIKU_5'), 'guard must see the Haiku 5.5 pin');
  const FIRST = /content\s*(\?\.)?\s*\[\s*0\s*\]\s*(\?\.)?\s*\.?\s*text/;
  const files = execSync('git ls-files scripts src supabase', { cwd: ROOT }).toString().split('\n')
    .filter(f => /\.(c?js|mjs|ts)$/.test(f) && !/\.test\.|\/tests?\//.test(f));
  const bad = [];
  for (const f of files) {
    let s;
    try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    // Raw HTTP and SDK callers alike (ship-check: SDK callers were missed).
    if (!/api\.anthropic\.com|@anthropic-ai\/sdk|messages\.create\(/.test(s) || !FIRST.test(s)) continue;
    const used = pins.filter(p => new RegExp(`\\b${p}\\b`).test(s));
    if (used.length) bad.push(`${f} (${used.join(', ')})`);
  }
  assert.deepEqual(bad, [], `read text blocks with finalResponseText, not content[0].text:\n${bad.join('\n')}`);
});

test('spot-check meter prices every model at the Haiku 4.5 rate for the cap', () => {
  const { createMeter } = require('./capped-spend-meter.js');
  const m = createMeter(1, { capModel: models.CLAUDE_HAIKU, concurrency: 4 });
  assert.equal(m.canSpend(), true); // 0 + 4 x $0.05 reserve < $1
  m.record({ input_tokens: 10_000, output_tokens: 0 }, models.CLAUDE_HAIKU_5);
  assert.ok(Math.abs(m.totals.capPricedUsd - 0.01) < 1e-9); // priced at the 4.5 rate
  assert.ok(Math.abs(m.totals.listUsd - 0.001) < 1e-9);     // list price kept apart
  assert.equal(m.canSpend(), true);
  m.record({ input_tokens: 700_000, output_tokens: 0 }, models.CLAUDE_HAIKU);
  // $0.71 spent, and the biggest call ($0.70) x 4 in-flight reserve passes the cap
  assert.equal(m.canSpend(), false);
});
