/**
 * BRO-8262: when the cheap listing misses but a paid listing is already in the
 * anchor memo (a canary or forced probe within the TTL), the gate consults it
 * for free instead of returning not-found. No network: the gate is forced on
 * (paidCanary:false) so an empty memo returns not-found without a paid call.
 *
 * Run: node --test tests/unit/bww-rr-discover-cached-paid.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bww-anchors-test-'));
process.env.BWW_ANCHOR_CACHE_DIR = dir;
const { discoverBwwRoundupUrl } = require('../../scripts/lib/bww-rr-discover.js');
const { createTtlCache } = require('../../scripts/lib/ttl-cache.js');

const show = { title: 'Seven Guitars', openingDate: '2026-11-20', category: 'broadway' };
const OTHER = 'https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-On-SOME-OTHER-SHOW-20261120';
const HIT = 'https://www.broadwayworld.com/article/Review-Roundup-Critics-Weigh-In-On-SEVEN-GUITARS-20261120';
const run = () => discoverBwwRoundupUrl(show, {
  paidCanary: false,
  fetchSectionAnchors: async () => [],
  fetchCheapAnchors: async () => [OTHER],
});

describe('BRO-8262 gate consults a cached paid listing', () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('empty memo: confident cheap miss, no paid call', async () => {
    const r = await run();
    assert.strictEqual(r.via, 'not-found');
    assert.strictEqual(r.tier, 'cheap-listing');
  });

  it('memo holds a paid listing with the show: uses it', async () => {
    const cache = createTtlCache({ dir, ttlMs: 15 * 60 * 1000 });
    cache.set('reviews.php', {}, [OTHER, HIT]);
    const r = await run();
    assert.strictEqual(r.via, 'reviews.php');
    assert.strictEqual(r.url, HIT);
  });
});
