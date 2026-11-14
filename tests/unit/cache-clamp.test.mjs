/**
 * BRO-2428: process-local freshness caches must not treat a future-dated
 * timestamp as fresh (`now - t < window` with no `t <= now` bound).
 * Run: node --test tests/unit/cache-clamp.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

for (const [name, lib, envVar] of [
  ['brightdata-caps', '../../scripts/lib/brightdata-caps.js', 'BD_BREAKER_STATE_PATH'],
  ['scrapingdog-caps', '../../scripts/lib/scrapingdog-caps.js', 'SD_BREAKER_STATE_PATH'],
  ['scrapingbee-caps', '../../scripts/lib/scrapingbee-caps.js', 'SB_BREAKER_STATE_PATH'],
]) {
  test(`${name}: state cache is refreshed when its timestamp is in the future`, () => {
    const caps = require(lib);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cache-clamp-')), 'state.json');
    const env = { [envVar]: file };
    fs.writeFileSync(file, JSON.stringify({ v: 1 }));
    caps._resetForTests();
    assert.deepEqual(caps.readBreakerState(env, 10_000), { v: 1 });
    fs.writeFileSync(file, JSON.stringify({ v: 2 }));
    // normal: inside the window, cached
    assert.deepEqual(caps.readBreakerState(env, 10_500), { v: 1 });
    // clock went backwards: cached `at` (10_000) is now in the future, must re-read
    assert.deepEqual(caps.readBreakerState(env, 5_000), { v: 2 });
  });
}

test('browserbase-session: both caches clamp ts <= now', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/browserbase-session.js', import.meta.url), 'utf8');
  assert.match(src, /_dayCapCache\.ts <= now && now - _dayCapCache\.ts < DAY_CAP_CACHE_TTL_MS/);
  assert.match(src, /_openingWindowCache\.ts <= now && now - _openingWindowCache\.ts < OPENING_WINDOW_CACHE_TTL_MS/);
});
