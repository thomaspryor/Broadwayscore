/**
 * Diary grid delete affordance. UX audit #270 once found the grid card's
 * delete hidden on phones (`hidden sm:flex`), leaving mobile grid users no
 * way to delete a rating. The fix made it always visible, which on phones
 * meant a 44px trash circle covering a third of every poster.
 *
 * Owner, 2026-10-03 (BRO-4558): no buttons on the poster at all; delete by
 * clicking into the show. Regression guard: poster grid cards render no
 * buttons, the diary grid card links to the show page, and the show page's
 * rating editor offers Delete. List view keeps its inline delete.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const SOURCE = read('src/app/my-shows/MyShowsClient.tsx');
const CARDS = read('src/components/user/upcoming-cards.tsx');
const HERO = read('src/components/show-page/ShowHeroRedesign.tsx');

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

test('poster grid cards carry no buttons on the poster', () => {
  const grid = extractFunctionBody(CARDS, 'PosterGridCard');
  assert.doesNotMatch(grid, /<button\b/, 'no corner delete/edit buttons on posters (owner, 2026-10-03)');
  assert.doesNotMatch(grid, /onRemove|onEdit|onDelete/, 'PosterGridCard takes no remove/edit/delete handler');
  for (const name of ['DiaryGridCard', 'WatchlistCard', 'ToBeRatedSection']) {
    const body = extractFunctionBody(SOURCE, name);
    assert.doesNotMatch(body, /aria-label=\{?["'`](?:Delete|Remove)/, `${name} must not put a delete/remove button on the poster`);
  }
});

test('diary grid card opens the show page', () => {
  const card = extractFunctionBody(SOURCE, 'DiaryGridCard');
  assert.match(card, /href=\{href\}/);
  assert.match(card, /const href = getShowHref\(/);
});

test('the show page rating editor offers Delete', () => {
  assert.match(HERO, /onDelete=\{editingReview \? handleDeleteRating : undefined\}/,
    'with no trash can on grid posters, the show page is where a rating gets deleted');
  assert.match(HERO, /await deleteReview\(editingReview\.id\)/);
});

test('list view keeps its inline Delete rating', () => {
  assert.match(extractFunctionBody(SOURCE, 'DiaryCard'), /aria-label="Delete rating"/);
});
