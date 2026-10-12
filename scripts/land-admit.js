#!/usr/bin/env node
'use strict';

/**
 * land-admit.js — land.yml's `admit` job (BRO-5096). Holds an ordinary lane
 * out of the single `landing` pending seat while a main-red fix lane is ahead
 * of it. Fail-open: any error or the deadline admits (exit 0). One gh call per
 * poll. Decisions: scripts/lib/land-admit.js.
 *
 *   node scripts/land-admit.js   (env: GITHUB_REF_NAME, GITHUB_RUN_ID, GITHUB_REPOSITORY, GH_TOKEN)
 */

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { runGhWithFallback } = require('./lib/land-retry-on-cancel');
const { decideAdmit, POLL_SECONDS, DEADLINE_MINUTES } = require('./lib/land-admit');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('usage: node scripts/land-admit.js  (env: GITHUB_REF_NAME, GITHUB_RUN_ID, GITHUB_REPOSITORY)');
  process.exit(0);
}

const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const selfBranch = process.env.LAND_BRANCH || process.env.GITHUB_REF_NAME || '';
const selfRunId = process.env.GITHUB_RUN_ID || '';
const listRuns = () => JSON.parse(runGhWithFallback(
  [`repos/${repo}/actions/workflows/land.yml/runs?per_page=60`],
  { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN },
)).workflow_runs;

const deadline = Date.now() + DEADLINE_MINUTES * 60000;
for (;;) {
  let d;
  try {
    d = decideAdmit({ selfBranch, selfRunId, runs: listRuns() });
  } catch (err) {
    console.log(`admit: fail-open (${String(err.message).split('\n')[0]})`);
    process.exit(0);
  }
  if (d.admit) { console.log(`admit: ${selfBranch} admitted (${d.reason})`); process.exit(0); }
  console.log(`admit: ${selfBranch} waits for main-red lane(s): ${d.ahead.map((a) => `${a.id} ${a.branch} ${a.status}/${a.conclusion || '-'}`).join(', ')}`);
  if (Date.now() + POLL_SECONDS * 1000 > deadline) { console.log(`admit: ${DEADLINE_MINUTES}m deadline, admitting (fail-open)`); process.exit(0); }
  execFileSync('sleep', [String(POLL_SECONDS)]);
}
