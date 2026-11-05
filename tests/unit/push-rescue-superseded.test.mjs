import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mainSupersedesRescue, replayPlan } = createRequire(import.meta.url)('../../scripts/lib/push-rescue.js');
const stub = { url: 'https://x.com/a/', outletId: 'bww', contentTier: 'stub', firstSeenAt: 't' };
const full = { ...stub, url: 'https://x.com/a', contentTier: 'complete', fullText: 'abc', publishDate: '2026-10-12' };
const j = (o) => JSON.stringify(o);

test('enriched main copy of the same review supersedes the stub', () => {
  assert.equal(mainSupersedesRescue(j(stub), j(full)), true);
});
test('a richer rescue file never loses to a stub on main', () => {
  assert.equal(mainSupersedesRescue(j(full), j(stub)), false);
});
test('different or missing url, unknown tier, bad json stay conflicts', () => {
  assert.equal(mainSupersedesRescue(j(stub), j({ ...full, url: 'https://x.com/b' })), false);
  assert.equal(mainSupersedesRescue(j({ ...stub, url: '' }), j({ ...full, url: '' })), false);
  assert.equal(mainSupersedesRescue(j({ ...stub, contentTier: 'needs-rescrape' }), j(full)), false);
  assert.equal(mainSupersedesRescue('{', j(full)), false);
});
test('a rescued field main lacks keeps it a conflict', () => {
  assert.equal(mainSupersedesRescue(j({ ...stub, originalScore: 4 }), j(full)), false);
});
test('replayPlan skips superseded paths instead of keeping them for a human', () => {
  const args = { adds: ['s/a.json'], mainBlob: new Map([['s/a.json', 'm']]), touchedOnMain: new Set(), rescueBlob: new Map([['s/a.json', 'r']]) };
  assert.equal(replayPlan(args).keepForHuman, true);
  const p = replayPlan({ ...args, superseded: () => true });
  assert.equal(p.keepForHuman, false);
  assert.equal(p.skipped.length, 1);
});
test('provenance-only fields (dateSource, false flags) do not block supersede', () => {
  assert.equal(mainSupersedesRescue(j({ ...stub, dateSource: 'google-news-rss', isFullReview: false }), j(full)), true);
});
test('main downgrading a review keeps it a conflict unless the text is identical', () => {
  assert.equal(mainSupersedesRescue(j({ ...full }), j({ ...full, contentTier: 'invalid', fullText: 'other' })), false);
  assert.equal(mainSupersedesRescue(j({ ...full }), j({ ...full, contentTier: 'invalid' })), true);
});
test('same tier with different text, differing score, or path-case-only url stay conflicts', () => {
  assert.equal(mainSupersedesRescue(j({ ...full, fullText: 'one' }), j({ ...full, fullText: 'two' })), false);
  assert.equal(mainSupersedesRescue(j({ ...stub, originalScore: 3 }), j({ ...full, originalScore: 4 })), false);
  assert.equal(mainSupersedesRescue(j({ ...stub, url: 'https://x.com/A' }), j({ ...full, url: 'https://x.com/a' })), false);
});
test('same data with different formatting is superseded', () => {
  assert.equal(mainSupersedesRescue(JSON.stringify(stub, null, 2), JSON.stringify(stub)), true);
});
test('same data in a different key order is superseded', () => {
  assert.equal(mainSupersedesRescue(j({ a: 1, url: 'u', contentTier: 'stub' }), j({ contentTier: 'stub', url: 'u', a: 1 })), true);
});
test('main holding every rescued field plus more is superseded at equal tier', () => {
  assert.equal(mainSupersedesRescue(j(stub), j({ ...stub, extra: 1 })), true);
  assert.equal(mainSupersedesRescue(j({ ...stub, note: 'x' }), j({ ...stub, extra: 1 })), false);
});
