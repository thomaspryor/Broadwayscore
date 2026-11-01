/**
 * Tests for scripts/lib/cross-outlet-pair-policy.js (BRO-6759).
 * Run: node --test scripts/lib/cross-outlet-pair-policy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  sameCritic, classifyCrossOutletPair, declaresProvenance,
} = require('./cross-outlet-pair-policy.js');

const deadlineBody = 'Pay attention to those loud, annoying cicadas, they seem to have a story to tell. '.repeat(6);

// appropriate-2023: the Guardian row holds Deadline's review, with Deadline's own editor's note.
const guardian = {
  outletId: 'guardian', outlet: 'The Guardian', criticName: 'Adrian Horton',
  text: `Editor's Note: Appropriate re-opens on Broadway tonight at the Belasco. The following review was posted on Deadline December 18. ${deadlineBody}`,
};
const deadline = { outletId: 'deadline', outlet: 'Deadline', criticName: 'Greg Evans', text: deadlineBody };

test('Appropriate: the Guardian row that quotes Deadline is the copy, Deadline stays live', () => {
  // Guardian is passed first (the higher tier "primary" the old rule kept).
  const v = classifyCrossOutletPair(guardian, deadline, { similarity: 83 });
  assert.equal(v.action, 'flag');
  assert.equal(v.reason, 'provenance');
  assert.equal(v.copy, 'a', 'the declaring Guardian file is the copy');
  assert.equal(declaresProvenance(deadline, guardian), false);
});

test('sim 49 pair by different critics at unrelated outlets is NOT hidden (la-bete-2010 ny1 vs northjerseycom)', () => {
  const a = { outletId: 'northjerseycom', outlet: 'NorthJersey.com', criticName: 'Robert Feldberg', text: 'Feldberg review body about La Bete.' };
  const b = { outletId: 'ny1', outlet: 'NY1', criticName: 'Roma Torre', text: 'Torre review body about La Bete.' };
  assert.deepEqual(classifyCrossOutletPair(a, b, { similarity: 49 }), { action: 'review', reason: 'different-critics-unverified' });
});

test('different critics at unrelated outlets stay unflagged even at fingerprint-level similarity', () => {
  const a = { outletId: 'bloomberg', outlet: 'Bloomberg', criticName: 'Jeremy Gerard', text: 'Wit review.' };
  const b = { outletId: 'usatoday', outlet: 'USA Today', criticName: 'Elysa Gardner', text: 'Wit review.' };
  assert.equal(classifyCrossOutletPair(a, b, { similarity: 100 }).action, 'review');
});

test('verified families still dedupe: Reuters reprint of Hollywood Reporter (american-idiot-2010, sim 49)', () => {
  const thr = { outletId: 'hollywood-reporter', outlet: 'The Hollywood Reporter', criticName: 'David Rooney', text: 'x' };
  const reuters = { outletId: 'reuters', outlet: 'Reuters', criticName: 'Frank Scheck', text: 'x' };
  assert.deepEqual(classifyCrossOutletPair(thr, reuters, { similarity: 49 }), { action: 'flag', reason: 'verified-family' });
});

test('Tribune Content Agency: Chris Jones (Tribune) vs Joe Dziemianowicz (Daily News) is a verified family', () => {
  const a = { outletId: 'chicagotribune', outlet: 'Chicago Tribune', criticName: 'Chris Jones', text: 'x' };
  const b = { outletId: 'nydailynews', outlet: 'New York Daily News', criticName: 'Joe Dziemianowicz', text: 'x' };
  assert.equal(classifyCrossOutletPair(a, b, { similarity: 78 }).reason, 'verified-family');
});

test('same critic under two outlets (Observer on guardian.com style) still flags', () => {
  const a = { outletId: 'observer', outlet: 'Observer', criticName: 'Susannah Clapp', text: 'x' };
  const b = { outletId: 'guardian', outlet: 'The Guardian', criticName: 'Susannah Clapp', text: 'x' };
  assert.equal(classifyCrossOutletPair(a, b, { similarity: 90 }).reason, 'same-critic');
});

test('sameCritic: spelling variants, slug-style names, middle initials, blanks', () => {
  assert.equal(sameCritic('Aleks Sierz', 'Alex Sierz'), true);
  assert.equal(sameCritic('Rachelrweinberg', 'Rachel Weinberg'), true);
  assert.equal(sameCritic('Douglas Bursch', 'Doug Bursch'), true);
  assert.equal(sameCritic('Mark Kennedy', 'Mark Kemp'), false);
  assert.equal(sameCritic('Adrian Horton', 'Greg Evans'), false);
  assert.equal(sameCritic('Unknown', 'Greg Evans'), false, 'a blank byline is not the same critic, it needs near-identical text');
});

test('bylineless file hides only at near-identical similarity', () => {
  const named = { outletId: 'artsdesk', outlet: 'theartsdesk', criticName: 'Aleks Sierz', text: 'x' };
  const blank = { outletId: 'sierz-co-uk', outlet: 'Sierz', criticName: 'Unknown', text: 'x' };
  assert.equal(classifyCrossOutletPair(named, blank, { similarity: 85 }).action, 'flag');
  assert.equal(classifyCrossOutletPair(named, blank, { similarity: 58 }).action, 'review');
});
