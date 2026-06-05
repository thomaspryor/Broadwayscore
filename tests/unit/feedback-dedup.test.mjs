import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findDuplicateOpenBug, jaccard, tokenize } = require('../../scripts/lib/feedback-dedup.js');

// Fixtures drawn from REAL recurring bug-diagnosis issues that the pipeline
// created multiple times for the same underlying bug (the loop we're killing).

const caissieA = {
  showId: 'ragtime',
  summary: 'User reports that Caissie Levy is missing as a co-winner of the Drama Desk Award for best leading performance',
};
const caissieB = {
  showId: 'ragtime',
  summary: 'User reports that Caissie Levy co-won the Drama Desk Award for best leading performance in a musical',
};

const obA = {
  showId: null,
  summary: 'Off Broadway listings are missing shows from several major theatres',
};
const obB = {
  showId: null,
  summary: 'Off Broadway listings are missing shows from several major theatres and venues',
};

const scoresA = {
  showId: null,
  summary: 'User reports that show scores fluctuate daily without apparent reason',
};
const scoresB = {
  showId: null,
  summary: 'User reports that show scores appear to fluctuate daily even though reviews have not changed',
};

// Distinct bugs that must NOT be deduped.
const closingDate = {
  showId: 'into-the-woods-bridge',
  summary: 'The closing date for Into The Woods at The Bridge Theatre is wrong',
};
const varietyAttribution = {
  showId: 'some-show',
  summary: 'The site is incorrectly attributing a Variety review to the wrong critic',
};

test('same-show recurring bug (Caissie Levy co-winner) is detected as duplicate', () => {
  const dup = findDuplicateOpenBug(caissieB, [{ number: 356, diagnosis: caissieA }]);
  assert.ok(dup, 'expected duplicate match');
  assert.equal(dup.number, 356);
});

test('show-agnostic recurring bug (OB listings) is detected as duplicate', () => {
  const dup = findDuplicateOpenBug(obB, [{ number: 346, diagnosis: obA }]);
  assert.ok(dup, 'expected duplicate match');
  assert.equal(dup.number, 346);
});

test('show-agnostic terse-vs-verbose (scores fluctuate) is detected as duplicate', () => {
  const dup = findDuplicateOpenBug(scoresB, [{ number: 270, diagnosis: scoresA }]);
  assert.ok(dup, 'expected duplicate match for scores-fluctuate pair');
  assert.equal(dup.number, 270);
});

test('distinct bugs are NOT deduped', () => {
  const openBugs = [
    { number: 356, diagnosis: caissieA },
    { number: 346, diagnosis: obA },
    { number: 270, diagnosis: scoresA },
  ];
  assert.equal(findDuplicateOpenBug(closingDate, openBugs), null);
  assert.equal(findDuplicateOpenBug(varietyAttribution, openBugs), null);
});

test('same show but different topic is NOT deduped', () => {
  const ragtimeSynopsis = { showId: 'ragtime', summary: 'The synopsis for Ragtime is outdated and mentions the wrong cast' };
  const dup = findDuplicateOpenBug(ragtimeSynopsis, [{ number: 356, diagnosis: caissieA }]);
  assert.equal(dup, null, 'different topic on same show should not dedupe');
});

test('picks the highest-similarity match among multiple opens', () => {
  const openBugs = [
    { number: 100, diagnosis: obA },       // unrelated to Caissie
    { number: 356, diagnosis: caissieA },  // the real match
  ];
  const dup = findDuplicateOpenBug(caissieB, openBugs);
  assert.equal(dup.number, 356);
});

test('show-agnostic merge requires >=2 shared tokens (no single-word merges)', () => {
  // Two unrelated show-agnostic bugs sharing exactly ONE meaningful token.
  // After stopword stripping each is tiny, so a single shared word would clear
  // 0.5 overlap — the floor must block it.
  const a = { showId: null, summary: 'The homepage filter buttons behave unexpectedly' };
  const b = { showId: null, summary: 'The homepage layout looks cramped' };
  assert.equal(findDuplicateOpenBug(a, [{ number: 1, diagnosis: b }]), null);
  // A genuine pair sharing 3+ tokens still dedupes.
  assert.ok(findDuplicateOpenBug(scoresB, [{ number: 270, diagnosis: scoresA }]));
});

test('empty / missing inputs are safe', () => {
  assert.equal(findDuplicateOpenBug(null, [{ number: 1, diagnosis: caissieA }]), null);
  assert.equal(findDuplicateOpenBug(caissieA, []), null);
  assert.equal(findDuplicateOpenBug(caissieA, null), null);
});

test('tokenize strips stopwords and short tokens', () => {
  const t = tokenize('User reports that the show is missing a co-winner');
  assert.ok(t.has('winner'));
  assert.ok(!t.has('the'));
  assert.ok(!t.has('co')); // length 2
});

test('jaccard sanity', () => {
  assert.equal(jaccard(tokenize('alpha beta gamma'), tokenize('alpha beta gamma')), 1);
  assert.equal(jaccard(tokenize('alpha'), tokenize('omega')), 0);
});
