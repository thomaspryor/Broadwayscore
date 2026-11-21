import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isForumLinkRecoverable, FORUM_RECOVERY_CAP, FORUM_RECOVERY_SLOW_TRIES } = require('./talkinbroadway-forum-link.js');
const { classifySilentGap } = require('./t1-silent-gap.js');

// Real shape of the four 2026-10-11 stuck files: empty stub, forum-thread url,
// generic same-URL retry counter already at the cap.
const STUCK = {
  outletId: 'talkinbroadway', url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2654485',
  contentTier: 'stub', fullText: null, aggUrlRecoveryCount: 3,
};

test('forum-thread stub stays recoverable after the generic same-URL counter is spent', () => {
  assert.equal(isForumLinkRecoverable(STUCK), true);
});

test('own lifetime cap, human score and wrong-production flags stop it', () => {
  assert.equal(isForumLinkRecoverable({ ...STUCK, forumLinkRecoveryCount: FORUM_RECOVERY_CAP }), false);
  assert.equal(isForumLinkRecoverable({ ...STUCK, humanReviewScore: 80 }), false);
  assert.equal(isForumLinkRecoverable({ ...STUCK, wrongProduction: true }), false);
  assert.equal(isForumLinkRecoverable({ ...STUCK, url: 'https://www.talkinbroadway.com/page/ob/10_09_26.html' }), false);
});

test('audit classifier marks such a stub recoverable (empty-body) so the forum path can run', () => {
  const g = classifySilentGap({ file: STUCK, show: {}, tier: 2, outletScored: false, now: new Date('2026-10-11T12:00:00Z') });
  assert.equal(g?.type, 'empty-body');
  assert.equal(g?.recoverable, true);
  const spent = classifySilentGap({ file: { ...STUCK, forumLinkRecoveryCount: FORUM_RECOVERY_CAP }, show: {}, tier: 2, outletScored: false, now: new Date('2026-10-11T12:00:00Z') });
  assert.equal(spent?.recoverable, false);
});

// BRO-5166: three hourly Bright Data timeouts spent the fast tries in three hours
// while the recovery script itself worked; a daily long tail keeps it alive.
test('after the fast tries, one retry a day for a bounded tail', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const spent = { ...STUCK, forumLinkRecoveryCount: FORUM_RECOVERY_CAP };
  assert.equal(isForumLinkRecoverable({ ...spent, forumLinkRecoveryAt: '2026-10-12T09:00:00Z' }, undefined, now), false);
  assert.equal(isForumLinkRecoverable({ ...spent, forumLinkRecoveryAt: '2026-10-11T11:00:00Z' }, undefined, now), true);
  const exhausted = { ...STUCK, forumLinkRecoveryCount: FORUM_RECOVERY_CAP + FORUM_RECOVERY_SLOW_TRIES, forumLinkRecoveryAt: '2026-10-01T00:00:00Z' };
  assert.equal(isForumLinkRecoverable(exhausted, undefined, now), false);
  // An explicit cap stays a hard cap.
  assert.equal(isForumLinkRecoverable({ ...spent, forumLinkRecoveryAt: '2026-10-01T00:00:00Z' }, 2, now), false);
});
