// BRO-7140 review: the phone rating must tell a screen reader what the number is,
// without changing the visible text (rating-beside-date.test.mjs pins that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every phone rating span labels its rating for screen readers', () => {
  const src = readFileSync(new URL('../../src/components/ReviewsList.tsx', import.meta.url), 'utf8');
  const lines = src.split('\n').filter((l) => l.includes('review-original-rating-mobile'));
  assert.ok(lines.length >= 2, 'expected the byline and the no-date variants');
  for (const l of lines) assert.match(l, /aria-label=\{`Rated \$\{rating\}`\}/);
});
