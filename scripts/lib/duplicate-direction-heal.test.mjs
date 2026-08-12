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
  return { criticName: 'Alun Hood', llmScore: ANCHORED, ...overrides };
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

test('shouldFlipDuplicateDirection: legitimate direction — winner itself anchored — does not flip', () => {
  assert.equal(shouldFlipDuplicateDirection(loser(), winner({ llmScore: ANCHORED })), false);
});

test('shouldFlipDuplicateDirection: loser with neither name nor band — does not flip', () => {
  assert.equal(shouldFlipDuplicateDirection(loser({ criticName: 'Unknown', llmScore: undefined }), winner()), false);
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
