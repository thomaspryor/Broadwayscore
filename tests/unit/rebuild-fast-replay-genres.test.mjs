import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeGenreTags } = require('../../scripts/lib/rebuild-fast-replay-genres.js');

test('replays new tags and preserves unrelated main additions', () => {
  assert.deepEqual(mergeGenreTags({}, { ours: ['comedy'] }, { theirs: ['drama'] }), {
    theirs: ['drama'], ours: ['comedy'],
  });
});

test('replays an update only when main still has its base value', () => {
  const base = { unchanged: ['drama'], updated: ['comedy'] };
  const lost = { unchanged: ['drama'], updated: ['thriller'] };
  assert.deepEqual(mergeGenreTags(base, lost, base), { unchanged: ['drama'], updated: ['thriller'] });
  assert.deepEqual(base, { unchanged: ['drama'], updated: ['comedy'] });
});

test('fresh main wins conflicting updates and conflicting new records', () => {
  assert.deepEqual(mergeGenreTags(
    { updated: ['comedy'] },
    { updated: ['thriller'], added: ['drama'] },
    { updated: ['family'], added: ['romance'] },
  ), { updated: ['family'], added: ['romance'] });
});

test('never resurrects a tag record deleted on main', () => {
  assert.deepEqual(mergeGenreTags(
    { unchanged: ['comedy'], updated: ['drama'] },
    { unchanged: ['comedy'], updated: ['thriller'] },
    {},
  ), {});
});

test('preserves empty results so the tagger will not retry paid classification', () => {
  assert.deepEqual(mergeGenreTags({}, { none: [] }, {}), { none: [] });
});

test('replaying twice is idempotent and does not revert newer main tags', () => {
  const base = { old: ['comedy'] };
  const lost = { old: ['comedy'], fresh: ['drama'] };
  const current = { old: ['family'], other: [] };
  const merged = mergeGenreTags(base, lost, current);
  assert.deepEqual(mergeGenreTags(base, lost, merged), { old: ['family'], other: [], fresh: ['drama'] });
});
