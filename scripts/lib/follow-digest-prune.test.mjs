import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unfollowedShowIds } = require('./follow-digest-prune.js');

test('drops shows with no followers, keeps followed ones (BRO-4897)', () => {
  const changes = { hamilton: [{ type: 'cast-change' }], wicked: [{ type: 'status-change' }], six: [] };
  const followers = { hamilton: ['a@example.com'], six: [] };
  assert.deepEqual(unfollowedShowIds(changes, followers).sort(), ['six', 'wicked']);
});

test('tolerates missing inputs', () => {
  assert.deepEqual(unfollowedShowIds(undefined, undefined), []);
  assert.deepEqual(unfollowedShowIds({ a: [] }, undefined), ['a']);
  assert.deepEqual(unfollowedShowIds({ a: [] }, { a: 'not-an-array' }), ['a']);
});
