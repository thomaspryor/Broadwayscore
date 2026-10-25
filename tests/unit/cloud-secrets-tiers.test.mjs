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

test('the accounts and deploy keys are listed, so a cloud session sees when it lacks them (BRO-4894)', () => {
  for (const k of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VERCEL_TOKEN', 'SENTRY_AUTH_TOKEN']) {
    assert.ok(TIER_1.includes(k) || TIER_2.includes(k), `${k} must be in a tier: the 2026-10-08 accounts audit ran with none of these and could not tell`);
  }
});

// BRO-6112: SCRAPINGDOG_API_KEY (the main scraper) was never in TIER_1, so nobody
// asked the owner for it. Requires the real provider list, never a copy.
const { SCRAPER_CREDENTIAL_KEYS } = require('../../scripts/lib/opening-night-monitor.js');
const { CLOUD_WITHHELD: WITHHELD_KEYS } = require('../../scripts/check-cloud-secrets.js');

test('every scraper provider credential is Tier 1 (BRO-6112)', () => {
  assert.ok(SCRAPER_CREDENTIAL_KEYS.length > 0);
  for (const k of SCRAPER_CREDENTIAL_KEYS) {
    assert.ok(TIER_1.includes(k), `${k} authenticates a fetchPage() provider but is not in TIER_1 of check-cloud-secrets.js`);
    assert.ok(!WITHHELD_KEYS.includes(k), `${k} must not be withheld in cloud: that would hide a missing scraper key (BRO-6112)`);
  }
});

test('APPROVAL_HMAC_SECRET is never required in cloud (a session holding it could sign its own approvals)', () => {
  assert.ok(!TIER_1.includes('APPROVAL_HMAC_SECRET'));
  assert.ok(TIER_2.includes('APPROVAL_HMAC_SECRET'), 'keep it listed so a stray copy is visible');
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

// --- cloud-withheld keys (BRO-5731) -----------------------------------------

const { CLOUD_WITHHELD, isWithheldInCloud } = require('../../scripts/check-cloud-secrets.js');

test('every cloud-withheld key is a Tier 1 key (so it still fails outside cloud)', () => {
  for (const k of CLOUD_WITHHELD) {
    assert.ok(TIER_1.includes(k), `${k} is withheld in cloud but not in TIER_1, so it would never be checked anywhere`);
  }
});

test('the board and read keys are never withheld, so a real gap still fails in cloud', () => {
  for (const k of ['LINEAR_API_KEY', 'GH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
    assert.equal(isWithheldInCloud(k, { CLAUDE_CODE_REMOTE: 'true' }), false, `${k} must still count as missing in cloud`);
  }
});

test('withheld keys are expected-absent in cloud only', () => {
  for (const k of CLOUD_WITHHELD) {
    assert.equal(isWithheldInCloud(k, { CLAUDE_CODE_REMOTE: 'true' }), true, `${k} should be expected-absent in cloud`);
    assert.equal(isWithheldInCloud(k, {}), false, `${k} must still be required outside cloud`);
    assert.equal(isWithheldInCloud(k, { CLAUDE_CODE_REMOTE: 'false' }), false);
  }
});

// End to end: runs main() so a deleted or inverted withheld branch fails here
// (the predicate tests above would still pass). Cloud mode with every
// non-withheld Tier 1 key present must exit 0 and must not call it "all present".
import { spawnSync } from 'node:child_process';

test('cloud mode with only the non-withheld Tier 1 keys exits 0 and does not claim all are present (BRO-5731)', () => {
  const env = { PATH: process.env.PATH, CLAUDE_CODE_REMOTE: 'true' };
  for (const k of TIER_1.filter((n) => !CLOUD_WITHHELD.includes(n))) env[k] = 'x'.repeat(20);
  const r = spawnSync(process.execPath, ['scripts/check-cloud-secrets.js'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /MISSING/);
  assert.doesNotMatch(r.stdout, /All Tier 1 secrets present in the environment/,
    'must not claim every Tier 1 secret is present while withheld keys are absent');
});
