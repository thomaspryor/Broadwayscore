/**
 * Watchlist grid delete-icon contrast test (UX audit: destructive actions not
 * clearly differentiated — the desktop watchlist grid's trash icon rendered
 * in the same neutral gray as the card's other icons (calendar/star) until
 * hovered, so a signed-in user scanning the grid couldn't tell it apart from
 * non-destructive controls).
 *
 * Regression guard: read the real WatchlistCard source (grid view) and
 * assert its remove button uses a destructive (score-skip/red) tint at rest,
 * not the neutral gray shared by the card's other icons.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(join(ROOT, 'src/app/my-shows/MyShowsClient.tsx'), 'utf8');

/**
 * Isolate one top-level `function Name(...) { ... }` block. The prop
 * destructuring often carries an inline `{ ... }` type annotation, so we
 * first skip past the parameter list by paren-depth (not brace-depth) before
 * brace-counting the actual function body.
 */
function extractFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in MyShowsClient.tsx`);
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

// WatchlistCard is the grid-view card (desktop__watchlist_grid) — distinct
// from WatchlistListItem (list view) and ToBeRatedCard, which share the same
// aria-label but aren't in scope for this finding.
const watchlistCardSrc = extractFunctionBody(SOURCE, 'WatchlistCard');

test('grid card remove button is defined and labeled', () => {
  assert.match(watchlistCardSrc, /aria-label="Remove from watchlist"/);
});

/**
 * The trash button's className is `${confirmRemove ? '<confirm-state>' :
 * '<rest-state>'}` — pull the rest-state (else) branch specifically, since
 * that's what a user sees on hover before tapping.
 */
function restStateClasses(src) {
  const buttonMatch = src.match(
    /confirmRemove \? onRemove\(\) : setConfirmRemove\(true\); \}\}\s*\n\s*className=\{`[^$]*\$\{confirmRemove \? '([^']+)' : '([^']+)'\}/
  );
  assert.ok(buttonMatch, 'could not locate the grid remove button ternary className');
  return buttonMatch[2]; // else-branch = rest state
}

test('grid remove-button rest-state tint is destructive (score-skip), not neutral gray', () => {
  const restState = restStateClasses(watchlistCardSrc);
  assert.match(restState, /text-score-skip/, 'rest-state icon color must use the destructive score-skip token');
  assert.doesNotMatch(restState, /text-gray-400/, 'rest-state icon must not fall back to the neutral gray shared by other card icons');
});

test('grid remove-button color is distinct from the card\'s other icon colors (calendar, stars)', () => {
  // DatePickerButton (calendar icon) and the star-rating strip both render at
  // the neutral gray-400 / amber tiers within this same card — the trash
  // icon must not match either so it reads as destructive at a glance.
  const restState = restStateClasses(watchlistCardSrc);
  const trashColorToken = restState.match(/text-[\w-]+(?:\/\d+)?/)[0].replace(/\/\d+$/, '');

  assert.notEqual(trashColorToken, 'text-gray-400');
  assert.notEqual(trashColorToken, 'text-amber-400');
});
