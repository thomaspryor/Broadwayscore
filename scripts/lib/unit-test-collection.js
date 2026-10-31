#!/usr/bin/env node
/**
 * unit-test-collection.js — the plain-node unit-test batch, collected from the
 * tree instead of read from a hand-maintained list (BRO-2483).
 *
 * Until BRO-2483 test.yml's unit-tests job and land's unit-tests-node gate ran
 * `node --test $(cat tests/unit-test-manifest.txt)`: ~1,450 sorted lines that
 * every session adding a test had to edit. It was edited 5+ times on
 * 2026-10-13 alone, and concurrent sessions kept producing duplicate or
 * out-of-order lines (BRO-151) that reddened CI after landing. That file is
 * now a tombstone: RETIRED_HEADER prepended to the frozen old list,
 * merge=union kept so in-flight branches' appends merge cleanly into a file
 * nothing reads (while this module exists in the tree under test).
 *
 * The batch is OPT-OUT: every *.test.{mjs,js,cjs} file directly inside
 * NODE_TEST_DIRS (non-recursive), plus scripts/lib/*.test.{js,cjs}, minus
 *   - every path in the tsx and e2e manifests (they pick a different runner,
 *     are small and rarely edited, and stay hand-maintained),
 *   - top-level scripts/verify-*.test.* and scripts/_skip-*.test.* (live-world
 *     acceptance / RECHECK-AFTER probes; one sat in the unit batch and reddened
 *     main, BRO-4837) unless listed in OPT_IN,
 *   - EXCLUDED: per-file opt-outs, each with the reason and where it runs
 *     instead.
 * scripts/lib/*.test.mjs is deliberately NOT collected: test.yml's
 * `tests=(scripts/lib/*.test.mjs)` step and land's scripts-lib-tests gate run
 * those already (the old manifest listed 87 of them, so they ran twice).
 *
 * scripts/audit-orphan-tests.js still forces every test file to have a CI
 * execution path or a documented exemption, so an EXCLUDED file must run
 * somewhere else or be exempted there. The steady state is the same as the
 * manifest era; the difference is that adding a test needs no shared-file edit.
 *
 * Usage:
 *   node scripts/lib/unit-test-collection.js [--root <dir>]
 *     prints one repo-relative path per line; exits 1 when the list is empty
 *     (`node --test` with zero file arguments silently falls back to its own
 *     discovery glob, so an empty list must never reach it).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const COLLECTION_MODULE_REL = 'scripts/lib/unit-test-collection.js';
const NODE_MANIFEST_REL = 'tests/unit-test-manifest.txt';
const TSX_MANIFEST_REL = 'tests/unit-test-manifest-tsx.txt';
const E2E_MANIFEST_REL = 'tests/e2e-unit-test-manifest.txt';
const OTHER_RUNNER_MANIFESTS = [TSX_MANIFEST_REL, E2E_MANIFEST_REL];

// Floor for the real repo's node batch (~1,360 files when BRO-2483 landed).
// test.yml and land-gauntlet.sh enforce it via the CLI's --min; fixtures, which
// legitimately collect a handful, simply omit the flag.
const MIN_NODE_BATCH = 1300; // ~1390 collected on 2026-10-13; 1000 let a whole dropped directory (262 files) through (BRO-2483 ship-check)

// Scanned non-recursively. scripts/lib is special-cased below.
const NODE_TEST_DIRS = ['tests/unit', 'tests/smoke', 'scripts', 'scripts/tests', 'scripts/newsletter', 'scripts/llm-scoring'];
const NODE_TEST_FILE_RE = /\.test\.(mjs|js|cjs)$/;
const SCRIPTS_LIB_DIR = 'scripts/lib';
const SCRIPTS_LIB_TEST_RE = /\.test\.(js|cjs)$/; // .mjs runs in the scripts/lib glob step

// Live-world acceptance / recheck probes at the top level of scripts/.
const DEFAULT_EXCLUDE_RE = /^scripts\/(verify-|_skip-)[^/]*\.test\.(mjs|js|cjs)$/;

// Pattern matches that DO belong in the unit batch (offline, deterministic).
// Every entry must exist and match DEFAULT_EXCLUDE_RE (glob-based-manifest.test.mjs).
const OPT_IN = new Set([
  'scripts/verify-addams-wsj-dedup-held.test.mjs',
  'scripts/verify-feedback-requests-live.test.mjs',
  'scripts/verify-frankie-2002-cleanup.test.mjs',
  'scripts/verify-photo-limits.test.mjs',
  'scripts/verify-prior-run-former-cast-sweep.test.mjs',
  'scripts/verify-reroute-migration.test.mjs',
  'scripts/verify-review-text-folders.test.mjs',
  'scripts/verify-review-recovery.test.mjs',
]);

// A reason containing this marker asserts the file runs at its OWN dedicated
// test.yml step; scripts/lib/test-yml-manifest-paths.js verifies that claim.
const RUNS_AT_OWN_STEP = 'DOES run';

// tests/unit files knowingly kept out of the batch. Moved here from
// scripts/lib/test-yml-manifest-paths.js (which re-exports it as
// UNREGISTERED_TEST_QUARANTINE, and still verifies the RUNS_AT_OWN_STEP claims).
const TESTS_UNIT_QUARANTINE = new Map([
  [
    'tests/unit/dependency-audit-clean.test.mjs',
    'BRO-6404 (BRO-4434 pattern): live npm registry advisory feed can change without a code change, so it must not gate land. Run by the card VERIFY command; EXEMPT_NEVER_CI in audit-orphan-tests.js.',
  ],
  [
    'tests/unit/rendered-copy-voice.test.mjs',
    'BRO-5812 \u2014 DOES run at its own advisory test.yml step ("Rendered copy voice guard (BRO-5812, advisory)", continue-on-error: true). CLAUDE.md section 19: new gates land advisory first, so a voice-rule regression must not block the unit batch.',
  ],
  [
    'tests/unit/scraper-cookie-wiring.test.mjs',
    'BRO-2778 — DOES run in CI, by design, at its own test.yml step ("Run scraper-cookie-wiring tests (direct exec, no --test wrapper)"). It monkey-patches https.get/https.request globally, which under `node --test` trips a worker-IPC "Unable to deserialize cloned data" error on Node 20 EVERY run (regression noted 2026-04-30). Collecting it would put it back in the `node --test` batch, which has no continue-on-error. Must stay excluded.',
  ],
  [
    'tests/unit/opening-night-checks-skeleton.test.mjs',
    'BRO-2778 — DOES run in CI at its own serial test.yml step. It writes _stub-passes.check.js and _stub-throws.check.js into scripts/lib/opening-night-checks/, which loadChecks() in that directory\'s index.js discovers by globbing *.check.js. Batch files run in parallel `node --test` workers alongside opening-night-bypass-corpus.test.mjs, which calls that loader, so collecting it would make main red nondeterministically. Must stay excluded.',
  ],
  [
    'tests/unit/dmarc-deliverability.test.mjs',
    'BRO-2600 — DOES run in CI at its own advisory step ("Run slow network-dependent unit tests", continue-on-error: true). It does a live dns.resolveTxt() of _dmarc.broadwayscorecard.com; collecting it would put a real network call in the no-continue-on-error batch, gating unrelated PRs on a resolver hiccup. Must stay excluded.',
  ],
  // BRO-3425 (2026-09-24): live-DATA assertions, moved out of test.yml's
  // no-data unit batch because they reddened main with no code change (test.yml
  // run 36077865497). They run in check-corpus-drift.yml's "Live-data
  // assertions" step (the data-health workflow) — scripts/audit-orphan-tests.js
  // verifies that run: line exists.
  [
    'tests/unit/cast-changes-real-data.test.mjs',
    'BRO-3425 — runs in check-corpus-drift.yml (data-health), not test.yml: asserts on data/cast-changes.json state (stale [AUTO-FLAGGED] > 30 d), which bots rewrite daily. In the unit batch it turned main red with no code change.',
  ],
  [
    'tests/unit/bro3887-cache-fix-acceptance.test.mjs',
    'BRO-3425 — runs in check-corpus-drift.yml (data-health), not test.yml: a live probe of the repo Actions cache usage via the GitHub API (BRO-447; was gather-reviews credits/day) plus a credits diagnostic from data/audit/scraper-spend-ledger.jsonl. Live readings are not code facts; in the unit batch it turned main red on 2026-09-24 (7,054 credits).',
  ],
  [
    'tests/unit/image-presence.test.mjs',
    'BRO-3425 — runs in check-corpus-drift.yml (data-health), not test.yml: asserts no scored show in the live catalog is imageless past the self-heal threshold (Date.now()), which turns true whenever a newly scored show still lacks a poster. In the unit batch it turned main red on 2026-09-29 (5 West End shows) with no code change.',
  ],
  [
    'tests/unit/venue-complex-live-data.test.mjs',
    'BRO-3425 — runs in check-corpus-drift.yml (data-health), not test.yml: venue-complex orphan + candidate-gap checks over data/shows.json, which bots add to and retire from many times a day. In the unit batch it turned main red 2026-09-29 (orphans) and 2026-09-30 ("box" candidate gap) with no code change. Orphans stay gated at write time by validate-data.js.',
  ],
  [
    'tests/unit/tour-runtime-coverage.test.mjs',
    'BRO-4750 — runs in check-corpus-drift.yml (data-health), not test.yml: asserts every national tour in data/shows.json carries a runtime and synopsis (unless a documented gap). shows.json is rewritten daily and new tours appear, so in the unit batch it would redden main with no code change.',
  ],
  [
    'tests/unit/sound-of-music-synopsis.test.mjs',
    'BRO-4763: live-data synopsis backfill assertion, imported by tour-runtime-coverage.test.mjs in check-corpus-drift.yml (data-health). Keep daily shows.json state out of the code-only batch.',
  ],
  [
    'tests/unit/tour-runtime-source-agreement.test.mjs',
    'BRO-4776 acceptance shim: imports tour-runtime-coverage.test.mjs, which runs in check-corpus-drift.yml (data-health). Keep live source reads out of the unit batch. EXEMPT_NEVER_CI in audit-orphan-tests.js.',
  ],
  [
    'tests/unit/outlet-registry-live-data.test.mjs',
    'BRO-3425 — runs in check-corpus-drift.yml (data-health), not test.yml: null-domain ceiling + domain collisions over data/outlet-registry.json, which the rebuild auto-registers into and commits to main many times a day. In the unit batch it turned main red on 2026-09-29 (51 > 50) with no code change.',
  ],
  [
    'tests/unit/merge-reviews-json-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of merge-reviews-json.test.mjs over bot-rewritten data/reviews.json. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/cast-changes-data-quality-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of cast-changes-data-quality.test.mjs over bot-rewritten data/cast-changes.json. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/duplicate-images-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of duplicate-images.test.mjs over bot-rewritten data/shows.json + public/. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/drain-unknown-outlets-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of drain-unknown-outlets.test.mjs over bot-rewritten data/audit/unknown-aggregator-outlets.json + data/shows.json. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/discover-playbill-urls-target-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of discover-playbill-urls-target.test.mjs over bot-rewritten data/shows.json. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/audit-bad-stub-visibility-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of audit-bad-stub-visibility.test.mjs over bot-rewritten data/shows.json. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/review-pullquotes-live-data.test.mjs',
    'BRO-5798 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: asserts no review missing a pullQuote has a recoverable excerpt in review-texts, split out of review-pullquotes.test.mjs over bot-rewritten data/reviews.json + data/review-texts. In the unit batch it turned main red 2026-10-20 (4 reviews) with no code change.',
  ],
  [
    'tests/unit/doubled-market-ids-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of doubled-market-ids.test.mjs over bot-rewritten data/shows.json. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/outlet-domain-validation-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of outlet-domain-validation.test.mjs over bot-rewritten data/review-texts + data/outlet-registry.json. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/automated-clear-not-manual-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of automated-clear-not-manual.test.mjs over bot-rewritten data/review-texts. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/critic-spelling-duplicates-live-data.test.mjs',
    'BRO-5729 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: ceiling / zero-count assertions split out of critic-spelling-duplicates.test.mjs over bot-rewritten data/review-texts. In the unit batch they turn main red with no code change.',
  ],
  [
    'tests/unit/duplicate-show-dedup-live-data.test.mjs',
    'BRO-5737 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: live shows.json alias/id-clash check split out of duplicate-show-dedup.test.mjs. In the unit batch it can turn main red with no code change.',
  ],
  [
    'tests/unit/review-gap-remediation-live-data.test.mjs',
    'BRO-5737 (BRO-3425 pattern) — runs in check-corpus-drift.yml (data-health), not test.yml: live reviews.json cross-check split out of review-gap-remediation.test.mjs. In the unit batch it can turn main red with no code change.',
  ],
]);

// Every per-file opt-out. Single source of truth. Each entry must exist and
// carry a non-empty reason; a stale entry fails glob-based-manifest.test.mjs.
const EXCLUDED = new Map([
  ...TESTS_UNIT_QUARANTINE,
  // Run at their own test.yml steps (named in a run: line, so the orphan audit counts them).
  ['scripts/auto-close-expired-shows.test.mjs', 'BRO-5071 — runs at its own test.yml step ("Auto-close expired shows tests (BRO-5071)") in the data-safety-guards job, next to the --dry-run check of the same CLI.'],
  ['scripts/enrich-fallback-ticket-links-live.test.mjs', 'Makes live network calls; runs at test.yml\'s advisory "Run slow network-dependent unit tests" step (continue-on-error: true) so a transient flake cannot block an unrelated PR.'],
  ['scripts/merge-worktree-to-main.test.mjs', 'BRO-2904 — runs at its own test.yml step ("Run merge-worktree-to-main stash-restore test (BRO-2904)") under `timeout 180`, so a hang is a named red step.'],
  // Acceptance-command shims: one-line imports of a suite CI already runs (collecting them would run it twice).
  ['scripts/morning-digest.test.mjs', 'BRO-6222 acceptance shim: imports tests/unit/money-signups-digest.test.mjs, collected by the unit batch. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/cast-backfill-year-validation.test.mjs', 'BRO-4051 acceptance shim: imports tests/unit/cast-backfill-year-validation.test.mjs, which the batch already runs. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/ccusage-baseline.test.mjs', 'BRO-4491 acceptance shim: re-imports the collected tests/unit copy. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/discovery-broadwayworld-westend.test.mjs', 'BRO-4850 acceptance shim: imports scripts/lib/discovery-broadwayworld-westend.test.mjs (scripts/lib/*.test.mjs glob step). EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/ingest-manual-review.test.mjs', 'BRO-3151 acceptance shim: imports scripts/lib/manual-review-url-change.test.mjs (scripts/lib/*.test.mjs glob step). EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/replay-pending-bylines.test.mjs', 'BRO-4408 + BRO-2735 acceptance shim: imports scripts/lib/opening-night-poller-pending-drain.test.mjs, pending-drain-order.test.mjs and replay-pending-zero-text.test.mjs (scripts/lib/*.test.mjs glob step). EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/scrape-playbill-verdict.test.mjs', 'BRO-2136 acceptance shim: re-imports the collected tests/unit copy. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/scraper-dtli-routing.test.mjs', 'BRO-4244 acceptance shim: imports scripts/lib/scraper-dtli-routing.test.mjs (scripts/lib/*.test.mjs glob step). EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  // Live-data acceptance checks (data-state, would flap in CI).
  ['scripts/matilda-theatre-row-closed.test.mjs', 'BRO-328 live-data acceptance check (data-state, would flap in CI). Run by hand / by its card\'s VERIFY. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/opening-night-express.test.mjs', 'BRO-3137 live-data acceptance check (data-state, would flap in CI). Run by hand / by its card\'s VERIFY. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/tests/linear-backlog-verifiability.test.mjs', 'BRO-2718 future-state probe against the live Linear board (fails today by design). Run as its card\'s acceptance command. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
  ['scripts/tests/verify-watchdog-claim-loop-gone.test.mjs', 'task-1564 RECHECK-AFTER probe: reads a per-machine, gitignored dispatch-ledger.jsonl at a hardcoded absolute path, so it cannot run in CI. EXEMPT_NEVER_CI in audit-orphan-tests.js.'],
]);

/** Non-comment, non-blank lines of a manifest's text. */
function manifestLines(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Is this repo-relative path a candidate for the node batch (before any exclusion)? */
function isCandidate(rel) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  if (NODE_TEST_DIRS.includes(dir)) return NODE_TEST_FILE_RE.test(base);
  if (dir === SCRIPTS_LIB_DIR) return SCRIPTS_LIB_TEST_RE.test(base);
  return false;
}

