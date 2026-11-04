// BRO-6924: a manually cleared wrong_content review fetches its stored url.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { needsSerpUrlDiscovery } = require('../../scripts/lib/serp-discovery-gate.js');

const url = 'https://www.thetimes.com/culture/classical-opera/article/tosca-review-london-coliseum-nqwpdjr9t';

test('wrong_content still searches by default', () => {
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: 'wrong_content', url }), true);
});
test('a manual clear with a stored url fetches that url', () => {
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: 'wrong_content', url, wrongProductionManualClear: true }), false);
});
test('a manual clear beside a live wrong flag still searches', () => {
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: 'wrong_content', url, wrongProductionManualClear: true, wrongProduction: true }), true);
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: 'wrong_content', url, wrongProductionManualClear: true, wrongShow: true }), true);
});
test('a manual clear with no url still searches', () => {
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: 'wrong_content', wrongProductionManualClear: true }), true);
});
test('no_url and fabricated always search; dateless hold never does', () => {
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: 'no_url', wrongProductionManualClear: true, url }), true);
  assert.equal(needsSerpUrlDiscovery({ fabricatedEntry: true, url }), true);
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: 'no_url', _datelessDateRetry: true }), false);
  assert.equal(needsSerpUrlDiscovery({ incompleteReason: null, url }), false);
});
