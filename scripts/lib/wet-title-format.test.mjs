import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { extractShowTitle } = createRequire(import.meta.url)('../scrape-westendtheatre-roundups.js');
// BRO-7931 #3: "X Reviews - Venue" must reduce to the bare show title.
const cases = [
  ['Ballet Shoes Reviews - Lyttelton Theatre', 'Ballet Shoes'],
  ['Kyoto Reviews – Donmar Warehouse', 'Kyoto'],
  ['The Price Reviews — Wyndham&#8217;s Theatre', 'The Price'],
  ['Hamilton Reviews Round-up – Victoria Palace', 'Hamilton'],   // old format unchanged
  ['Reviews Roundup: Cats', 'Cats'],                              // old prefix unchanged
];
for (const [t, want] of cases) test(t, () => assert.equal(extractShowTitle(t), want));
