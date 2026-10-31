#!/usr/bin/env node
/**
 * audit-orphan-tests.js — find *.test.mjs/ts/js files not referenced in any
 * .github/workflows/*.yml. Wired into test.yml's lint-workflows job so a forgotten
 * registration blocks the PR instead of silently going un-tested.
 *
 * Scans tests/unit/, the top level of scripts/, AND scripts/tests/ (a test placed
 * directly in scripts/ — not scripts/lib/, which runs via its own glob step —
 * otherwise falls in a gap: no glob covers it and the old audit never looked
 * there, so it ran locally but never in CI. Hit 2026-07-12 with notion-tasks-
 * sync/bsc-next tests.)
 *
 * scripts/tests/ joined the scan BRO-4133 (2026-09-25): 6 files there had
 * accumulated with zero manifest/path-list registration — one of them was
 * this very fix's own acceptance test, caught only by a manual audit run, not
 * by this script, because it never looked in that directory. Two of the six
 * were legitimately unregistrable (a future-state Linear-backlog probe and a
 * per-machine-ledger recheck-after probe) and moved to EXEMPT_NEVER_CI below;
 * the rest were wired into tests/unit-test-manifest.txt (since BRO-2483 the
 * node batch is collected by scripts/lib/unit-test-collection.js instead).
 *
 * BRO-2778 (2026-10-12): coverage is decided per repo-relative PATH
 * (scripts/lib/ci-test-coverage.js): the exact path in a manifest, matched by a
 * run: glob, or named in a run: step. The old basename match let a scripts/
 * test hide behind a same-named tests/unit/ file. tests/, tests/smoke/ and
 * tests/live/ joined the scan in the same change (see SCANNED_DIRS).
 *
 * Notion 362637c5-416f-81f4 — discovered 59 orphans (33% of the suite) during the
 * Stuart King Fixes v2 session. The orphan that triggered the audit (bulk-import-
 * summary.test.mjs) had shipped 2 weeks earlier without being registered, so
 * regressions in its surface area went uncaught.
 *
 * Usage:
 *   node scripts/audit-orphan-tests.js            # exits 1 with a list if orphans found
 *   node scripts/audit-orphan-tests.js --json     # JSON output for CI/scripts
 *   <changed-files> | node scripts/audit-orphan-tests.js --scope-stdin
 *                                                  # (card #1488) only orphans whose repo-
 *                                                  # relative path is in the piped newline-
 *                                                  # separated list are blocking; other
 *                                                  # pre-existing orphans print as
 *                                                  # informational and don't fail the run.
 *                                                  # Used by scripts/lib/run-push-audits.sh
 *                                                  # so an unrelated push isn't blocked by
 *                                                  # someone else's unregistered test. CI's
 *                                                  # direct calls in test.yml never pass this
 *                                                  # flag, so the full-repo check there is
 *                                                  # unchanged.
 *
 * Exempt: files matching tests/unit/_skip-*.test.mjs (intentionally unregistered,
 * e.g., network-dependent tests that can't run in CI).
 */

'use strict';

const fs = require('fs');
const { readWorkflowFilesOrFailClosed } = require('./lib/workflow-glob-guard.js');
const path = require('path');
const { decideOrphanGate } = require('./lib/orphan-test-gate.js');
const { MANIFESTS, NODE_RUNNABLE_TEST_EXTENSIONS, testFileRegex, testReferenceRegex, validateManifest, readManifest, COLLECTOR_FAILURE } = require('./lib/test-manifest.js');

const ROOT = path.resolve(__dirname, '..');
// test.yml's main runner reads file lists from MANIFESTS (task #763 —
// replaced a single 15,987-char inline `node --test <368 files>` line), so a
// registration lives in a manifest, not literally inside test.yml; see
// collectCiCoverage() below.