/** Why a candidate is left out, or null when it is collected. */
function exclusionReason(rel, { otherRunnerEntries = new Set(), excluded = EXCLUDED, optIn = OPT_IN } = {}) {
  if (otherRunnerEntries.has(rel)) return 'listed in the tsx or e2e manifest (runs under tsx there)';
  if (excluded.has(rel)) return excluded.get(rel);
  if (DEFAULT_EXCLUDE_RE.test(rel) && !optIn.has(rel)) return 'top-level scripts/verify-* or _skip-* probe (default-excluded; add to OPT_IN to collect)';
  return null;
}

/**
 * Pure core. `files` is every repo-relative path the caller found (any
 * superset is fine; non-candidates are ignored). Returns the sorted node batch.
 */
function selectNodeUnitTests({ files, otherRunnerEntries = [], excluded = EXCLUDED, optIn = OPT_IN }) {
  const others = new Set(otherRunnerEntries);
  const out = new Set();
  for (const rel of files) {
    if (!isCandidate(rel)) continue;
    if (exclusionReason(rel, { otherRunnerEntries: others, excluded, optIn }) !== null) continue;
    out.add(rel);
  }
  return [...out].sort();
}

/**
 * OPT_IN / EXCLUDED entries that no longer hold: the file is gone, an OPT_IN
 * path the pattern does not match, or an EXCLUDED entry with an empty reason.
 */
