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

// BRO-7173: 2026-11-08 rescue branch held 32 "conflicts" where main was ahead.
test('fetch-state incomplete notes a fuller main cleared do not block; verdict reasons do', () => {
  const rescued = { ...stub, contentTier: 'excerpt', incompleteReason: 'not_attempted', incompleteDetail: 'Fetched via x, 0 words' };
  assert.equal(mainSupersedesRescue(j(rescued), j(full)), true);
  assert.equal(mainSupersedesRescue(j({ ...rescued, incompleteReason: 'wrong_content' }), j(full)), false, 'a verdict is never dropped');
  assert.equal(mainSupersedesRescue(j({ ...stub, contentTier: 'invalid', incompleteReason: 'url_content_mismatch' }), j(full)), false);
});
test('a rescue-side Unknown critic that main named is not a conflict; the reverse is', () => {
  assert.equal(mainSupersedesRescue(j({ ...stub, criticName: 'Unknown' }), j({ ...full, criticName: 'Jane Roe' })), true);
  assert.equal(mainSupersedesRescue(j({ ...stub, criticName: 'Jane Roe' }), j({ ...full, criticName: 'Unknown' })), false);
  assert.equal(mainSupersedesRescue(j({ ...stub, criticName: 'Jane Roe' }), j({ ...full, criticName: 'John Doe' })), false);
});
test('a no-text rescue at the same tier or vs main-invalid loses only retry bookkeeping', () => {
  const s1 = { ...stub, fetchRetryAfter: '2026-11-01', incompleteReason: 'paywall', textRetryAttemptedAt: 't1' };
  const m1 = { ...stub, fetchRetryAfter: '2026-11-09', incompleteReason: 'paywall', textRetryAttemptedAt: 't2' };
  assert.equal(mainSupersedesRescue(j(s1), j(m1)), true, 'stub->stub, newer retry stamps');
  assert.equal(mainSupersedesRescue(j(s1), j({ ...m1, contentTier: 'invalid', contentTierReason: 'author mismatch' })), true, 'main judged it invalid');
  assert.equal(mainSupersedesRescue(j({ ...s1, contentTier: 'excerpt' }), j(m1)), false, 'main downgraded excerpt->stub');
  assert.equal(mainSupersedesRescue(j({ ...s1, publishDate: '2026-10-01' }), j({ ...m1, publishDate: '2026-10-02' })), false, 'a differing real field stays a conflict');
});
test('excerpt text counts as text: a different excerpt is never lost', () => {
  const ex = { ...stub, contentTier: 'excerpt', bwwExcerpt: 'longer rescued excerpt' };
  assert.equal(mainSupersedesRescue(j(ex), j({ ...ex, bwwExcerpt: 'short', fetchRetryAfter: 'x' })), false);
  assert.equal(mainSupersedesRescue(j({ ...ex, fetchRetryAfter: 'a' }), j({ ...ex, fetchRetryAfter: 'b' })), true);
});
test('the 2026-11-08 judgment cases stay conflicts', () => {
  const t = { ...full, contentTier: 'truncated' };
  assert.equal(mainSupersedesRescue(j({ ...t, fullText: 'longer older text' }), j({ ...t, fullText: 'newer', textFetchedAt: 'z' })), false, 'rescue text differs, same tier');
  assert.equal(mainSupersedesRescue(j({ ...t, duplicateClearReason: 'healed' }), j({ ...t, duplicateOf: 'x.json' })), false, 'duplicate pointer judgment');
  assert.equal(mainSupersedesRescue(j({ ...t, assignedScore: 93 }), j({ ...t, assignedScore: 96 })), false, 'score differs');
});
test('verifier verdicts, archive pointers, sources and bare details are never waived (review findings)', () => {
  const m = { ...stub, fetchRetryAfter: 'b' };
  assert.equal(mainSupersedesRescue(j({ ...m, contentVerification: { wrongArticle: true } }), j(m)), false, 'wrongArticle verdict');
  assert.equal(mainSupersedesRescue(j({ ...m, contentVerification: { wrongArticle: true } }), j({ ...m, contentTier: 'invalid' })), false, 'verdict vs main invalid');
  assert.equal(mainSupersedesRescue(j({ ...m, contentVerificationPromoted: true }), j(m)), false);
  assert.equal(mainSupersedesRescue(j({ ...m, archivePath: 'archive/x.html' }), j(m)), false, 'saved HTML pointer');
  assert.equal(mainSupersedesRescue(j({ ...m, sources: ['bww'] }), j(m)), false, 'aggregator attribution at an equal tier');
  assert.equal(mainSupersedesRescue(j({ ...m, incompleteDetail: 'author mismatch: wrong critic' }), j(m)), false, 'detail with no reason');
});

// BRO-7173: owner-approved main_wins resolves main conflicts without a manual branch delete.
const { parseMainWins, onlyMainConflicts } = createRequire(import.meta.url)('../../scripts/lib/push-rescue.js');
const BR = 'push-rescue/20261108T182248Z-local-07cdde010f490dfd1a9b9968742475208519c8b7';
const TIP = '744f3332cdbbc391cfa26d3c05fa029e3f02bbfb';
test('mainWins turns main conflicts into logged skips, keeps other-rescue conflicts, still restores absent adds', () => {
  const args = {
    adds: ['s/a.json', 's/b.json', 's/c.json'],
    mainBlob: new Map([['s/a.json', 'm']]),
    touchedOnMain: new Set(),
    rescueBlob: new Map([['s/a.json', 'r'], ['s/b.json', 'r2'], ['s/c.json', 'r3']]),
    claimed: new Map([['s/b.json', 'other']]),
  };
  const before = replayPlan(args);
  assert.deepEqual(before.conflicts.map((c) => c.path), ['s/a.json', 's/b.json']);
  const p = replayPlan({ ...args, mainWins: true });
  assert.deepEqual(p.conflicts.map((c) => c.path), ['s/b.json']);
  assert.equal(p.keepForHuman, true);
  assert.deepEqual(p.restore, ['s/c.json']);
  const sk = p.skipped.find((x) => x.path === 's/a.json');
  assert.equal(sk.rescueBlob, 'r');
  assert.equal(sk.mainBlob, 'm');
  const only = replayPlan({ ...args, adds: ['s/a.json'], mainWins: true });
  assert.equal(only.keepForHuman, false);
});
test('parseMainWins needs branch@tip, strips refs/heads/, rejects junk', () => {
  assert.equal(parseMainWins('').size, 0);
  assert.equal(parseMainWins(`refs/heads/${BR}@${TIP.toUpperCase()}`).get(BR), TIP);
  assert.throws(() => parseMainWins(BR), /tip sha/);
  assert.throws(() => parseMainWins(`main@${TIP}`), /tip sha/);
  assert.throws(() => parseMainWins(`${BR}@abc`), /tip sha/);
});
test('onlyMainConflicts: hint only when main_wins can settle the branch', () => {
  assert.equal(onlyMainConflicts({ conflicts: [{ why: 'main holds a different version' }] }), true);
  assert.equal(onlyMainConflicts({ conflicts: [{ why: 'another rescue branch holds a different version' }] }), false);
  assert.equal(onlyMainConflicts({ conflicts: [{ why: 'main holds a different version' }], dropped: ['x'] }), false);
  assert.equal(onlyMainConflicts({ conflicts: [] }), false);
});
