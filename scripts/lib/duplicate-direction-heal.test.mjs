import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hasAnchoredBand,
  isFlaggedRecord,
  shouldFlipDuplicateDirection,
  findDirectionFlips,
} = require('./duplicate-direction-heal.js');

const ANCHORED = { score: 85, band: { floor: 71, ceiling: 90, fraction: 0.8 } };
const UNANCHORED = { score: 91 };

function loser(overrides) {
  return { criticName: 'Alun Hood', llmScore: ANCHORED, fullText: 'x'.repeat(3000), ...overrides };
}
function winner(overrides) {
  return { criticName: 'Unknown', llmScore: UNANCHORED, ...overrides };
}

test('hasAnchoredBand: true only when llmScore.band.floor is numeric', () => {
  assert.equal(hasAnchoredBand({ llmScore: ANCHORED }), true);
  assert.equal(hasAnchoredBand({ llmScore: UNANCHORED }), false);
  assert.equal(hasAnchoredBand({ llmScore: { band: {} } }), false);
  assert.equal(hasAnchoredBand({}), false);
  assert.equal(hasAnchoredBand(null), false);
});

test('isFlaggedRecord: true for exclusion flags and invalid tier', () => {
  assert.equal(isFlaggedRecord({ wrongProduction: true }), true);
  assert.equal(isFlaggedRecord({ wrongShow: true }), true);
  assert.equal(isFlaggedRecord({ isNonReview: true }), true);
  assert.equal(isFlaggedRecord({ contentTier: 'invalid' }), true);
  assert.equal(isFlaggedRecord({ contentTier: 'complete' }), false);
  assert.equal(isFlaggedRecord(null), true);
});

test('isFlaggedRecord: true for an ensemble-rejected garbage_text record even when contentTier is not invalid (BRO-3821: the-lion-king-west-end-2021 guardian--lyngardner pattern)', () => {
  assert.equal(isFlaggedRecord({
    contentTier: 'truncated',
    rejectionReason: 'garbage_text',
    rejectedBy: 'ensemble-scoreability-check',
  }), true);
});

test('shouldFlipDuplicateDirection: the Death Note case — named+anchored loser under Unknown+unanchored winner flips', () => {
  assert.equal(shouldFlipDuplicateDirection(loser(), winner()), true);
});

test('shouldFlipDuplicateDirection: named-only loser (no band) still flips', () => {
  assert.equal(shouldFlipDuplicateDirection(loser({ llmScore: undefined }), winner()), true);
});

test('shouldFlipDuplicateDirection: anchored-only loser (Unknown byline) still flips', () => {
  assert.equal(shouldFlipDuplicateDirection(loser({ criticName: 'Unknown' }), winner()), true);
});

test('shouldFlipDuplicateDirection: legitimate direction — winner already named — does not flip', () => {
  assert.equal(shouldFlipDuplicateDirection(loser(), winner({ criticName: 'Alex Wood' })), false);
});

test('shouldFlipDuplicateDirection: winner anchored but its body is SHORTER than loser\'s — still does not flip (the genuine short-stub protection)', () => {
  assert.equal(shouldFlipDuplicateDirection(
    loser({ fullText: 'x'.repeat(3000) }),
    winner({ llmScore: ANCHORED, fullText: 'x'.repeat(2000) }),
  ), false);
});

test('shouldFlipDuplicateDirection: winner anchored but its body is LONGER than a named loser\'s — flips (BRO-3821: boilerplate-contaminated Unknown scrape no longer auto-wins)', () => {
  assert.equal(shouldFlipDuplicateDirection(
    loser({ fullText: 'x'.repeat(2000) }),
    winner({ llmScore: ANCHORED, fullText: 'x'.repeat(3000) }),
  ), true);
});

test('shouldFlipDuplicateDirection: winner anchored and disproportionately longer than loser — does not flip (ship-check adversarial finding: a bare-minimum-length loser must not beat a genuinely complete, much longer anchored winner just because it has a byline)', () => {
  assert.equal(shouldFlipDuplicateDirection(
    loser({ fullText: 'x'.repeat(500) }),
    winner({ llmScore: ANCHORED, fullText: 'x'.repeat(6000) }),
  ), false);
});

