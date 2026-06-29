// Tests the title-fragment duplicate detector: it must catch a fragment dupe
// while NOT flagging revivals, repertory trilogies, or multi-programme seasons
// (the false positives that ruled out a flat title/venue match).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findTitleFragmentDupes } = require('./show-duplicate-detection.js');

const show = (over = {}) => ({
  id: 'x', title: 'Some Show', venue: 'Hampstead Theatre',
  openingDate: '2026-03-01', closingDate: '2026-06-01', ...over,
});

test('catches a title-fragment dupe at the same venue with overlapping dates', () => {
  const shows = [
    show({ id: 'krapps-godots', title: "Krapp's Last Tape / Godot's To-Do List" }),
    show({ id: 'godots-todo', title: "Godot's To-Do List", openingDate: '2026-03-05', closingDate: '2026-05-01' }),
  ];
  const d = findTitleFragmentDupes(shows);
  assert.equal(d.length, 1);
  assert.ok(d[0].a === 'krapps-godots' || d[0].b === 'krapps-godots');
});

test('does NOT flag a revival (same title, different year/venue, no date overlap)', () => {
  const shows = [
    show({ id: 'miss-saigon-2017', title: 'Miss Saigon', venue: 'Prince Edward Theatre', openingDate: '2017-05-01', closingDate: '2018-01-01' }),
    show({ id: 'miss-saigon-2026', title: 'Miss Saigon', venue: 'Sondheim Theatre', openingDate: '2026-03-01', closingDate: '2026-09-01' }),
  ];
  assert.equal(findTitleFragmentDupes(shows).length, 0);
});

test('does NOT flag a repertory trilogy (siblings, same venue/run)', () => {
  const venue = 'Morosco Theatre';
  const dates = { openingDate: '1975-12-07', closingDate: '1976-02-01' };
  const shows = [
    show({ id: 'nc-living', title: 'The Norman Conquests: Living Together', venue, ...dates }),
    show({ id: 'nc-table', title: 'The Norman Conquests: Table Manners', venue, ...dates }),
    show({ id: 'nc-garden', title: 'The Norman Conquests: Round and Round the Garden', venue, ...dates }),
  ];
  assert.equal(findTitleFragmentDupes(shows).length, 0);
});

test('does NOT flag a two-programme season (Alvin Ailey New Works vs Legacy)', () => {
  const venue = "Sadler's Wells";
  const dates = { openingDate: '2026-09-01', closingDate: '2026-09-15' };
  const shows = [
    show({ id: 'ailey-new', title: 'Alvin Ailey American Dance Theater - New Works', venue, ...dates }),
    show({ id: 'ailey-legacy', title: 'Alvin Ailey American Dance Theater - Legacy', venue, ...dates }),
  ];
  assert.equal(findTitleFragmentDupes(shows).length, 0);
});

test('does NOT flag same-title-fragment at a DIFFERENT venue', () => {
  const shows = [
    show({ id: 'a', title: "Krapp's Last Tape / Godot's To-Do List", venue: 'Hampstead Theatre' }),
    show({ id: 'b', title: "Godot's To-Do List", venue: 'Almeida Theatre' }),
  ];
  assert.equal(findTitleFragmentDupes(shows).length, 0);
});
