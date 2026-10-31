import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outlets } = require('../../data/outlet-registry.json');
const { standingOutletIds, standingOutletsSource } = require('../../scripts/lib/standing-outlets.js');

// BRO-5452: measured coverage qualifies both outlets for Broadway standing
// coverage. Guard the registry configuration without pinning changing rates.
for (const outletId of ['cititour', 'theater-scene']) {
  test(`${outletId} contributes standing census expectations only on Broadway`, () => {
    assert.equal(outlets[outletId].standingCoverage, true);
    assert.deepEqual(outlets[outletId].standingMarkets, ['broadway']);
    assert.ok(standingOutletIds(outlets, 'broadway').includes(outletId));
    assert.ok(standingOutletsSource('probe-show', { outlets, market: 'broadway' })
      .some((row) => row.outletId === outletId));
    assert.ok(!standingOutletIds(outlets, 'west-end').includes(outletId));
    assert.ok(!standingOutletsSource('probe-show', { outlets, market: 'west-end' })
      .some((row) => row.outletId === outletId));
  });
}
