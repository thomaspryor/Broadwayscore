// BRO-5993: the lane's configurable sources default to the regular pipeline's feeds and the tier-1/2 outlets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/default-adapters.js');

const REG = { outlets: {
  nytimes: { tier: 1, domain: 'nytimes.com' }, vulture: { tier: 1, domain: 'vulture.com' },
  chicagotribune: { tier: 2, domain: 'chicagotribune.com', region: 'chicago' }, guardian: { tier: 1, domain: 'theguardian.com', region: 'london' },
  stage: { tier: 2, domain: 'thestage.co.uk', region: 'london' }, blog: { tier: 3, domain: 'blog.example' }, nodomain: { tier: 1 },
} };

test('Broadway: tier 1 before tier 2, no London-only outlets, no tier 3, nothing without a domain', () => {
  assert.deepEqual(d.defaultMissingOutlets({ category: 'broadway' }, REG), ['nytimes', 'vulture', 'chicagotribune']);
});

test('West End: London and dual-market outlets only', () => {
  assert.deepEqual(d.defaultMissingOutlets({ category: 'west-end' }, REG), ['guardian', 'stage']);
});

test('feeds follow the market, and an explicit config overrides a key', () => {
  const bw = d.defaultFeeds({ category: 'broadway' });
  assert.ok(bw.length > 5 && bw.every((f) => f.url && f.outletId));
  const cfg = d.laneAdaptersConfig({ category: 'broadway' }, { feeds: [] });
  assert.deepEqual(cfg.feeds, []);
  assert.ok(cfg.missingOutlets.includes('vulture') && cfg.missingOutlets.includes('chicagotribune'), 'the two outlets the Oct 22 shadow run never found');
});
