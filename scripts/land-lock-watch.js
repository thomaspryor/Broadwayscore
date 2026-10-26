#!/usr/bin/env node
'use strict';

/**
 * land-lock-watch.js — BRO-6276 deadman for the landing mutex. Reads
 * refs/land-mutex/lock and the holder run's jobs; exits 1 (so the workflow's
 * notify-failure step fires) when the holder has held the lock longer than
 * LOCK_HOLD_ALERT_MS. Alert only: it never breaks a live holder; waiters break
 * a lock whose run completed (land-mutex.js decideStep).
 *   node scripts/land-lock-watch.js [--dry-run]
 */

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseLsRemote, assessLockHold } = require('./lib/land-mutex.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('usage: node scripts/land-lock-watch.js');
  process.exit(0);
}

const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

const state = parseLsRemote(out('git', ['ls-remote', 'origin', 'refs/land-mutex/*']));
let jobs = null;
const holder = state.lock && state.tickets.find((t) => t.sha === state.lock.sha);
if (holder) {
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
    jobs = JSON.parse(out('gh', ['api', `repos/${repo}/actions/runs/${holder.runId}/jobs?per_page=30`])).jobs;
  } catch (e) {
    console.error(`land-lock-watch: could not read run ${holder.runId} jobs: ${String(e.message).split('\n')[0]}`);
  }
}
const verdict = assessLockHold({ state, jobs });
console.log(`land-lock-watch: ${verdict.status} — ${verdict.reason}`);
process.exit(verdict.status === 'stuck' ? 1 : 0);
