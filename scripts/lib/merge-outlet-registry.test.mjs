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

test('with a base: our unchanged (stale) entry yields to the remote edit (BRO-5352)', () => {
  const base = doc({ x: { tier: 3 }, y: { tier: 3 } });
  const ours = doc({ x: { tier: 3 }, y: { tier: 2 } });
  const remote = doc({ x: { tier: 3, domain: 'x.com' }, y: { tier: 3, domain: 'y.com' } });
  const { merged } = mergeOutletRegistry(ours, remote, base);
  assert.deepEqual(merged.outlets.x, { tier: 3, domain: 'x.com' }, 'stale ours loses to remote backfill');
  assert.deepEqual(merged.outlets.y, { tier: 2 }, 'a real local edit still wins');
});

test('without a base (or a null one) ours still wins a shared id', () => {
  const ours = doc({ x: { tier: 3 } });
  const remote = doc({ x: { tier: 3, domain: 'x.com' } });
  assert.deepEqual(mergeOutletRegistry(ours, remote).merged.outlets.x, { tier: 3 });
  assert.deepEqual(mergeOutletRegistry(ours, remote, null).merged.outlets.x, { tier: 3 });
});

test('_meta.lastChange follows the newer document', () => {
  const ours = { ...doc({}), _meta: { lastUpdated: '2026-10-14T01:00:00.000Z', lastChange: 'old' } };
  const remote = { ...doc({}), _meta: { lastUpdated: '2026-10-14T05:00:00.000Z', lastChange: 'new' } };
  assert.equal(mergeOutletRegistry(ours, remote).merged._meta.lastChange, 'new');
});

test('with a base: a stale unchanged alias yields to the remote remap; kept excludes remote-won ids', () => {
  const base = doc({ x: { tier: 3 } }, { _aliasIndex: { xx: 'x' } });
  const ours = doc({ x: { tier: 3 } }, { _aliasIndex: { xx: 'x' } });
  const remote = doc({ x: { tier: 3, domain: 'x.com' } }, { _aliasIndex: { xx: 'x2' } });
  const { merged, stats } = mergeOutletRegistry(ours, remote, base);
  assert.equal(merged._aliasIndex.xx, 'x2');
  assert.equal(stats.kept, 0);
});
