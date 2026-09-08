import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANIFESTS, readManifest, validateManifest } = require('../../scripts/lib/test-manifest.js');

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
  const overlap = [...nodeManifest].filter((entry) => tsxManifest.has(entry));
  assert.deepEqual(
    overlap,
    [],
    `registered in BOTH tests/unit-test-manifest.txt and tests/unit-test-manifest-tsx.txt (pick exactly one runner): ${overlap.join(', ')}`
  );
});

// Not every tests/unit/*.test.mjs file needs a home in the node/tsx pair:
// tests/e2e-unit-test-manifest.txt feeds a separate CI job (the "Run unit
// tests" step in the e2e job, all under tsx) that re-runs a largely-
// overlapping-but-distinct set, and a handful of files are wired in by a
// literal path in a workflow `run:` step instead of any manifest (verified
// against origin/main 2026-09-08: 57 files live only in the e2e manifest,
// plus opening-night-checklist-cli, opening-night-checks-skeleton and
// scraper-cookie-wiring are path-listed directly in test.yml). Full CI-wiring
// coverage for all of that is scripts/audit-orphan-tests.js's job, already
// wired into CI — duplicating its workflow-parsing here would be a second
// hand-maintained copy of the same list (exactly what test-manifest.js's
// MANIFESTS comment warns against). This test only owns the node/tsx SPLIT:
// a file must not be silently absent from both AND absent from every other
// known escape hatch, and must never be double-registered.
test('every tests/unit/*.test.mjs file has a home: node/tsx manifest, the e2e manifest, or an explicit workflow reference', () => {
  const nodeManifest = new Set(readManifest(nodeManifestPath));
  const tsxManifest = new Set(readManifest(tsxManifestPath));
  const e2eManifest = new Set(readManifest(path.join(repoRoot, 'tests/e2e-unit-test-manifest.txt')));
  const unitDir = path.join(repoRoot, 'tests', 'unit');
  const files = fs
    .readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.mjs') && !f.startsWith('_skip-'))
    .map((f) => path.posix.join('tests/unit', f));

  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const workflowText = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => fs.readFileSync(path.join(workflowsDir, f), 'utf8'))
    .join('\n');

  const inBoth = files.filter((f) => nodeManifest.has(f) && tsxManifest.has(f));
  assert.deepEqual(
    inBoth,
    [],
    `tests/unit/*.test.mjs files registered in BOTH the node and tsx manifests: ${inBoth.join(', ')}`
  );

  // scripts/audit-orphan-tests.js's EXEMPT_KNOWN_BROKEN map deliberately keeps
  // this one out of CI pending a fix (card 363637c5-416f-814f: --json mode
  // prints a stray "Fetching: ..." line before the JSON, breaking JSON.parse)
  // — not a gap this test should flag.
  const KNOWN_CI_EXEMPT = new Set(['tests/unit/opening-night-checklist-cli.test.mjs']);

  const homeless = files.filter((f) => {
    if (nodeManifest.has(f) || tsxManifest.has(f) || e2eManifest.has(f)) return false;
    if (KNOWN_CI_EXEMPT.has(f)) return false;
    return !workflowText.includes(path.basename(f));
  });
  assert.deepEqual(
    homeless,
    [],
    `tests/unit/*.test.mjs files not in any manifest and not referenced by any workflow: ${homeless.join(', ')}`
  );
});