function staleListEntries({ files, excluded = EXCLUDED, optIn = OPT_IN }) {
  const present = new Set(files);
  const problems = [];
  for (const rel of optIn) {
    if (!present.has(rel)) problems.push(`OPT_IN entry does not exist: ${rel}`);
    else if (!DEFAULT_EXCLUDE_RE.test(rel)) problems.push(`OPT_IN entry is not default-excluded, so listing it does nothing: ${rel}`);
  }
  for (const [rel, reason] of excluded) {
    if (!present.has(rel)) problems.push(`EXCLUDED entry does not exist: ${rel}`);
    if (typeof reason !== 'string' || reason.trim() === '') problems.push(`EXCLUDED entry has no reason: ${rel}`);
  }
  return problems;
}

/** Repo-relative paths of the files in the scanned directories under root. */
function listCandidateFiles(root) {
  const out = [];
  for (const dir of [...NODE_TEST_DIRS, SCRIPTS_LIB_DIR]) {
    const abs = path.join(root, dir);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw e;
    }
    for (const entry of entries) {
      if (entry.isFile()) out.push(`${dir}/${entry.name}`);
    }
  }
  return out;
}

/** Paths in the tsx + e2e manifests under root (a missing one reads as empty). */
function readOtherRunnerEntries(root) {
  const out = [];
  for (const rel of OTHER_RUNNER_MANIFESTS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    out.push(...manifestLines(fs.readFileSync(abs, 'utf8')));
  }
  return out;
}

