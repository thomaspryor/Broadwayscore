/**
 * BRO-7511 class guard. gemini-3.5-flash-lite REJECTS thinkingConfig.thinkingBudget
 * (HTTP 400 "Request contains an invalid argument" on all 20 calls of the
 * 2026-11-21 smoke A/B) and Google routes gemini-2.5-flash to it on 2026-12-01.
 * Gemini requests must take their "thinking off" config from geminiThinkingOff(model)
 * (scripts/lib/llm-batch.js), which picks thinkingBudget:0 (2.x) or
 * thinkingLevel:'minimal' (3.x).
 *
 * Scoring files are fixed now. PENDING lists the other callers still on the
 * literal (the rest of the BRO-7511 migration): it may only SHRINK. A new file
 * with a literal thinkingBudget:0 fails; a fixed file must be removed from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { geminiThinkingOff, buildGeminiBatchRequest } = require('../../scripts/lib/llm-batch.js');

// Kept in a data file so the audit that maps test-named paths to test.yml does not treat them as test deps.
const PENDING = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/gemini-thinking-pending.json'), 'utf8')).pending);

// The helper itself returns the 2.x literal; its batch builder is checked functionally below.
const HELPER_HOME = 'scripts/lib/llm-batch.js';
const LITERAL = /["']?thinkingBudget["']?\s*:\s*0\b/;
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c?js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
// Lines that are only comments do not count.
const hits = (src) => src.split('\n').filter((l) => LITERAL.test(l) && !/^\s*(\/\/|\*)/.test(l)).length;
// The helper's home may hold exactly ONE literal: the helper's own 2.x return.
const offends = (src, rel) => hits(src) > (rel === HELPER_HOME ? 1 : 0);
const offenders = ['scripts', 'src'].flatMap((d) => walk(path.join(ROOT, d)))
  .map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))
  .filter((rel) => offends(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel));

test('geminiThinkingOff: 2.x keeps thinkingBudget 0, 3.x gets thinkingLevel minimal', () => {
  assert.deepEqual(geminiThinkingOff('gemini-2.5-flash'), { thinkingBudget: 0 });
  assert.deepEqual(geminiThinkingOff('gemini-3.5-flash-lite'), { thinkingLevel: 'minimal' });
  assert.deepEqual(geminiThinkingOff('gemini-3.8-flash'), { thinkingLevel: 'minimal' });
  assert.deepEqual(geminiThinkingOff('models/gemini-3.5-flash-lite'), { thinkingLevel: 'minimal' });
  assert.deepEqual(geminiThinkingOff('gemini-10-flash'), { thinkingLevel: 'minimal' });
});

test('no NEW file sends a literal thinkingBudget:0 (use geminiThinkingOff(model))', () => {
  const fresh = offenders.filter((f) => !PENDING.has(f));
  assert.deepEqual(fresh, [], `use geminiThinkingOff(model) from scripts/lib/llm-batch.js: ${fresh.join(', ')}`);
});

test('the PENDING list only shrinks: drop files that no longer send the literal', () => {
  const gone = [...PENDING].filter((f) => !offenders.includes(f));
  assert.deepEqual(gone, [], `remove from PENDING: ${gone.join(', ')}`);
});

test('scoring paths are fixed: sync scorer, batch builder, comparative (red-then-green)', () => {
  for (const f of ['scripts/llm-scoring/gemini-scorer.ts', 'scripts/lib/llm-batch.js', 'scripts/lib/comparative-batch.js', 'scripts/llm-scoring/comparative-core.ts']) {
    assert.equal(offenders.includes(f), false, f);
  }
  assert.equal(offends("generationConfig: { thinkingConfig: { thinkingBudget: 0 } }", 'x.js'), true);
  assert.equal(offends('generationConfig: { "thinkingBudget": 0 }', 'x.js'), true);
  assert.equal(offends("  // thinkingBudget: 0 was the old form", 'x.js'), false);
  assert.equal(offends("a = { thinkingBudget: 0 };\nb = { thinkingBudget: 0 };", HELPER_HOME), true, 'a 2nd literal in the helper home is caught');
  const line = buildGeminiBatchRequest({ customId: 'c', systemPrompt: 's', userPrompt: 'u', model: 'gemini-3.5-flash-lite' });
  assert.equal('thinkingBudget' in line.request.generationConfig.thinkingConfig, false);
});
