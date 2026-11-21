import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { settleConflict, replayPlan, describeReviewFile, AUTO_MAIN_WHY, prunable } = createRequire(import.meta.url)('../../scripts/lib/push-rescue.js');
const j = (o) => JSON.stringify(o);
const base = { url: 'https://x.com/a', showId: 's', outletId: 'o', criticName: 'A B' };
const T = 'x'.repeat(2411);

test('real case 1: main has text, rescued empty, both invalid wrongProduction => main', () => {
  const main = { ...base, fullText: 'y'.repeat(3197), contentTier: 'invalid', wrongProduction: true };
  const resc = { ...base, fullText: '', contentTier: 'invalid', wrongProduction: true };
  assert.equal(settleConflict(j(main), j(resc)).decision, 'main');
});
test('real case 2: same text, main truncated+scored, rescued unscored => main', () => {
  const main = { ...base, fullText: T, contentTier: 'truncated', assignedScore: 62 };
  const resc = { ...base, fullText: T, contentTier: 'truncated' };
  assert.equal(settleConflict(j(main), j(resc)).decision, 'main');
});
test('equal length but different text waits (reviewer blocker 1)', () => {
  const main = { ...base, fullText: 'a'.repeat(2411), contentTier: 'truncated' };
  const resc = { ...base, fullText: 'b'.repeat(2411), contentTier: 'truncated' };
  assert.equal(settleConflict(j(main), j(resc)).decision, 'wait');
});
test('rescued strictly better => rescued', () => {
  const main = { ...base, fullText: '', contentTier: 'stub' };
  const resc = { ...base, fullText: T, contentTier: 'complete' };
  assert.equal(settleConflict(j(main), j(resc)).decision, 'rescued');
});
test('mixed (rescued longer text, main higher tier) waits', () => {
  const main = { ...base, fullText: 'short', contentTier: 'complete' };
  const resc = { ...base, fullText: 'short but longer', contentTier: 'stub' };
  assert.equal(settleConflict(j(main), j(resc)).decision, 'wait');
});
test('both scored with different scores waits', () => {
  const main = { ...base, fullText: T, contentTier: 'complete', assignedScore: 80 };
  const resc = { ...base, fullText: T, contentTier: 'complete', assignedScore: 70 };
  assert.equal(settleConflict(j(main), j(resc)).decision, 'wait');
});
test('differing flags, rescued-only score or excerpt, unparseable all wait (reviewer blocker 2)', () => {
  const main = { ...base, fullText: T, contentTier: 'complete' };
  assert.equal(settleConflict(j(main), j({ ...main, wrongShow: true })).decision, 'wait');
  assert.equal(settleConflict(j(main), j({ ...main, originalScore: 4 })).decision, 'rescued');
  assert.equal(settleConflict(j({ ...main, originalScore: 3 }), j({ ...main, originalScore: 4 })).decision, 'wait');
  assert.equal(settleConflict(j({ ...main, aExcerpt: 'one' }), j({ ...main, aExcerpt: 'two' })).decision, 'wait');
  assert.equal(settleConflict(j(main), '{').decision, 'wait');
  assert.equal(settleConflict('', j(main)).decision, 'wait');
});
test('reasons and describe output never carry review text', () => {
  const main = { ...base, fullText: 'SECRETPROSE one', contentTier: 'complete' };
  const resc = { ...base, fullText: 'SECRETPROSE two', contentTier: 'complete' };
  const v = settleConflict(j(main), j(resc));
  assert.ok(!JSON.stringify(v).includes('SECRETPROSE'));
  assert.ok(!describeReviewFile(j(main)).includes('SECRETPROSE'));
});
test('replayPlan: predicate settles only the paths it accepts; a waiting path keeps the branch', () => {
  const args = { adds: ['a.json', 'b.json'], mainBlob: new Map([['a.json', 'm1'], ['b.json', 'm2']]), touchedOnMain: new Set(), rescueBlob: new Map([['a.json', 'r1'], ['b.json', 'r2']]) };
  const both = replayPlan({ ...args, mainWins: () => true });
  assert.equal(both.keepForHuman, false);
  assert.ok(both.skipped.every((x) => x.why === AUTO_MAIN_WHY));
  const one = replayPlan({ ...args, mainWins: (p) => p === 'a.json' });
  assert.equal(one.keepForHuman, true);
  assert.equal(one.conflicts.length, 1);
  assert.equal(replayPlan({ ...args, mainWins: false }).keepForHuman, true);
});
test('an auto-settled branch is prunable (prune tags it first via ARCHIVE_WHYS)', () => {
  const m = { refs: [{ ref: 'push-rescue/x', tip: 't', restored: [], restoredBlobs: {}, keepForHuman: false, skipped: [{ path: 'a', why: AUTO_MAIN_WHY }] }] };
  assert.equal(prunable(m, () => null).length, 1);
});
test('a rescued-only date field main lacks keeps the conflict (external reviewer: silent ignore)', () => {
  const main = { ...base, fullText: T, contentTier: 'complete' };
  assert.equal(settleConflict(j(main), j({ ...main, publishDate: '2026-10-01' })).decision, 'wait');
  assert.equal(settleConflict(j(main), j({ ...main, textFetchedAt: '2026-10-01' })).decision, 'main');
});
test('differing values on both sides of any non-timestamp field wait (reviewer: headline, sources)', () => {
  const main = { ...base, fullText: T, contentTier: 'complete', headline: 'M', sources: ['a'] };
  assert.equal(settleConflict(j(main), j({ ...main, headline: 'R' })).decision, 'wait');
  assert.equal(settleConflict(j(main), j({ ...main, sources: ['a', 'dtli'] })).decision, 'wait');
  assert.equal(settleConflict(j({ ...main, lastCheckedAt: '2026-01-01' }), j({ ...main, lastCheckedAt: '2026-02-01' })).decision, 'main');
});
test('verdict fields only on rescued wait (reviewer: contentVerification, archivePath, incompleteReason)', () => {
  const main = { ...base, fullText: T, contentTier: 'complete' };
  assert.equal(settleConflict(j(main), j({ ...main, contentVerification: { wrongArticle: true } })).decision, 'wait');
  assert.equal(settleConflict(j(main), j({ ...main, archivePath: 'a.html' })).decision, 'wait');
  assert.equal(settleConflict(j(main), j({ ...main, incompleteReason: 'wrong_content' })).decision, 'wait');
  assert.equal(settleConflict(j(main), j({ ...main, incompleteReason: 'paywall' })).decision, 'main');
});
