import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { countReviewsByShow, buildSyncRows } = createRequire(import.meta.url)('../../scripts/lib/score-call-forecasts.js');

test('countReviewsByShow reads the real flat reviews.json shape and fails loudly otherwise', () => {
  assert.deepEqual(countReviewsByShow({ _meta: {}, reviews: [{ showId: 'a' }, { showId: 'a' }, { showId: 'b' }] }), { a: 2, b: 1 });
  assert.throws(() => countReviewsByShow({ reviews: { a: [1] } }));
  assert.throws(() => countReviewsByShow({ reviews: [] }));
  assert.throws(() => countReviewsByShow(null));
});

test('buildSyncRows: frozen pre-opening forecast, reviews_live from counts, no row without a forecast', () => {
  const shows = [{ id: 's', category: 'broadway', type: 'musical', status: 'previews', openingDate: '2099-01-10' }];
  const ledger = [{ showId: 's', recordedAt: '2098-12-01', forecast: 71.4, lo80: 55, hi80: 88 }, { showId: 's', recordedAt: '2098-12-20', forecast: 72.2, lo80: 56, hi80: 87 }];
  const [r] = buildSyncRows({ shows, ledgerRows: ledger, today: '2098-12-25', reviewCounts: { s: 3 } });
  assert.equal(r.p_forecast, 72); assert.equal(r.p_reviews_live, true);
  assert.equal(buildSyncRows({ shows, ledgerRows: [], today: '2098-12-25' }).length, 0);
});
