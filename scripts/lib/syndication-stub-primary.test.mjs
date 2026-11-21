// BRO-7327: a stub (truncated) syndication primary must not shield a complete secondary.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const synd = require('./syndication-pairs.js');
const guards = require('./review-guards.js');
const { isScoreable } = require('./is-scoreable.js');
const { isActionableUnscored, isActionableRescore } = require('./scoring-queue-counts.js');
const tempDirs = [];
after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'synd-stub-'));
  tempDirs.push(d);
  return d;
}

const base = { showId: 'test-show-2020', criticName: 'Jonathan Mandell', assignedScore: 80, fullText: 'Test Show brings an excellent cast to the theater. The actors give the play emotional depth, and the direction keeps the stage alive. '.repeat(20), isFullReview: true };
function mkdir(primary, secondary) {
  const d = tempDir();
  if (primary) fs.writeFileSync(path.join(d, 'nyt-theater--jonathan-mandell.json'), JSON.stringify({ ...base, outletId: 'nyt-theater', outlet: 'New York Theater', ...primary }));
  if (secondary) fs.writeFileSync(path.join(d, 'dctheatrescene--jonathan-mandell.json'), JSON.stringify({ ...base, outletId: 'dctheatrescene', outlet: 'DC Theatre Scene', ...secondary }));
  return d;
}
const read = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
const show = { id: 'test-show-2020', title: 'Test Show', status: 'closed', openingDate: '2020-01-23' };

test('truncated primary yields to complete secondary (real Mandell pair)', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete' });
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--jonathan-mandell.json', read(d, 'nyt-theater--jonathan-mandell.json')), true);
  // secondary is no longer shielded by the stub
  assert.equal(synd.hasLiveSyndicationPrimary(d, ['nyt-theater'], 'Jonathan Mandell'), false);
  assert.equal(guards.explainExclusion(read(d, 'nyt-theater--jonathan-mandell.json'), show, path.join(d, 'nyt-theater--jonathan-mandell.json')), 'knownSyndicationSecondary');
  assert.notEqual(guards.explainExclusion(read(d, 'dctheatrescene--jonathan-mandell.json'), show, path.join(d, 'dctheatrescene--jonathan-mandell.json')), 'knownSyndicationSecondary');
});

test('complete primary still shields secondary (unchanged behaviour)', () => {
  const d = mkdir({ contentTier: 'complete' }, { contentTier: 'complete' });
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--jonathan-mandell.json', read(d, 'nyt-theater--jonathan-mandell.json')), false);
  assert.equal(synd.hasLiveSyndicationPrimary(d, ['nyt-theater'], 'Jonathan Mandell'), true);
});

test('stub primary with stub secondary: primary keeps shielding', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'excerpt' });
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--jonathan-mandell.json', read(d, 'nyt-theater--jonathan-mandell.json')), false);
});

test('flagged complete secondary does not displace the stub primary', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete', wrongProduction: true });
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--jonathan-mandell.json', read(d, 'nyt-theater--jonathan-mandell.json')), false);
});

test('non-syndicated critic unaffected', () => {
  const d = tempDir();
  fs.writeFileSync(path.join(d, 'nyt-theater--someone-else.json'), JSON.stringify({ ...base, criticName: 'Someone Else', outletId: 'nyt-theater', contentTier: 'truncated' }));
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--someone-else.json', read(d, 'nyt-theater--someone-else.json')), false);
});

test('two complete secondaries: stub primary keeps shielding (no double count)', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete' });
  fs.writeFileSync(path.join(d, 'faster-times--jonathan-mandell.json'), JSON.stringify({ ...base, outletId: 'faster-times', contentTier: 'complete' }));
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--jonathan-mandell.json', read(d, 'nyt-theater--jonathan-mandell.json')), false);
});

test('complete secondary excluded by another gate (rejectionReason): stub primary stays', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete', rejectionReason: 'not a review' });
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--jonathan-mandell.json', read(d, 'nyt-theater--jonathan-mandell.json')), false);
});

test('publishing-group sibling for same critic blocks the yield (no double ship)', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete' });
  fs.writeFileSync(path.join(d, 'sfgate--jonathan-mandell.json'), JSON.stringify({ ...base, outletId: 'sfgate', contentTier: 'complete' }));
  assert.equal(synd.hasFullerSecondary(d, 'nyt-theater--jonathan-mandell.json', read(d, 'nyt-theater--jonathan-mandell.json')), false);
});

test('unscored complete secondary enters the scorer while the stub stays live until scoring succeeds', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete', assignedScore: null });
  const primaryPath = path.join(d, 'nyt-theater--jonathan-mandell.json');
  const secondaryPath = path.join(d, 'dctheatrescene--jonathan-mandell.json');
  const primary = read(d, path.basename(primaryPath));
  const secondary = read(d, path.basename(secondaryPath));
  const ctx = { show, filePath: secondaryPath };
  assert.equal(guards.explainExclusion(secondary, show, secondaryPath), 'knownSyndicationSecondary');
  assert.equal(guards.explainExclusion(primary, show, primaryPath), null);
  assert.equal(isScoreable(secondary, show, secondaryPath), true);
  assert.equal(isActionableUnscored(secondary, ctx), true);
  assert.equal(isActionableRescore({ ...secondary, needsRescore: true }, ctx), true);
  // A failed score leaves the primary intact. A valid persisted score swaps exactly one copy.
  assert.equal(synd.hasFullerSecondary(d, path.basename(primaryPath), primary), false);
  const scored = { ...secondary, assignedScore: 85 };
  fs.writeFileSync(secondaryPath, JSON.stringify(scored));
  assert.equal(guards.explainExclusion(primary, show, primaryPath), 'knownSyndicationSecondary');
  assert.equal(guards.explainExclusion(scored, show, secondaryPath), null);
});

for (const flags of [
  { wrongProduction: true }, { crossOutletDuplicate: true }, { isSyndicatedDuplicate: true },
  { rejectionReason: 'not a review' }, { showNotMentioned: true },
]) {
  test(`unscored secondary retains other scoring gates: ${Object.keys(flags)[0]}`, () => {
    const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete', assignedScore: null, ...flags });
    const fp = path.join(d, 'dctheatrescene--jonathan-mandell.json');
    assert.equal(isScoreable(read(d, path.basename(fp)), show, fp), false);
  });
}

for (const primary of [{ contentTier: 'complete' }, { contentTier: 'truncated', manualContentTier: 'truncated' }]) {
  test(`unscored secondary cannot bypass ${JSON.stringify(primary)}`, () => {
    const d = mkdir(primary, { contentTier: 'complete', assignedScore: null });
    const fp = path.join(d, 'dctheatrescene--jonathan-mandell.json');
    assert.equal(isScoreable(read(d, path.basename(fp)), show, fp), false);
  });
}

test('multiple secondary copies do not enter the scoring queue behind a stub', () => {
  const d = mkdir({ contentTier: 'truncated' }, { contentTier: 'complete', assignedScore: null });
  fs.writeFileSync(path.join(d, 'faster-times--jonathan-mandell.json'), JSON.stringify({ ...base, outletId: 'faster-times', contentTier: 'complete', assignedScore: null }));
  const fp = path.join(d, 'dctheatrescene--jonathan-mandell.json');
  assert.equal(isScoreable(read(d, path.basename(fp)), show, fp), false);
});