/** The plain-node unit batch for the tree at root, sorted repo-relative paths. */
function collectNodeUnitTests(root, opts = {}) {
  return selectNodeUnitTests({
    files: listCandidateFiles(root),
    otherRunnerEntries: readOtherRunnerEntries(root),
    ...opts,
  });
}

/**
 * The node batch for the tree at root, picking the source the tree itself
 * uses: the collector when root carries scripts/lib/unit-test-collection.js
 * (this change), otherwise the pre-BRO-2483 manifest file. Only a tree from
 * before this change lacks the collector (land runs the BRANCH's harness
 * against the base tree too). Never selects by manifest presence: the
 * tombstone is always present.
 */
function nodeUnitTestsForTree(root) {
  const own = path.join(root, COLLECTION_MODULE_REL);
  if (fs.existsSync(own)) {
    // The tree's OWN rules (its EXCLUDED / OPT_IN), not this copy's, when the
    // caller runs from a different checkout (daily-runner judges a Codex
    // worktree; the merge gate judges a merged tree).
    if (path.resolve(own) === path.resolve(__filename)) return collectNodeUnitTests(root);
    delete require.cache[require.resolve(own)];
    return require(own).collectNodeUnitTests(root);
  }
  const manifest = path.join(root, NODE_MANIFEST_REL);
  if (!fs.existsSync(manifest)) return [];
  return manifestLines(fs.readFileSync(manifest, 'utf8'));
}

