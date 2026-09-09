/**
 * data/outlet-registry.json schema consistency (BRO-46).
 *
 * The T3→T4 demotion (commit b4716e1d01, 2026-05-16) added tier-4 outlets
 * to the registry. VALID_TIERS was canonicalized the same day
 * (tests/unit/tier-config-consistency.test.ts) so config-side tier arrays
 * derive from TIER_WEIGHTS instead of a stale hardcoded [1, 2, 3] literal —
 * but the registry DATA itself (data/outlet-registry.json) had no direct
 * regression test pinning it against that canonical list. This closes that
 * gap: it validates the live registry file, not just the config helper.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { VALID_TIERS } = require(resolve(ROOT, 'scripts/lib/outlet-tiers.js'));
const { CV_STYLES, findInvalidCvStyles, countArmedCvStyles } = require(
  resolve(ROOT, 'scripts/lib/outlet-canonicalize.js')
);

const registry = JSON.parse(readFileSync(resolve(ROOT, 'data', 'outlet-registry.json'), 'utf8'));

describe('outlet-registry.json tier schema', () => {
  test('VALID_TIERS includes tier 4 (regression guard against a stale [1,2,3] literal)', () => {
    assert.ok(VALID_TIERS.includes(4), `VALID_TIERS must include 4, got ${JSON.stringify(VALID_TIERS)}`);
  });

  test('every outlet.tier is in VALID_TIERS', () => {
    const invalid = [];
    for (const [id, outlet] of Object.entries(registry.outlets)) {
      if (outlet.tier != null && !VALID_TIERS.includes(outlet.tier)) {
        invalid.push(`${id}: invalid tier ${outlet.tier} (valid: ${VALID_TIERS.join(',')})`);
      }
    }
    assert.deepEqual(invalid, [], `Outlets with invalid tier:\n  ${invalid.join('\n  ')}`);
  });

  test('tier-4 outlets (forward, theater-pizzazz) validate cleanly', () => {
    for (const id of ['forward', 'theater-pizzazz']) {
      const outlet = registry.outlets[id];
      assert.ok(outlet, `${id} should exist in outlet-registry.json`);
      assert.equal(outlet.tier, 4, `${id} should be tier 4`);
      assert.ok(VALID_TIERS.includes(outlet.tier), `${id}'s tier ${outlet.tier} should be in VALID_TIERS`);
    }
  });

  test('at least one tier-4 outlet exists in the registry', () => {
    const tier4 = Object.values(registry.outlets).filter((o) => o.tier === 4);
    assert.ok(tier4.length > 0, 'expected at least one tier-4 outlet (the 2026-05-16 T3->T4 demotion)');
  });
});

describe('outlet-registry.json cvStyle arming (BRO-2776)', () => {
  // These keys were populated once (cbf7e97c5c) and a CLEAN 3-way merge
  // (4014d52077) dropped every one of them, which left
  // shouldDeferCvWrongShow() unable to fire for any review on production main
  // for roughly four months. Nothing caught it, because vanished keys read as
  // "absent" and absent is never "invalid" — the validity check stays silent
  // through the exact regression it looks like it guards. Only a positive
  // count sees it, so that is what this asserts.
  test('at least one outlet is armed with cvStyle long-biographical', () => {
    const armed = countArmedCvStyles(registry);
    assert.ok(
      armed > 0,
      'countArmedCvStyles() returned 0 — shouldDeferCvWrongShow() cannot fire for any review. ' +
        'This is how the 2026-05-16 silent merge loss presented. Restore the keys from cbf7e97c5c.'
    );
  });

  test('the six outlets restored from cbf7e97c5c still carry the key', () => {
    const missing = ['nytimes', 'vulture', 'newyorker', 'washpost', 'nysr', 'new-york-sun']
      .filter((id) => !registry.outlets[id] || registry.outlets[id].cvStyle !== 'long-biographical');
    assert.deepEqual(missing, [], `outlets missing cvStyle=long-biographical: ${missing.join(', ')}`);
  });

  test('no outlet carries a cvStyle outside the canonical vocabulary', () => {
    // An out-of-vocabulary value is worse than an absent one: getCvStyle()
    // falls back to 'standard', so the outlet looks configured and is disarmed.
    const bad = findInvalidCvStyles(registry).map((b) => `${b.outletId}=${JSON.stringify(b.cvStyle)}`);
    assert.deepEqual(bad, [], `invalid cvStyle value(s): ${bad.join(', ')}. Valid: ${CV_STYLES.join(', ')}`);
  });
});
