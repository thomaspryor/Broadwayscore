/**
 * useWatchlist may only broadcast a list it knows belongs to the account.
 *
 * Every useWatchlist instance starts with a placeholder []. One that never
 * loaded (the welcome sheet only removes a bookmark) used to run its edit on
 * that [] and broadcast the result, which blanked the saved-show bookmarks on
 * every other card on the page until reload (BRO-4727). So:
 *   - an edited list is broadcast from one place, commitEdit, after its
 *     `loadedFor.current !== userId` early return;
 *   - every other broadcast sends a list just marked as this account's
 *     (`loadedFor.current = userId` right before it: a fetch, a sync, a merge).
 * Run:
 *   node --test tests/unit/watchlist-broadcast-loaded.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOOK = new URL('../../src/hooks/useWatchlist.ts', import.meta.url).pathname;
const MARK = /loadedFor\.current\s*=\s*userId\b/;
const GUARD = /if\s*\(\s*loadedFor\.current\s*!==\s*userId\s*\)/;

/** Problems with the hook's broadcasts; [] when every one is safe. */
function broadcastProblems(src) {
  const lines = src.split('\n');
  const problems = [];
  const updaters = lines.flatMap((l, i) => (/setWatchlist\(\s*prev\b/.test(l) ? [i] : []));
  const guardAt = lines.findIndex(l => GUARD.test(l));
  if (updaters.length !== 1) {
    problems.push(`expected one setWatchlist(prev => ...) (in commitEdit), found ${updaters.length}`);
  } else if (guardAt === -1 || guardAt > updaters[0]) {
    problems.push(`setWatchlist(prev => ...) on line ${updaters[0] + 1} is not behind the loadedFor guard`);
  }
  lines.forEach((l, i) => {
    if (!/\bbroadcastWatchlist\(/.test(l) || /^\s*function\s+broadcastWatchlist/.test(l)) return;
    const inUpdater = updaters.length === 1 && i > updaters[0] && i <= updaters[0] + 3;
    const marked = lines.slice(Math.max(0, i - 3), i).some(p => MARK.test(p));
    if (!inUpdater && !marked) problems.push(`broadcastWatchlist on line ${i + 1} sends a list not marked as this account's`);
  });
  return problems;
}

test('the checks recognise both shapes', () => {
  const safe = [
    'function broadcastWatchlist(userId, entries) {}',
    'if (loadedFor.current !== userId) { return; }',
    'setWatchlist(prev => {',
    '  const next = edit(prev);',
    '  broadcastWatchlist(userId, next);',
    '});',
    'loadedFor.current = userId;',
    'setWatchlist(result);',
    'broadcastWatchlist(userId, result);',
  ].join('\n');
  assert.deepEqual(broadcastProblems(safe), []);
  // The pre-fix shape: each mutator edited its own (possibly placeholder) list.
  const unsafe = [
    'setWatchlist(prev => {',
    '  const next = prev.filter(w => w.show_id !== showId);',
    '  broadcastWatchlist(userId, next);',
    '});',
    'setWatchlist(prev => { const next = [entry, ...prev]; broadcastWatchlist(userId, next); return next; });',
    'setWatchlist(result);',
    'broadcastWatchlist(userId, result);',
  ].join('\n');
  assert.ok(broadcastProblems(unsafe).length >= 2);
});

test('useWatchlist broadcasts only lists known to be the account\'s', () => {
  assert.deepEqual(broadcastProblems(readFileSync(HOOK, 'utf8')), []);
});
