import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { isStubIdClaimed } = require('../../scripts/lib/stub-drain-guards.js');

test('a stub id that names an existing catalog entry is claimed', () => {
  const used = new Set(['hamilton', 'wicked']);
  assert.equal(isStubIdClaimed({ id: 'hamilton' }, used), true);
  assert.equal(isStubIdClaimed({ id: 'some-new-diary-show-ab12' }, used), false);
});

test('the drain script actually calls the claimed-id guard', () => {
  const src = readFileSync(new URL('../../scripts/resolve-unmatched-imports.js', import.meta.url), 'utf8');
  assert.match(src, /isStubIdClaimed\(row, ctx\.usedSlugs\)/);
});
