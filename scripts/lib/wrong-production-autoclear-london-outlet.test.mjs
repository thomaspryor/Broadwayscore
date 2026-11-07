/**
 * Unit tests for shouldAutoClearStaleLondonOutletCrossMarket in
 * scripts/lib/wrong-production-autoclear.js: the reverse of the UK dual-market
 * self-heal. Stale "Cross-market: London outlet" flags on NYC shows, written
 * before the outlet was registered as dual-market (observer.com / NY Observer),
 * never re-checked (BRO-4185 follow-up).
 *
 * Run: node --test scripts/lib/wrong-production-autoclear-london-outlet.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldAutoClearStaleLondonOutletCrossMarket, ADJUDICATED_NOTE_PREFIX } = require('./wrong-production-autoclear');

const baseCtx = {
  isNycMarketShow: true,
  outletIsDualMarket: true,
  urlOnOutletPrimaryDomain: true,
  isUkUrl: false,
  isDateMismatch: false,
  isShowListingUrl: false,
  cvBlocksClear: false,
  inOwnProductionWindow: true,
  urlFiledUnderOtherShow: false,
};

// Rex Reed, Miss Saigon 2017: a NY Observer review filed on the NYC show,
// flagged while observer was still registered as a London outlet.
const reed = () => ({
  outletId: 'observer',
  criticName: 'Rex Reed',
  url: 'https://observer.com/2017/03/miss-saigon-review/',
  publishDate: 'March 24, 2017',
  wrongProduction: true,
  wrongProductionNote: 'Cross-market: London outlet "observer" reviewing broadway show',
});

describe('shouldAutoClearStaleLondonOutletCrossMarket', () => {
  it('clears a NY Observer review on its own US domain, inside its own run', () => {
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(reed(), baseCtx), true);
  });

  it('keeps UK Observer files: no URL, or a URL off the primary domain (theguardian.com)', () => {
    const noUrl = { ...reed(), url: null, criticName: 'Susannah Clapp' };
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(noUrl, baseCtx), false);
    const guardian = { ...reed(), url: 'https://www.theguardian.com/stage/2017/x' };
    assert.strictEqual(
      shouldAutoClearStaleLondonOutletCrossMarket(guardian, { ...baseCtx, urlOnOutletPrimaryDomain: false }), false);
  });

  it('keeps the flag when the URL is also filed under another production (Hello, Dolly! 1978/1995/2017)', () => {
    assert.strictEqual(
      shouldAutoClearStaleLondonOutletCrossMarket(reed(), { ...baseCtx, urlFiledUnderOtherShow: true }), false);
  });

  it('keeps the flag when the publish date is outside this production\'s run (or unknown)', () => {
    assert.strictEqual(
      shouldAutoClearStaleLondonOutletCrossMarket(reed(), { ...baseCtx, inOwnProductionWindow: false }), false);
  });

  it('only touches the stale London-outlet note', () => {
    const other = { ...reed(), wrongProductionNote: 'Same URL exists in x which is closer to review year 2017' };
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(other, baseCtx), false);
  });

  it('respects every existing blocker', () => {
    const cases = [
      [{ ...reed(), wrongProductionOverride: true }, baseCtx],
      [{ ...reed(), wrongProductionReason: 'manual' }, baseCtx],
      [{ ...reed(), wrongProductionNote: ADJUDICATED_NOTE_PREFIX + ' x' }, baseCtx],
      [reed(), { ...baseCtx, isNycMarketShow: false }],
      [reed(), { ...baseCtx, outletIsDualMarket: false }],
      [reed(), { ...baseCtx, isUkUrl: true }],
      [reed(), { ...baseCtx, isDateMismatch: true }],
      [reed(), { ...baseCtx, isShowListingUrl: true }],
      [reed(), { ...baseCtx, cvBlocksClear: true }],
    ];
    for (const [d, ctx] of cases) {
      assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(d, ctx), false, JSON.stringify({ d, ctx }));
    }
  });
});

// BRO-5896: a US outlet the BRO-133 backfill wrongly stamped london, since
// corrected to a Broadway-local region (or cleared by hand / retraction), is not
// dual-market. Its stale flags clear when the caller says the region is
// explicitly not London; the plain region-less default never qualifies.
describe('non-dual outlet with a corrected Broadway-local region (BRO-5896)', () => {
  const outinjersey = () => ({
    outletId: 'outinjersey',
    url: 'https://outinjersey.net/broadway-review-some-show/',
    publishDate: 'May 1, 2024',
    wrongProduction: true,
    wrongProductionNote: 'Cross-market: London outlet "outinjersey" reviewing broadway show',
  });

  it('clears when outletRegionNotLondon is true', () => {
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(outinjersey(),
      { ...baseCtx, outletIsDualMarket: false, outletRegionNotLondon: true }), true);
  });

  it('keeps the flag when neither dual-market nor explicitly non-London', () => {
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(outinjersey(),
      { ...baseCtx, outletIsDualMarket: false, outletRegionNotLondon: false }), false);
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(outinjersey(),
      { ...baseCtx, outletIsDualMarket: false }), false);
  });

  it('every other gate still applies on the new path', () => {
    const ctx = { ...baseCtx, outletIsDualMarket: false, outletRegionNotLondon: true };
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(outinjersey(), { ...ctx, isUkUrl: true }), false);
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(outinjersey(), { ...ctx, urlOnOutletPrimaryDomain: false }), false);
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(outinjersey(), { ...ctx, urlFiledUnderOtherShow: true }), false);
    assert.strictEqual(shouldAutoClearStaleLondonOutletCrossMarket(outinjersey(), { ...ctx, inOwnProductionWindow: false }), false);
  });
});
