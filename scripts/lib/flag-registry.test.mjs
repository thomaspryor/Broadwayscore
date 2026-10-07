import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTERED_FLAGS,
  extractReferencedFlagKeys,
  checkFlagParity,
  evaluateFlagHealth,
} from './flag-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'fake-flag-src');
const AMBIGUOUS_FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'ambiguous-const-src');

test('extractReferencedFlagKeys finds every real flag key currently used in src/', () => {
  const { keys, unresolved } = extractReferencedFlagKeys();
  const found = new Set(keys.map((k) => k.key));
  assert.equal(unresolved.length, 0, `unresolved getFeatureFlag() args (scanner can't statically resolve): ${JSON.stringify(unresolved)}`);
  for (const expectedKey of ['mobile-gate-timing', 'ticket-primary-platform']) {
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

// Two files defining the SAME identifier name with DIFFERENT string values
// must NOT silently resolve to whichever file was scanned first — that would
// misattribute a real getFeatureFlag() call to the wrong key (a false
// negative for whichever key is actually referenced). It must come back
// unresolved so CI fails loud instead of the registry silently missing it.
test('extractReferencedFlagKeys treats an ambiguous identifier (2+ distinct definitions) as unresolved, not a silent guess', () => {
  const { keys, unresolved } = extractReferencedFlagKeys(AMBIGUOUS_FIXTURE_DIR);
  assert.deepEqual(keys, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].arg, 'SHARED_FLAG');
});

test('checkFlagParity: a registered key is never reported missing', () => {
  const referenced = [{ key: 'ticket-primary-platform', files: ['src/fake.tsx'] }];
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

// ── ensure_experience_continuity (sticky bucketing) — 2026-07-24 ──
// Per-flag expected value lives in the registry so sessions stop
// flip-flopping on whether sticky-off is "a bug" (it is NOT for
// anonymous-only experiments — see the REGISTERED_FLAGS comment).

// BRO-3456: ticket-single-button ran for 5 months (2026-04-11 restart to
// 2026-09-15) with ownerDoc: null and no pre-registration/audit doc — the
// docs/experiments/README.md contract (step c) says to write one, but
// nothing enforced it. This catches the next experiment from repeating the
// gap: a genuinely LIVE split (exists, active, 2+ variants each with
// pct > 0 — excludes pinned-winner entries like ticket-primary-platform's
// todaytix:100/stubhub:0, which isn't a running comparison) must declare a
// non-null ownerDoc pointing to a file that actually exists on disk.
test('schema: every live split entry has a non-null ownerDoc pointing to a real file', () => {
  for (const entry of REGISTERED_FLAGS) {
    const { expected } = entry;
    const isLiveSplit = expected.exists && expected.active
      && Array.isArray(expected.variants) && expected.variants.length >= 2
      && expected.variants.every((v) => (v.pct || 0) > 0);
    if (!isLiveSplit) continue;
    assert.ok(
      entry.ownerDoc,
      `REGISTERED_FLAGS['${entry.key}'] is a live running split with ownerDoc: null — ` +
      `write docs/experiments/${entry.key}.md per docs/experiments/README.md step (c) ` +
      `before this experiment goes another week undocumented (BRO-3456).`
    );
    const docPath = path.join(REPO_ROOT, entry.ownerDoc);
    assert.ok(
      fs.existsSync(docPath),
      `REGISTERED_FLAGS['${entry.key}'].ownerDoc points to '${entry.ownerDoc}', which doesn't exist on disk.`
    );
  }
});

test('schema: every exists:true entry declares boolean ensure_experience_continuity', () => {
  for (const entry of REGISTERED_FLAGS) {
    if (!entry.expected.exists) continue;
    assert.equal(
      typeof entry.expected.ensure_experience_continuity,
      'boolean',
      `REGISTERED_FLAGS['${entry.key}'].expected.ensure_experience_continuity must be a boolean — ` +
      `decide sticky bucketing at experiment design time (anonymous-only → false; identified users → true). ` +
      `See the comment above REGISTERED_FLAGS.`
    );
  }
});

// These three tests exercise evaluateFlagHealth's generic sticky-bucketing
// check against a SYNTHETIC expected fixture (not a live REGISTERED_FLAGS
// entry) — gate-cold-start's entry was removed 2026-09-15 when its A/B
// concluded, and no other registered flag has ensure_experience_continuity:
// false (both ticket-single-button and ticket-primary-platform are true), so
// repointing to a live entry would test the wrong sticky semantics.
const ANONYMOUS_EXPERIMENT_FIXTURE = {
  exists: true,
  active: true,
  variants: [{ key: 'control', pct: 50 }, { key: 'treatment', pct: 50 }],
  rollout: 100,
  ensure_experience_continuity: false, // anonymous-only experiment convention
};

test('evaluateFlagHealth: sticky drift is flagged (live-shape fixture)', () => {
  // Live shape mirrors monitor-flag-parity.js fetchLiveFlag's mapping — NOT
  // a hand-built expected object.
  const live = {
    active: true,
    variants: [{ key: 'control', pct: 50 }, { key: 'treatment', pct: 50 }],
    rollout: 100,
    ensure_experience_continuity: true, // ← someone flipped it ON
  };
  const { ok, problem } = evaluateFlagHealth(live, ANONYMOUS_EXPERIMENT_FIXTURE);
  assert.equal(ok, false);
  assert.match(problem, /ensure_experience_continuity is true/);
});

test('evaluateFlagHealth: unmapped sticky field from the fetcher fails loudly (three-way-sync guard)', () => {
  const live = { active: true, variants: [{ key: 'control', pct: 50 }, { key: 'treatment', pct: 50 }], rollout: 100 };
  const { ok, problem } = evaluateFlagHealth(live, ANONYMOUS_EXPERIMENT_FIXTURE);
  assert.equal(ok, false);
  assert.match(problem, /fetcher did not supply the field/);
});

test('evaluateFlagHealth: matching sticky value passes', () => {
  const live = {
    active: true,
    variants: [{ key: 'control', pct: 50 }, { key: 'treatment', pct: 50 }],
    rollout: 100,
    ensure_experience_continuity: false,
  };
  const { ok, problem } = evaluateFlagHealth(live, ANONYMOUS_EXPERIMENT_FIXTURE);
  assert.equal(ok, true);
  assert.equal(problem, null);
});
