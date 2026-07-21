import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTERED_FLAGS,
  extractReferencedFlagKeys,
  checkFlagParity,
  evaluateFlagHealth,
} from './flag-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'fake-flag-src');

test('extractReferencedFlagKeys finds every real flag key currently used in src/', () => {
  const { keys, unresolved } = extractReferencedFlagKeys();
  const found = new Set(keys.map((k) => k.key));
  assert.equal(unresolved.length, 0, `unresolved getFeatureFlag() args (scanner can't statically resolve): ${JSON.stringify(unresolved)}`);
  for (const expectedKey of ['gate-cold-start', 'mobile-gate-timing', 'ticket-single-button', 'ticket-primary-platform']) {
    assert.ok(found.has(expectedKey), `expected src/ to still reference '${expectedKey}' — if this flag's code was removed, delete its REGISTERED_FLAGS entry too`);
  }
});

test('checkFlagParity: real src/ scan against REGISTERED_FLAGS has zero missing entries', () => {
  const { keys } = extractReferencedFlagKeys();
  const { missing } = checkFlagParity(keys, REGISTERED_FLAGS);
  assert.deepEqual(
    missing.map((m) => m.key),
    [],
    `flag key(s) referenced in src/ with no REGISTERED_FLAGS entry: ${JSON.stringify(missing)} — this is the exact failure mode that shipped the mobile-gate-timing incident (card #250). Add an entry to scripts/lib/flag-registry.js before merging.`
  );
});

// Proves the gate actually catches the failure mode it exists for — a flag
// key referenced in code with no registry entry — without touching real
// src/ files. Uses a synthetic fixture dir (scripts/lib/__fixtures__/
// fake-flag-src/) that calls getFeatureFlag('totally-fake-flag'), a key that
// intentionally has no REGISTERED_FLAGS entry.
test('checkFlagParity flags an unregistered flag key (synthetic fixture)', () => {
  const { keys, unresolved } = extractReferencedFlagKeys(FIXTURE_DIR);
  assert.equal(unresolved.length, 0);
  assert.deepEqual(keys.map((k) => k.key), ['totally-fake-flag']);
  const { missing } = checkFlagParity(keys, REGISTERED_FLAGS);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].key, 'totally-fake-flag');
});

test('checkFlagParity: a registered key is never reported missing', () => {
  const referenced = [{ key: 'gate-cold-start', files: ['src/fake.tsx'] }];
  const { missing } = checkFlagParity(referenced, REGISTERED_FLAGS);
  assert.deepEqual(missing, []);
});

test('evaluateFlagHealth: flag missing from PostHog when expected to exist', () => {
  const { ok, problem } = evaluateFlagHealth(null, { exists: true, active: true });
  assert.equal(ok, false);
  assert.match(problem, /DOES NOT EXIST/);
});

test('evaluateFlagHealth: flag exists but inactive', () => {
  const { ok, problem } = evaluateFlagHealth({ active: false }, { exists: true, active: true });
  assert.equal(ok, false);
  assert.match(problem, /INACTIVE/);
});

test('evaluateFlagHealth: variant split drifted', () => {
  const live = { active: true, variants: [{ key: 'control', pct: 60 }, { key: 'cold-start', pct: 40 }] };
  const expected = { exists: true, active: true, variants: [{ key: 'control', pct: 50 }, { key: 'cold-start', pct: 50 }] };
  const { ok, problem } = evaluateFlagHealth(live, expected);
  assert.equal(ok, false);
  assert.match(problem, /variant split drifted/);
});

test('evaluateFlagHealth: rollout drifted', () => {
  const live = { active: true, variants: [{ key: 'control', pct: 50 }, { key: 'cold-start', pct: 50 }], rollout: 50 };
  const expected = { exists: true, active: true, variants: [{ key: 'control', pct: 50 }, { key: 'cold-start', pct: 50 }], rollout: 100 };
  const { ok, problem } = evaluateFlagHealth(live, expected);
  assert.equal(ok, false);
  assert.match(problem, /rollout is 50%/);
});

test('evaluateFlagHealth: healthy flag matching expected state passes', () => {
  const live = { active: true, variants: [{ key: 'control', pct: 50 }, { key: 'cold-start', pct: 50 }], rollout: 100 };
  const expected = { exists: true, active: true, variants: [{ key: 'control', pct: 50 }, { key: 'cold-start', pct: 50 }], rollout: 100 };
  const { ok, problem } = evaluateFlagHealth(live, expected);
  assert.equal(ok, true);
  assert.equal(problem, null);
});

test('evaluateFlagHealth: expected-absent flag that stays absent is healthy', () => {
  const { ok, problem } = evaluateFlagHealth(null, { exists: false });
  assert.equal(ok, true);
  assert.equal(problem, null);
});

test('evaluateFlagHealth: expected-absent flag that now exists is flagged (registry is stale)', () => {
  const { ok, problem } = evaluateFlagHealth({ active: true }, { exists: false });
  assert.equal(ok, false);
  assert.match(problem, /registry expects it absent/);
});