/** Does the tree at root collect its node batch (true) or read the manifest (false)? */
function treeUsesCollector(root) {
  return fs.existsSync(path.join(root, COLLECTION_MODULE_REL));
}

// BRO-2483 tombstone design: tests/unit-test-manifest.txt keeps main's old
// list VERBATIM under this header (merge=union kept). Branches cut before
// BRO-2483 keep appending lines to it and land rebases keep union-merging them;
// a comments-only file could never land cleanly against that churn, so the
// list stays, frozen and ignored. Nothing reads it while this module exists in
// the tree under test (the path-name special case in test-manifest.js etc.).
const RETIRED_HEADER = [
  '# RETIRED (BRO-2483): this file is IGNORED. Nothing reads it; edits here change nothing.',
  '# Node unit tests are collected by scripts/lib/unit-test-collection.js (every',
  '# *.test.{mjs,js,cjs} in tests/unit, tests/smoke, scripts, scripts/tests, scripts/newsletter,',
  '# scripts/llm-scoring, plus scripts/lib/*.test.{js,cjs}, minus the tsx/e2e manifests and its',
  '# EXCLUDED map; top-level scripts/verify-* and scripts/_skip-* need an OPT_IN entry).',
  '# Adding a test needs no edit here. The list below is frozen so branches cut before',
  '# BRO-2483 still merge (merge=union); a follow-up card deletes this file.',
];

