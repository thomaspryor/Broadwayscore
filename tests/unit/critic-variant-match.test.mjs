/**
 * BRO-6928: critic pages split by spelling variants. Exercises the real matcher
 * (scripts/lib/critic-variant-match.js) on pairs taken from live data.
 * Run: node --test tests/unit/critic-variant-match.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyVariantPair } = require('../../scripts/lib/critic-variant-match.js');
const { findSplitPairs, buildPages } = require('../../scripts/audit-critic-splits.js');

const pg = (name, count, ...outlets) => ({ name, count, outlets });

test('real splits merge', () => {
  const cases = [
    [pg('Andrjez Lukowski', 1, 'Time Out London'), pg('Andrzej Lukowski', 371, 'Time Out London')],
    [pg('David Fargnoli', 1, 'Stage Left'), pg('Dave Fargnoli', 30, 'Stage Left')],
    [pg('Chris Caggiano', 15, 'Dc Metro'), pg('Christopher Caggiano', 12, 'Dc Metro')],
    [pg('Jospeh Verlezza', 1, 'Theatre Reviews Limited'), pg('Joseph Verlezza', 40, 'Theatre Reviews Limited')],
    [pg('Erickson Elisabeth Vincentelli', 1, 'X'), pg('Elisabeth Vincentelli', 200, 'Y')],
  ];
  for (const [a, b] of cases) assert.equal(classifyVariantPair(a, b).verdict, 'merge', `${a.name} / ${b.name}`);
});

test('different people stay apart', () => {
  const cases = [
    [pg('Stu Brown', 40, 'A'), pg('Scott Brown', 300, 'B')],
    [pg('Breanne J Heldman', 20, 'A'), pg('Breanne L Heldman', 20, 'A')],
    [pg('Marina Kennedy', 8, 'A'), pg('Mark Kennedy', 80, 'B')],
    // name match but no shared outlet: a human decides (review found these were two people)
    [pg('Simon Thomson', 1, 'City A.M.'), pg('Simon Thompson', 16, 'WhatsOnStage')],
    [pg('Jess Green', 1, 'Musical Theatre Review'), pg('Jesse Green', 400, 'New York Times')],
    [pg('Erin Grode', 1, 'A'), pg('Eric Grode', 50, 'B')],
    [pg('Jane Roberts', 3, 'A'), pg('Jane Robertson', 40, 'B')],
  ];
  for (const [a, b] of cases) assert.notEqual(classifyVariantPair(a, b).verdict, 'merge', `${a.name} / ${b.name}`);
});

test('confirmed-distinct pairs are never flagged', () => {
  const r = classifyVariantPair(pg('Marian Kennedy', 3, 'A'), pg('Marina Kennedy', 8, 'A'),
    { distinct: new Set(['marian-kennedy|marina-kennedy']) });
  assert.equal(r.verdict, 'distinct');
});

test('joint bylines are sent to review, not merged', () => {
  const r = classifyVariantPair(pg('Barry Gordin and Patrick Christiano', 31, 'A'), pg('Patrick Christiano', 22, 'A'));
  assert.equal(r.verdict, 'review');
});

test('findSplitPairs on reviews finds the straggler', () => {
  const rv = (criticName, outlet) => ({ criticName, outlet });
  const rows = [rv('Dave Fargnoli', 'S'), rv('Dave Fargnoli', 'S'), rv('Dave Fargnoli', 'S'),
    ...Array(30).fill(rv('Dave Fargnoli', 'S')), rv('David Fargnoli', 'S')];
  const pairs = findSplitPairs(buildPages(rows));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].verdict, 'merge');
  assert.equal(pairs[0].canonical.slug, 'dave-fargnoli');
});
