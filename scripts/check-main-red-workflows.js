#!/usr/bin/env node
'use strict';

/**
 * check-main-red-workflows.js (BRO-7486)
 *
 * Prints a warning for each watched post-land workflow (Bundle Size Check,
 * UGC visual tests) whose latest finished run on main failed. Called by
 * land.yml as an advisory step, and usable by hand.
 *
 *   node scripts/check-main-red-workflows.js            # advisory, exit 0
 *   node scripts/check-main-red-workflows.js --strict   # exit 1 if any is red
 *   node scripts/check-main-red-workflows.js --json
 *
 * Needs GH_TOKEN (or gh auth) and GITHUB_REPOSITORY (defaults to the repo).
 * Any API failure is "unknown", never red: the guard must not block a land
 * because GitHub was slow.
 */

const { execFileSync } = require('child_process');
const { WATCHED_WORKFLOWS, evaluateMainRed, formatWarnings } = require('./lib/main-red-workflows.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log('Usage: node scripts/check-main-red-workflows.js [--strict] [--json]\n\nWarns when check-performance.yml or test-ugc.yml is red on main. Advisory unless --strict.');
  process.exit(0);
}

const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

function fetchRuns(file) {
  const out = execFileSync('gh', ['api', `repos/${repo}/actions/workflows/${file}/runs?branch=main&status=completed&per_page=10`, '--jq', '[.workflow_runs[] | {id, conclusion, created_at, html_url}]'], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(out);
}

const workflows = WATCHED_WORKFLOWS.map((w) => {
  try { return { ...w, runs: fetchRuns(w.file) }; } catch (e) {
    console.error(`could not read runs for ${w.file}: ${String(e.message).split('\n')[0]}`);
    return { ...w, runs: [] };
  }
});

const result = evaluateMainRed(workflows);
if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
else if (result.red.length) formatWarnings(result).forEach((l) => console.log(l));
else console.log(`main is green for ${WATCHED_WORKFLOWS.map((w) => w.file).join(', ')}${result.unknown.length ? ` (no verdict: ${result.unknown.join(', ')})` : ''}`);

process.exit(args.includes('--strict') && result.red.length ? 1 : 0);
