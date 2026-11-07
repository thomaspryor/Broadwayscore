// Regression lock for Piece 3 (silent-reversion guard): a committed manual
// contentTier override (manualContentTier) MUST survive re-classification, and a
// raw contentTier field MUST NOT (so manual fixes are forced to use the durable
// marker). Origin: 2026-06-01 — a manual `contentTier: invalid` 404 fix written
// WITHOUT manualContentTier was silently reverted to `truncated` by a rebuild
// re-classification. This test fails if classifyContentTier ever stops honoring
// manualContentTier, or if it starts trusting a raw contentTier field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyContentTier } = require('../../scripts/lib/content-quality.js');

// A body that would otherwise classify as a real (non-invalid) review.
const REAL_BODY = 'The revival of this Pulitzer-winning two-hander is superbly acted. '
  + 'Directed with precision, the staging is inventive and the performances electric '
  + 'throughout the evening at the theater. '.repeat(8);

test('manualContentTier overrides recompute (survives re-classification)', () => {
  const r = classifyContentTier({ fullText: REAL_BODY, manualContentTier: 'invalid' });
  assert.equal(r.contentTier, 'invalid', 'manual override must win over recompute');
  assert.match(r.tierReason, /Manual override/i);
});

test('manualContentTier is honored for every valid tier', () => {
  for (const tier of ['complete', 'truncated', 'excerpt', 'stub', 'invalid']) {
    const r = classifyContentTier({ fullText: REAL_BODY, manualContentTier: tier });
    assert.equal(r.contentTier, tier, `manualContentTier=${tier} must be honored`);
  }
});

test('a RAW contentTier field is NOT trusted (manual fixes must use the marker)', () => {
  // The 2026-06-01 bug: setting contentTier directly (no marker) is recomputed away.
  // This documents/locks the contract: manual overrides must set manualContentTier.
  const r = classifyContentTier({ fullText: REAL_BODY, contentTier: 'invalid' });
  assert.notEqual(r.contentTier, 'invalid',
    'raw contentTier must be ignored — only manualContentTier is durable');
});

test('an invalid manualContentTier value is ignored (no injection of bad tiers)', () => {
  const r = classifyContentTier({ fullText: REAL_BODY, manualContentTier: 'bogus-tier' });
  assert.ok(['complete', 'truncated', 'excerpt', 'stub', 'invalid'].includes(r.contentTier));
  assert.notEqual(r.contentTier, 'bogus-tier');
});
