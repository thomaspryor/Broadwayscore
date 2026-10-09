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

// The manifests test.yml runs under `npx tsx --test`: every one except the
// plain-node unit-test-manifest.txt (the tsx batch, and the E2E batch at
// test.yml's e2e-unit-test-manifest step). A test listed only here may import
// .ts modules, so anything that re-runs it must use tsx too (BRO-4930: Land
// ran the e2e-listed outlet-id-mapper.test.mjs under plain node and refused).
const TSX_MANIFESTS = MANIFESTS.filter((m) => !m.endsWith('/unit-test-manifest.txt'));

// Every extension this repo writes a test file in. Single source of truth for
// the two "is this test actually executed by CI?" guards, which had DIVERGENT
// hand-maintained lists until BRO-2751:
//   scripts/audit-orphan-tests.js            (tests/unit + scripts/ top level)
//   scripts/lib/colocated-test-ci-coverage.test.mjs  (scripts/lib, recursive)
// The divergence was not theoretical: neither listed `sh`, so 2 of the repo's
// 19 tracked *.test.sh files ran in ZERO CI jobs while both guards reported
// all-clear — the same seam BRO-2749 closed for `.test.js`, reopened one
// extension over. Same reasoning as MANIFESTS above (card #1657): a second
// independent copy of a list like this is how the next extension gets missed.
//
// Exported as EXTENSIONS, not as a shared RegExp: audit-orphan-tests.js needs
// a /g/-flagged matcher, and a /g/ RegExp carries mutable lastIndex, so a
// single shared instance would leak state between the two consumers.
const TEST_FILE_EXTENSIONS = ['mjs', 'ts', 'js', 'cjs', 'sh'];

// Extensions `node --test` can actually execute. A *.test.sh is a real,
// CI-executed test, but it runs via `run: bash <path>` — it can never be
// listed in a manifest (the manifests are fed straight to `node --test`) nor
// matched by the scripts/lib/*.test.mjs glob. Consumers that resolve a test
// file to a node invocation must filter on THIS list, not on
// TEST_FILE_EXTENSIONS.
const NODE_RUNNABLE_TEST_EXTENSIONS = TEST_FILE_EXTENSIONS.filter((e) => e !== 'sh');

/** /\.test\.(mjs|ts|js|cjs|sh)$/ — matches a bare filename or a full path. */
function testFileRegex(flags = '') {
  return new RegExp(`\\.test\\.(${TEST_FILE_EXTENSIONS.join('|')})$`, flags);
}

/** Global matcher for test filenames cited inside workflow `run:` text. */
function testReferenceRegex() {
  // Dots allowed in the prefix class (not just alnum/dash/underscore):
  // filenames like review-normalization.maybeUpgradeUrl.test.mjs embed a dot
  // before the .test.mjs suffix (BRO-111).
  return new RegExp(`[a-zA-Z0-9_.-]+\\.test\\.(${TEST_FILE_EXTENSIONS.join('|')})`, 'g');
}

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

  // Duplicates were invisible here until 2026-09-15, and that gap is what let
  // one reach main: 178c0ccb02c (BRO-3426) APPENDED
  // tests/unit/done-evidence-audit.test.mjs while the same entry already sat in
  // its correct sorted position, so the file carried it twice. Only the
  // sortedness check above fired — and the sort auto-fix would have "healed"
  // that red by parking the two copies adjacent to each other, silently
  // registering the test twice and leaving nothing to report. A duplicate is
  // never intentional in a test manifest: the runner would execute that file
  // twice, inflating the TAP count and any per-file timing.
  const seen = new Set();
  const duplicates = [];
  for (const entry of entries) {
    if (seen.has(entry) && !duplicates.includes(entry)) duplicates.push(entry);
    seen.add(entry);
  }
  if (duplicates.length > 0) {
    errors.push(
      `manifest lists the same test file more than once (remove the extra line(s)): ${duplicates.join(', ')}`
    );
  }

  for (const entry of entries) {
    const fullPath = path.join(repoRoot, entry);
    if (!fs.existsSync(fullPath)) {
      errors.push(`listed test file does not exist: ${entry}`);
    } else if (path.basename(manifestPath) === 'unit-test-manifest.txt') {
      // BRO-4647: only the plain-node batch (the tsx and e2e manifests run under
      // other runners). It runs on CI's Node 20, which cannot load
      // .ts modules (ERR_UNKNOWN_FILE_EXTENSION). A test that imports `.ts`
      // passes on a newer local node but goes red on CI — it belongs in the
      // tsx manifest.
      const src = fs.readFileSync(fullPath, 'utf8');
      if (/(?:from\s+|import\s*\(\s*|require\(\s*)['"][^'"]+\.ts['"]/.test(src)) {
        errors.push(`imports a .ts module, so it cannot run under plain node (move it to the tsx manifest): ${entry}`);
      }
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
// Also DEDUPES (2026-09-15). Sorting alone would have turned the
// done-evidence-audit duplicate into a permanently-green double registration
// (see validateManifest's note): the two copies sort adjacent, the sortedness
// check then passes, and the auto-fix would have laundered the defect instead of
// surfacing it. Dropping the extra copy is always the intended outcome here, so
// the auto-fix half of the check heals it rather than cementing it.
function sortManifestFile(manifestPath) {
  const entries = readManifest(manifestPath);
  const sorted = [...new Set(entries)].sort();
  const isSorted = entries.length === sorted.length && entries.every((e, i) => e === sorted[i]);
  if (isSorted) return false;
  fs.writeFileSync(manifestPath, sorted.join('\n') + '\n');
  return true;
}

module.exports = {
  MANIFESTS,
  TSX_MANIFESTS,
  TEST_FILE_EXTENSIONS,
  NODE_RUNNABLE_TEST_EXTENSIONS,
  testFileRegex,
  testReferenceRegex,
  readManifest,
  validateManifest,
  sortManifestFile,
};

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
