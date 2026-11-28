// BRO-8217 class guard: a joint credit of known critics must never be reported as a split of either author
// (cards BRO-7222/7855/8143 each hand-patched one such pair after the live gate failed). Pure synthetic input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPages, findSplitPairs } = require('../../scripts/audit-critic-splits.js');

const rv = (criticName, outlet = 'The Times', n = 1) => Array.from({ length: n }, () => ({ criticName, outlet }));
const keys = (reviews) => findSplitPairs(buildPages(reviews), { distinct: new Set() }).map(p => p.key);

test('joint byline of two known critics yields no split pair', () => {
  const reviews = [...rv('Jane Edwardes', 'Sunday Times', 18), ...rv('Thomas W. Hodgkinson', 'Sunday Times', 4), ...rv('Jane Edwardes, Thomas W Hodgkinson')];
  assert.deepEqual(keys(reviews).filter(k => k.includes('hodgkinson') || k.includes('edwardes')), []);
});

test('"and" and "&" joint credits are also recognised', () => {
  const reviews = [...rv('Dan Dinero', 'X', 5), ...rv('Molly Marinik', 'X', 5), ...rv('Dan Dinero & Molly Marinik', 'X')];
  assert.deepEqual(keys(reviews), []);
});

test('garbled tail with an unknown part stays reported', () => {
  const reviews = [...rv('Rick Mauch', 'X', 20), ...rv('Rick Mauch and Photo by Matthew Murphy', 'X')];
  assert.ok(keys(reviews).length > 0);
});

test('a genuine typo still reports', () => {
  const reviews = [...rv('Marilyn Stasio', 'Variety', 20), ...rv('Marylin Stasio', 'Variety')];
  assert.ok(keys(reviews).length > 0);
});

test('slash joint credit is recognised; Anderson / "Jr." names are not split', () => {
  assert.deepEqual(keys([...rv('Sara Holdren', 'X', 5), ...rv('Jackson McHenry', 'X', 5), ...rv('Sara Holdren/Jackson McHenry', 'X')]), []);
  const { jointParts } = require('../../scripts/audit-critic-splits.js');
  assert.equal(jointParts('Jason Anderson'), null);
  assert.equal(jointParts('Peter Marks, Jr.'), null);
});
