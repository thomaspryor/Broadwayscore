/**
 * Regression tests for BRO-2409: cycle-clear leaves same-URL review clusters
 * fully unsuppressed (no duplicateOf/duplicateTextOf pointer on ANY member),
 * so rebuild-all-reviews.js double-counts the article; plus the missing
 * placeholder-byline canonical rule for that class.
 *
 * Covers:
 *   1. findFullyUnsuppressedSameUrlGroups (pure) — detects the "zero pointer"
 *      class and ignores anything an existing pointer already resolves.
 *   2. chooseSameUrlCanonical (pure, chooseCanonicalFn injected) — folds
 *      fix-circular-duplicate-pairs.js's real chooseCanonical across a group,
 *      so a placeholder byline (card #1907's "The Times" outlet-name-as-
 *      byline shape) never survives as canonical alongside a real critic.
 *   3. Regression fixture matching the live the-winslow-boy-2013 corpus shape
 *      (two named critics, one shared URL, neither field ever set).
 *
 * Run: node --test tests/unit/suppression-logic.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findFullyUnsuppressedSameUrlGroups,
  chooseSameUrlCanonical,
  canonicalUrl,
  outletKeyOf,
} = require('../../scripts/lib/suppression-logic.js');
const { chooseCanonical } = require('../../scripts/fix-circular-duplicate-pairs.js');

const body = (n) => 'x'.repeat(n);
const URL = 'https://www.nytimes.com/2013/10/18/theater/reviews/the-winslow-boy-is-revived.html';

// ---------------------------------------------------------------------------
// canonicalUrl / outletKeyOf
// ---------------------------------------------------------------------------
test('canonicalUrl: strips query/hash/trailing slash, lowercases', () => {
  assert.equal(canonicalUrl('https://X.com/a/?utm=1#frag'), 'https://x.com/a');
  assert.equal(canonicalUrl('https://x.com/a/'), 'https://x.com/a');
  assert.equal(canonicalUrl(null), '');
  assert.equal(canonicalUrl(''), '');
});

test('outletKeyOf: prefers filename outlet prefix over free-text outlet field', () => {
  assert.equal(outletKeyOf('nytimes--ben-brantley.json', { outlet: 'The New York Times' }), 'nytimes');
  assert.equal(outletKeyOf('no-separator.json', { outletId: 'nytimes' }), 'nytimes');
  assert.equal(outletKeyOf('no-separator.json', { outlet: 'Variety' }), 'variety');
});

// ---------------------------------------------------------------------------
// findFullyUnsuppressedSameUrlGroups
// ---------------------------------------------------------------------------
test('findFullyUnsuppressedSameUrlGroups: flags a same-URL pair with ZERO pointers on either side', () => {
  const records = [
    { file: 'nytimes--ben-brantley.json', data: { url: URL, criticName: 'Ben Brantley' } },
    { file: 'nytimes--charles-isherwood.json', data: { url: URL, criticName: 'Charles Isherwood' } },
  ];
  const groups = findFullyUnsuppressedSameUrlGroups(records);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].outlet, 'nytimes');
  assert.equal(groups[0].url, canonicalUrl(URL));
  assert.deepEqual(groups[0].members.map((m) => m.file).sort(), [
    'nytimes--ben-brantley.json', 'nytimes--charles-isherwood.json',
  ]);
});

test('findFullyUnsuppressedSameUrlGroups: NOT flagged when one member already points at the other (duplicateOf)', () => {
  const records = [
    { file: 'a--x.json', data: { url: URL, duplicateOf: 'a--y.json' } },
    { file: 'a--y.json', data: { url: URL } },
  ];
  assert.deepEqual(findFullyUnsuppressedSameUrlGroups(records), []);
});

test('findFullyUnsuppressedSameUrlGroups: NOT flagged when the pointer is duplicateTextOf', () => {
  const records = [
    { file: 'a--x.json', data: { url: URL } },
    { file: 'a--y.json', data: { url: URL, duplicateTextOf: 'a--x.json' } },
  ];
  assert.deepEqual(findFullyUnsuppressedSameUrlGroups(records), []);
});

test('findFullyUnsuppressedSameUrlGroups: a pointer aimed OUTSIDE the group does not resolve it', () => {
  const records = [
    { file: 'a--x.json', data: { url: URL, duplicateOf: 'a--stale-deleted-sibling.json' } },
    { file: 'a--y.json', data: { url: URL } },
  ];
  const groups = findFullyUnsuppressedSameUrlGroups(records);
  assert.equal(groups.length, 1);
});

test('findFullyUnsuppressedSameUrlGroups: self-referential pointer does not count as internal resolution', () => {
  const records = [
    { file: 'a--x.json', data: { url: URL, duplicateOf: 'a--x.json' } },
    { file: 'a--y.json', data: { url: URL } },
  ];
  const groups = findFullyUnsuppressedSameUrlGroups(records);
  assert.equal(groups.length, 1);
});

test('findFullyUnsuppressedSameUrlGroups: different outlets on the same URL are separate groups, not merged', () => {
  const records = [
    { file: 'nytimes--a.json', data: { url: URL } },
    { file: 'nytimes--b.json', data: { url: URL } },
    { file: 'vulture--c.json', data: { url: URL } },
  ];
  const groups = findFullyUnsuppressedSameUrlGroups(records);
  assert.equal(groups.length, 1); // only nytimes has 2+
  assert.equal(groups[0].outlet, 'nytimes');
});

test('findFullyUnsuppressedSameUrlGroups: a single file sharing no URL with anyone is never a group', () => {
  const records = [{ file: 'a--x.json', data: { url: URL } }];
  assert.deepEqual(findFullyUnsuppressedSameUrlGroups(records), []);
});

test('findFullyUnsuppressedSameUrlGroups: 3-member group with no internal pointers flags all 3', () => {
  const records = [
    { file: 'whatsonstage--alex-wood.json', data: { url: URL } },
    { file: 'whatsonstage--miriam-sallon.json', data: { url: URL } },
    { file: 'whatsonstage--sarah-crompton.json', data: { url: URL } },
  ];
  const groups = findFullyUnsuppressedSameUrlGroups(records);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 3);
});

// ---------------------------------------------------------------------------
// chooseSameUrlCanonical — the placeholder-byline canonical rule (card #1907
// half of BRO-2409's title), using the REAL chooseCanonical.
// ---------------------------------------------------------------------------
test('chooseSameUrlCanonical: a placeholder byline (outlet-name-as-byline) never survives over a real critic', () => {
  const members = [
    { file: 'times-uk--the-times.json', data: { url: URL, criticName: 'The Times', outlet: 'The Times (UK)', fullText: body(2000) } },
    { file: 'times-uk--clive-davis.json', data: { url: URL, criticName: 'Clive Davis', outlet: 'The Times (UK)', fullText: body(2000) } },
  ];
  const verdict = chooseSameUrlCanonical(members, chooseCanonical);
  assert.equal(verdict.canonical, 'times-uk--clive-davis.json');
  assert.deepEqual(verdict.losers, ['times-uk--the-times.json']);
});

test('chooseSameUrlCanonical: placeholder rule holds regardless of filename lexical order', () => {
  // "aardvark" would win a pure lexicographic tiebreak — the placeholder rule
  // must dominate that, not just happen to agree with it.
  const members = [
    { file: 'times-uk--aardvark-placeholder.json', data: { url: URL, criticName: 'The Times', outlet: 'The Times (UK)' } },
    { file: 'times-uk--clive-davis.json', data: { url: URL, criticName: 'Clive Davis', outlet: 'The Times (UK)' } },
  ];
  const verdict = chooseSameUrlCanonical(members, chooseCanonical);
  assert.equal(verdict.canonical, 'times-uk--clive-davis.json');
});

test('chooseSameUrlCanonical: N-way fold picks the one real byline among several placeholders', () => {
  const members = [
    { file: 'whatsonstage--staff.json', data: { url: URL, criticName: 'Staff', outlet: 'WhatsOnStage' } },
    { file: 'whatsonstage--unknown.json', data: { url: URL, criticName: 'Unknown', outlet: 'WhatsOnStage' } },
    { file: 'whatsonstage--miriam-sallon.json', data: { url: URL, criticName: 'Miriam Sallon', outlet: 'WhatsOnStage' } },
  ];
  const verdict = chooseSameUrlCanonical(members, chooseCanonical);
  assert.equal(verdict.canonical, 'whatsonstage--miriam-sallon.json');
  assert.equal(verdict.losers.length, 2);
});

test('chooseSameUrlCanonical: two real named critics (the-winslow-boy-2013 shape) — deterministic single survivor, order-independent', () => {
  const a = { file: 'nytimes--ben-brantley.json', data: { url: URL, criticName: 'Ben Brantley', fullText: body(3000) } };
  const b = { file: 'nytimes--charles-isherwood.json', data: { url: URL, criticName: 'Charles Isherwood', fullText: body(3000) } };
  const forward = chooseSameUrlCanonical([a, b], chooseCanonical);
  const reversed = chooseSameUrlCanonical([b, a], chooseCanonical);
  assert.equal(forward.canonical, reversed.canonical);
  assert.equal(forward.losers.length, 1);
  assert.notEqual(forward.canonical, forward.losers[0]);
});

test('chooseSameUrlCanonical: reason reflects why the winner first won, not whichever comparison ran last', () => {
  // 3-way fold: winner beats challenger #1 for reason A (winner stays winner),
  // then beats challenger #2 for reason B (winner stays winner again). The
  // returned reason must be A — the reason the winner is written into the
  // on-disk duplicateReason audit trail must describe an ACTUAL basis for its
  // standing, not just whichever pairwise comparison happened to run last.
  const members = [
    { file: 'a--x.json', data: {} },
    { file: 'b--y.json', data: {} },
    { file: 'c--z.json', data: {} },
  ];
  const fakeChooser = (aName, aData, bName, bData) => {
    // fold order is filename-sorted: a--x.json vs b--y.json first, then
    // (a--x.json, the still-standing winner) vs c--z.json.
    if (aName === 'a--x.json' && bName === 'b--y.json') {
      return { canonical: 'a--x.json', loser: 'b--y.json', reason: 'reason-A' };
    }
    return { canonical: 'a--x.json', loser: 'c--z.json', reason: 'reason-B' };
  };
  const verdict = chooseSameUrlCanonical(members, fakeChooser);
  assert.equal(verdict.canonical, 'a--x.json');
  assert.equal(verdict.reason, 'reason-A');
});

test('chooseSameUrlCanonical: reason updates when the winner actually changes mid-fold', () => {
  const members = [
    { file: 'a--x.json', data: {} },
    { file: 'b--y.json', data: {} },
    { file: 'c--z.json', data: {} },
  ];
  const fakeChooser = (aName, aData, bName, bData) => {
    if (aName === 'a--x.json' && bName === 'b--y.json') {
      return { canonical: 'a--x.json', loser: 'b--y.json', reason: 'reason-A' };
    }
    // a--x.json vs c--z.json — the challenger wins this time.
    return { canonical: 'c--z.json', loser: 'a--x.json', reason: 'reason-C-takeover' };
  };
  const verdict = chooseSameUrlCanonical(members, fakeChooser);
  assert.equal(verdict.canonical, 'c--z.json');
  assert.equal(verdict.reason, 'reason-C-takeover');
});

test('chooseSameUrlCanonical: propagates a skip verdict (e.g. cross-market both-contaminated) instead of forcing a winner', () => {
  const members = [
    { file: 'a--x.json', data: { url: URL } },
    { file: 'a--y.json', data: { url: URL } },
  ];
  const skippingChooser = () => ({ canonical: null, loser: null, reason: 'both class-A contaminated', skip: true });
  const verdict = chooseSameUrlCanonical(members, skippingChooser);
  assert.equal(verdict.skip, true);
  assert.equal(verdict.canonical, null);
  assert.deepEqual(verdict.losers, []);
});

test('chooseSameUrlCanonical: throws without a chooseCanonicalFn (no silent fallback ranking)', () => {
  const members = [{ file: 'a--x.json', data: { url: URL } }, { file: 'a--y.json', data: { url: URL } }];
  assert.throws(() => chooseSameUrlCanonical(members), TypeError);
});

test('chooseSameUrlCanonical: empty input is a no-op, not a throw', () => {
  assert.deepEqual(chooseSameUrlCanonical([], chooseCanonical), { canonical: null, losers: [], reason: null });
});
