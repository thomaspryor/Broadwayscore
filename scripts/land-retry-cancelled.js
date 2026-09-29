#!/usr/bin/env node
'use strict';

/**
 * land-retry-cancelled.js — BRO-4246. Given a completed Land run id, re-run
 * its cancelled Land job when it was only a queue casualty (decision in
 * scripts/lib/land-retry-on-cancel.js). Run by land-retry-cancelled.yml.
 *
 *   node scripts/land-retry-cancelled.js --run=<id> [--dry-run]
 */

const { execFileSync } = require('child_process');
const { decideLandRetry } = require('./lib/land-retry-on-cancel');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const runId = arg('run');
const dry = process.argv.includes('--dry-run');
if (!/^\d+$/.test(runId)) { console.error('usage: --run=<id> [--dry-run]'); process.exit(2); }

const gh = (args) => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

const run = gh([`repos/${repo}/actions/runs/${runId}`]);
const jobs = gh([`repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=50`]).jobs;
let branchExists = false;
let branchTip;
try {
  branchTip = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/git/ref/heads/${run.head_branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).object.sha;
  branchExists = true;
} catch { /* 404 → landed/deleted */ }

const d = decideLandRetry({ run, jobs, branchExists, branchTip });
console.log(`run ${runId} ${run.head_branch} attempt ${run.run_attempt}: ${d.retry ? 'RETRY' : 'skip'} (${d.reason})`);
if (d.retry && !dry) {
  execFileSync('gh', ['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`], { stdio: 'inherit' });
  console.log('re-run requested (Land job only; Checks result kept)');
}
