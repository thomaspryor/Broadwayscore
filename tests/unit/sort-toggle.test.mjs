// BRO-2762: fixed-order sort buttons (Default/custom, Newest, ...) can't be
// reversed, so clicking one while active is a no-op by design. Each must say
// so via its tooltip instead of looking dead. Tests the real helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSortToggle } = require('../../src/lib/sort-toggle');
const t = createSortToggle({ score: 'score_asc', alpha: 'alpha_desc' });

test('fixed-order sorts get a state-specific title', () => {
  for (const v of ['custom', 'newest', 'oldest', 'closing', 'performances']) {
    assert.equal(t.getFixedSortTitle(v, v, 'X'), 'Sorted by X');
    assert.equal(t.getFixedSortTitle(v, 'score', 'X'), 'Click to sort by X');
    assert.equal(t.getNextSort(v, v), v);
  }
});

test('reversible sorts leave the title to the caller', () => {
  assert.equal(t.getFixedSortTitle('score', 'score', 'Critics'), undefined);
  assert.equal(t.getFixedSortTitle('alpha', 'alpha_desc', 'A-Z'), undefined);
});

test('BrowseListClient wires the helper into the option title', () => {
  const src = readFileSync(new URL('../../src/components/BrowseListClient.tsx', import.meta.url), 'utf8');
  assert.match(src, /getFixedSortTitle\(\s*s,\s*sort,\s*sortLabels\[s\]\s*\)/);
});