// Known-broken tests that need investigation before they can be wired into CI.
// Each entry MUST have a Notion card so the exemption can be unwound. Audit will
// list these in --json output as `exemptKnownBroken` so the existence is visible
// but doesn't fail CI.
// Deliberately never run by CI, and NOT expected to stay failing — so the
// decayed-exemption gate must never evaluate these. A deferred-effect
// acceptance probe passes the day its condition finally comes true; flagging
// that as "decay" would turn a success into a red main. Keep this map tiny and
// only for tests whose correct home is a scheduled recheck, not the test suite.
const EXEMPT_NEVER_CI = {
  // BRO-5992 RECHECK-AFTER probe: live GSC/PostHog snapshots, skipped until the cohort hold ends (2026-11-16).
  'scripts/verify-bro-5992-recheck.test.mjs': 'BRO-5992',
  // BRO-4763: runs indirectly, imported by tour-runtime-coverage.test.mjs in
  // check-corpus-drift.yml. The path-based audit does not trace ESM imports.
  'tests/unit/sound-of-music-synopsis.test.mjs': 'BRO-4763',
  // BRO-4776 acceptance shim; imports the live-data suite run by check-corpus-drift.yml.
  'tests/unit/tour-runtime-source-agreement.test.mjs': 'BRO-4776',
  // BRO-6134 RECHECK-AFTER probe: reads live git/Linear/GitHub signals, red while a Codex lane is down.
  'tests/live/codex-lane-alarm-clean.test.mjs': 'BRO-6134',
  // BRO-5989 RECHECK-AFTER probe: live PostHog data, red until each arm has the pre-registered minimum exposed people.
  'tests/live/related-shows-ab-sample.test.mjs': 'BRO-5989',
  // BRO-3490 RECHECK-AFTER probe: live data, red until Saturday's deep-research run researches the six stuck closures.
  'scripts/verify-bro-3490-recheck.test.mjs': 'BRO-3490',
  // BRO-5879 RECHECK-AFTER probe: live data, red until the daily Reddit draft job has run the update-email code.
  'scripts/verify-reddit-update-emails.test.mjs': 'BRO-5879',
  // BRO-5887 RECHECK-AFTER probe: live data, red until a scheduled run has used the pre-send review check.
  'scripts/verify-reddit-review-check.test.mjs': 'BRO-5887',
  // BRO-4993 live-data check of hand-verified director credits; reads data/shows.json.
  'scripts/verify-directors.test.mjs': 'BRO-4993',
  // BRO-4491 acceptance-command shim; re-imports the CI-registered tests/unit copy.
  'scripts/ccusage-baseline.test.mjs': 'BRO-4491',
  // Acceptance shim; its tests/unit suite is collected by the unit batch.
  'scripts/morning-digest.test.mjs': 'BRO-6222',
  // BRO-2136 acceptance-command shim; re-imports the CI-registered tests/unit copy.
  'scripts/scrape-playbill-verdict.test.mjs': 'BRO-2136',
  // BRO-3137 live-data acceptance check (data-state, would flap in CI).
  'scripts/opening-night-express.test.mjs': 'BRO-3137',
  // BRO-328 live-data acceptance check (data-state, would flap in CI).
  'scripts/matilda-theatre-row-closed.test.mjs': 'BRO-328',
  // Deferred-effect acceptance probe (task #695, card 3ae637c5-416f-81bb):
  // asserts a 7-day provider-spend streak, EXPECTED to fail until the ledger
  // accumulates history. Run by autonomous-acceptance-recheck.js at its
  // RECHECK-AFTER date, never by CI. Lives in scripts/, not tests/unit/.
  'scripts/verify-provider-spend-streak.test.mjs': '3ae637c5-416f-81bb',
  // Deferred-effect acceptance probe (task #419, card 3a7637c5-416f-81fd):
  // asserts the "SEO: health" digest condition doesn't fire on the next
  // weekly check-seo-health.yml run. Run by autonomous-acceptance-recheck.js
  // at its RECHECK-AFTER date, never by CI. Lives in scripts/, not
  // tests/unit/ (same pattern as the entry above).
  'scripts/verify-seo-health-clean.test.mjs': '3a7637c5-416f-81fd',
  // Deferred-effect acceptance probe (task #1466, card 3bc637c5-416f-8118):
  // asserts promote-we-aggregator.yml's daily cron produced a real
  // we-promotion-log.jsonl entry after the feature merged 2026-08-14.
  // RECHECK-AFTER 2026-08-16. This file was left off the manifest by the
  // merging session (#1478 ship-check found it as an orphan-tests block
  // when merging unrelated work) — same fix as the two entries above:
  // exempt from CI, let autonomous-acceptance-recheck.js pick it up.
  'scripts/verify-we-aggregator-promotion-ran.test.mjs': '3bc637c5-416f-8118',
  // Deferred-effect acceptance probe (card 3bd637c5-416f-81ed): asserts main's
  // test.yml has HELD green for 24h after the 2026-08-14 recovery from an
  // 89-failure red streak, reading the committed trunk snapshot (the recheck's
  // sandbox has no gh auth). RECHECK-AFTER 2026-08-15. Run by
  // autonomous-acceptance-recheck.js at its stamp date, never by CI — a probe
  // that is EXPECTED to report "not yet 24h" on its first evaluation must
  // never be able to redden the very trunk it is measuring. Lives in scripts/,
  // not tests/unit/ (same pattern as the three entries above).
  'scripts/verify-main-green-streak.test.mjs': '3bd637c5-416f-81ed',
  // Deferred-effect acceptance probe (task #1812, BRO-445): asserts the
  // cmux wrapper-detection fix (96ec6d951d8, merged 2026-08-19T04:05Z)
  // actually moved the dead-launch rate. EXPECTED to fail/be inconclusive
  // until >=20 post-fix launches accumulate. Run by
  // autonomous-acceptance-recheck.js, never by CI. Lives in scripts/, not
  // tests/unit/ (same pattern as the entries above). Added by BRO-445: this
  // file's absence from EXEMPT_NEVER_CI blocked every push-with-retry.sh
  // push repo-wide for 3 days (2026-08-17 through 2026-08-19), including
  // the daily health-check snapshot commit, which is why the snapshot went
  // stale and "Stuck pipeline items" got flagged.
  'scripts/verify-dispatch-dead-rate-recovery.test.mjs': 'task-1812',
  // Deferred-effect acceptance probe (task #1814, BRO-445): asserts
  // update-show-status.yml stops ending CANCELLED after the timeout raise
  // (0d3716a9ba8, landed 2026-08-19T10:19:28Z) + the setup-playwright
  // install-step timeout cap (task #1815). Needs 5 non-cancelled completed
  // runs post-fix before it can pass. Run by autonomous-acceptance-
  // recheck.js, never by CI. Lives in scripts/, not tests/unit/ (same
  // pattern as the entries above). Added by BRO-445 alongside the #1812
  // entry above — both were left off this map by their authoring sessions
  // and both blocked every push-with-retry.sh push repo-wide.
  'scripts/verify-update-show-status-no-cancellations.test.mjs': 'task-1814',
  // BRO-2718: asserts the Linear backlog's refused-command ratio has
  // materially improved over a hardcoded pre-remediation baseline — a
  // FUTURE-state claim that fails against today's live Linear board by
  // design (the file's own header says so). Exists to be run directly as
  // BRO-2718's acceptance command once that sweep lands, never by CI.
  'scripts/tests/linear-backlog-verifiability.test.mjs': 'BRO-2718',
  // task #1564: reads the per-machine, gitignored dispatch-ledger.jsonl at a
  // hardcoded absolute path (/Users/tompryor/Broadwayscore/data/audit/) —
  // cannot run in CI (no such file in a fresh checkout) or on any other
  // machine. A RECHECK-AFTER acceptance probe for autonomous-acceptance-
  // recheck.js, same pattern as the entries above.
  'scripts/tests/verify-watchdog-claim-loop-gone.test.mjs': 'task-1564',
  // BRO-4467: asserts comparative-rescore stopped re-scoring the same groups
  // every chain run, from the live data/llm-scoring-runs.json. Needs post-fix
  // run history, so it is a RECHECK-AFTER probe, never run by CI.
  'scripts/verify-comparative-no-repeat.test.mjs': 'BRO-4467',
  // BRO-4486: asserts the NYT Degenerates rescore and the star re-anchoring
  // happened, from live review files. Red until the enrich + scoring crons
  // act, so it is a RECHECK-AFTER probe, never run by CI.
  'scripts/verify-bro-4486-recheck.test.mjs': 'BRO-4486',
  // BRO-4725: asserts the daily landing job read every Broadway-titled Tours To
  // You page within the stale window, from live data/audit/tour-autocreate.json.
  // Needs scheduled runs after the fix, so it is a RECHECK-AFTER probe.
  'scripts/verify-tours-to-you-coverage.test.mjs': 'BRO-4725',
  // BRO-4724: asserts the first tour auto-create write run and the next day's
  // schedule fetch acted, from live data. Date-gated RECHECK-AFTER probe; it
  // sat in the CI unit manifest and redded main (BRO-4837).
  'scripts/verify-bro-4724-recheck.test.mjs': 'BRO-4724',
  // BRO-4061: asserts the gap-audit checkpoint grew past its 925-show plateau
  // a week after the catalogue lane landed. Date-gated RECHECK-AFTER probe.
  'scripts/verify-bro-4061-recheck.test.mjs': 'BRO-4061',
  'scripts/verify-bro-6687-recheck.test.mjs': 'BRO-6687',
  // BRO-4930: asserts the 2026-10 outlet tier moves reached published show
  // JSON after the nightly rebuild-reviews run. Date-gated RECHECK-AFTER probe.
  'scripts/verify-outlet-tiers-published.test.mjs': 'BRO-4930',
  // BRO-5063: asserts the synopsis cleanup plan applied and the rows it
  // cleared were refilled, from live data/shows.json. Red between the plan
  // run and the backfill, so it is an acceptance probe, never run by CI.
  'scripts/verify-bro-5063-synopses.test.mjs': 'BRO-5063',
  // BRO-2778: keys are repo-relative PATHS. A bare filename used to exempt
  // every same-named file in every scanned directory (ccusage-baseline and
  // opening-night-express each have a tests/unit/ twin), the collision this
  // card fixed; audit-orphan-tests.test.mjs rejects any key without a '/'.
  // BRO-2778 triage: these hid behind a same-named tests/unit/ or scripts/lib/
  // file under the old basename match. Both are one-line acceptance-command
  // shims that only import a suite CI already runs (registering them would run
  // that suite twice).
  // BRO-4051 shim: imports tests/unit/cast-backfill-year-validation.test.mjs (unit manifest).
  'scripts/cast-backfill-year-validation.test.mjs': 'BRO-4051',
  // BRO-3151 shim: imports scripts/lib/manual-review-url-change.test.mjs (scripts/lib/*.test.mjs glob).
  'scripts/ingest-manual-review.test.mjs': 'BRO-3151',
  // BRO-4408 shim: imports scripts/lib/opening-night-poller-pending-drain.test.mjs (CI glob).
  'scripts/replay-pending-bylines.test.mjs': 'BRO-4408',
  'scripts/discovery-broadwayworld-westend.test.mjs': 'BRO-4850',
  // BRO-4244 shim: imports scripts/lib/scraper-dtli-routing.test.mjs (CI glob).
  'scripts/scraper-dtli-routing.test.mjs': 'BRO-4244',
  // BRO-4434 LIVE VERIFY probes in tests/live/ (first scanned BRO-2778): run the
  // real `npm audit` against the registry advisory feed and the calendar, so
  // their answer changes without a code change. Card acceptance commands only.
  'tests/live/audit-dependencies-clean.test.mjs': 'BRO-4434',
  'tests/unit/dependency-audit-clean.test.mjs': 'BRO-6404',
  // BRO-3444 RECHECK-AFTER probe: reads the CI health snapshot on origin/main.
  'tests/live/digest-urgent-visitor-only.test.mjs': 'BRO-3444',
  'tests/live/audit-dependencies-no-expiring.test.mjs': 'BRO-4434',
};

