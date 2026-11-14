#!/usr/bin/env node
/**
 * Lint guard: no `git fetch` (or `git pull`) without a depth bound in any
 * script reachable from a SHALLOW workflow checkout. Task #420.
 *
 * WHY THIS EXISTS
 * ---------------
 * actions/checkout defaults to `fetch-depth: 1`. From a shallow clone, a fetch
 * with no depth bound makes upload-pack send the ENTIRE repository — measured
 * on a real runner (run 30218025467) at 1365 MB pulled before a 180s kill,
 * against a ~500-object delta. It only fires when there is something new to
 * fetch, so it presents as an intermittent CI stall rather than a hard bug.
 *
 * push-with-retry.sh was fixed at the source in #466 (it depth-bounds via
 * scripts/lib/shallow-fetch-args.js). #420 then found three scripts that
 * hand-rolled the same fetch+rebase+push sequence and therefore never got that
 * fix: collect-review-texts.js (11 shallow workflows, several opening-night-
 * critical), rediscover-review-urls.js, and llm-scoring/index.ts. Fixing those
 * three by hand is a one-off; this guard is the prevention, so the fourth one
 * is caught at lint time.
 *
 * THE FIX AT A CALL SITE (in preference order)
 *   1. Route the whole commit→push through `bash scripts/lib/push-with-retry.sh`
 *      — it already handles depth bounding, conflict resolution, the no-op
 *      rebase guard, and HEAD preservation.
 *   2. If the call site genuinely cannot, ask the shared decision function for
 *      the flags:
 *        node scripts/lib/shallow-fetch-args.js --is-shallow=<bool> \
 *             --oldest-epoch=<epoch> --slack-sec=1800
 *      Do NOT hand-roll `--depth=1`: it makes the fetched tip a parentless
 *      root, destroying ancestry, so any later rebase replays a whole-tree
 *      snapshot over main (proven by fault injection in #466). Do NOT use
 *      `--depth=N` as a fallback either — it can SHORTEN a deep clone; use
 *      `--deepen=N`.
 *   3. Reviewed false positive (e.g. a wrapper whose depth args arrive via
 *      "$@"): waive with `unbounded-fetch-ok: <reason>` on the offending line
 *      or the line above it.
 *
 * Detection logic is pure and unit-tested in scripts/lib/unbounded-fetch-guard.js
 * (+ .test.mjs) per project rule §15; this file only walks the filesystem and
 * formats the report.
 *
 * Usage:
 *   node scripts/audit-unbounded-fetch.js            # blocking lint (exit 1 on violation)
 *   node scripts/audit-unbounded-fetch.js --verbose  # also list shallow workflows + exposed scripts
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { auditUnboundedFetches } = require('./lib/unbounded-fetch-guard.js');

const USAGE = `Audit: unbounded git fetch in scripts reachable from a shallow workflow (task #420)

Usage:
  node scripts/audit-unbounded-fetch.js [--verbose]

  --verbose   list the shallow workflows and every script they can reach

Exit codes: 0 = clean, 1 = at least one unbounded fetch on a shallow path.
Waive a reviewed false positive with an inline "unbounded-fetch-ok: <reason>".`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = path.join(REPO_ROOT, '.github', 'actions');

const SCRIPT_EXT = /\.(?:js|mjs|cjs|ts|sh)$/;
// Tests describe the bug in fixture strings; they never run a fetch in CI.
const SKIP_PATH = /(?:^|\/)(?:node_modules|\.git)\//;
const SKIP_FILE = /\.test\.(?:mjs|js|ts)$|\.test\.sh$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, abs);
    if (SKIP_PATH.test(`${rel}/`)) continue;
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile() && SCRIPT_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) out.push(rel);
  }
  return out;
}

function readAll(files) {
  const map = new Map();
  for (const rel of files) {
    try { map.set(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')); } catch { /* unreadable → skip */ }
  }
  return map;
}

function main() {
  const verbose = process.argv.includes('--verbose');

  const scripts = readAll(walk(SCRIPTS_DIR));
  // Workflows AND composite actions. .github/actions/*/action.yml carry their
  // own `uses: actions/checkout` steps (checkout-review-texts defaults to
  // fetch-depth: 1) and their own `run:` blocks invoking scripts — skipping
  // them left a whole class of shallow-checkout entry points invisible to the
  // guard (Codex ship-check finding, 2026-07-26).
  const workflowFiles = [];
  if (fs.existsSync(WORKFLOWS_DIR)) {
    for (const f of fs.readdirSync(WORKFLOWS_DIR)) {
      if (/\.ya?ml$/.test(f)) workflowFiles.push(path.relative(REPO_ROOT, path.join(WORKFLOWS_DIR, f)));
    }
  }
  if (fs.existsSync(ACTIONS_DIR)) {
    for (const d of fs.readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const name of ['action.yml', 'action.yaml']) {
        const abs = path.join(ACTIONS_DIR, d.name, name);
        if (fs.existsSync(abs)) workflowFiles.push(path.relative(REPO_ROOT, abs));
      }
    }
  }
  const workflows = readAll(workflowFiles);

  const { violations, shallowWorkflows, exposedScripts } = auditUnboundedFetches({ scripts, workflows });

  if (verbose) {
    console.log(`Shallow workflows (no fetch-depth: 0): ${shallowWorkflows.length}/${workflows.size}`);
    console.log(`Scripts reachable from them: ${exposedScripts.length}/${scripts.size}\n`);
  }

  if (violations.length === 0) {
    console.log(`✅ Unbounded-fetch guard: no violations (${scripts.size} scripts, ${shallowWorkflows.length} shallow workflows).`);
    return;
  }

  console.log(`❌ Unbounded-fetch guard: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const wfs = v.workflows.map((w) => path.basename(w));
    const shown = wfs.slice(0, 4).join(', ') + (wfs.length > 4 ? `, +${wfs.length - 4} more` : '');
    console.log(`  ${v.file}:${v.line}`);
    console.log(`      ${v.snippet}`);
    console.log(`      git ${v.subcommand} with no depth bound; reachable from ${wfs.length} shallow workflow(s): ${shown}`);
    console.log('');
  }
  console.log('From a fetch-depth: 1 checkout an unbounded fetch pulls the WHOLE repo');
  console.log('(~2.1 GB / 165k commits here — measured, run 30218025467), so the job stalls');
  console.log('until its timeout. Fix by routing the push through');
  console.log('  bash scripts/lib/push-with-retry.sh [retries] [branch]');
  console.log('or, if that is impossible, by taking the flags from');
  console.log('  node scripts/lib/shallow-fetch-args.js --is-shallow=<bool> --oldest-epoch=<epoch>');
  console.log('Never hand-roll --depth=1 before a rebase (it destroys ancestry — task #466).');
  console.log('Reviewed false positive? Add "unbounded-fetch-ok: <reason>" on or above the line.');
  process.exitCode = 1;
}

main();
