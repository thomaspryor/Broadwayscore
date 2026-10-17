// BRO-4405: data/outlet-registry.json is auto-registered by every rebuild
// (~20 workflows) and committed by push-core-data; it needs a keyed merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeOutletRegistry } = require('./merge-outlet-registry.js');

const doc = (outlets, extra = {}) => ({
  _meta: { lastUpdated: '2026-10-14T01:00:00.000Z', version: '2.1.0' },
  outlets,
  _aliasIndex: {},
  ...extra,
});

test('two rebuilds registering different outlets keep both', () => {
  const ours = doc({ nyt: { tier: 1 }, aaa: { tier: 3 } }, { _aliasIndex: { aaa: 'aaa' } });
  const remote = doc({ nyt: { tier: 1 }, bbb: { tier: 3 } }, { _aliasIndex: { bbb: 'bbb' } });
  const { merged, stats } = mergeOutletRegistry(ours, remote);
  assert.deepEqual(Object.keys(merged.outlets).sort(), ['aaa', 'bbb', 'nyt']);
  assert.deepEqual(merged._aliasIndex, { aaa: 'aaa', bbb: 'bbb' });
  assert.deepEqual(stats, { added: 1, kept: 1, total: 3 });
});

test('ours wins the whole entry on a shared id', () => {
  const { merged } = mergeOutletRegistry(doc({ x: { tier: 2 } }), doc({ x: { tier: 3, domain: 'x.com' } }));
  assert.deepEqual(merged.outlets.x, { tier: 2 });
});

test('_meta.lastUpdated and lastChange follow the newer document', () => {
  const ours = doc({}, { lastChange: 'old' }); // 01:00
  const remote = { ...doc({}, { lastChange: 'new' }), _meta: { lastUpdated: '2026-10-14T05:00:00.000Z', version: '2.1.0' } };
  const { merged } = mergeOutletRegistry(ours, remote);
  assert.equal(merged._meta.lastUpdated, '2026-10-14T05:00:00.000Z');
  assert.equal(merged.lastChange, 'new');
});

test('tolerates missing/garbage inputs', () => {
  assert.deepEqual(mergeOutletRegistry(null, undefined).merged.outlets, {});
  assert.deepEqual(Object.keys(mergeOutletRegistry(doc({ a: {} }), 'x').merged.outlets), ['a']);
});