const EXEMPT_KNOWN_BROKEN = {
  // (headless-prompt-no-owner-handoff.test.mjs removed 2026-08-02 — the task
  // #757 exemption above was explicitly conditional on "register in test.yml
  // when its guard lib passes". The guard shipped, all 10 cases pass, and the
  // test is now in the tests/unit node --test list, so the exemption decayed
  // the moment it was registered and the decayed-exemption gate demanded it go.)

  // (opening-night-checks-bww-rr.test.mjs removed 2026-08-01 — it was never
  // "behavior drift". Its no-bwwRoundupUrl case asserted the branch the check
  // takes when Browserbase is UNCONFIGURED, then inherited the ambient env: it
  // passed in CI's secret-less lint job and failed on any machine with a .env.
  // The test now scrubs BROWSERBASE_* itself and is registered in test.yml.
  // Surfaced when this gate ran for the first time ever — see the note on the
  // decayed-exemption step in test.yml.)

  // (opening-night-checklist-cli.test.mjs removed 2026-10-12, BRO-2777 — it now
  // drives the CLI with --json --out=<file> like its production callers, runs
  // offline against a temp fixture (OPENING_NIGHT_CHECKLIST_OFFLINE=1), and is
  // registered in tests/unit-test-manifest.txt.)
  // (opening-night-checks-skeleton.test.mjs removed 2026-05-16 — it actually passes
  // given a 30s per-test budget; the original "TIMEOUT" report was from a 30s
  // wall-clock kill across 3 sequential tests. Now registered in test.yml's main
  // runner. Decayed-exemption gate caught this.)
};

