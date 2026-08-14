/**
 * BRO-254: outletId 'westend' is a real, legitimate West End review outlet
 * (westend.com — has its own byline files across multiple shows), but it had
 * no entry in data/outlet-registry.json. Confirmed corpus evidence:
 * now-you-see-me-live-west-end-2026/westend--unknown.json,
 * allegra-west-end-2026/westend--peter-quilter.json,
 * the-gruffalo-west-end-2026/westend--unknown.json all carry
 * wrongProductionNote: 'Cross-market: US outlet "westend" reviewing London show'.
 *
 * Exactly HOW those 3 files got flagged is unresolved: with the codebase's
 * CURRENT unregistered-outlet bootstrap exemption (task #817), an
 * unregistered 'westend' would NOT be flagged (the "regression guard" test
 * below proves this) — so either they were flagged by a run that predates
 * that exemption, or by a stale/partial checkout (a known recurring class
 * of pipeline bug in this repo). The precise mechanism doesn't change the
 * fix: an outlet with no registry entry is fragile regardless of which
 * historical code path flagged it — one stale-checkout race, one revert of
 * the #817 exemption, or one future refactor of that fallback and the same
 * outlet is exposed again.
 *
 * Root cause: no registry entry for 'westend' (region-less), and its
 * domain (westend.com) has no UK-looking substring for the URL fallback
 * to catch, so the forward cross-market guard (rebuild-all-reviews.js,
 * extracted to lib/cross-market-guard.js) has no reliable signal that it's
 * a London outlet. Fix: register 'westend' explicitly with region: 'london'
 * (data/outlet-registry.json) so the region lookup — the guard's primary,
 * first-checked signal — resolves correctly on its own, independent of
 * URL shape or the unregistered-outlet bootstrap exemption.
 *
 * Run: node --test scripts/lib/westend-outlet-cross-market-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  buildOutletRegionMap,
  buildRegisteredOutletIds,
  evaluateForwardCrossMarketGuard,
} = require('./cross-market-guard.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
const outletRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const outletRegionMap = buildOutletRegionMap(outletRegistry);
const registeredOutletIds = buildRegisteredOutletIds(outletRegistry);

test('outlet-registry.json declares westend as a london-region outlet', () => {
  assert.equal(outletRegionMap['westend'], 'london');
  assert.ok(registeredOutletIds.has('westend'));
});

// The exact 3 corpus files affected by the bug (task #1266 dogfooding evidence).
const REAL_WESTEND_URLS = [
  'https://www.westend.com/shows/now-you-see-me-live/',
  'https://www.westend.com/shows/allegra/',
  'https://www.westend.com/shows/the-gruffalo/',
];

for (const url of REAL_WESTEND_URLS) {
  test(`real westend outlet review (${url}) is never flagged wrongProduction by the cross-market guard`, () => {
    const verdict = evaluateForwardCrossMarketGuard({
      outletRegionMap,
      registeredOutletIds,
      canonicalOutlet: 'westend',
      rawOutlet: 'westend',
      url,
      contentVerification: undefined,
    });
    assert.equal(verdict.shouldFlag, false);
    assert.equal(verdict.reason, null);
  });
}

test('the westend.com domain itself does not look UK by URL shape (proves the registry entry, not the URL fallback, is what protects it)', () => {
  const hostname = new URL('https://www.westend.com/shows/allegra/').hostname;
  assert.ok(!hostname.endsWith('.co.uk'));
  assert.ok(!hostname.endsWith('.org.uk'));
  assert.ok(!hostname.includes('london'));
  assert.ok(!hostname.includes('theatre'));
});

test('regression guard: a genuinely unregistered US outlet with no UK URL IS flagged (proves the guard is not a no-op)', () => {
  const verdict = evaluateForwardCrossMarketGuard({
    outletRegionMap: {},
    registeredOutletIds: new Set(['nypost']), // registered, region-less (US national)
    canonicalOutlet: 'nypost',
    rawOutlet: 'nypost',
    url: 'https://nypost.com/theater/some-broadway-review/',
    contentVerification: undefined,
  });
  assert.equal(verdict.shouldFlag, true);
  assert.match(verdict.reason, /Cross-market: US outlet "nypost" reviewing London show/);
});

test('regression guard: simulating the original bug (westend removed from the registry) still self-protects via the unregistered-outlet bootstrap exemption (task #817)', () => {
  const regionlessMap = { ...outletRegionMap };
  delete regionlessMap['westend'];
  const unregisteredIds = new Set(registeredOutletIds);
  unregisteredIds.delete('westend');

  const verdict = evaluateForwardCrossMarketGuard({
    outletRegionMap: regionlessMap,
    registeredOutletIds: unregisteredIds,
    canonicalOutlet: 'westend',
    rawOutlet: 'westend',
    url: 'https://www.westend.com/shows/allegra/',
    contentVerification: undefined,
  });
  assert.equal(verdict.shouldFlag, false);
});
