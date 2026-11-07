/**
 * Locks the Tony-shape grouping used by /tony-awards/predictions/[season].
 *
 * The season block used to render one flat, date-sorted, two-column list, which
 * is what the owner objected to on 2026-08-13: the Tony show-level categories
 * split musical/play and new/revival, and the page didn't. This calls the real
 * groupShowsByTonyShape() (CLAUDE.md rule 15 — no re-implemented logic here), so
 * changing the bucket rules or their order fails this test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupShowsByTonyShape } from '../../src/lib/tony-season-groups';

const show = (id: string, type: string | null, isRevival?: boolean | null) => ({ id, type, isRevival });

test('splits musical/play and new/revival into the four Tony show-level shapes', () => {
  const groups = groupShowsByTonyShape([
    show('paddington', 'musical', false),
    show('school-girls', 'play', false),
    show('evita', 'musical', true),
    show('gloria', 'play', true),
  ]);
  assert.deepEqual(
    groups.map(g => [g.key, g.shows.map(s => s.id)]),
    [
      ['new-musical', ['paddington']],
      ['new-play', ['school-girls']],
      ['revival-musical', ['evita']],
      ['revival-play', ['gloria']],
    ],
  );
});

test('group order is Tony-category order regardless of input order', () => {
  const groups = groupShowsByTonyShape([
    show('gloria', 'play', true),
    show('evita', 'musical', true),
    show('school-girls', 'play', false),
    show('paddington', 'musical', false),
  ]);
  assert.deepEqual(groups.map(g => g.key), ['new-musical', 'new-play', 'revival-musical', 'revival-play']);
});

test('input order is preserved inside a group (caller pre-sorts by opening date)', () => {
  const groups = groupShowsByTonyShape([
    show('celebrity-autobiography', 'play', true),
    show('other-desert-cities', 'play', true),
    show('a-few-good-men', 'play', true),
  ]);
  assert.deepEqual(groups[0].shows.map(s => s.id), [
    'celebrity-autobiography',
    'other-desert-cities',
    'a-few-good-men',
  ]);
});

test('empty groups are omitted, not rendered as empty headings', () => {
  const groups = groupShowsByTonyShape([show('dolly', 'musical', false)]);
  assert.deepEqual(groups.map(g => g.key), ['new-musical']);
});

test('missing isRevival counts as new, not as unclassified', () => {
  // shows.json omits isRevival on plenty of entries; treating undefined as
  // "unknown" would dump real new shows into the Other bucket.
  const groups = groupShowsByTonyShape([show('a', 'musical'), show('b', 'play', null)]);
  assert.deepEqual(groups.map(g => g.key), ['new-musical', 'new-play']);
});

test('type matching is case- and whitespace-insensitive', () => {
  const groups = groupShowsByTonyShape([show('a', 'Musical'), show('b', ' PLAY ', true)]);
  assert.deepEqual(groups.map(g => g.key), ['new-musical', 'revival-play']);
});

test('non-play/musical types land in a trailing Other bucket instead of vanishing', () => {
  // A list headed "this season's Broadway shows" silently dropping a show would
  // be a worse bug than an imprecise heading.
  const groups = groupShowsByTonyShape([
    show('special-event', 'special', false),
    show('no-type', null),
    show('dolly', 'musical', false),
  ]);
  assert.deepEqual(groups.map(g => g.key), ['new-musical', 'other']);
  assert.deepEqual(groups[1].shows.map(s => s.id), ['special-event', 'no-type']);
  const total = groups.reduce((n, g) => n + g.shows.length, 0);
  assert.equal(total, 3, 'every input show must appear in exactly one group');
});

test('empty input produces no groups', () => {
  assert.deepEqual(groupShowsByTonyShape([]), []);
});
