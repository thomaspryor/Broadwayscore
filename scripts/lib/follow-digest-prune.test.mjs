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

const { isStaleBaseline, stampDetectedAt, dropAgedChanges } = require('./follow-digest-prune.js');
const DAY = 24 * 60 * 60 * 1000;

test('a digest older than 21 days (or undated) is a stale baseline', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(isStaleBaseline('2026-02-09T04:16:49.404Z', now), true);
  assert.equal(isStaleBaseline(new Date(now - 7 * DAY).toISOString(), now), false);
  assert.equal(isStaleBaseline(undefined, now), true);
});

test('changes get a detectedAt and age out after 30 days', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const changes = {
    wicked: [{ type: 'new-reviews', detectedAt: new Date(now - 40 * DAY).toISOString() }],
    six: [{ type: 'score-change' }],
    hamilton: [{ type: 'closing-announced', detectedAt: new Date(now - 2 * DAY).toISOString() }, { type: 'x' }],
  };
  stampDetectedAt({ six: changes.six }, new Date(now - 31 * DAY).toISOString());
  const removed = dropAgedChanges(changes, now);
  assert.equal(removed, 3);
  assert.deepEqual(Object.keys(changes), ['hamilton']);
  assert.equal(changes.hamilton.length, 1);
});
