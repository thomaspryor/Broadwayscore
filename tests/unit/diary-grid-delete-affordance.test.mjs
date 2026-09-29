/**
 * Diary grid/list delete-affordance parity test — cousin of the Watchlist
 * grid/list remove-affordance bug (#270). DiaryCard (list view) already
 * renders its delete button in-flow on mobile via `actionIcons`
 * (`md:hidden` block), but DiaryGridCard's own delete button used
 * `hidden sm:flex` — invisible on mobile with no hover fallback, so mobile
 * grid users had no way to delete a rating. Same bug shape, different tab.
 *
 * Regression guard: read the real DiaryGridCard source (grid view) and
 * assert its delete button is never `hidden` and is visible at rest on
 * mobile, only hover/focus-revealed at sm+ — same treatment as
 * WatchlistCard's remove button.
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

const diaryGridCardSrc = extractFunctionBody(SOURCE, 'DiaryGridCard');

/**
 * The delete button's className is `${confirmDelete ? '<confirm-state>' :
 * '<rest-state>'}` — pull the rest-state (else) branch specifically, since
 * that's what governs default visibility (unhovered, untapped).
 */
function restStateClasses(src) {
  const buttonMatch = src.match(
    /confirmDelete \? onDelete\(\) : setConfirmDelete\(true\); \}\}\s*\n\s*className=\{`([^$]*)\$\{confirmDelete \? '([^']+)' : '([^']+)'\}/
  );
  assert.ok(buttonMatch, 'could not locate the diary grid delete button ternary className');
  return { base: buttonMatch[1], restState: buttonMatch[3] };
}

test('diary grid delete button is defined and labeled', () => {
  assert.match(diaryGridCardSrc, /aria-label="Delete rating"/);
});

test('diary grid delete button is not hidden on mobile', () => {
  const { base, restState } = restStateClasses(diaryGridCardSrc);
  const allClasses = `${base} ${restState}`;
  assert.doesNotMatch(allClasses, /\bhidden\b/, 'diary grid delete button must not use `hidden` — that removes it entirely on mobile with no hover fallback');
});

test('diary grid delete button is visible at rest (mobile) and only hover/focus-revealed at sm+', () => {
  const { restState } = restStateClasses(diaryGridCardSrc);
  assert.match(restState, /(?:^|\s)opacity-100(?:\s|$)/, 'must be visible (opacity-100) at rest for mobile, which has no hover');
  assert.match(restState, /sm:opacity-0/, 'must be hover-gated only at sm+ (desktop), not hidden outright');
  assert.match(restState, /sm:group-hover\/grid:opacity-100/, 'must reveal on desktop hover via the group/grid pattern used elsewhere on this card');
  assert.match(restState, /focus-visible:opacity-100/, 'must also reveal on keyboard focus, not just mouse hover');
});
