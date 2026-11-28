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

test('REGRESSION (E2E 2026-06-05): verbose same-show duplicate below 0.25 still dedupes', () => {
  // The live E2E created a fresh Caissie/Ragtime bug whose AI diagnosis landed
  // at only 0.216 Jaccard vs the open #356/#358 — MISSED at the old 0.25 bar,
  // wrongly creating a duplicate issue + owner email. The threshold is now 0.12.
  const newRagtimeBug = {
    showId: 'ragtime-2025',
    summary: 'The Ragtime awards section is missing Caissie Levy as a co-winner of the Drama Desk Award for Best Leading Performance in a Musical, which she shared with Joshua Henry. The site currently only credits Joshua Henry.',
    whatsHappening: 'The Drama Desk award data for Ragtime omits Caissie Levy.',
    submitterShow: 'Ragtime',
    originalMessage: 'The Ragtime page is missing an award winner. Caissie Levy co-won the Drama Desk for Best Leading Performance in a Musical, tied with Joshua Henry, but the site only credits him.',
  };
  const openRagtimeIssue = {
    showId: 'ragtime-2025',
    summary: 'User reports that Caissie Levy is missing as a co-winner of the Drama Desk Award for best leading performance',
    whatsHappening: 'The site does not list Caissie Levy among Drama Desk winners.',
    submitterShow: 'Ragtime',
    originalMessage: 'Caissie Levy also won the Drama Desk for best leading performance.',
  };
  const dup = findDuplicateOpenBug(newRagtimeBug, [{ number: 356, diagnosis: openRagtimeIssue }]);
  assert.ok(dup, 'verbose same-show duplicate must dedupe at the calibrated threshold');
  assert.equal(dup.number, 356);
});

test('REGRESSION: genuinely different bugs on the same show do NOT dedupe', () => {
  // From the real backlog: a misattribution bug vs a score-explanation bug on
  // the same show sit at ~0.02-0.03 Jaccard — must stay separate.
  const misattribution = { showId: 'two-strangers-bway-2025', summary: 'The site appears to be showing a Variety review that belongs to a different production' };
  const scoreExplain = { showId: 'two-strangers-bway-2025', summary: 'The score of 75 is not a simple average; it uses a weighted tier calculation' };
  assert.equal(findDuplicateOpenBug(misattribution, [{ number: 244, diagnosis: scoreExplain }]), null);
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
