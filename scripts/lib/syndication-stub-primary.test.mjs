// BRO-7327: a stub (truncated) syndication primary must not shield a complete secondary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const synd = require('./syndication-pairs.js');
const guards = require('./review-guards.js');

const base = { showId: 'x-2020', criticName: 'Jonathan Mandell', assignedScore: 80, fullText: 'A full review. '.repeat(120), isFullReview: true };
function mkdir(primary, secondary) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'synd-stub-'));
  if (primary) fs.writeFileSync(path.join(d, 'nyt-theater--jonathan-mandell.json'), JSON.stringify({ ...base, outletId: 'nyt-theater', outlet: 'New York Theater', ...primary }));
  if (secondary) fs.writeFileSync(path.join(d, 'dctheatrescene--jonathan-mandell.json'), JSON.stringify({ ...base, outletId: 'dctheatrescene', outlet: 'DC Theatre Scene', ...secondary }));
  return d;
}
const read = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
const show = { id: 'x-2020', status: 'closed', openingDate: '2020-01-23' };

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'synd-stub-'));
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