/** Pure: does the text open with RETIRED_HEADER (the list below it is ignored)? */
function hasRetiredHeader(text) {
  const lines = String(text).split('\n');
  return RETIRED_HEADER.every((h, k) => lines[k] === h);
}

module.exports = {
  MIN_NODE_BATCH,
  RETIRED_HEADER,
  hasRetiredHeader,
  COLLECTION_MODULE_REL,
  NODE_MANIFEST_REL,
  TSX_MANIFEST_REL,
  E2E_MANIFEST_REL,
  OTHER_RUNNER_MANIFESTS,
  NODE_TEST_DIRS,
  DEFAULT_EXCLUDE_RE,
  OPT_IN,
  EXCLUDED,
  TESTS_UNIT_QUARANTINE,
  RUNS_AT_OWN_STEP,
  manifestLines,
  isCandidate,
  exclusionReason,
  selectNodeUnitTests,
  staleListEntries,
  listCandidateFiles,
  readOtherRunnerEntries,
  collectNodeUnitTests,
  nodeUnitTestsForTree,
  treeUsesCollector,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: node scripts/lib/unit-test-collection.js [--root <dir>] [--min]\n\n' +
        'Prints the plain-node unit-test batch (one repo-relative path per line). Exits 1 when it is empty.\n' +
        `--min also exits 1 (printing nothing) when fewer than MIN_NODE_BATCH (${MIN_NODE_BATCH}) files are collected:\n` +
        'the floor test.yml and land-gauntlet.sh use to catch a collector that silently returns too few.'
    );
    process.exit(0);
  }
  const i = args.indexOf('--root');
  const root = i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.resolve(__dirname, '..', '..');
  let list;
  try {
    list = collectNodeUnitTests(root);
  } catch (e) {
    console.error(`unit-test-collection: collection failed under ${root}: ${e.message}`);
    process.exit(1);
  }
  if (list.length === 0) {
    console.error(`unit-test-collection: collected 0 node unit tests under ${root}`);
    process.exit(1);
  }
  if (args.includes('--min') && list.length < MIN_NODE_BATCH) {
    console.error(`unit-test-collection: collected only ${list.length} node unit tests under ${root} (MIN_NODE_BATCH ${MIN_NODE_BATCH}) — the collector is broken`);
    process.exit(1);
  }
  process.stdout.write(list.join('\n') + '\n');
}
