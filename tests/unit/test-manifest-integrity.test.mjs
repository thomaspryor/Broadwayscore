import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANIFESTS, readManifest, validateManifest } = require('../../scripts/lib/test-manifest.js');
const { collectReferencedTests, EXEMPT_KNOWN_BROKEN, EXEMPT_NEVER_CI } = require('../../scripts/audit-orphan-tests.js');

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
// exported collectReferencedTests()/exemption maps here, rather than
// re-deriving the same answer with a second, weaker check, is what keeps this
// test from drifting out of sync with that canonical one (BRO-3061 ship-check,
// Codex review).
test('every tests/unit/*.test.mjs file is either registered in CI (per audit-orphan-tests.js) or a tracked exemption', () => {
  const unitDir = path.join(repoRoot, 'tests', 'unit');
  const files = fs.readdirSync(unitDir).filter((f) => f.endsWith('.test.mjs') && !f.startsWith('_skip-'));
  const referenced = collectReferencedTests();

  const homeless = files.filter(
    (f) => !referenced.has(f) && !(f in EXEMPT_KNOWN_BROKEN) && !(f in EXEMPT_NEVER_CI)
  );
  assert.deepEqual(
    homeless,
    [],
    `tests/unit/*.test.mjs files not registered in any manifest, not referenced in a workflow run: step, and not a tracked exemption: ${homeless.join(', ')}`
  );
});
