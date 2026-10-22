'use strict';
const assert = require('assert');
const { test } = require('node:test');
const c = require('./supabase-backup-core');
test('supabase-backup-core', () => {
assert.deepStrictEqual(c.parseTableRows([{ t: 'a', pk: 'x,y' }]), [{ name: 'a', pk: ['x', 'y'] }]);
assert.throws(() => c.parseTableRows([{ t: 'a', pk: null }]), /no primary key/);
assert.throws(() => c.parseTableRows([]), /empty/);
assert.throws(() => c.parseTableRows([{ t: 'a;drop', pk: 'id' }]), /unexpected table/);
assert.strictEqual(c.keysetParams(['id'], null), null);
assert.deepStrictEqual(c.keysetParams(['id'], { id: 'u1' }), { id: 'gt.u1' });
assert.strictEqual(c.keysetParams(['user_id', 'show_id'], { user_id: 'u', show_id: 's"1' }).or,
  '(user_id.gt."u",and(user_id.eq."u",show_id.gt."s\\"1"))');
assert.deepStrictEqual(c.compareCounts({ a: 100, b: 0 }, { a: 101, b: 0 }), []);
assert.strictEqual(c.compareCounts({ a: 100 }, { a: 140 }).length, 1);
assert.strictEqual(c.compareCounts({ a: 100 }, {}).length, 1);
assert.strictEqual(c.compareCounts({ a: 1 }, { a: 1, z: 1 }).length, 1);
assert.strictEqual(c.compareCounts({ a: 0 }, { a: 3 }).length, 1);
assert.strictEqual(c.projectRefFromUrl('https://AbC123.supabase.co/'), 'abc123');
assert.strictEqual(c.projectRefFromUrl('https://example.com'), null);
});
