#!/usr/bin/env node
/**
 * Pure decision logic for scripts/audit-test-yml-manifest-paths.js (CLAUDE.md
 * §15: the test require()s this, never a copy of the rule).
 *
 * The question: is every test file registered in a unit-test manifest also
 * reachable by test.yml's on.push.paths allow-list? See the CLI's header for
 * why the two lists diverging is so costly.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readPushPathsFrom, isCovered } = require('./test-yml-push-paths.js');
const {
  NODE_MANIFEST_REL,
  TSX_MANIFEST_REL,
  E2E_MANIFEST_REL,
  nodeUnitTestsForTree,
  treeUsesCollector,
  TESTS_UNIT_QUARANTINE,
  RUNS_AT_OWN_STEP: COLLECTION_RUNS_AT_OWN_STEP,
} = require('./unit-test-collection.js');

// All THREE manifests test.yml actually consumes. The e2e one was missed on the
// first pass and caught in pre-merge review: test.yml:4996 reads it exactly the
// way :3539/:3545 read the other two, so omitting it left the gate green while an
// e2e-unit test registered there but placed outside tests/** would reintroduce
// precisely the bug this gate blocks. All 75 of its entries sit under tests/**
// today, so there was no live gap — but an invisible blind spot in a blocking
// gate is the thing that lets the bug class come back a fifth time.
const MANIFEST_FILES = [NODE_MANIFEST_REL, TSX_MANIFEST_REL, E2E_MANIFEST_REL]; // single source: unit-test-collection.js
const WORKFLOW_REL = '.github/workflows/test.yml';

/** Manifest lines are one repo-relative path each; `#` comments and blanks skipped. */
function readManifestEntries(absPath) {
  return fs
    .readFileSync(absPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Entries one of MANIFEST_FILES contributes for the tree at repoRoot. BRO-2483:
 * the node manifest path names the collected batch whenever the tree carries
 * scripts/lib/unit-test-collection.js (the file is a tombstone); a
 * pre-BRO-2483 tree (or a fixture without the collector) is read from disk.
 */
function manifestEntriesFor(repoRoot, manifest) {
  if (manifest === NODE_MANIFEST_REL && treeUsesCollector(repoRoot)) return nodeUnitTestsForTree(repoRoot);
  const abs = path.join(repoRoot, manifest);
  if (!fs.existsSync(abs)) throw new Error(`manifest not found: ${manifest}`);
  return readManifestEntries(abs);
}

/**
 * @param {string} repoRoot
 * @returns {{test: string, manifest: string}[]} registered tests no push path reaches
 */
function findManifestPathGaps(repoRoot) {
  const pathEntries = readPushPathsFrom(path.join(repoRoot, WORKFLOW_REL));
  if (pathEntries.length === 0) {
    // Fail closed rather than declaring every test uncovered OR every test fine:
    // an empty list means the parse broke, not that the allow-list is empty.
    throw new Error(`parsed 0 push paths from ${WORKFLOW_REL} — the on.push.paths block moved or changed shape`);
  }

  const gaps = [];
  for (const manifest of MANIFEST_FILES) {
    for (const entry of manifestEntriesFor(repoRoot, manifest)) {
      if (!isCovered(entry, pathEntries)) gaps.push({ test: entry, manifest });
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// The MIRROR-IMAGE gap: a test file on disk that no manifest registers.
//
// findManifestPathGaps above asks "is every REGISTERED test reachable by a push
// path?". That leaves the other direction wide open: a test file that exists,
// looks wired, and is in NO manifest at all. test.yml:3575 runs only what the
// manifest lists (`mapfile -t node_tests < tests/unit-test-manifest.txt`), so
// such a file never executes in CI — in any run, on any push, ever.
// (BRO-2483: test.yml now collects the node batch with
// scripts/lib/unit-test-collection.js, so a tests/unit file is "registered"
// unless that module's EXCLUDED map leaves it out. The quarantine below IS that
// map's tests/unit part; the gap this guards is now a .ts/.tsx test missing
// from the tsx manifest, or an exclusion whose own-step claim went stale.)
//
// Found with 4 unregistered files on 2026-09-04. Being unregistered does NOT by
// itself mean a test never runs — two of the four have their own dedicated
// test.yml steps and are deliberately kept OUT of the manifest batch (see the
// quarantine below). The other two really did run nowhere, and one had rotted
// unnoticed: should-defer-cv-wrong-show.test.mjs was failing 2 of its
// assertions because the guard it covers had gone completely inert (BRO-2776 —
// no outlet in outlet-registry.json carried a cvStyle, so
// shouldDeferCvWrongShow() could never return true and 8 call sites in
// rebuild-all-reviews.js were dead branches). A test that never runs cannot tell
// you its subject died, which is the same "absence of a signal looks like the
// safe outcome" shape the gates in this repo exist to break.
//
// RESOLVED 2026-09-05. The 6 cvStyle keys were restored (nytimes, vulture,
// newyorker, washpost, nysr, new-york-sun), the test now passes 8/8, and it is
// registered in tests/unit-test-manifest.txt so it runs. The standing guard
// against a silent repeat is audit-outlet-registry.js, which now FAILS
// --strict when zero outlets carry 'long-biographical' — the original 2026-05-16
// loss was a clean 3-way merge silently dropping every key.
//
// SCOPE: this scans tests/unit only, by design. Test files elsewhere
// (scripts/*.test.mjs, scripts/tests/, tests/smoke/, tests/live/, top-level
// tests/) are policed by scripts/audit-orphan-tests.js, which since BRO-2778
// decides coverage per repo-relative path: a file counts only when that exact
// path is in a manifest, matched by a run: glob, or named in a run: step. Its
// old basename match let scripts/ tests hide behind same-named tests/unit/
// files; tests/smoke/stage-latency-wiring.test.mjs is now manifest-registered.
// Do not widen this scan into a second orphan gate.
//
// Directories scanned are those whose contents are expected to be manifest-
// registered. tests/e2e and tests/fixtures are driven by Playwright / read as
// data, so they are deliberately out of scope.
const SCANNED_TEST_DIRS = ['tests/unit'];
// Every extension a manifest can carry, NOT just the ones tests/unit happens to
// use most. The first cut listed mjs/ts/tsx and silently ignored the five
// .test.js files already in tests/unit — and .test.js IS a format the manifests
// execute (6 entries across the three today), so a new unregistered .test.js
// would have passed the gate while it printed "every test file is registered".
// A blocking gate with a hole exactly where it claims coverage is worse than no
// gate, because it is believed. (Codex adversarial review, 2026-09-04.)
const TEST_FILE_RE = /\.test\.(c?js|mjs|tsx?)$/;

/**
 * Tests knowingly left unregistered, each with the issue that will end the
 * exemption. This list is PRINTED on every run rather than silently skipped —
 * a quarantine nobody can see is just an orphan with extra steps. Adding an
 * entry here is a deliberate, reviewable act; the gate stays exact for
 * everything else.
 *
 * A reason containing the marker below asserts the file runs at its OWN
 * dedicated test.yml step. That claim is VERIFIED, not taken on trust: if the
 * step is renamed or deleted the file silently stops running anywhere, and a
 * pathname-only exemption would keep the gate green while printing prose
 * saying it still runs (Codex adversarial review, 2026-09-04). Such an entry
 * whose premise has failed is reported as a blocking finding, because it means
 * a test now runs nowhere at all.
 */
// BRO-2483: the quarantine now lives in scripts/lib/unit-test-collection.js
// (its EXCLUDED map is the single source of truth for files the collected node
// batch leaves out). Re-exported here under the old names for compatibility;
// the RUNS_AT_OWN_STEP verification below is unchanged.
const RUNS_AT_OWN_STEP = COLLECTION_RUNS_AT_OWN_STEP;
const UNREGISTERED_TEST_QUARANTINE = TESTS_UNIT_QUARANTINE;

/** Repo-relative paths of every test file under SCANNED_TEST_DIRS. */
function listTestFilesOnDisk(repoRoot) {
  const found = [];
  for (const dir of SCANNED_TEST_DIRS) {
    const absDir = path.join(repoRoot, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !TEST_FILE_RE.test(entry.name)) continue;
      // The entry's own directory, which with recursive:true can sit BELOW
      // absDir — so the repo-relative path must be derived from it, not from
      // absDir. Node renamed this field: `path` in 20.1-20.11, `parentPath`
      // from 20.12 (CI pins node-version '20', which resolves to the latest
      // 20.x, but both spellings are cheap to accept). Falling back to absDir
      // would silently emit a WRONG path for a nested test — a manifest lookup
      // that misses, i.e. a phantom orphan — so an unknown shape throws
      // instead.
      const parent = entry.parentPath || entry.path;
      if (!parent) {
        throw new Error(
          `readdirSync entry for ${entry.name} exposes neither parentPath nor path — Node ${process.version} is not supported by this scan`
        );
      }
      const abs = path.join(parent, entry.name);
      found.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
    }
  }
  return found.sort();
}

/**
 * Test files that exist on disk but appear in no manifest, so CI never runs
 * them. Quarantined entries are reported separately rather than counted as
 * findings.
 *
 * @param {string} repoRoot
 * @returns {{orphans: string[], quarantined: {test: string, reason: string}[], staleQuarantine: string[], brokenExemptions: string[]}}
 */
// `quarantine` is injectable so this guard's OWN tests can drive it with a
// synthetic entry instead of whichever real card happens to sit at index 0.
// Reading a live entry made the fixtures depend on that entry's SHAPE: entries
// whose reason contains RUNS_AT_OWN_STEP route to brokenExemptions, not
// quarantined, so 2 of the 3 real entries produce quarantined:0 and would red
// main the moment the first one retired (review 2026-09-05).
function findUnregisteredTests(repoRoot, quarantine = UNREGISTERED_TEST_QUARANTINE) {
  const registered = new Set();
  for (const manifest of MANIFEST_FILES) {
    for (const entry of manifestEntriesFor(repoRoot, manifest)) registered.add(entry);
  }

  // Fail CLOSED on a moved layout. The signal is the DIRECTORY being gone, not
  // the file count: a directory that exists and holds no test files is a real,
  // legitimate answer (and is what a minimal fixture tree looks like), whereas
  // every scanned directory having vanished means this gate is now scanning
  // nothing and would report "no orphans" forever.
  if (!SCANNED_TEST_DIRS.some((d) => fs.existsSync(path.join(repoRoot, d)))) {
    throw new Error(
      `none of ${SCANNED_TEST_DIRS.join(', ')} exists under ${repoRoot} — the test layout moved and this gate would scan nothing`
    );
  }
  const onDisk = listTestFilesOnDisk(repoRoot);

  // Read once, for verifying RUNS_AT_OWN_STEP claims below. Missing test.yml is
  // already fatal in findManifestPathGaps, so tolerate it here rather than
  // throwing a second, less informative error for the same cause.
  const workflowAbs = path.join(repoRoot, WORKFLOW_REL);
  const workflowText = fs.existsSync(workflowAbs) ? fs.readFileSync(workflowAbs, 'utf8') : '';

  const orphans = [];
  const quarantined = [];
  const brokenExemptions = [];
  for (const rel of onDisk) {
    if (registered.has(rel)) continue;
    const reason = quarantine.get(rel);
    if (!reason) {
      orphans.push(rel);
      continue;
    }
    // An exemption that claims a dedicated step must still HAVE one. Matching
    // the repo-relative path is deliberate: that is what the `run:` line
    // contains, and it cannot be satisfied by the file merely being named in a
    // comment elsewhere the way a bare basename could.
    if (reason.includes(RUNS_AT_OWN_STEP) && !workflowText.includes(rel)) {
      brokenExemptions.push(rel);
      continue;
    }
    quarantined.push({ test: rel, reason });
  }

  // A quarantine entry for a file that is now registered (or deleted) is stale.
  // Reported, never fatal: the exemption has simply stopped applying, and
  // failing the build for a tidy-up would punish the person who fixed it.
  const onDiskSet = new Set(onDisk);
  const staleQuarantine = [...quarantine.keys()].filter(
    (t) => registered.has(t) || !onDiskSet.has(t)
  );

  return { orphans, quarantined, staleQuarantine, brokenExemptions };
}

module.exports = {
  findManifestPathGaps,
  findUnregisteredTests,
  listTestFilesOnDisk,
  readManifestEntries,
  manifestEntriesFor,
  MANIFEST_FILES,
  WORKFLOW_REL,
  SCANNED_TEST_DIRS,
  UNREGISTERED_TEST_QUARANTINE,
  RUNS_AT_OWN_STEP,
};
