// BRO-224: the live West End aggregator is westendtheatre.COM; the guard must carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AGGREGATOR_DOMAINS, isAggregatorUrlMismatch } = require('./aggregator-domains.js');

test('AGGREGATOR_DOMAINS carries westendtheatre.com (BRO-224)', () => {
  assert.ok(AGGREGATOR_DOMAINS.has('westendtheatre.com'));
});

test('real-outlet id on a westendtheatre.com URL is flagged; the aggregator id is not', () => {
  const url = 'https://www.westendtheatre.com/reviews-roundup/x/';
  assert.equal(isAggregatorUrlMismatch(url, 'guardian'), true);
  assert.equal(isAggregatorUrlMismatch(url, 'westendtheatre'), false);
});
