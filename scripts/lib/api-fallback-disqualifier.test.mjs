// Unit tests for the Git Data API fallback path disqualifier (BRO-3663).
// Requires the REAL disqualifyingPath() rather than restating its rules
// (CLAUDE.md §15) — a production change to the predicate must fail these.
//
// The shell-level behaviour (that a disqualifying path suppresses the
// early-fallback break instead of forfeiting the retry budget) lives in
// push-with-retry.early-fallback-budget.test.sh — node:test cannot exercise
// bash control flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { disqualifyingPath } = require('./api-fallback-disqualifier.js');
const realRegistry = require('./reconcile-merged-json.js');

const registry = {
  MANAGED: [{ file: 'data/audit/managed-thing.json' }],
  API_FALLBACK_SAFE: [{ file: 'data/audit/verified-single-writer.json' }],
  API_FALLBACK_MERGE: [{ file: 'data/audit/managed-thing.json' }],
};

test('an unaudited data/audit/ path disqualifies — the BRO-3663 production case', () => {
  assert.equal(
    disqualifyingPath(['data/audit/nobody-registered-me.json'], registry),
    'data/audit/nobody-registered-me.json'
  );
});

test('a registered apiFallbackSafe data/audit/ path does NOT disqualify', () => {
  assert.equal(disqualifyingPath(['data/audit/verified-single-writer.json'], registry), null);
});

test('a MANAGED file WITH apiFallbackMerge coverage does not disqualify (BRO-2413)', () => {
  assert.equal(disqualifyingPath(['data/audit/managed-thing.json'], registry), null);
});

test('a MANAGED file WITHOUT apiFallbackMerge coverage disqualifies', () => {
  const noMerge = { ...registry, API_FALLBACK_MERGE: [] };
  assert.equal(disqualifyingPath(['data/audit/managed-thing.json'], noMerge), 'data/audit/managed-thing.json');
});

test('shows.json and reviews.json always disqualify, registry regardless', () => {
  const permissive = {
    MANAGED: [],
    API_FALLBACK_SAFE: [{ file: 'data/shows.json' }, { file: 'data/reviews.json' }],
    API_FALLBACK_MERGE: [],
  };
  assert.equal(disqualifyingPath(['data/shows.json'], permissive), 'data/shows.json');
  assert.equal(disqualifyingPath(['data/reviews.json'], permissive), 'data/reviews.json');
});

test('ordinary source paths never disqualify — the early break must stay available', () => {
  assert.equal(disqualifyingPath(['src/app/page.tsx', 'scripts/foo.js', 'docs/x.md'], registry), null);
});

test('one bad path among many clean ones still disqualifies the whole diff', () => {
  const changed = ['src/a.ts', 'docs/b.md', 'data/audit/nobody-registered-me.json', 'src/c.ts'];
  assert.equal(disqualifyingPath(changed, registry), 'data/audit/nobody-registered-me.json');
});

test('empty and missing inputs are clean, not a crash (the fallback stays available)', () => {
  assert.equal(disqualifyingPath([], registry), null);
  assert.equal(disqualifyingPath(undefined, registry), null);
  assert.equal(disqualifyingPath(['src/a.ts'], {}), null);
});

test('against the REAL registry: show-review-gap.json is registered, a made-up sibling is not', () => {
  // Pins the two halves of the live BRO-3071 state this fix exists around:
  // the file that caused the incident is now registered, and the 360 files
  // that still are not remain disqualifying.
  assert.equal(disqualifyingPath(['data/audit/show-review-gap.json'], realRegistry), null);
  assert.equal(
    disqualifyingPath(['data/audit/bro-3663-definitely-unregistered.json'], realRegistry),
    'data/audit/bro-3663-definitely-unregistered.json'
  );
});
