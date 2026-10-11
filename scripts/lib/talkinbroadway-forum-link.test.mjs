import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isForumLinkRecoverable, FORUM_RECOVERY_CAP } = require('./talkinbroadway-forum-link.js');
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
