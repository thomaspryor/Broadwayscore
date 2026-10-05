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
const { hasHelpFlag } = require('./lib/cli-help.js');
const { decideLandRetry, runGhWithFallback, isRefNotFound } = require('./lib/land-retry-on-cancel');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('usage: node scripts/land-retry-cancelled.js --run=<id> [--dry-run]');
  process.exit(0);
}

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const runId = arg('run');
const dry = process.argv.includes('--dry-run');
if (!/^\d+$/.test(runId)) { console.error('usage: --run=<id> [--dry-run]'); process.exit(2); }

const ghRaw = (args) => runGhWithFallback(args, { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN });
const gh = (args) => JSON.parse(ghRaw(args));
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

const run = gh([`repos/${repo}/actions/runs/${runId}`]);
const jobs = gh([`repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=50`]).jobs;
let branchExists = false;
let branchTip;
try {
  branchTip = gh([`repos/${repo}/git/ref/heads/${run.head_branch}`]).object.sha;
  branchExists = true;
} catch (err) {
  if (!isRefNotFound(err)) throw err; // only a 404 means landed/deleted
}

const d = decideLandRetry({ run, jobs, branchExists, branchTip });
console.log(`run ${runId} ${run.head_branch} attempt ${run.run_attempt}: ${d.retry ? 'RETRY' : 'skip'} (${d.reason})`);
if (d.retry && !dry) {
  process.stdout.write(ghRaw(['-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]));
  console.log('re-run requested (Land job only; Checks result kept)');
}