// BRO-6077: the previously advisory probe wording now blocks as well.
// Keep the implementation in scripts/lib so its regressions run in CI.
const { neverCiEntriesWithComments, recheckProbeGuardViolations } = require('./lib/recheck-probe-guard.js');

// .mjs is the canonical extension but .test.ts and .test.js exist too — must
// audit all of them or the gate has the same hole it was built to close. Claude
// caught this during ship-check: 6 .ts/.js orphans were silently uncovered.
//
// BRO-2751: the extension list now lives in scripts/lib/test-manifest.js and is
// SHARED with scripts/lib/colocated-test-ci-coverage.test.mjs. The two guards
// kept independent hand-maintained lists and both were missing `sh`, so bash
// tests could run in zero CI jobs with both reporting all-clear. Fresh RegExp
// objects per call, never one shared instance — REFERENCE_REGEX is /g/-flagged
// and would otherwise leak lastIndex across consumers.
const TEST_FILE_REGEX = testFileRegex();
const REFERENCE_REGEX = testReferenceRegex();

// Exemption lookup by repo-relative path only (BRO-2778).
const has = (map, k) => Object.prototype.hasOwnProperty.call(map, k);
function exemptionFor(map, f) {
  return has(map, f.rel) ? map[f.rel] : undefined;
}

