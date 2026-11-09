import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditCacheEntries, keyPrefix } = require('../../scripts/lib/actions-cache-budget');

const GIB = 1024 ** 3;
const e = (key, gib) => ({ key, sizeInBytes: Math.round(gib * GIB), createdAt: '2026-11-06T00:00:00Z' });

test('healthy listing passes', () => {
  const r = auditCacheEntries([e('nextjs-cache-Linux-123456789', 0.3), e('aggregator-archive-' + 'a'.repeat(40), 0.13)]);
  assert.deepEqual(r.violations, []);
});

test('flags a single huge static-key entry', () => {
  const r = auditCacheEntries([e('static-key-' + 'b'.repeat(40), 3.4)]);
  assert.deepEqual(r.violations.map((v) => v.kind), ['entry']);
});

test('flags total over budget (the BRO-3887 28 GiB shape)', () => {
  const rows = Array.from({ length: 12 }, (_, i) => e(`bd-serp-cache-${1000000 + i}`, 2.3));
  const kinds = auditCacheEntries(rows).violations.map((v) => v.kind).sort();
  assert.deepEqual(kinds, ['churn', 'entry', 'entry', 'entry', 'entry', 'entry', 'entry', 'entry', 'entry', 'entry', 'entry', 'entry', 'entry', 'total'].sort());
});

test('flags unbounded count of small entries sharing a prefix', () => {
  const rows = Array.from({ length: 9 }, (_, i) => e(`checkout-aggregator-archive-${'c'.repeat(11)}${i}1234`, 0.13));
  const r = auditCacheEntries(rows);
  assert.deepEqual(r.violations.map((v) => v.kind), ['churn']);
});

test('keyPrefix collapses run-id and hash tails but keeps different families apart', () => {
  assert.equal(keyPrefix('nextjs-cache-Linux-12345678901'), keyPrefix('nextjs-cache-Linux-12345678902'));
  assert.notEqual(keyPrefix('nextjs-cache-Linux-12345678901'), keyPrefix('bd-serp-cache-12345678901'));
});

test('tolerates empty / malformed input', () => {
  assert.deepEqual(auditCacheEntries([]).violations, []);
  assert.deepEqual(auditCacheEntries(null).violations, []);
});

test('groups mid-key run ids (bd-serp-cache merged/gather shapes)', () => {
  assert.equal(keyPrefix('bd-serp-cache-32393356269-merged-1'), keyPrefix('bd-serp-cache-32393356270-merged-2'));
  assert.equal(keyPrefix('bd-serp-cache-32393356269-gather-3'), keyPrefix('bd-serp-cache-32393356271-gather-4'));
  assert.notEqual(keyPrefix('bd-serp-cache-32393356269-merged-1'), keyPrefix('bd-serp-cache-32393356269-gather-1'));
});
