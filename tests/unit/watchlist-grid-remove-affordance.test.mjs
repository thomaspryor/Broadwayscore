/**
 * Watchlist grid remove affordance. UX audit #270 once found the grid
 * card's trash hidden on phones (`hidden sm:flex`), so mobile grid users
 * had no way to remove an entry. The fix made it always visible, which on
 * phones meant a 44px circle covering every poster.
 *
 * Owner, 2026-10-03 (BRO-4558): no buttons on the poster; remove by
 * clicking into the show. Regression guard: watchlist and To Be Rated
 * cards link to the show page, whose watchlist button removes the entry;
 * list view keeps its inline remove. (diary-grid-delete-affordance.test.mjs
 * guards that poster cards carry no buttons.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const SOURCE = read('src/app/my-shows/MyShowsClient.tsx');
const SHOW_PAGE_BUTTON = read('src/components/user/ShowPageWatchlistButton.tsx');

/**
 * Isolate one top-level `function Name(...) { ... }` block. The prop
 * destructuring often carries an inline `{ ... }` type annotation, so we
 * first skip past the parameter list by paren-depth (not brace-depth) before
 * brace-counting the actual function body.
 */
function extractFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found`);
  const parenListStart = source.indexOf('(', start);

  let parenDepth = 0;
  let paramsEnd = -1;
  for (let i = parenListStart; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    else if (source[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) { paramsEnd = i; break; }
    }
  }
  assert.ok(paramsEnd !== -1, `unbalanced parens scanning function ${name} params`);

  const braceStart = source.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces scanning function ${name} body`);
}

test('watchlist grid card opens the show page', () => {
  const card = extractFunctionBody(SOURCE, 'WatchlistCard');
  assert.match(card, /const href = getShowHref\(/);
  assert.match(card, /href=\{href\}/);
});

test('To Be Rated card opens the show page rating flow', () => {
  assert.match(extractFunctionBody(SOURCE, 'ToBeRatedSection'), /href=\{`\$\{href\}\?rate=1`\}/);
});

test('the show page watchlist button removes the entry', () => {
  assert.match(SHOW_PAGE_BUTTON, /await removeFromWatchlist\(showId\)/);
});

test('list item remove button is defined and labeled', () => {
  assert.match(extractFunctionBody(SOURCE, 'WatchlistListItem'), /aria-label="Remove from watchlist"/);
});
