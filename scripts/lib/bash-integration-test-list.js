'use strict';
// scripts/lib/bash-integration-test-list.js — the list of scripts/lib/*.test.sh
// files test.yml's unit-tests job ACTUALLY invokes (BRO-4150).
//
// WHY THIS EXISTS
//   land.yml's gauntlet (scripts/lib/land-gauntlet.sh) ran tsc/lint/node-test
//   parity with test.yml, but never test.yml's ~26 `run: timeout 180 bash
//   scripts/lib/*.test.sh` integration steps — so a regression in one of them
//   could land clean through land.yml and only turn main red afterwards
//   (BRO-3873 step 4 hung merge-worktree-to-main.stash-pop-head-missing-path
//   for 36h of cancelled main runs; BRO-4135/BRO-4149 landed a failure in
//   push-with-retry.stranded-commit-cascade.test.sh the same way). Closing
//   that gap means land-gauntlet.sh must run the SAME file list test.yml
//   runs — and hardcoding that list a second time in land-gauntlet.sh is
//   exactly the two-independent-copies bug this repo has hit before
//   (test-manifest.js's own header: TEST_FILE_EXTENSIONS used to be two
//   diverging lists). So this is the one place that derives it, and BOTH
//   consumers read it:
//     - scripts/lib/colocated-test-ci-coverage.test.mjs (is every
//       scripts/lib/*.test.sh file run by SOME CI job?) — require()s
//       isInvokedIn/stripShellComments/executableWorkflowText from here
//       rather than keeping a second copy (rule 15).
//     - scripts/lib/land-gauntlet.sh's bash-integration gate — CLI mode
//       below (`node bash-integration-test-list.js --list`), one path per
//       line.
//   A change to what counts as "invoked" (isInvokedIn) can no longer drift
//   between the coverage guard and the gate that runs the tests it covers.
//
// isInvokedIn() is anchored at a command position (line start or after ;, &&,
// ||, |) with an optional `timeout <duration>` prefix (test.yml's hang bound,
// 2026-09-24), so a path inside a quoted echo argument, a comment, or a
// filename that merely starts with the same string cannot pass. Node-runnable
// extensions (mjs/js/cjs/ts) keep the historical loose `includes()` check —
// this repo runs those a dozen different ways (glob, manifest, repeat loop)
// and a stricter rule there would produce false REDs on real coverage.

const fs = require('fs');
const path = require('path');
const { extractRunBlocks } = require('../audit-orphan-tests.js');
const { NODE_RUNNABLE_TEST_EXTENSIONS, testReferenceRegex } = require('./test-manifest.js');

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

/**
 * Strip SHELL comments from a run: body. extractRunBlocks() keeps every line
 * of a `run: |` block, which is correct for YAML but not for shell: a `#`
 * line inside the block is a shell comment, not code. Quote state is tracked
 * per line so a `#` inside 'single' or "double" quotes is left alone.
 */
function stripShellComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** Executable shell of every workflow: `run:` bodies, shell comments removed. */
function executableWorkflowText(workflowsDir = WORKFLOWS_DIR) {
  return fs
    .readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => stripShellComments(extractRunBlocks(fs.readFileSync(path.join(workflowsDir, f), 'utf8'))))
    .join('\n');
}

/**
 * Does `runText` actually INVOKE relPath, as opposed to merely naming it?
 *
 * For a node test this stays the historical `includes()` check. For a shell
 * test it does not: there is exactly one way a *.test.sh runs here — an
 * interpreter followed by the literal path — so the loose check would accept
 * `run: echo "see scripts/lib/x.test.sh"` or a commented-out step resurrected
 * as a string.
 */
function isInvokedIn(runText, relPath, ext) {
  if (NODE_RUNNABLE_TEST_EXTENSIONS.includes(ext)) return runText.includes(relPath);
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invocation = new RegExp(`(?:^|[;&|])\\s*(?:timeout\\s+\\d+[smh]?\\s+)?(?:bash|sh|zsh)\\s+(?:-\\S+\\s+)*${escaped}(?![\\w./-])`, 'm');
  return invocation.test(runText);
}

/**
 * scripts/lib/*.test.sh files (top-level only — none live deeper today, and
 * isInvokedIn's job-position matcher assumes a literal `scripts/lib/<file>`)
 * that `runText` actually invokes via a `run:` step, sorted, repo-relative.
 *
 * Deliberately NOT filtered to files that exist on disk (Codex adversarial
 * review, BRO-4150): reading scripts/lib/ first and checking each existing
 * file against isInvokedIn would silently DROP a file that test.yml still
 * invokes but that was deleted (or never existed — a typo'd new addition).
 * test.yml itself does not get that free pass — `bash <missing-path>` fails
 * loudly there — so the candidate universe here is instead every bare
 * `*.test.sh` filename testReferenceRegex() finds anywhere in the workflow
 * text (a superset — comments and mentions included), each then confirmed
 * as a genuine invocation via the same isInvokedIn() the coverage guard
 * uses. A candidate that isInvokedIn confirms but that doesn't exist on disk
 * is still returned; land-gauntlet.sh's `bash <path>` will fail on it with
 * its own real "No such file or directory", exactly mirroring test.yml.
 */
function listInvokedBashIntegrationTests({ workflowsDir = WORKFLOWS_DIR, runText = null } = {}) {
  const text = runText != null ? runText : executableWorkflowText(workflowsDir);
  const candidates = new Set();
  for (const m of text.matchAll(testReferenceRegex())) {
    if (m[0].endsWith('.test.sh')) candidates.add(`scripts/lib/${m[0]}`);
  }
  return [...candidates].filter((relPath) => isInvokedIn(text, relPath, 'sh')).sort();
}

module.exports = {
  stripShellComments,
  executableWorkflowText,
  isInvokedIn,
  listInvokedBashIntegrationTests,
  WORKFLOWS_DIR,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    const list = listInvokedBashIntegrationTests();
    if (list.length === 0) {
      console.error('bash-integration-test-list: derived ZERO scripts/lib/*.test.sh files from test.yml — refusing an empty list silently');
      process.exit(1);
    }
    for (const p of list) console.log(p);
  } else {
    console.error('usage: bash-integration-test-list.js --list');
    process.exit(2);
  }
}