// Directories scanned, each NON-recursively (readdirSync): scripts/lib/ is
// covered by scripts/lib/colocated-test-ci-coverage.test.mjs, and tests/e2e /
// tests/fixtures are Playwright specs and data. BRO-2778 added tests/ itself
// (star-rating-extractors.test.js), tests/smoke/ and tests/live/: a test there
// was invisible to every orphan check (stage-latency-wiring.test.mjs sat in
// tests/smoke/ referenced by nothing).
// scripts/newsletter and scripts/llm-scoring joined with the BRO-2483
// collector, which runs them: without a scan, dropping either from its
// NODE_TEST_DIRS would silently stop 18 tests (BRO-2483 ship-check).
const SCANNED_DIRS = ['tests', 'tests/unit', 'tests/smoke', 'tests/live', 'scripts', 'scripts/tests', 'scripts/newsletter', 'scripts/llm-scoring'];

// Returns { name, rel } for each test file: name is the bare filename (used for
// the exemption-map lookups), rel is the repo-relative path (what coverage is
// decided on, BRO-2778).
function listTestFiles(root = ROOT) {
  const out = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile() || !TEST_FILE_REGEX.test(entry.name)) continue;
      if (entry.name.startsWith('_skip-')) continue; // explicit opt-out prefix
      out.push({ name: entry.name, rel: `${dir}/${entry.name}` });
    }
  }
  return out.sort((x, y) => x.rel.localeCompare(y.rel));
}

// Task #1643: a bare filename mention anywhere in a workflow's raw text used
// to count as "referenced", including inside a `#` comment, a `paths:`
// trigger-list entry (`- 'tests/unit/foo.test.mjs'`), or (adversarial review
// caught this before it shipped) a `name:`/`env:`/`with:` scalar that merely
// NAMES a test file without running it — none of which mean the file
// actually executes. That let 5 real orphans hide behind this exact audit.
//
// A first pass tried "drop lines starting with `#` or `-`", which fixed the
// 5 known orphans but left the name:/env:/with: shape open — the same
// false-negative direction (a mentioned-but-not-run file reads as covered)
// that created this bug in the first place. The precise fix: a real
// invocation in this repo's workflow files always lives inside a step's
// `run:` value — either the single-line form (`run: cmd ... file.test.mjs`)
// or the block-scalar form (`run: |`, followed by lines indented deeper than
// the `run:` key itself, per standard YAML block-scalar semantics). Extract
// ONLY that text and match against it; every other YAML key (comments,
// paths:, name:, env:, with:, etc.) is excluded by construction, not by
// guessing at punctuation.
function extractRunBlocks(content) {
  const lines = content.split('\n');
  const out = [];
  const singleLineRunRe = /^(\s*)run:\s*(.+)$/;
  const blockRunRe = /^(\s*)run:\s*[|>][+-]?\s*$/;
  let blockIndent = null; // indentation (char count) of an open `run: |` key, or null
  for (const line of lines) {
    if (blockIndent !== null) {
      const indent = line.match(/^ */)[0].length;
      // Blank lines don't end a block scalar; anything indented no deeper
      // than the `run:` key itself does (next step, next key, dedent).
      if (line.trim() === '' || indent > blockIndent) {
        out.push(line);
        continue;
      }
      blockIndent = null; // fall through — this line starts a new key
    }
    const block = line.match(blockRunRe);
    if (block) { blockIndent = block[1].length; continue; }
    const single = line.match(singleLineRunRe);
    if (single) out.push(single[2]);
  }
  return out.join('\n');
}

