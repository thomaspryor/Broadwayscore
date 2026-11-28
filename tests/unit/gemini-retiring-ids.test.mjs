/**
 * BRO-7511 class guard. gemini-2.5-flash and gemini-2.5-pro shut down 2026-12-01.
 * General Gemini callers (classifiers, extractors, audits, workflows) take their
 * model from scripts/lib/models.js GEMINI_FLASH, so the next move is one line.
 * A new hardcoded 2.5 id outside the files below fails this test.
 *
 * ALLOWED holds the callers that need their own A/B or validation before they
 * move (CLAUDE.md rule 13): the review-scoring pins and their experiments, the
 * comparative rescore pin. The Pro callers take models.js GEMINI_PRO. The retirement registry lists
 * the ids by design.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED = new Set([
  'scripts/lib/research-cost.js', // MODEL_SHUTDOWNS registry
  'scripts/lib/comparative-batch.js', // comparative rescore pin: own check first
  // review-scoring pin and the scoring experiments that construct GeminiScorer
  'scripts/llm-scoring/gemini-scorer.ts',
  'scripts/llm-scoring/ensemble-scorer.ts',
  'scripts/llm-scoring/index.ts',
  'scripts/llm-scoring/openai-leg-shadow.ts',
  'scripts/llm-scoring/comprehensive-experiment.ts',
  'scripts/llm-scoring/test-consistency.ts',
  'scripts/llm-scoring/test-ensemble.ts',
  'scripts/llm-scoring/test-helen-shaw-fixture.ts',
  'scripts/llm-scoring/test-prompt-structural-ab.ts',
]);

// Bare id in any form (quoted, URL path, `?key=`, unquoted YAML); -lite and other variants excluded.
const RETIRING = /(?<![\w.-])gemini-2\.5-(flash|pro)(?![\w-])/;
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || (e.name.startsWith('.') && e.name !== '.github')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c?js|mjs|tsx?|jsx|ya?ml|sh|py)$/.test(e.name) && !/\.test\./.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
// Comment-only lines do not count.
const pins = (src) => src.split('\n').some((l) => RETIRING.test(l) && !/^\s*(\/\/|\*|#)/.test(l));
const offenders = ['scripts', 'src', '.github/workflows'].flatMap((d) => walk(path.join(ROOT, d)))
  .map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))
  .filter((rel) => pins(fs.readFileSync(path.join(ROOT, rel), 'utf8')));

test('the utility alias is off the retiring ids', () => {
  const { GEMINI_FLASH } = require('../../scripts/lib/models.js');
  assert.doesNotMatch(GEMINI_FLASH, /^gemini-2\.5-/);
  assert.doesNotMatch(require('../../scripts/lib/models.js').GEMINI_PRO, /^gemini-2\.5-/);
});

test('no new hardcoded gemini-2.5 id outside the A/B-gated callers (use models.js GEMINI_FLASH)', () => {
  const fresh = offenders.filter((f) => !ALLOWED.has(f));
  assert.deepEqual(fresh, [], `take the model from scripts/lib/models.js GEMINI_FLASH: ${fresh.join(', ')}`);
});

test('the detector catches the forms the callers used (red-then-green)', () => {
  assert.equal(pins("const MODEL = 'gemini-2.5-flash';"), true);
  assert.equal(pins("fetch('https://x/v1beta/models/gemini-2.5-flash:generateContent')"), true);
  assert.equal(pins('fetch(`https://x/models/gemini-2.5-pro:generateContent`)'), true);
  assert.equal(pins("  // gemini-2.5-flash shut down 2026-12-01"), false);
  assert.equal(pins("const MODEL = 'gemini-3.5-flash-lite';"), false);
  assert.equal(pins('      model: gemini-2.5-flash'), true);
  assert.equal(pins('fetch(`https://x/models/gemini-2.5-flash?key=${k}`)'), true);
  assert.equal(pins("const LITE = 'gemini-2.5-flash-lite';"), false);
});
