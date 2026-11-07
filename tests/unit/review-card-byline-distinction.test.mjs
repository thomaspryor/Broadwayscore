// BRO-7024: the critic byline must stay visually distinct from the pull quote.
// Compact layout (owner pick 2026-11-06): the byline runs in at the end of the
// quote as muted, smaller "— Name", and Full Review is an icon link in the
// header row. This guards the structure so a refactor cannot put the byline
// back on its own full-size row under the quote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/components/ReviewsList.tsx', import.meta.url), 'utf8');

test('byline is a muted, smaller run-in span', () => {
  const m = src.match(/const attribution = \(\s*<span className="([^"]+)">/);
  assert.ok(m, 'attribution span exists');
  assert.match(m[1], /text-xs/, 'smaller than the quote (text-sm)');
  assert.match(m[1], /text-fg-muted/, 'muted color, not the quote color');
});

test('the dash is decorative and the name keeps a screen-reader "By"', () => {
  assert.match(src, /<span aria-hidden="true">&mdash; <\/span>/);
  assert.match(src, /<span className="sr-only">By <\/span>/);
});

test('every quote paragraph carries the byline inline', () => {
  const paras = [...src.matchAll(/<p className="text-sm sm:text-base [^"]*">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  assert.ok(paras.length >= 3, 'quote, summary and pullQuote paragraphs');
  for (const body of paras) assert.match(body, /\{attribution\}/);
});

test('no separate byline row and no text "Full Review" link', () => {
  assert.doesNotMatch(src, /By \{featureFlags\.criticPages/);
  assert.doesNotMatch(src, />\s*Full Review\s*</);
  assert.match(src, /aria-label=\{`Read full review from/);
});