// BRO-2778: coverage is decided per repo-relative PATH, never per basename.
// The old collectReferencedTests() returned a Set of bare filenames, so
// scripts/foo.test.mjs read as covered whenever tests/unit/foo.test.mjs (a
// different file) was in a manifest or a run: step. Two scripts/ tests ran in
// zero CI jobs behind that collision. The rule itself lives in
// scripts/lib/ci-test-coverage.js (rule 15) so the regression test drives the
// real function against a fixture tree.
//
// Manifest entries only prove execution for a file `node --test` can run
// (BRO-2751): every manifest is fed straight to it, so a *.test.sh listed
// there would satisfy the audit while guaranteeing a run-time failure.
// ciCoverageOf() ignores manifests for .sh for exactly that reason.
function collectCiCoverage(root = ROOT) {
  readWorkflowFilesOrFailClosed(path.join(root, '.github', 'workflows'), { includeYaml: true });
  // Lazy: bash-integration-test-list.js (pulled in by ci-test-coverage.js)
  // require()s this module for extractRunBlocks.
  const { ciCoverageOf } = require('./lib/ci-test-coverage.js');
  const { executableWorkflowText } = require('./lib/bash-integration-test-list.js');
  const runText = executableWorkflowText(path.join(root, '.github', 'workflows'));
  // BRO-2483: MANIFESTS[0] names the collected node batch; readManifest()
  // resolves it (scripts/lib/unit-test-collection.js) whenever the tree carries
  // the collector, and reads the file only in a pre-BRO-2483 tree. A test the
  // collector leaves out (its EXCLUDED map, the verify-* default) needs a run:
  // step or an exemption below, exactly as an unregistered file did before.
  const manifestEntries = new Set();
  for (const manifest of MANIFESTS) {
    const abs = path.join(root, manifest);
    let entries;
    try {
      entries = readManifest(abs, root);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      // A collector failure must not crash the audit (land-preflight reads a
      // crash as "skip"): checkManifests() reports it as a blocking
      // COLLECTOR FAILURE, so the run fails closed with parseable output.
      if (manifest === MANIFESTS[0]) continue;
      throw e;
    }
    for (const entry of entries) manifestEntries.add(entry);
  }
  const ci = { manifestEntries, runText };
  return { ...ci, coverageOf: (rel) => ciCoverageOf(rel, ci) };
}

// Every scanned test file with no CI execution path, before exemptions.
function findRawOrphans(root = ROOT) {
  const files = listTestFiles(root);
  const { coverageOf } = collectCiCoverage(root);
  return { files, rawOrphans: files.filter((f) => !coverageOf(f.rel)) };
}

// Manifest hygiene (BRO-4525). CI's test-manifest-integrity test refuses an
// unsorted, duplicated or dangling manifest entry, but this audit is what a
// session runs after registering a test, and it answered "All N registered"
// for an entry inserted out of order. Cloud sessions don't install
// scripts/hooks/pre-commit (the hook that auto-sorts), so a land run was the
// first thing to notice. Scoped like the orphan list: with --scope-stdin a
// problem blocks only when its manifest is part of this push.
function checkManifests(root = ROOT, changedFiles) {
  const blocking = [];
  const informational = [];
  for (const manifest of MANIFESTS) {
    const { errors } = validateManifest(path.join(root, manifest), root);
    // BRO-2483: a collected-batch problem names the test file, not a manifest
    // anyone edits, so it is in scope when that file is part of the push.
    // A COLLECTOR FAILURE (collector threw, or collected nothing) is never
    // somebody else's red: it blocks every scoped run (fail closed).
    const inScope = (error) => !changedFiles || error.startsWith(COLLECTOR_FAILURE) || changedFiles.includes(manifest) || changedFiles.some((f) => error.includes(f));
    for (const error of errors) (inScope(error) ? blocking : informational).push({ manifest, error });
  }
  return { blocking, informational };
}

