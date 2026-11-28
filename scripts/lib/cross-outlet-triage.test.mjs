// BRO-7391 CLASS-GUARD (cross-outlet attribution drift; cards BRO-6860, BRO-6976,
// BRO-7038, BRO-8038). Pure fixtures shaped like the real cases, so the guard runs
// in test.yml's blocking lib batch without the private corpus.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isTriagedOut, hasApprovedCriticName } = require('./cross-outlet-triage.js');
const { buildEvidencedDefaultHomes } = require('./default-critic-home.js');
const { approvedFixBinding } = require('./approved-fix-flag.js');

const noExclusion = () => null;

test('BRO-8038 wicked shape: an approved criticName plan counts as verified triage', () => {
  const d = { criticName: 'Peter Filichia', outletId: 'theatermania', url: 'https://x/a', fullText: 'body',
    approvedFixes: [{ fixId: 'fc2f07f3', field: 'criticName', newValue: 'Peter Filichia' }] };
  assert.equal(hasApprovedCriticName(d), true);
  assert.equal(isTriagedOut(d, noExclusion), true);
});

test('an approved plan for a DIFFERENT criticName (byline rewritten since) is not evidence', () => {
  const d = { criticName: 'Someone Else', approvedFixes: [{ field: 'criticName', newValue: 'Peter Filichia' }] };
  assert.equal(isTriagedOut(d, noExclusion), false);
});

test('a bound approved plan stops counting once the judged article changes', () => {
  const judged = { criticName: 'Peter Filichia', url: 'https://x/a', fullText: 'original body' };
  const fix = { field: 'criticName', newValue: 'Peter Filichia', boundTo: approvedFixBinding(judged) };
  assert.equal(hasApprovedCriticName({ ...judged, approvedFixes: [fix] }), true);
  assert.equal(hasApprovedCriticName({ ...judged, fullText: 'a different article', approvedFixes: [fix] }), false);
});

test('non-criticName approved fixes are not attribution evidence', () => {
  const d = { criticName: 'Ann', approvedFixes: [{ field: 'wrongShow', newValue: true }] };
  assert.equal(isTriagedOut(d, noExclusion), false);
});

const reg = {
  _aliasIndex: { 'herald-alias': 'boston-herald' },
  outlets: {
    'boston-herald': { defaultCritic: 'Marilyn Stasio' }, // BRO-8038: she publishes at Variety, never here
    'news-tribune': { defaultCritic: 'Mark Kennedy' },   // BRO-7038: he is AP
    operawire: { defaultCritic: 'David Salazar' },        // evidenced home (Carmen case stays caught)
    variety: {},
  },
};
const reviews = [
  { outletId: 'variety', criticName: 'Marilyn Stasio' },
  { outletId: 'chicagotribune', criticName: 'Marilyn Stasio' },
  { outletId: 'ap', criticName: 'Mark Kennedy' },
  { outletId: 'operawire', criticName: 'David Salazar' },
  { outletId: 'parterre-box', criticName: 'David Salazar' },
];

test('homeless registry defaults are not homes (BRO-7038 + BRO-8038 shapes mint no suspect)', () => {
  const homes = buildEvidencedDefaultHomes(reg, reviews);
  assert.equal(homes.has('Marilyn Stasio'), false);
  assert.equal(homes.has('Mark Kennedy'), false);
  assert.deepStrictEqual(homes.get('David Salazar'), ['operawire']);
});

test('a home reached through a registry alias counts as evidence', () => {
  const homes = buildEvidencedDefaultHomes(reg, [...reviews, { outletId: 'herald-alias', criticName: 'Marilyn Stasio' }]);
  assert.deepStrictEqual(homes.get('Marilyn Stasio'), ['boston-herald']);
});

test('refuses an empty corpus instead of silently dropping every home', () => {
  assert.throws(() => buildEvidencedDefaultHomes(reg, []), /non-empty reviews/);
});
