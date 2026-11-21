/**
 * BRO-6909: a copy its own show disowned as another production gives the URL up.
 *
 * ENO's Tosca (London Coliseum, opened 2026-10-30) counted 3 reviews while 12
 * London reviews (FT, Telegraph, Times, Guardian, The Stage...) sat under the
 * Met's Tosca (2026-11-01), rejected there as wrong_production. Same year on
 * both sides, so first-writer-wins in gather-reviews kept every one of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { existingCopyYieldsUrl } = require('../../scripts/lib/url-cross-production.js');

const FT_UNDER_MET = {
  showId: 'tosca-off-broadway-2026', outletId: 'financial-times', contentTier: 'complete',
  rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check',
};

test('a copy rejected as wrong production yields the URL', () => {
  assert.equal(existingCopyYieldsUrl(FT_UNDER_MET), true);
  assert.equal(existingCopyYieldsUrl({ contentTier: 'complete', wrongProduction: true }), true);
});

test('a manual clear or override keeps the URL with its holder', () => {
  for (const hatch of [{ wrongProductionManualClear: true }, { wrongProductionOverride: true }, { allowCrossMarket: true }, { humanReviewedWrongProduction: false }]) {
    assert.equal(existingCopyYieldsUrl({ ...FT_UNDER_MET, ...hatch }), false, JSON.stringify(hatch));
  }
});

test('a healthy copy keeps the URL', () => {
  assert.equal(existingCopyYieldsUrl({ contentTier: 'complete' }), false);
  assert.equal(existingCopyYieldsUrl({ contentTier: 'complete', wrongProduction: false, rejectionReason: 'stub' }), false);
  assert.equal(existingCopyYieldsUrl(null), false);
});

test('the old junk conditions still yield', () => {
  for (const d of [{ contentTier: 'invalid' }, { wrongShow: true }, { incompleteReason: 'wrong_content' },
    { incompleteReason: 'scraper_garbage' }, { contentVerification: { wrongArticle: true, confidence: 'medium' } }]) {
    assert.equal(existingCopyYieldsUrl(d), true, JSON.stringify(d));
  }
});
