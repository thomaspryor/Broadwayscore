// BRO-5534: bf00893ed74 passed `normalizeOutlet` into loadConsensusInputs without
// importing it, so every Update Critics' Take run died with
// "ReferenceError: normalizeOutlet is not defined" (9 failures/24h).
// Every injected collaborator in the wrapper must be bound in the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../scripts/generate-critic-consensus.js', import.meta.url), 'utf8');

test('normalizeOutlet is bound before loadReviewTexts uses it', () => {
  assert.match(src, /import\s+reviewNormalization\s+from\s+'\.\/lib\/review-normalization\.js'/);
  assert.match(src, /const\s*\{[^}]*\bnormalizeOutlet\b[^}]*\}\s*=\s*reviewNormalization/);
});

test('real wiring resolves outlet aliases', async () => {
  const { default: rn } = await import('../../scripts/lib/review-normalization.js');
  assert.equal(typeof rn.normalizeOutlet, 'function');
});
