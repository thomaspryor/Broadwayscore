/**
 * BRO-3238 — classifyTierWriteBack() decides what rebuild-all-reviews.js and
 * the sync-content-tier-reason-2026-10 backfill write back. The case that
 * used to be lost: right tier, stale reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTierWriteBack } = require('./content-tier-reason-sync.js');
const { classifyContentTier } = require('./content-quality.js');
const { applyPaywallTierOverride } = require('./paywall-completeness.js');

const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ') + '.';
const base = {
  showId: 'some-show-2024', outlet: 'Some Outlet', criticName: 'A Critic',
  url: 'https://example.com/review', fullText: words(700),
};
const current = (r) => applyPaywallTierOverride(r, classifyContentTier(r));

test('same tier + stale reason -> reasonOnlyChanged', () => {
  const now = current(base);
  const r = { ...base, contentTier: now.contentTier, contentTierReason: 'Old classifier wording (v1)' };
  const d = classifyTierWriteBack(r);
  assert.equal(d.tierChanged, false);
  assert.equal(d.reasonOnlyChanged, true);
  assert.equal(d.tierResult.tierReason, now.tierReason);
});

test('same tier + current reason -> nothing to write', () => {
  const now = current(base);
  const d = classifyTierWriteBack({ ...base, contentTier: now.contentTier, contentTierReason: now.tierReason });
  assert.equal(d.tierChanged, false);
  assert.equal(d.reasonOnlyChanged, false);
});

test('missing or different tier -> tierChanged (full write-back), never reasonOnlyChanged', () => {
  const missing = classifyTierWriteBack({ ...base });
  assert.equal(missing.tierChanged, true);
  assert.equal(missing.reasonOnlyChanged, false);
  const wrong = classifyTierWriteBack({ ...base, contentTier: 'stub', contentTierReason: 'x' });
  assert.equal(wrong.tierChanged, current(base).contentTier !== 'stub');
  assert.equal(wrong.reasonOnlyChanged, false);
});

test('a manualContentTier record syncs to the manual-override reason', () => {
  const r = { ...base, manualContentTier: 'excerpt', contentTier: 'excerpt', contentTierReason: 'stale' };
  const d = classifyTierWriteBack(r);
  assert.equal(d.tierResult.contentTier, current(r).contentTier);
  if (!d.tierChanged) {
    assert.equal(d.reasonOnlyChanged, true);
    assert.equal(d.tierResult.tierReason, current(r).tierReason);
  }
});

test('null and undefined reasons compare equal', () => {
  const now = current(base);
  if (now.tierReason == null) {
    const d = classifyTierWriteBack({ ...base, contentTier: now.contentTier });
    assert.equal(d.reasonOnlyChanged, false);
  } else {
    const d = classifyTierWriteBack({ ...base, contentTier: now.contentTier });
    assert.equal(d.reasonOnlyChanged, true, 'a missing reason is stale when the classifier has one');
  }
});
