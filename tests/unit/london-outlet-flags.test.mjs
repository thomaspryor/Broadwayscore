/**
 * BRO-6994: Observer (NY Observer) reviews of NYC shows held as "Cross-market:
 * London outlet". The reverse self-heal needs the review inside the show's own
 * production window, but 38 observer.com files had no publishDate, so they
 * never released. isInOwnWindowByDateOrUrlYear falls back to the URL date/year.
 *
 * Run: node --test tests/unit/london-outlet-flags.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isInOwnWindowByDateOrUrlYear,
  shouldAutoClearStaleLondonOutletCrossMarket,
} = require('../../scripts/lib/wrong-production-autoclear');

const show2024 = { id: 'eureka-day-2024', previewsStartDate: '2024-03-20', openingDate: '2024-04-18', closingDate: '2024-06-30' };
const OBS = 'https://observer.com/2024/04/eureka-day-broadway-review/';

describe('isInOwnWindowByDateOrUrlYear', () => {
  it('uses publishDate when present (in and out of window)', () => {
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, '2024-04-19', OBS), true);
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, '2016-12-09', OBS), false);
  });
  it('null publishDate: full URL date decides', () => {
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, null, 'https://x.com/2024/04/19/eureka-day/'), true);
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, null, 'https://x.com/2019/04/19/eureka-day/'), false);
  });
  it('null publishDate: URL year inside the show window counts', () => {
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, undefined, 'https://observer.com/2024/culture/eureka-day'), true);
  });
  it('null publishDate: URL year outside the window does not (old-production copy)', () => {
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, null, 'https://observer.com/2016/culture/eureka-day'), false);
  });
  it('no date, no URL year, or no show: false', () => {
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, null, 'https://observer.com/culture/eureka-day'), false);
    assert.equal(isInOwnWindowByDateOrUrlYear(show2024, null, null), false);
    assert.equal(isInOwnWindowByDateOrUrlYear(null, null, OBS), false);
  });
});

describe('Observer NYC review with null publishDate releases end to end', () => {
  const data = {
    wrongProduction: true,
    wrongProductionNote: 'Cross-market: London outlet "observer" reviewing broadway show',
    url: OBS,
    publishDate: null,
  };
  const ctxFor = (d, url) => ({
    isNycMarketShow: true,
    outletIsDualMarket: true,
    urlOnOutletPrimaryDomain: true,
    isUkUrl: false,
    isDateMismatch: false,
    isShowListingUrl: false,
    cvBlocksClear: false,
    inOwnProductionWindow: isInOwnWindowByDateOrUrlYear(show2024, d.publishDate, url),
    urlFiledUnderOtherShow: false,
  });
  it('releases (was held before the fix)', () => {
    assert.equal(shouldAutoClearStaleLondonOutletCrossMarket(data, ctxFor(data, data.url)), true);
  });
  it('stays held when the URL is filed under another show', () => {
    assert.equal(shouldAutoClearStaleLondonOutletCrossMarket(data, { ...ctxFor(data, data.url), urlFiledUnderOtherShow: true }), false);
  });
  it('UK Observer file (no URL, Theatre Record) stays held', () => {
    const uk = { ...data, url: null, publishDate: '2021-12-12' };
    assert.equal(shouldAutoClearStaleLondonOutletCrossMarket(uk, { ...ctxFor(uk, null), inOwnProductionWindow: false }), false);
  });
  it('old-production URL year stays held', () => {
    const old = { ...data, url: 'https://observer.com/2016/culture/eureka-day' };
    assert.equal(shouldAutoClearStaleLondonOutletCrossMarket(old, ctxFor(old, old.url)), false);
  });
});
