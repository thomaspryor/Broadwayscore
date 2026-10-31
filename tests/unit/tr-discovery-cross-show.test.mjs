/**
 * theatre.reviews cross-show gate (opening-night-poller.js TR discovery).
 *
 * Incident 2026-06-04 (War Horse): theatre.reviews's WP-API search for "war horse"
 * returns the EQUUS roundup (equus-menier-reviews). The poller accepted it on the
 * weak "len>1000 + ⭑ + one title word" gate and attributed Equus reviews to War Horse.
 * The fix gates both TR acceptance points with verifyAggregatorUrl (the purpose-built
 * URL-stage show-match gate). This test pins that gate's behavior on the exact trap.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { verifyAggregatorUrl } = require('../../scripts/lib/show-match-verifier.js');

const WAR_HORSE = { id: 'war-horse-west-end-2026', title: 'War Horse', venue: 'National Theatre' };

describe('theatre.reviews cross-show gate', () => {
  test('REJECTS the Equus roundup when polling War Horse', () => {
    const url = 'https://theatre.reviews/reviews-roundup/equus-menier-reviews/';
    const html = '<html><head><title>Equus, Menier Chocolate Factory review roundup</title></head>' +
      '<body><p>5 stars ⭑⭑⭑⭑⭑</p><p>Equus at the Menier Chocolate Factory...</p></body></html>';
    const v = verifyAggregatorUrl({ url, html, show: WAR_HORSE, openingDate: '2026-06-02' });
    assert.equal(v.isValid, false, 'Equus roundup must not validate as War Horse');
  });

  test('ACCEPTS a real War Horse roundup', () => {
    const url = 'https://theatre.reviews/reviews-roundup/war-horse-national-theatre-reviews/';
    const html = '<html><head><title>War Horse, National Theatre review roundup</title></head>' +
      '<body><p>5 stars ⭑⭑⭑⭑⭑</p><p>War Horse returns to the Olivier...</p></body></html>';
    const v = verifyAggregatorUrl({ url, html, show: WAR_HORSE, openingDate: '2026-06-02' });
    assert.equal(v.isValid, true, `War Horse roundup should validate (got ${v.rejectReason})`);
  });
});