function main() {
  // --list-exempt prints REPO-RELATIVE PATHS of decay candidates, one per line,
  // for the decayed-exemption check in CI (`for f in $(...); run; if pass: fail`).
  //
  // Paths, not bare names: CI used to prepend `tests/unit/`, so any exempt test
  // living in scripts/ resolved to a nonexistent file, `node --test` exited 1,
  // and the gate scored it "still failing" forever — it could never detect that
  // one had decayed. Resolving through listTestFiles() means the gate always
  // runs the file that actually exists.
  //
  // EXEMPT_NEVER_CI is excluded by construction: those are expected to start
  // passing, and their passing is not decay.
  if (process.argv.includes('--list-exempt')) {
    const byKey = new Map(listTestFiles().map(f => [f.rel, f.rel]));
    for (const key of Object.keys(EXEMPT_KNOWN_BROKEN)) {
      const name = path.basename(key);
      const rel = byKey.get(key);
      // A missing file means the exemption outlived the test — surface it
      // rather than silently emitting a path that can't run.
      if (!rel) {
        console.error(`::warning::EXEMPT_KNOWN_BROKEN lists ${name} but no such test file exists — stale entry`);
        continue;
      }
      // BRO-2751: this list is consumed by a CI loop that runs each path
      // through `node --test`. Since `sh` joined TEST_FILE_EXTENSIONS, a
      // *.test.sh can now reach EXEMPT_KNOWN_BROKEN, and node cannot execute
      // one — it would fail for the wrong reason and read as "still broken"
      // forever, which is the decay check's own false-all-clear direction.
      // Refuse loudly instead of emitting an unrunnable path.
      const ext = name.slice(name.lastIndexOf('.') + 1);
      if (!NODE_RUNNABLE_TEST_EXTENSIONS.includes(ext)) {
        console.error(
          `::warning::EXEMPT_KNOWN_BROKEN lists ${name}, which node --test cannot run — ` +
            'bash tests are executed by a literal `run: bash <path>` step, so they cannot ' +
            'be decay-checked this way. Remove the exemption or fix the test.'
        );
        continue;
      }
      console.log(rel);
    }
    process.exit(0);
  }
  const json = process.argv.includes('--json');
  // --scope-stdin (card #1488): read repo-relative paths from a newline-
  // separated stdin stream and only treat orphans within that scope as
  // blocking. Absent this flag, scope is undefined and every orphan blocks —
  // byte-for-byte the pre-#1488 behavior, which is what CI's direct calls in
  // test.yml still get (they never pass this flag).
  const scopeStdin = process.argv.includes('--scope-stdin');
  const scope = scopeStdin
    ? fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : undefined;
  // Known accepted tradeoff (raised in review — Codex): a push that edits
  // test.yml/a manifest to REMOVE a test's registration, without touching
  // that test file's own content, downgrades the newly-orphaned test to
  // informational here instead of blocking. Making test.yml's mere presence
  // in scope fall back to full blocking was tried and reverted — it defeats
  // the fix's actual purpose, since test.yml touched for an UNRELATED reason
  // is exactly the #483/#1478 trigger this card exists to stop blocking.
  // There's no cheap way to tell "this push removed a registration line"
  // apart from "this push touched test.yml for any other reason" without a
  // content diff, so this stays a real, informational-only gap covered by
  // CI's unscoped full check as the safety net (test.yml:2566/2600).
  // BRO-2483: a collector failure (it threw, or collected nothing) makes every
  // collected test look orphaned. Report ONLY the failure, never ~1,350 bogus
  // orphans, and fail closed (exit 1 with parseable JSON for land-preflight).
  const earlyGate = checkManifests(ROOT, scope);
  const collectorFailures = earlyGate.blocking.filter((p) => p.error.startsWith(COLLECTOR_FAILURE));
  if (collectorFailures.length > 0) {
    if (json) {
      console.log(JSON.stringify({ collectorFailure: true, total: 0, registered: 0, orphans: [], blocking: [], informational: [], exemptKnownBroken: [], exemptNeverCi: [], manifestProblems: collectorFailures, manifestInformational: [] }, null, 2));
    } else {
      console.error('❌ the node unit-test batch could not be collected, so registration cannot be judged:');
      for (const p of collectorFailures) console.error(`  ${p.error}`);
      console.error(`Fix scripts/lib/unit-test-collection.js (\`node scripts/lib/unit-test-collection.js --min\` reproduces the error).`);
    }
    process.exit(1);
  }
  const { files, rawOrphans } = findRawOrphans(ROOT);
  const isExempt = f => exemptionFor(EXEMPT_KNOWN_BROKEN, f) || exemptionFor(EXEMPT_NEVER_CI, f);
  const orphans = rawOrphans.filter(f => !isExempt(f));
  const exemptKnownBroken = rawOrphans
    .filter(f => exemptionFor(EXEMPT_KNOWN_BROKEN, f))
    .map(f => ({ file: f.rel, notion: exemptionFor(EXEMPT_KNOWN_BROKEN, f) }));
  const exemptNeverCi = rawOrphans
    .filter(f => exemptionFor(EXEMPT_NEVER_CI, f))
    .map(f => ({ file: f.rel, notion: exemptionFor(EXEMPT_NEVER_CI, f) }));
  const { blocking, informational } = decideOrphanGate({ orphans, changedFiles: scope });
  const manifestGate = earlyGate;
  const unguardedProbes = recheckProbeGuardViolations();

  if (json) {
    console.log(JSON.stringify({
      total: files.length,
      registered: files.length - rawOrphans.length,
      orphans: orphans.map(f => f.rel),
      blocking: blocking.map(f => f.rel),
      informational: informational.map(f => f.rel),
      exemptKnownBroken,
      exemptNeverCi,
      manifestProblems: manifestGate.blocking,
      manifestInformational: manifestGate.informational,
      unguardedRecheckProbes: unguardedProbes,
      advisoryUnguardedRecheckProbes: [], // Retained for JSON consumers; all probes now block.
    }, null, 2));
  } else if (blocking.length > 0) {
    console.error(`❌ ${blocking.length} orphan test file(s) — not referenced in any .github/workflows/*.yml:`);
    for (const f of blocking) console.error(`  ${f.rel}`);
    if (informational.length > 0) {
      console.error('');
      console.error(`(${informational.length} more pre-existing orphan(s) elsewhere in the repo, not touched by this push — not blocking:)`);
      for (const f of informational) console.error(`  ${f.rel}`);
    }
    console.error('');
    console.error('Fix: a *.test.{mjs,js,cjs} in tests/unit, tests/smoke, scripts, scripts/tests, scripts/newsletter or scripts/llm-scoring is collected automatically (scripts/lib/unit-test-collection.js, BRO-2483) unless its EXCLUDED map or the scripts/verify-* default leaves it out; a .ts test goes in tests/unit-test-manifest-tsx.txt; otherwise name that exact path in a workflow run: step. A same-named file elsewhere, or an on.push.paths entry, does not count (BRO-2778).');
    console.error('Opt-out (known-broken): add to EXEMPT_KNOWN_BROKEN in scripts/audit-orphan-tests.js with a Linear issue (BRO-N).');
    console.error('Opt-out (deferred-effect acceptance probe, run only by autonomous-acceptance-recheck.js): add to EXEMPT_NEVER_CI in scripts/audit-orphan-tests.js — do this in the SAME commit that adds the test file (BRO-445: this was missed 2x in one day and blocked every repo-wide push for 3 days).');
    console.error('Opt-out (intentional): rename to `_skip-${name}.test.mjs`.');
  } else if (informational.length > 0) {
    console.log(`✅ ${files.length - informational.length} of ${files.length} unit test files registered in CI — ${informational.length} pre-existing orphan(s) elsewhere in the repo not touched by this push (not blocking):`);
    for (const f of informational) console.log(`  ${f.rel}`);
  } else if (manifestGate.blocking.length === 0) {
    console.log(`✅ All ${files.length} unit test files registered in CI (${exemptKnownBroken.length} known-broken exempt, ${exemptNeverCi.length} never-CI exempt)`);
  }
  if (!json && manifestGate.blocking.length > 0) {
    console.error(`❌ ${manifestGate.blocking.length} test manifest problem(s):`);
    for (const p of manifestGate.blocking) console.error(`  ${p.manifest}: ${p.error}`);
    // The sorter only fixes order/duplicate problems; other problems (a .ts
    // import, a missing file) carry their own fix in the text above.
    if (manifestGate.blocking.some((p) => /not sorted|more than once/.test(p.error))) {
      console.error('Fix ordering and duplicates: node scripts/lib/test-manifest.js --fix');
    }
  }
  if (!json && manifestGate.informational.length > 0) {
    console.log(`(${manifestGate.informational.length} manifest problem(s) in manifests this push doesn't touch, not blocking:)`);
    for (const p of manifestGate.informational) console.log(`  ${p.manifest}: ${p.error}`);
  }
  if (!json && unguardedProbes.length > 0) {
    console.error(`❌ ${unguardedProbes.length} RECHECK-AFTER/acceptance probe(s) in EXEMPT_NEVER_CI with no skip-until guard (BRO-6077):`);
    for (const f of unguardedProbes) console.error(`  ${f}`);
    console.error('Fix: give the red-by-design test `{ skip: Date.now() < CHECKABLE_FROM && \'not checkable before the RECHECK-AFTER date\' }`, or add a `RECHECK-GREEN-TODAY: <why it passes now>` comment. land.yml runs a changed test file, so an unguarded probe refuses the landing that adds it.');
  }
  process.exit(blocking.length > 0 || manifestGate.blocking.length > 0 || unguardedProbes.length > 0 ? 1 : 0);
}

