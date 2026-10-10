/**
 * Unit tests for the shared strict Category-A cross-market contamination
 * predicate (scripts/lib/cross-market-contamination.js) — the single source of
 * truth used by BOTH audit-review-contamination.js (the zero-tolerance CI gate)
 * and fix-circular-duplicate-pairs.js (canonical selection). Keeping the
 * predicate in one place is what stops the two from drifting; these tests pin
 * its boundaries so a threshold change is caught here rather than in prod.
 *
 * Run: node --test tests/unit/cross-market-contamination.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyClassAContamination, normalizeShowTitle, buildSiblingOpeningsMap,
  NEAR_SIBLING_DAYS, FAR_OWN_SHOW_DAYS,
} = require('../../scripts/lib/cross-market-contamination.js');
const { parseDate } = require('../../scripts/lib/date-utils.js');

const d = (s) => parseDate(s);

// --- classifyClassAContamination boundaries -------------------------------
test('the 2026-07-12 incident: Mar-20-2025 review under a 2024 WE folder with a Broadway sibling opening Mar-20-2025 is class-A', () => {
  const v = classifyClassAContamination(d('March 20, 2025'), d('2024-05-01'), [d('2025-03-20')]);
  assert.equal(v.isClassA, true);
  assert.equal(v.sibIndex, 0);
});

test('a review dated near its OWN show opening is never class-A (even with a distant sibling)', () => {
  const v = classifyClassAContamination(d('2024-05-03'), d('2024-05-01'), [d('2025-03-20')]);
  assert.equal(v.isClassA, false);
});

test('no siblings → cannot be class-A', () => {
  assert.equal(classifyClassAContamination(d('2025-03-20'), d('2024-05-01'), []).isClassA, false);
});

test('sibling far (>30d) from the review date → not class-A even if far from own show', () => {
  // review 400d from own opening, but nearest sibling opening is 60d away.
  const v = classifyClassAContamination(d('2025-06-01'), d('2024-04-27'), [d('2025-04-01')]);
  assert.equal(v.sibDiff > NEAR_SIBLING_DAYS, true);
  assert.equal(v.isClassA, false);
});

test('exactly on the boundaries: sibling ==30d AND own ==181d qualifies; own ==180d does not', () => {
  const sib = d('2025-03-20');
  // pub 30d after sibling opening.
  const pub = new Date(+sib + NEAR_SIBLING_DAYS * 86400000);
  // own opening exactly FAR+1 days before pub → thisDiff = 181 > 180 → class-A.
  const ownFar = new Date(+pub - (FAR_OWN_SHOW_DAYS + 1) * 86400000);
  assert.equal(classifyClassAContamination(pub, ownFar, [sib]).isClassA, true);
  // own opening exactly FAR days before pub → thisDiff = 180, NOT > 180 → clean.
  const ownEdge = new Date(+pub - FAR_OWN_SHOW_DAYS * 86400000);
  assert.equal(classifyClassAContamination(pub, ownEdge, [sib]).isClassA, false);
});

test('symmetry: two members sharing a URL+publishDate are both class-A (the mutual-pair case)', () => {
  const pub = d('March 20, 2025'), own = d('2024-05-01'), sibs = [d('2025-03-20')];
  const a = classifyClassAContamination(pub, own, sibs);
  const b = classifyClassAContamination(pub, own, sibs);
  assert.equal(a.isClassA, true);
  assert.equal(b.isClassA, true);
});

test('missing / unparseable dates are treated as not-contaminated (never a false gate red)', () => {
  assert.equal(classifyClassAContamination(null, d('2024-05-01'), [d('2025-03-20')]).isClassA, false);
  assert.equal(classifyClassAContamination(d('2025-03-20'), null, [d('2025-03-20')]).isClassA, false);
  assert.equal(classifyClassAContamination(d('not a date'), d('2024-05-01'), [d('2025-03-20')]).isClassA, false);
  assert.equal(classifyClassAContamination(d('2025-03-20'), d('2024-05-01'), [null, 'nope']).isClassA, false);
});

// --- normalizeShowTitle + buildSiblingOpeningsMap -------------------------
test('normalizeShowTitle strips terminal punctuation so Op Mincemeat! == Op Mincemeat', () => {
  assert.equal(normalizeShowTitle('Operation Mincemeat!'), normalizeShowTitle('operation mincemeat'));
});

test('buildSiblingOpeningsMap groups same-title shows (different ids) and excludes self', () => {
  const m = buildSiblingOpeningsMap([
    { id: 'om-we-2024', title: 'Operation Mincemeat!', openingDate: '2024-05-01' },
    { id: 'om-bway-2025', title: 'Operation Mincemeat', openingDate: '2025-03-20' },
    { id: 'unrelated', title: 'Some Other Play', openingDate: '2025-01-01' },
  ], parseDate);
  assert.equal(m.get('om-we-2024').length, 1, 'WE run sees exactly its Broadway sibling');
  assert.equal(new Date(m.get('om-we-2024')[0]).toISOString().slice(0, 10), '2025-03-20');
  assert.equal(m.get('unrelated').length, 0, 'a unique-title show has no siblings');
});
