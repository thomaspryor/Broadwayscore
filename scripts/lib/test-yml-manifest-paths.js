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

// All THREE manifests test.yml actually consumes. The e2e one was missed on the
// first pass and caught in pre-merge review: test.yml:4996 reads it exactly the
// way :3539/:3545 read the other two, so omitting it left the gate green while an
// e2e-unit test registered there but placed outside tests/** would reintroduce
// precisely the bug this gate blocks. All 75 of its entries sit under tests/**
// today, so there was no live gap — but an invisible blind spot in a blocking
// gate is the thing that lets the bug class come back a fifth time.
const MANIFEST_FILES = [
  'tests/unit-test-manifest.txt',
  'tests/unit-test-manifest-tsx.txt',
  'tests/e2e-unit-test-manifest.txt',
];
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
    const abs = path.join(repoRoot, manifest);
    if (!fs.existsSync(abs)) throw new Error(`manifest not found: ${manifest}`);
    for (const entry of readManifestEntries(abs)) {
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
//
// Found with 4 unregistered files on 2026-09-04. Being unregistered does NOT by
// itself mean a test never runs — two of the four have their own dedicated
// test.yml steps and are deliberately kept OUT of the manifest batch (see the
// quarantine below). The other two really did run nowhere, and one had rotted
// unnoticed: should-defer-cv-wrong-show.test.mjs was failing 2 of its 9
// assertions because the guard it covers had gone completely inert (BRO-2776 —
// no outlet in outlet-registry.json carries a cvStyle, so
// shouldDeferCvWrongShow() can never return true and 8 call sites in
// rebuild-all-reviews.js are dead branches). A test that never runs cannot tell
// you its subject died, which is the same "absence of a signal looks like the
// safe outcome" shape the gates in this repo exist to break.
//
// KNOWN SCOPE LIMIT: this scans tests/unit only. 8 of the ~96 scripts/*.test.mjs
// files are in no manifest, and the colocated step globs scripts/lib/*.test.mjs
// rather than scripts/*.test.mjs, so those run nowhere either;
// tests/smoke/stage-latency-wiring.test.mjs is referenced by nothing at all.
// Same disease, deliberately not widened here — each of those needs triaging
// (does it pass? does it belong in a batch?) before a blocking gate can demand
// registration, and shipping a gate that reds main on day one helps nobody.
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
const RUNS_AT_OWN_STEP = 'DOES run';
const UNREGISTERED_TEST_QUARANTINE = new Map([
  [
    'tests/unit/should-defer-cv-wrong-show.test.mjs',
    'BRO-2776 — runs nowhere today AND fails 2/9: no outlet carries cvStyle, so shouldDeferCvWrongShow() is inert. Register once the guard is armed.',
  ],
  [
    'tests/unit/opening-night-checklist-cli.test.mjs',
    'BRO-2777 — runs nowhere today and cannot pass as written: it parses --json off stdout, which carries progress logs before the JSON, and it spends a live Scrapingdog credit per run.',
  ],
  [
    'tests/unit/scraper-cookie-wiring.test.mjs',
    'BRO-2778 — DOES run in CI, by design, at its own test.yml step ("Run scraper-cookie-wiring tests (direct exec, no --test wrapper)"). It monkey-patches https.get/https.request globally, which under `node --test` trips a worker-IPC "Unable to deserialize cloned data" error on Node 20 EVERY run (regression noted 2026-04-30). Adding it to the manifest would put it back in the `node --test` batch, which has no continue-on-error. Must stay unregistered.',
  ],
  [
    'tests/unit/opening-night-checks-skeleton.test.mjs',
    'BRO-2778 — DOES run in CI at its own serial test.yml step. It writes _stub-passes.check.js and _stub-throws.check.js into scripts/lib/opening-night-checks/, which loadChecks() in that directory\'s index.js discovers by globbing *.check.js. Manifest files run in parallel `node --test` workers alongside opening-night-bypass-corpus.test.mjs, which calls that loader, so registering it would make main red nondeterministically. Must stay unregistered.',
  ],
]);

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
function findUnregisteredTests(repoRoot) {
  const registered = new Set();
  for (const manifest of MANIFEST_FILES) {
    const abs = path.join(repoRoot, manifest);
    if (!fs.existsSync(abs)) throw new Error(`manifest not found: ${manifest}`);
    for (const entry of readManifestEntries(abs)) registered.add(entry);
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
    const reason = UNREGISTERED_TEST_QUARANTINE.get(rel);
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
  const staleQuarantine = [...UNREGISTERED_TEST_QUARANTINE.keys()].filter(
    (t) => registered.has(t) || !onDiskSet.has(t)
  );

  return { orphans, quarantined, staleQuarantine, brokenExemptions };
}

module.exports = {
  findManifestPathGaps,
  findUnregisteredTests,
  listTestFilesOnDisk,
  readManifestEntries,
  MANIFEST_FILES,
  WORKFLOW_REL,
  SCANNED_TEST_DIRS,
  UNREGISTERED_TEST_QUARANTINE,
  RUNS_AT_OWN_STEP,
};
