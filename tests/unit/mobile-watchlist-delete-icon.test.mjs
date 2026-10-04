/**
 * BRO-4046: My Shows delete/remove icons used the same neutral gray as the
 * non-destructive icons beside them (text-gray-600 hover:text-red-400).
 * Every remove/delete button on the page now rests in the destructive
 * score-skip token (design-system.md: status danger = score-skip).
 *
 * This sweeps every remove/delete icon button in MyShowsClient so a new one
 * cannot ship gray.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Poster grid cards carry no buttons at all (BRO-4558); see
// diary-grid-delete-affordance.test.mjs.
const SOURCE = readFileSync(join(ROOT, 'src/app/my-shows/MyShowsClient.tsx'), 'utf8');

/** Opening-tag text of every <button> whose aria-label starts Delete/Remove. */
function destructiveButtons() {
  const out = [];
  const re = /aria-label=(?:"(?:Delete|Remove)[^"]*"|\{label\})/g;
  let m;
  while ((m = re.exec(SOURCE))) {
    const start = SOURCE.lastIndexOf('<button', m.index);
    const ends = [SOURCE.indexOf('<svg', m.index), SOURCE.indexOf('</button>', m.index)].filter((i) => i > 0);
    const line = SOURCE.slice(0, m.index).split('\n').length;
    out.push({ line, label: m[0], tag: SOURCE.slice(start, Math.min(...ends)) });
  }
  return out;
}

test('finds every remove/delete button (guards the scan itself)', () => {
  // RowRemoveButton, DiaryCard and WatchlistListItem.
  assert.ok(destructiveButtons().length >= 3, `expected at least 3, found ${destructiveButtons().length}`);
});

test('every remove/delete icon rests in the destructive score-skip token', () => {
  for (const { line, label, tag } of destructiveButtons()) {
    assert.match(tag, /text-score-skip\/80/, `line ${line} ${label}: rest-state icon must use text-score-skip/80`);
    assert.match(tag, /hover:text-score-skip\b/, `line ${line} ${label}: hover must deepen to text-score-skip`);
    assert.doesNotMatch(tag, /text-gray-600/, `line ${line} ${label}: neutral gray is the bug this guards`);
    assert.doesNotMatch(tag, /hover:text-red-400/, `line ${line} ${label}: use the score-skip token, not raw red`);
  }
});
