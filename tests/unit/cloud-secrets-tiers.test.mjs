// Regression guard for scripts/check-cloud-secrets.js's TIER_1/TIER_2 lists.
//
// WHY THIS EXISTS: LINEAR_API_KEY was absent from TIER_1 until 2026-09-05, so a
// cloud sandbox reported "All Tier 1 secrets present" while every linear-brain.js
// call failed closed and the session left no board entry — precisely the silent
// gap the checker exists to catch. Nothing asserted the list's contents, so the
// omission was invisible.
//
// CLAUDE.md §15: this requires the REAL arrays from the script, never a copy —
// deleting an entry there fails this test, which is the whole point.
//
// It deliberately does NOT shell out to `node scripts/check-cloud-secrets.js`:
// that exits 1 in any environment merely missing a secret (including CI), so it
// could never serve as a passing acceptance-criteria command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TIER_1, TIER_2 } = require('../../scripts/check-cloud-secrets.js');

test('LINEAR_API_KEY is a REQUIRED (Tier 1) cloud secret', () => {
  assert.ok(
    TIER_1.includes('LINEAR_API_KEY'),
    'CLAUDE.md §6 makes Linear the board of record and linear-brain.js needs this key at ' +
      'both session start and session end. If you are moving it to Tier 2, the board is no ' +
      'longer mandatory — update CLAUDE.md §6 first.'
  );
});

test('requiring the script does not execute it (no process.exit on import)', () => {
  // The module is guarded by `require.main === module`. Without that guard this
  // very test file would kill its own worker on import.
  assert.ok(Array.isArray(TIER_1) && TIER_1.length > 0);
  assert.ok(Array.isArray(TIER_2) && TIER_2.length > 0);
});

test('the two tiers are disjoint and free of duplicates', () => {
  // A key in both tiers is ambiguous: Tier 1 fails the check, Tier 2 does not.
  const overlap = TIER_1.filter((k) => TIER_2.includes(k));
  assert.deepEqual(overlap, [], `keys present in BOTH tiers: ${overlap.join(', ')}`);

  for (const [label, list] of [['TIER_1', TIER_1], ['TIER_2', TIER_2]]) {
    assert.equal(new Set(list).size, list.length, `${label} contains duplicate entries`);
  }
});

test('every entry looks like an env var name (catches a stray comment or path)', () => {
  for (const key of TIER_1.concat(TIER_2)) {
    assert.match(key, /^[A-Z][A-Z0-9_]*$/, `not an env var name: ${JSON.stringify(key)}`);
  }
});

// --- the resolver itself -----------------------------------------------------
// ship-check P1: the arrays were guarded but the behavior this change actually
// introduced — process.env-then-.env precedence, the source label, the prefix
// floor — was not. statusFor() is the pure function main() formats, so these
// assert the real thing rather than a copy of it (§15).
const { statusFor, PREFIX_MIN_LEN } = require('../../scripts/check-cloud-secrets.js');

const withEnv = (name, value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); } finally {
    if (had) process.env[name] = prev; else delete process.env[name];
  }
};

const KEY = '__CLOUD_SECRETS_TEST_KEY__';
const LONG = 'x'.repeat(PREFIX_MIN_LEN + 8);

test('process.env wins over .env, and is labelled as such', () => {
  const s = withEnv(KEY, LONG, () => statusFor(KEY, { [KEY]: 'disk-value-here' }));
  assert.equal(s.set, true);
  assert.equal(s.source, 'env', 'a non-empty process.env value must never be shadowed by .env');
  assert.equal(s.len, LONG.length, 'length must describe the env value, not the disk one');
});

test('.env fills in only what the environment lacks, labelled ".env"', () => {
  const s = withEnv(KEY, undefined, () => statusFor(KEY, { [KEY]: LONG }));
  assert.equal(s.set, true);
  assert.equal(s.source, '.env', 'a disk-sourced hit must be visibly distinct from an env one');
});

test('an EMPTY process.env value is absent, and gets filled from .env', () => {
  // Matches scripts/lib/load-env.js:22's documented convention.
  const s = withEnv(KEY, '', () => statusFor(KEY, { [KEY]: LONG }));
  assert.equal(s.source, '.env');
  const none = withEnv(KEY, '', () => statusFor(KEY, {}));
  assert.equal(none.set, false, 'empty with no disk fallback is MISSING, as before this change');
});

test('missing everywhere is MISSING', () => {
  assert.deepEqual(withEnv(KEY, undefined, () => statusFor(KEY, {})), { set: false });
});

test('short values print no prefix (BRIGHTDATA_ZONE class), long ones do', () => {
  const short = withEnv(KEY, 'x'.repeat(PREFIX_MIN_LEN - 1), () => statusFor(KEY, {}));
  assert.equal(short.prefix, null, `values under ${PREFIX_MIN_LEN} chars must not leak a prefix`);
  const long = withEnv(KEY, LONG, () => statusFor(KEY, {}));
  assert.equal(long.prefix, LONG.slice(0, 3));
});

test('no full secret value is ever returned', () => {
  const secret = 'super-secret-token-value-do-not-print';
  const s = withEnv(KEY, secret, () => statusFor(KEY, {}));
  for (const v of Object.values(s)) {
    if (typeof v === 'string') {
      assert.ok(!secret.includes(v) || v.length <= 3,
        `statusFor leaked ${v.length} chars of the value`);
    }
  }
});
