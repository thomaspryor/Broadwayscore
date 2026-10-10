// Regression: homepage Tony-predictions + Beat-the-Critics promos must HIDE
// themselves once the season rolls past a ceremony. The 2026-2027 rollover
// (2026-06) left both promos live for two weeks because the old fallback
// returned "active" when the new season had no ceremonyDate record yet, while
// the promos still linked to last season's predictions page.
//
// We test the pure decision (isPromoActiveForCeremony) so the contract holds
// regardless of which Tony season is "current" at test time.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPromoActiveForCeremony } from '../../src/lib/data-tony-predictions';

const CEREMONY = '2026-06-07'; // 23:59:59Z deadline
const before = new Date('2026-06-01T00:00:00Z');
const justAfterDeadline = new Date('2026-06-08T00:00:00Z');
const day3 = new Date('2026-06-10T12:00:00Z'); // > deadline + 2 sunset days

describe('isPromoActiveForCeremony', () => {
  it('is INACTIVE when the ceremony date is unknown (the rollover bug)', () => {
    // The whole point of the fix: no date record ⇒ nothing to promote.
    assert.equal(isPromoActiveForCeremony(undefined, before, 2), false);
    assert.equal(isPromoActiveForCeremony(undefined, before, 0), false);
  });

  it('Tony promo (sunsetDays=2): active before, through the 2-day tail, off after', () => {
    assert.equal(isPromoActiveForCeremony(CEREMONY, before, 2), true);
    // ceremony day + ~1 day is still inside the 2-day sunset window
    assert.equal(isPromoActiveForCeremony(CEREMONY, justAfterDeadline, 2), true);
    assert.equal(isPromoActiveForCeremony(CEREMONY, day3, 2), false);
  });

  it('BTC gate (sunsetDays=0): closes exactly at the ceremony-day deadline', () => {
    assert.equal(isPromoActiveForCeremony(CEREMONY, before, 0), true);
    // 1s before deadline → open; 1s after → closed
    assert.equal(
      isPromoActiveForCeremony(CEREMONY, new Date('2026-06-07T23:59:59Z'), 0),
      true,
    );
    assert.equal(
      isPromoActiveForCeremony(CEREMONY, new Date('2026-06-08T00:00:01Z'), 0),
      false,
    );
  });
});
