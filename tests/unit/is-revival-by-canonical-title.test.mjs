/**
 * Unit tests for isRevivalByCanonicalTitle (review-guards.js)
 *
 * Replaces the fragile regex-based revival detection (`/-\d{4}$/`) which missed
 * shows like `giant-2` (TodayTix uses varied suffixes). The new helper looks
 * up the show's canonical title in shows.json and returns true if any OTHER
 * show shares the same title.
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #9
 *       Pre-mortem secondary scenario (giant-2 counterexample)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isRevivalByCanonicalTitle } = require('../../scripts/lib/review-guards.js');

const SAMPLE_SHOWS = [
  { id: 'death-of-a-salesman-2026', title: 'Death of a Salesman' },
  { id: 'death-of-a-salesman-2022', title: 'Death of a Salesman' },
  { id: 'death-of-a-salesman-2012', title: 'Death of a Salesman' },
  { id: 'cats-the-jellicle-ball-2026', title: 'Cats: The Jellicle Ball' },
  { id: 'giant-2', title: 'Giant' },
  { id: 'giant', title: 'Giant' },
  { id: 'hamilton', title: 'Hamilton' },
  { id: 'wicked', title: 'Wicked' },
  { id: 'titanique-2026', title: 'Titanique' },
];

describe('isRevivalByCanonicalTitle', () => {
  test('death-of-a-salesman-2026 → revival (3 productions in shows.json)', () => {
    assert.strictEqual(
      isRevivalByCanonicalTitle('death-of-a-salesman-2026', SAMPLE_SHOWS),
      true
    );
  });

  test('giant-2 → revival (matches giant by canonical title, no year suffix)', () => {
    // This is the pre-mortem counterexample: regex /-\d{4}$/ would not match
    // "giant-2" but it IS a revival of "giant".
    assert.strictEqual(isRevivalByCanonicalTitle('giant-2', SAMPLE_SHOWS), true);
  });

  test('giant → revival (older entry, also matches giant-2)', () => {
    assert.strictEqual(isRevivalByCanonicalTitle('giant', SAMPLE_SHOWS), true);
  });

  test('hamilton → not a revival (only one Hamilton in shows.json)', () => {
    assert.strictEqual(isRevivalByCanonicalTitle('hamilton', SAMPLE_SHOWS), false);
  });

  test('titanique-2026 → not a revival (only one Titanique)', () => {
    assert.strictEqual(isRevivalByCanonicalTitle('titanique-2026', SAMPLE_SHOWS), false);
  });

  test('cats-the-jellicle-ball-2026 → not a revival (the original "Cats" has a different title)', () => {
    // Cats: The Jellicle Ball is a separate show from the original Cats musical;
    // they have different canonical titles, so the helper correctly says "not a revival".
    assert.strictEqual(isRevivalByCanonicalTitle('cats-the-jellicle-ball-2026', SAMPLE_SHOWS), false);
  });

  test('uses canonicalTitle if present, otherwise falls back to title', () => {
    const shows = [
      { id: 'show-a', title: 'Foo Bar', canonicalTitle: 'CanonicalFoo' },
      { id: 'show-b', title: 'CanonicalFoo' },
    ];
    // show-a's canonicalTitle matches show-b's title — both should resolve to revival
    assert.strictEqual(isRevivalByCanonicalTitle('show-a', shows), true);
    assert.strictEqual(isRevivalByCanonicalTitle('show-b', shows), true);
  });

  test('case-insensitive title match', () => {
    const shows = [
      { id: 'a', title: 'Death of a Salesman' },
      { id: 'b', title: 'DEATH OF A SALESMAN' },
    ];
    assert.strictEqual(isRevivalByCanonicalTitle('a', shows), true);
  });

  test('whitespace tolerance', () => {
    const shows = [
      { id: 'a', title: '  Foo  ' },
      { id: 'b', title: 'Foo' },
    ];
    assert.strictEqual(isRevivalByCanonicalTitle('a', shows), true);
  });

  test('show not found in shows.json → false', () => {
    assert.strictEqual(isRevivalByCanonicalTitle('nonexistent-show', SAMPLE_SHOWS), false);
  });

  test('show with no title → false', () => {
    const shows = [{ id: 'a', title: '' }, { id: 'b', title: '' }];
    assert.strictEqual(isRevivalByCanonicalTitle('a', shows), false);
  });

  test('empty shows array → false', () => {
    assert.strictEqual(isRevivalByCanonicalTitle('any-show', []), false);
  });

  test('null/undefined shows → false (defensive)', () => {
    assert.strictEqual(isRevivalByCanonicalTitle('a', null), false);
    assert.strictEqual(isRevivalByCanonicalTitle('a', undefined), false);
  });

  test('null/undefined showId → false (defensive)', () => {
    assert.strictEqual(isRevivalByCanonicalTitle(null, SAMPLE_SHOWS), false);
    assert.strictEqual(isRevivalByCanonicalTitle('', SAMPLE_SHOWS), false);
  });

  test('does not match self if no other share title', () => {
    // Single-entry shows.json: show should not be a revival of itself.
    const shows = [{ id: 'only-show', title: 'Only Show' }];
    assert.strictEqual(isRevivalByCanonicalTitle('only-show', shows), false);
  });
});
