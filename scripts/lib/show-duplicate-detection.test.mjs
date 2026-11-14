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

// 2026-09-27 live dups: TodayTix listing vs venue/article entry.
test('flags performer-prefix colon variant at the same venue ("Louis Katz: Conflicted" ~ "Conflicted")', () => {
  const dates = { previewsStartDate: '2026-09-17', closingDate: '2026-10-18' };
  const shows = [
    show({ id: 'louis-katz', title: 'Louis Katz: Conflicted', venue: 'SoHo Playhouse', ...dates }),
    show({ id: 'conflicted', title: 'Conflicted', venue: 'SoHo Playhouse', ...dates }),
  ];
  assert.equal(findTitleFragmentDupes(shows).length, 1);
});

test('venue punctuation variants are the same room ("59E59 Theaters - Theater C" ~ "59E59 Theaters, Theater C")', () => {
  const shows = [
    show({ id: 'cm1', title: 'Crazy Mama', venue: '59E59 Theaters - Theater C', previewsStartDate: '2026-09-16', closingDate: '2026-10-18' }),
    show({ id: 'cm2', title: 'Crazy Mama: A True Story of Love and Madness', venue: '59E59 Theaters, Theater C', previewsStartDate: '2026-09-16', openingDate: '2026-09-22', closingDate: null }),
  ];
  assert.equal(findTitleFragmentDupes(shows).length, 1);
});

test('colon variant does NOT flag a partial segment ("Hamlet" vs "Hamlet Unbound: A Remix")', () => {
  const dates = { previewsStartDate: '2026-09-01', closingDate: '2026-10-01' };
  const shows = [
    show({ id: 'h1', title: 'Hamlet', venue: 'SoHo Playhouse', ...dates }),
    show({ id: 'h2', title: 'Hamlet Unbound: A Remix', venue: 'SoHo Playhouse', ...dates }),
  ];
  assert.equal(findTitleFragmentDupes(shows).length, 0);
});

test('flags a performer-prefix title without a colon ("Billy Crystal 860" ~ "860", BRO-5014)', () => {
  const { isStrictTitleSubset } = require('./show-duplicate-detection.js');
  const kept = show({ id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', venue: 'Imperial Theatre', openingDate: '2026-10-21', closingDate: '2027-01-03' });
  const dup = show({ id: '860-2026', title: '860', venue: 'Imperial Theatre', openingDate: '2026-10-21', closingDate: undefined });
  assert.equal(isStrictTitleSubset(kept, dup), true);
  assert.equal(findTitleFragmentDupes([kept, dup]).length, 1);
  // A one-word prefix, a short non-numeric tail, or a non-suffix are not performer prefixes.
  assert.equal(isStrictTitleSubset({ title: 'Crystal 860' }, { title: '860' }), false);
  assert.equal(isStrictTitleSubset({ title: 'Billy Crystal Act' }, { title: 'Act' }), false);
  assert.equal(isStrictTitleSubset({ title: '860 Billy Crystal' }, { title: '860' }), false);
  // Real titles that end in another title but whose front is not a name (review 2026-10-10).
  const { isColonSegmentTitle } = require('./show-duplicate-detection.js');
  for (const [long, short] of [['Romeo and Juliet', '& Juliet'], ['Drunk Romeo & Juliet', '& Juliet'], ['Sid Caesar & Company', 'Company'],
    ['Prince of Broadway', 'Broadway'], ['Find Your Way Home', 'Home'], ['The Lion King', 'King']]) {
    assert.equal(isColonSegmentTitle({ title: long }, { title: short }), false, `${long} ~ ${short}`);
  }
  assert.equal(isColonSegmentTitle({ title: "Bob Fosse's Dancin'" }, { title: "Dancin'" }), true);
});

test('an "@ building" venue tail and a leading "the" do not hide a dupe (Going Bacharach, BRO-6481)', () => {
  const d = findTitleFragmentDupes([
    show({ id: 'gb-full', title: 'Going Bacharach: The Songs of an Icon', venue: 'The Marjorie S. Deane Little Theater', openingDate: '2026-01-12', closingDate: '2026-02-22' }),
    show({ id: 'gb-short', title: 'GOING BACHARACH', venue: 'Marjorie S. Deane Little Theater @ The West Side Y', openingDate: '2026-01-12', closingDate: '2026-02-22' }),
  ]);
  assert.equal(d.length, 1);
  // A different room in the same building is still a different venue.
  assert.equal(findTitleFragmentDupes([
    show({ id: 'a', title: 'Going Bacharach: The Songs of an Icon', venue: 'Theater A @ The West Side Y' }),
    show({ id: 'b', title: 'GOING BACHARACH', venue: 'Theater B @ The West Side Y' }),
  ]).length, 0);
});
