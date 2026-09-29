/**
 * Watchlist grid/list remove-affordance parity test (UX audit #270): the
 * list view ('mobile__watchlist_list', WatchlistListItem) always renders its
 * remove button, but the grid view ('mobile__watchlist_grid', WatchlistCard)
 * used `hidden sm:flex` on its trash button — invisible below the sm
 * breakpoint with no hover-to-reveal on touch, so mobile grid users had no
 * remove affordance for the same watchlist entries list view exposed.
 *
 * Regression guard: read the real WatchlistCard source (grid view) and
 * assert its remove button is never `hidden` and is visible at rest on
 * mobile (no sm: prefix gating it away), only hover/focus-revealed at sm+ —
 * the same treatment this card's own rate-star strip already uses.
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

const watchlistCardSrc = extractFunctionBody(SOURCE, 'WatchlistCard');
const watchlistListItemSrc = extractFunctionBody(SOURCE, 'WatchlistListItem');

/**
 * The trash button's className is `${confirmRemove ? '<confirm-state>' :
 * '<rest-state>'}` — pull the rest-state (else) branch specifically, since
 * that's what governs default visibility (unhovered, untapped).
 */
function restStateClasses(src) {
  const buttonMatch = src.match(
    /confirmRemove \? onRemove\(\) : setConfirmRemove\(true\); \}\}\s*\n\s*className=\{`([^$]*)\$\{confirmRemove \? '([^']+)' : '([^']+)'\}/
  );
  assert.ok(buttonMatch, 'could not locate the grid remove button ternary className');
  return { base: buttonMatch[1], restState: buttonMatch[3] };
}

test('grid card remove button is defined and labeled', () => {
  assert.match(watchlistCardSrc, /aria-label="Remove from watchlist"/);
});

test('list item remove button is defined and labeled', () => {
  assert.match(watchlistListItemSrc, /aria-label="Remove from watchlist"/);
});

test('grid remove button is not hidden on mobile — visible affordance parity with list view', () => {
  const { base, restState } = restStateClasses(watchlistCardSrc);
  const allClasses = `${base} ${restState}`;
  assert.doesNotMatch(allClasses, /\bhidden\b/, 'grid remove button must not use `hidden` — that removes it entirely on mobile with no hover fallback');
});

test('grid remove button is visible at rest (mobile) and only hover/focus-revealed at sm+', () => {
  const { restState } = restStateClasses(watchlistCardSrc);
  // Same pattern as the card's rate-star strip: opacity-100 by default
  // (mobile has no hover), opacity-0 gated behind sm: and revealed on
  // sm:group-hover or focus, so desktop keeps its hover-only chrome.
  assert.match(restState, /(?:^|\s)opacity-100(?:\s|$)/, 'must be visible (opacity-100) at rest for mobile, which has no hover');
  assert.match(restState, /sm:opacity-0/, 'must be hover-gated only at sm+ (desktop), not hidden outright');
  assert.match(restState, /sm:group-hover\/wl:opacity-100/, 'must reveal on desktop hover via the group/wl pattern used elsewhere on this card');
  assert.match(restState, /focus-visible:opacity-100/, 'must also reveal on keyboard focus, not just mouse hover — a sm:opacity-0 button with no focus-visible fallback is unreachable via keyboard on desktop');
});
