#!/usr/bin/env node
'use strict';

/**
 * main-infra-rerun.js — re-run the newest main test.yml run when its only
 * failures are jobs GitHub never gave a runner (BRO-4754). Run by
 * main-infra-rerun.yml every 15 minutes.
 *
 *   node scripts/main-infra-rerun.js [--dry-run]
 *
 * Decision: scripts/lib/main-infra-rerun.js. Re-runs failed jobs only
 * (`rerun-failed-jobs`), which also re-runs Test Summary as their dependent.
 */

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { runGhWithFallback } = require('./lib/land-retry-on-cancel');
const { decideInfraRerun, candidateJobs } = require('./lib/main-infra-rerun');

const USAGE = 'usage: node scripts/main-infra-rerun.js [--dry-run]';
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}
const dry = process.argv.includes('--dry-run');

const ghRaw = (args) => runGhWithFallback(args, { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN });
const gh = (args) => JSON.parse(ghRaw(args));
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

function main() {
  const runs = gh([`repos/${repo}/actions/workflows/test.yml/runs?branch=main&event=push&per_page=5`]).workflow_runs || [];
  const newest = runs[0];
  let jobs = [];
  const annotationsByJobId = {};
  if (newest && newest.status === 'completed' && newest.conclusion !== 'success') {
    jobs = gh([`repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest&per_page=50`]).jobs || [];
    for (const j of candidateJobs(jobs)) {
      annotationsByJobId[j.id] = gh([`repos/${repo}/check-runs/${j.id}/annotations`]);
    }
  }
  const d = decideInfraRerun({ runs, jobs, annotationsByJobId });
  console.log(`main-infra-rerun: run ${d.runId || '-'} ${d.retry ? 'RERUN' : 'skip'} (${d.reason})${d.starved ? ` starved: ${d.starved.join(', ')}` : ''}`);
  if (!d.retry) return;
  if (dry) { console.log(`dry-run: would re-run failed jobs of ${d.runId} (attempt ${d.attempt} -> ${d.attempt + 1})`); return; }
  ghRaw(['-X', 'POST', `repos/${repo}/actions/runs/${d.runId}/rerun-failed-jobs`]);
  console.log(`re-ran failed jobs of ${d.runId}: https://github.com/${repo}/actions/runs/${d.runId}`);
}

try {
  main();
} catch (err) {
  console.error(`main-infra-rerun: ${(err && (err.stderr || err.message)) || err}`);
  process.exit(1);
}
