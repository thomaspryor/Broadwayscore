import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { isStubIdClaimed, isStubStale, STALE_STUB_MS } = require('../../scripts/lib/stub-drain-guards.js');

test('a stub id that names an existing catalog entry is claimed', () => {
  const used = new Set(['hamilton', 'wicked']);
  assert.equal(isStubIdClaimed({ id: 'hamilton' }, used), true);
  assert.equal(isStubIdClaimed({ id: 'some-new-diary-show-ab12' }, used), false);
});

test('unresolved stubs only go stale after 7 days', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  assert.equal(isStubStale({ created_at: new Date(now - STALE_STUB_MS + 60000).toISOString() }, now), false);
  assert.equal(isStubStale({ created_at: new Date(now - STALE_STUB_MS - 60000).toISOString() }, now), true);
  assert.equal(isStubStale({ created_at: 'garbage' }, now), false);
  assert.equal(isStubStale({}, now), false);
});

test('the drain script actually calls both guards', () => {
  const src = readFileSync(new URL('../../scripts/resolve-unmatched-imports.js', import.meta.url), 'utf8');
  assert.match(src, /isStubIdClaimed\(row, ctx\.usedSlugs\)/);
  assert.match(src, /isStubStale\(row\)/);
});
