'use strict';

const fs = require('fs');
const path = require('path');

// The 3 manifests test.yml actually runs tests from (repo-relative paths).
// Single source of truth for consumers that need to know "every manifest
// that exists" — scripts/audit-orphan-tests.js's MANIFEST_FILES,
// tests/unit/test-manifest-integrity.test.mjs's MANIFESTS, and
// scripts/audit-time-bomb-tests.js's SUITES all derive from this instead of
// each hardcoding the same 3 paths independently (card #1657: a 4th
// independent copy is how a manifest gets silently missed again).
const MANIFESTS = ['tests/unit-test-manifest.txt', 'tests/unit-test-manifest-tsx.txt', 'tests/e2e-unit-test-manifest.txt'];

function readManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// `node --test` with zero file args does NOT fail — it falls back to its own
// default test-discovery glob, which can silently exit 0 having run almost
// nothing, or hang scanning the whole tree. An empty/corrupted manifest must
// be caught before it ever reaches that invocation.
//
// Sortedness is enforced too: appending every new entry at the end of the
// file (the natural thing to do) means every concurrent session's addition
// lands on the same last line, which still guarantees a merge conflict —
// the exact class task #763 exists to reduce. Keeping the manifest sorted
// scatters new entries across the file at their alphabetical position, so
// two sessions only collide when their new test names are adjacent.
function validateManifest(manifestPath, repoRoot) {
  const errors = [];
  if (!fs.existsSync(manifestPath)) {
    errors.push(`manifest not found: ${manifestPath}`);
    return { entries: [], errors };
  }

  const entries = readManifest(manifestPath);
  if (entries.length === 0) {
    errors.push(`manifest is empty: ${manifestPath}`);
  }

  const sorted = [...entries].sort();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] !== sorted[i]) {
      errors.push(
        `manifest is not sorted (insert new entries alphabetically, not appended at the end): ${manifestPath}`
      );
      break;
    }
  }

  for (const entry of entries) {
    const fullPath = path.join(repoRoot, entry);
    if (!fs.existsSync(fullPath)) {
      errors.push(`listed test file does not exist: ${entry}`);
    }
  }

  return { entries, errors };
}

// Rewrites manifestPath with its lines alphabetically sorted, preserving a
// trailing newline. Returns true if the file changed on disk, false if it
// was already sorted (no-op write avoided so a clean tree stays clean).
// This is the auto-fix half of the sortedness check above: the check alone
// only catches an unsorted manifest after a commit already landed, which is
// exactly what let 3+ independent 'fix: re-sort tests/unit-test-manifest.txt'
// commits happen (card #1825) — sessions kept appending at the end faster
// than anyone could hand-fix it. scripts/hooks/pre-commit calls this before
// every commit that touches a manifest so the unsorted state never reaches
// CI, let alone main.
function sortManifestFile(manifestPath) {
  const entries = readManifest(manifestPath);
  const sorted = [...entries].sort();
  const isSorted = entries.length === sorted.length && entries.every((e, i) => e === sorted[i]);
  if (isSorted) return false;
  fs.writeFileSync(manifestPath, sorted.join('\n') + '\n');
  return true;
}

module.exports = { MANIFESTS, readManifest, validateManifest, sortManifestFile };

// CLI: `node scripts/lib/test-manifest.js --fix [manifest ...]` sorts the
// given repo-relative manifest paths in place (or every manifest in
// MANIFESTS if none are given) and prints which ones changed. Used by the
// pre-commit hook — which passes ONLY the manifests it has already
// confirmed are safe to rewrite (staged, with no unstaged hunks of their
// own) — and available for a session to run by hand with no args.
if (require.main === module) {
  const repoRoot = path.join(__dirname, '..', '..');
  if (process.argv.includes('--fix')) {
    const explicitTargets = process.argv.slice(3).filter((a) => !a.startsWith('--'));
    const targets = explicitTargets.length > 0 ? explicitTargets : MANIFESTS;
    let changedAny = false;
    for (const manifest of targets) {
      const manifestPath = path.join(repoRoot, manifest);
      if (!fs.existsSync(manifestPath)) continue;
      if (sortManifestFile(manifestPath)) {
        changedAny = true;
        console.log(`sorted: ${manifest}`);
      }
    }
    if (!changedAny) console.log('all manifests already sorted');
  } else {
    console.error('usage: node scripts/lib/test-manifest.js --fix [manifest ...]');
    process.exit(1);
  }
}