module.exports = {
  extractRunBlocks,
  REFERENCE_REGEX,
  // Exported for tests/unit/test-manifest-integrity.test.mjs (BRO-3061), which
  // needs the same "is this file referenced anywhere CI actually runs it"
  // answer this module already computes correctly — a second hand-rolled
  // copy (e.g. a raw substring scan over workflow YAML, or a re-typed
  // exemption list) is exactly the kind of drift-prone duplicate this file's
  // own MANIFESTS comment (scripts/lib/test-manifest.js) warns against.
  //
  // BRO-2778: replaces collectReferencedTests(), whose basename Set let a
  // scripts/ test hide behind a same-named tests/unit/ file.
  collectCiCoverage,
  findRawOrphans,
  listTestFiles,
  exemptionFor,
  SCANNED_DIRS,
  checkManifests,
  EXEMPT_KNOWN_BROKEN,
  EXEMPT_NEVER_CI,
  neverCiEntriesWithComments,
  recheckProbeGuardViolations,
};

// Guarded so `require()`-ing this file from a test (CLAUDE.md rule 15) doesn't
// also execute the CLI against the real repo and process.exit() the test run.
// After module.exports (BRO-2778): main() lazily loads ci-test-coverage.js,
// whose dependency require()s this module back for extractRunBlocks.
if (require.main === module) main();