test('shouldFlipDuplicateDirection: winner anchored, within the real corpus ratio (1.8x) — still flips', () => {
  assert.equal(shouldFlipDuplicateDirection(
    loser({ fullText: 'x'.repeat(3000) }),
    winner({ llmScore: ANCHORED, fullText: 'x'.repeat(5400) }),
  ), true);
});

test('shouldFlipDuplicateDirection: winner anchored, bodies tied in length — flips (attribution breaks the tie)', () => {
  assert.equal(shouldFlipDuplicateDirection(
    loser({ fullText: 'x'.repeat(3000) }),
    winner({ llmScore: ANCHORED, fullText: 'x'.repeat(3000) }),
  ), true);
});

test('shouldFlipDuplicateDirection: winner anchored, loser has neither name (anchored-only loser) — still does not flip (mutual-Unknown/anchored-only case unchanged)', () => {
  assert.equal(shouldFlipDuplicateDirection(
    loser({ criticName: 'Unknown', fullText: 'x'.repeat(1000) }),
    winner({ llmScore: ANCHORED, fullText: 'x'.repeat(3000) }),
  ), false);
});

test('shouldFlipDuplicateDirection: loser with neither name nor band — does not flip', () => {
  assert.equal(shouldFlipDuplicateDirection(loser({ criticName: 'Unknown', llmScore: undefined }), winner()), false);
});

test('shouldFlipDuplicateDirection: loser body below the substance floor — does not flip even with a real byline (BRO-3821: a-little-night-music-2009 backstage--luke-crowe pattern — empty, scoreless "loser" was about to bury a winner holding the only real content)', () => {
  assert.equal(shouldFlipDuplicateDirection(loser({ fullText: '' }), winner()), false);
  assert.equal(shouldFlipDuplicateDirection(loser({ fullText: 'x'.repeat(499) }), winner()), false);
  assert.equal(shouldFlipDuplicateDirection(loser({ fullText: 'x'.repeat(500) }), winner()), true);
});

test('shouldFlipDuplicateDirection: loser flagged wrongProduction — clean-source gate refuses', () => {
  assert.equal(shouldFlipDuplicateDirection(loser({ wrongProduction: true }), winner()), false);
});

test('shouldFlipDuplicateDirection: loser contentTier invalid — clean-source gate refuses', () => {
  assert.equal(shouldFlipDuplicateDirection(loser({ contentTier: 'invalid' }), winner()), false);
});

test('shouldFlipDuplicateDirection: missing loser/winner — false', () => {
  assert.equal(shouldFlipDuplicateDirection(null, winner()), false);
  assert.equal(shouldFlipDuplicateDirection(loser(), null), false);
});

test('findDirectionFlips: Death Note fixture — flips the alun-hood/unknown pair', () => {
  const records = [
    { file: 'whatsonstage--alun-hood.json', data: { ...loser(), duplicateOf: 'whatsonstage--unknown.json' } },
    { file: 'whatsonstage--unknown.json', data: winner() },
    { file: 'whatsonstage--alex-wood.json', data: { criticName: 'Alex Wood', llmScore: { score: 70 } } },
  ];
  const flips = findDirectionFlips(records);
  assert.deepEqual(flips.map((f) => [f.loserFile, f.winnerFile]), [
    ['whatsonstage--alun-hood.json', 'whatsonstage--unknown.json'],
  ]);
});

test('findDirectionFlips: mutual (circular) pair is left alone — fix-circular-duplicate-pairs.js\'s job', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateOf: 'b.json' } },
    { file: 'b.json', data: { ...winner(), duplicateOf: 'a.json' } },
  ];
  assert.deepEqual(findDirectionFlips(records), []);
});

test('findDirectionFlips: self-referential duplicateOf is ignored', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateOf: 'a.json' } },
  ];
  assert.deepEqual(findDirectionFlips(records), []);
});

test('findDirectionFlips: sibling target missing from records — ignored (handled by other audits)', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateOf: 'ghost.json' } },
  ];
  assert.deepEqual(findDirectionFlips(records), []);
});

test('findDirectionFlips: no duplicateOf at all — no flips', () => {
  const records = [
    { file: 'a.json', data: loser() },
    { file: 'b.json', data: winner() },
  ];
  assert.deepEqual(findDirectionFlips(records), []);
});
