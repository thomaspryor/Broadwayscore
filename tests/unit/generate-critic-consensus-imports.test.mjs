// BRO-5534: bf00893ed74 passed `normalizeOutlet` into loadConsensusInputs without
// importing it, so every Update Critics' Take run died with
// "ReferenceError: normalizeOutlet is not defined" (9 failures/24h).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../scripts/generate-critic-consensus.js', import.meta.url), 'utf8');

test('normalizeOutlet is bound at module level before use', () => {
  assert.match(src, /^import\s+reviewNormalization\s+from\s+'\.\/lib\/review-normalization\.js';\s*\nconst\s*\{[^}]*\bnormalizeOutlet\b[^}]*\}\s*=\s*reviewNormalization;/m);
});

test('injected normalizeOutlet resolves aliases', async () => {
  const { default: rn } = await import('../../scripts/lib/review-normalization.js');
  assert.equal(rn.normalizeOutlet('The New York Times'), 'nytimes');
});
