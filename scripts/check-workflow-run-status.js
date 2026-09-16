#!/usr/bin/env node
/**
 * check-workflow-run-status.js — machine-checkable acceptance criteria for
 * cards whose intent is "the last run of workflow X (on branch Y) passed"
 * (BRO-2208).
 *
 * Why this exists instead of a bare `gh run list` SAFE_CHECK_FORM: `gh run
 * list` is a GET that exits 0 whenever it can talk to the API, regardless of
 * what the runs it lists actually say — piping it through `--json`/`--jq`
 * only reshapes its stdout, it never changes gh's own exit code. A card
 * whose "verify" command is a bare `gh run list ...` would pass unattended
 * re-verification unconditionally, which is a worse outcome than being
 * refused outright (a silent rubber stamp, not a stuck card) — exactly the
 * vacuous-check failure mode classifyVacuousCheck() (card-premises-
 * auditor.js) already guards against for `test -f` cards. This wrapper
 * fetches the most recent matching run and asserts its conclusion itself,
 * so the exit code is a real pass/fail signal.
 *
 * Exit codes: 0 conclusion matches --expect · 1 no match / no runs / gh
 * error · 2 usage error
 *
 * Usage:
 *   node scripts/check-workflow-run-status.js --workflow=<name.yml or "Display Name"> \
 *     --expect=<success|failure|cancelled|...> [--branch=<name>]
 */

'use strict';

const { execFileSync } = require('child_process');

const USAGE = 'Usage: node scripts/check-workflow-run-status.js --workflow=<name.yml or "Display Name"> --expect=<conclusion> [--branch=<name>]';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const eq = a.indexOf('=');
    if (!a.startsWith('--') || eq === -1) continue;
    out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function main(argv) {
  const { workflow, branch, expect } = parseArgs(argv || []);
  if (!workflow || !expect) {
    console.error(USAGE);
    process.exit(2);
  }

  const args = ['run', 'list', '--workflow', workflow, '--limit', '1', '--json', 'conclusion,status,headBranch,url'];
  if (branch) args.push('--branch', branch);

  let stdout;
  try {
    stdout = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    console.error(`gh run list failed: ${err.message}`);
    process.exit(1);
  }

  let runs;
  try {
    runs = JSON.parse(stdout);
  } catch {
    console.error(`gh returned non-JSON output: ${stdout.slice(0, 200)}`);
    process.exit(1);
  }

  if (!Array.isArray(runs) || runs.length === 0) {
    console.error(`No runs found for workflow ${workflow}${branch ? ` on branch ${branch}` : ''}`);
    process.exit(1);
  }

  const run = runs[0];
  const match = run.conclusion === expect;
  console.log(match
    ? `MATCH — ${workflow}${branch ? `@${branch}` : ''} most recent run concluded '${run.conclusion}' (${run.url})`
    : `MISMATCH — ${workflow}${branch ? `@${branch}` : ''} most recent run concluded '${run.conclusion || run.status}', expected '${expect}' (${run.url})`);
  process.exit(match ? 0 : 1);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs };
