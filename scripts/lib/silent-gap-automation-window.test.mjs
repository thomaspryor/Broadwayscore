// BRO-7472 class guard: the "T1/T2 silent review gaps" digest row must not warn
// (and so must not mint a card) for a tier-2 gap automation is still retrying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAutomationStillWorking } = require('./t1-silent-gap.js');
const { silentGapBacklogResults } = require('../health-check.js');

const NOW = new Date('2026-11-14T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
// Real shape of the 2026-11-14 rope/talkinbroadway gap in data/audit/t1-silent-gaps.json.
const forumStub = (over = {}) => ({
  showId: 'rope-off-broadway-2026', outletId: 'talkinbroadway', tier: 2, type: 'empty-body',
  url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2655466',
  recoverable: true, forumLinkRecoveryCount: 6, firstSeen: daysAgo(4), gapSeenAt: daysAgo(4),
  needsManualRecovery: false, ...over,
});

test('tier-2 gap with automation left stays quiet inside the 7-day window', () => {
  assert.equal(isAutomationStillWorking(forumStub(), NOW), true);
  assert.deepEqual(silentGapBacklogResults({ gaps: [forumStub()] }, NOW), []);
});

test('same gap warns once automation has had 7 days and still has not recovered it', () => {
  const g = forumStub({ firstSeen: daysAgo(8) });
  assert.equal(isAutomationStillWorking(g, NOW), false);
  assert.equal(silentGapBacklogResults({ gaps: [g] }, NOW)[0].status !== undefined, true);
});

test('tier 1, rejected-unscoreable, unstamped and spent-automation gaps are never given the window', () => {
  assert.equal(isAutomationStillWorking(forumStub({ tier: 1 }), NOW), false);
  assert.equal(isAutomationStillWorking(forumStub({ type: 'rejected-unscoreable' }), NOW), false);
  assert.equal(isAutomationStillWorking(forumStub({ firstSeen: undefined }), NOW), false);
  const spent = { tier: 2, type: 'empty-body', url: 'https://www.theatermania.com/x', recoverable: false, firstSeen: daysAgo(4) };
  assert.equal(isAutomationStillWorking(spent, NOW), false);
});

test('a T1 gap still warns at 24h', () => {
  const r = silentGapBacklogResults({ gaps: [forumStub({ tier: 1, url: 'https://www.theguardian.com/a', recoverable: true, forumLinkRecoveryCount: 0, firstSeen: daysAgo(2) })] }, NOW);
  assert.equal(r.length, 1);
});
