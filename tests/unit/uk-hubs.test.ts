/** Beyond London city filter hubs (BRO-6516): real src/lib/uk-hubs.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ukHubForCity, ukHubFilterOptions, OTHER_UK_HUB } from '../../src/lib/uk-hubs';

test('metro slugs map to their UK hub, the rest to Elsewhere', () => {
  assert.equal(ukHubForCity('manchester-uk'), 'manchester');
  assert.equal(ukHubForCity('sheffield-uk'), 'yorkshire');
  assert.equal(ukHubForCity('pitlochry-uk'), 'scotland');
  assert.equal(ukHubForCity('edinburgh-uk'), OTHER_UK_HUB);
  assert.equal(ukHubForCity('chicago-il'), OTHER_UK_HUB);
  assert.equal(ukHubForCity(null), OTHER_UK_HUB);
});

test('options cover only hubs present, in table order, Elsewhere last', () => {
  const opts = ukHubFilterOptions(['scotland', OTHER_UK_HUB, 'manchester', 'manchester']);
  assert.deepEqual(opts.map(o => o.value), ['manchester', 'scotland', OTHER_UK_HUB]);
  assert.equal(opts[0].label, 'Manchester');
  assert.deepEqual(ukHubFilterOptions([]), []);
});
