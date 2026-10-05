/**
 * Signed-out watchlist decision helpers (BRO-4616, "save first, ask later").
 * Locks: the sheet shows right after the first save and then respects the
 * cooldown, malformed storage reads as empty, and the
 * sign-in migration skips shows the account already has.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_AT_COUNT,
  PROMPT_COOLDOWN_MS,
  MAX_LOCAL_SHOWS,
  parseLocalWatchlist,
  addEntry,
  removeEntry,
  shouldPromptAfterSave,
  showsToMigrate,
} from '../../src/lib/local-watchlist';

// Owner call 2026-10-04: ask right after the first save; the save still happens first.
test('the first save prompts, and so does any later one outside the cooldown', () => {
  assert.equal(PROMPT_AT_COUNT, 1);
  assert.equal(shouldPromptAfterSave(0, null, 1000), false);
  assert.equal(shouldPromptAfterSave(1, null, 1000), true);
  assert.equal(shouldPromptAfterSave(2, null, 1000), true);
  assert.equal(shouldPromptAfterSave(5, null, 1000), true);
});

test('prompt respects the cooldown', () => {
  const now = 10 * PROMPT_COOLDOWN_MS;
  assert.equal(shouldPromptAfterSave(3, now - 1000, now), false);
  assert.equal(shouldPromptAfterSave(3, now - PROMPT_COOLDOWN_MS, now), true);
});

test('parse: malformed storage reads as empty; dupes and bad entries dropped', () => {
  assert.deepEqual(parseLocalWatchlist(null), []);
  assert.deepEqual(parseLocalWatchlist('not json'), []);
  assert.deepEqual(parseLocalWatchlist('{"a":1}'), []);
  assert.deepEqual(
    parseLocalWatchlist(JSON.stringify([
      { showId: 'a', savedAt: 2 }, { showId: 'a', savedAt: 1 }, null, { showId: '' }, { showId: 'b' },
    ])),
    [{ showId: 'a', savedAt: 2 }, { showId: 'b', savedAt: 0 }],
  );
});

test('add is newest-first, idempotent and capped; remove drops the show', () => {
  let list = addEntry([], 'a', 1);
  list = addEntry(list, 'b', 2);
  assert.deepEqual(list.map(e => e.showId), ['b', 'a']);
  assert.equal(addEntry(list, 'a', 3), list);
  assert.deepEqual(removeEntry(list, 'b').map(e => e.showId), ['a']);
  let big: ReturnType<typeof addEntry> = [];
  for (let i = 0; i < MAX_LOCAL_SHOWS + 5; i++) big = addEntry(big, `s${i}`, i);
  assert.equal(big.length, MAX_LOCAL_SHOWS);
  assert.equal(big[0].showId, `s${MAX_LOCAL_SHOWS + 4}`);
});

test('migration: oldest first, skips shows already on the account', () => {
  const local = [{ showId: 'c', savedAt: 3 }, { showId: 'b', savedAt: 2 }, { showId: 'a', savedAt: 1 }];
  assert.deepEqual(showsToMigrate(local, []), ['a', 'b', 'c']);
  assert.deepEqual(showsToMigrate(local, new Set(['b'])), ['a', 'c']);
  assert.deepEqual(showsToMigrate([], ['x']), []);
});
