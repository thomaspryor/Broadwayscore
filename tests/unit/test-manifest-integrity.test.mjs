import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANIFESTS, readManifest, validateManifest } = require('../../scripts/lib/test-manifest.js');
const { collectCiCoverage, exemptionFor, EXEMPT_KNOWN_BROKEN, EXEMPT_NEVER_CI } = require('../../scripts/audit-orphan-tests.js');

const { collectNodeUnitTests, readOtherRunnerEntries, hasRetiredHeader, RETIRED_HEADER, MIN_NODE_BATCH } = require('../../scripts/lib/unit-test-collection.js');

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// BRO-2483: MANIFESTS[0] (tests/unit-test-manifest.txt) names the COLLECTED
// node batch; the file is a tombstone. validateManifest()/readManifest()
// resolve the path to scripts/lib/unit-test-collection.js's list, so the loop
// below checks the collected batch (non-empty, every file exists, no .ts
// imports) and the two hand-kept manifests (also sorted, no duplicates).
for (const manifest of MANIFESTS) {
  test(`${manifest} is non-empty and every listed file exists`, () => {
    const manifestPath = path.join(repoRoot, manifest);
    const { entries, errors } = validateManifest(manifestPath, repoRoot);
    assert.deepEqual(errors, []);
    assert.ok(entries.length > 0, `${manifest} must list at least one test file`);
  });
}

// BRO-3061: `npm run test:unit` used to glob tests/unit/*.test.mjs under
// plain `node --test`, which does not know about the tsx-only manifest below
// and swept its files into the wrong runner — they only resolve under tsx
// because they import TypeScript through the `@/` path alias. A file
// belongs in exactly ONE of these two manifests; the local runner and CI
// only agree if that invariant holds.
const nodeManifestPath = path.join(repoRoot, 'tests/unit-test-manifest.txt');
const tsxManifestPath = path.join(repoRoot, 'tests/unit-test-manifest-tsx.txt');

test('the node batch is the collected list, never the tombstone file\'s lines (BRO-2483)', () => {
  const collected = collectNodeUnitTests(repoRoot);
  assert.deepEqual(readManifest(nodeManifestPath), collected);
  assert.ok(collected.length >= MIN_NODE_BATCH, `collected only ${collected.length} (MIN_NODE_BATCH ${MIN_NODE_BATCH})`);
  // The file still exists (merge=union for in-flight branches): the RETIRED
  // header over the frozen old list, which keeps absorbing in-flight appends.
  // None of its lines is what runs, so its list lines are never judged here.
  assert.ok(fs.existsSync(nodeManifestPath), 'tombstone kept until its follow-up card deletes it');
});

// (a) the header is on top; (b) consumers use the collector (asserted above
// via readManifest, and by glob-based-manifest.test.mjs for test.yml,
// land-gauntlet.sh and the other consumers).
test('tests/unit-test-manifest.txt opens with the RETIRED header (BRO-2483)', () => {
  const text = fs.readFileSync(nodeManifestPath, 'utf8');
  assert.ok(
    hasRetiredHeader(text),
    `tests/unit-test-manifest.txt must start with the RETIRED header from scripts/lib/unit-test-collection.js:\n${RETIRED_HEADER.join('\n')}`
  );
});

test('no test file is in both the collected node batch and the e2e manifest (BRO-2483)', () => {
  const others = new Set(readOtherRunnerEntries(repoRoot));
  assert.deepEqual(collectNodeUnitTests(repoRoot).filter((e) => others.has(e)), []);
});

test('no test file is registered in both the node and tsx unit-test manifests', () => {
  const nodeManifest = new Set(readManifest(nodeManifestPath));
  const tsxManifest = new Set(readManifest(tsxManifestPath));
  const inBoth = [...nodeManifest].filter((entry) => tsxManifest.has(entry));
  assert.deepEqual(
    inBoth,
    [],
    `tests/unit/*.test.mjs files registered in BOTH the node and tsx manifests: ${inBoth.join(', ')}`
  );
});

// Not every tests/unit/*.test.mjs file needs a home in the node/tsx pair:
// tests/e2e-unit-test-manifest.txt feeds a separate CI job that re-runs a
// largely-overlapping-but-distinct set under tsx, and a handful of files are
// wired in by a literal path in a workflow `run:` step instead of any
// manifest. scripts/audit-orphan-tests.js already answers "is this file
// referenced anywhere CI would actually run it" correctly (it parses `run:`
// blocks specifically, not just any YAML text, and knows the tracked
// known-broken/never-CI exemptions) and is itself wired into CI — reusing its
// exported collectCiCoverage()/exemption maps here, rather than
// re-deriving the same answer with a second, weaker check, is what keeps this
// test from drifting out of sync with that canonical one (BRO-3061 ship-check,
// Codex review).
test('every tests/unit/*.test.mjs file is either registered in CI (per audit-orphan-tests.js) or a tracked exemption', () => {
  const unitDir = path.join(repoRoot, 'tests', 'unit');
  const files = fs.readdirSync(unitDir).filter((f) => f.endsWith('.test.mjs') && !f.startsWith('_skip-'));
  // BRO-2778: coverage is decided per repo-relative path (a basename Set let a
  // file hide behind a same-named test in another directory).
  const { coverageOf } = collectCiCoverage();

  const homeless = files.filter((name) => {
    const f = { name, rel: `tests/unit/${name}` };
    return !coverageOf(f.rel) && !exemptionFor(EXEMPT_KNOWN_BROKEN, f) && !exemptionFor(EXEMPT_NEVER_CI, f);
  });
  assert.deepEqual(
    homeless,
    [],
    `tests/unit/*.test.mjs files not registered in any manifest, not referenced in a workflow run: step, and not a tracked exemption: ${homeless.join(', ')}`
  );
});
