// BRO-6091: push-with-retry.sh's restore-protected-fields put the OLD video's
// wrongProduction flag back on 11 video transcript files that
// select-best-reviews.js had re-pointed at a different video, and a
// verify-productions.js stale-date clear came back the same way.
// require()s the real reconcile and guard (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reconcileProtectedFields } = require('../../scripts/lib/restore-protected-fields.js');
const { isIntentionalClear } = require('../../scripts/lib/review-write-guard.js');

// Shapes from titanique-2026/mickeyjotheatre.json before and after the 2026-10-24 run.
const oldPick = {
  creatorId: 'mickeyjotheatre', platform: 'youtube', videoId: 'EXHj1jpni5Y', score: 85,
  wrongProduction: true, wrongProductionReason: 'The transcript is a discussion about the announcement',
};
const newPick = {
  creatorId: 'mickeyjotheatre', platform: 'youtube', videoId: '9B4FmehGpAg',
  videoUrl: 'https://www.youtube.com/watch?v=9B4FmehGpAg', score: 91,
  productionCheck: { verdict: 'same' }, selection: { method: 'llm' },
};

test('a re-pointed video file does not get the old video\'s flag back', () => {
  const local = structuredClone(newPick);
  reconcileProtectedFields(local, structuredClone(oldPick), null);
  assert.equal(local.wrongProduction, undefined);
  assert.equal(local.wrongProductionReason, undefined);
});

test('same video, flag dropped by accident: the flag is still restored', () => {
  const local = { ...structuredClone(oldPick) };
  delete local.wrongProduction;
  delete local.wrongProductionReason;
  reconcileProtectedFields(local, structuredClone(oldPick), null);
  assert.equal(local.wrongProduction, true);
});

test('same video, verify-productions stale-date clear with its breadcrumb stays cleared', () => {
  const local = { ...structuredClone(oldPick), wrongProductionAutoCleared: 'verify-productions: earlier run of the same production recorded', wrongProductionAutoClearedAt: new Date().toISOString() };
  delete local.wrongProduction;
  delete local.wrongProductionReason;
  reconcileProtectedFields(local, structuredClone(oldPick), null);
  assert.equal(local.wrongProduction, undefined);
});

test('guard: only verdict fields, only when the video differs', () => {
  assert.equal(isIntentionalClear('wrongProduction', newPick, oldPick), true);
  assert.equal(isIntentionalClear('wrongProduction', { ...oldPick, wrongProduction: undefined }, oldPick), false);
  assert.equal(isIntentionalClear('humanReviewScore', newPick, { ...oldPick, humanReviewScore: 70 }), false);
  // same id on another platform is another video
  assert.equal(isIntentionalClear('wrongProduction', { ...oldPick, platform: 'tiktok' }, oldPick), true);
  // review-text files carry no videoId: unaffected
  assert.equal(isIntentionalClear('wrongProduction', { url: 'https://a.com/x' }, { url: 'https://a.com/x', wrongProduction: true }), false);
});
