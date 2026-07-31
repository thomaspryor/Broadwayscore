import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Requiring the script must NOT trigger a live sweep (require.main guard).
const { probeUrl, isVenueSiteHost } = require('./enrich-fallback-ticket-links.js');

function stub(map) {
  return async (url) => map[url] || { status: 404 };
}

test('probeUrl: 2xx on allowlisted platform host passes', async () => {
  const ok = await probeUrl('https://www.todaytix.com/nyc/shows/1-foo', 1000, stub({
    'https://www.todaytix.com/nyc/shows/1-foo': { status: 200 },
  }));
  assert.equal(ok, true);
});

test('probeUrl: 2xx on non-allowlisted host fails (redirect landed off-allowlist)', async () => {
  const ok = await probeUrl('https://www.todaytix.com/x', 1000, stub({
    'https://www.todaytix.com/x': { status: 302, location: 'https://random-landing.com/promo' },
    'https://random-landing.com/promo': { status: 200 },
  }));
  assert.equal(ok, false);
});

test('probeUrl: follows redirect chain to allowlisted 2xx', async () => {
  const ok = await probeUrl('https://todaytix.com/x', 1000, stub({
    'https://todaytix.com/x': { status: 301, location: 'https://www.todaytix.com/x' },
    'https://www.todaytix.com/x': { status: 200 },
  }));
  assert.equal(ok, true);
});

test('probeUrl: 403 passes only for first-party venue sites', async () => {
  const venue403 = await probeUrl('https://www.marylebonetheatre.com/productions/x', 1000, stub({
    'https://www.marylebonetheatre.com/productions/x': { status: 403 },
  }));
  assert.equal(venue403, true);
  const platform403 = await probeUrl('https://www.todaytix.com/x', 1000, stub({
    'https://www.todaytix.com/x': { status: 403 },
  }));
  assert.equal(platform403, false);
});

test('probeUrl: 404/410/5xx and redirect loops fail', async () => {
  assert.equal(await probeUrl('https://www.todaytix.com/gone', 1000, stub({
    'https://www.todaytix.com/gone': { status: 404 },
  })), false);
  assert.equal(await probeUrl('https://www.todaytix.com/err', 1000, stub({
    'https://www.todaytix.com/err': { status: 500 },
  })), false);
  // Infinite 301 loop exhausts the 4-hop cap
  assert.equal(await probeUrl('https://www.todaytix.com/a', 1000, stub({
    'https://www.todaytix.com/a': { status: 301, location: 'https://www.todaytix.com/b' },
    'https://www.todaytix.com/b': { status: 301, location: 'https://www.todaytix.com/a' },
  })), false);
});

test('probeUrl: malformed and non-https URLs fail without throwing', async () => {
  assert.equal(await probeUrl('not a url', 1000), false);
  assert.equal(await probeUrl('http://www.todaytix.com/x', 1000), false);
});

test('isVenueSiteHost matches venue domains and subdomains only', () => {
  assert.equal(isVenueSiteHost('https://www.bam.org/theater/2026/x'), true);
  assert.equal(isVenueSiteHost('https://tickets.marylebonetheatre.com/shop'), true);
  assert.equal(isVenueSiteHost('https://www.todaytix.com/x'), false);
  assert.equal(isVenueSiteHost('https://evil-bam.org.attacker.com/x'), false);
});

// The live-network smoke test lives in enrich-fallback-ticket-links.live.test.mjs,
// which runs in test.yml's continue-on-error network-dependent step — never in
// this blocking batch (second-opinion review: third-party flake must not gate
// every push to main).
