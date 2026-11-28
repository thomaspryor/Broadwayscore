// BRO-7957 class guard: the gap audit must pass the owning show to
// getSyndicationPrimaries so market primacy overrides apply (Chris Jones NYC).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../../scripts/audit-show-review-gap.js', import.meta.url), 'utf8');
test('every getSyndicationPrimaries call in the gap audit threads { show }', () => {
  const calls = src.match(/getSyndicationPrimaries\([^)]*\)/g) || [];
  assert.ok(calls.length >= 1, 'expected at least one call');
  for (const c of calls) assert.match(c, /\{\s*show\s*\}/, `missing { show }: ${c}`);
});
