// BRO-8330: HTML-scoped tier skips must not silence the JSON API of the same host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getSkippedTiers } = require('./domain-tier-skip.js');
const config = require('../config/domain-tier-skip.json');

test('scope:html entry skips for pages but not for json', () => {
  const cfg = { 'x.com': { scrapingdog: { skip: true, scope: 'html' }, brightdata: { skip: true } } };
  assert.deepEqual([...getSkippedTiers(cfg, 'x.com')].sort(), ['brightdata', 'scrapingdog']);
  assert.deepEqual([...getSkippedTiers(cfg, 'x.com', 'json')], ['brightdata']);
});

test('theatre.reviews: SD stays skipped for HTML round-ups, tried for wp-json', () => {
  assert.ok(getSkippedTiers(config, 'theatre.reviews').has('scrapingdog'));
  assert.ok(!getSkippedTiers(config, 'theatre.reviews', 'json').has('scrapingdog'));
});

test('class guard: every hand-written SD skip whose reason talks about guessed page URLs is scoped html', () => {
  const bad = Object.entries(config).filter(([, v]) => v && !Array.isArray(v) && v.scrapingdog && v.scrapingdog.skip
    && /guess/i.test(v.scrapingdog.reason || '') && !/^\d+ failures, 0 successes$/.test(v.scrapingdog.reason || '')
    && v.scrapingdog.scope !== 'html').map(([d]) => d);
  assert.deepEqual(bad, [], `page-URL-based SD skips without scope:html: ${bad.join(', ')}`);
});
