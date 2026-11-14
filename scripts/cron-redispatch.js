#!/usr/bin/env node
'use strict';

/**
 * cron-redispatch.js — re-dispatch critical crons whose scheduled runs GitHub
 * dropped (BRO-4282). Run by cron-redispatch.yml on every main Test Suite
 * completion (events are delivered; this repo's schedules mostly are not),
 * throttled to one sweep per 30-min window.
 *
 *   node scripts/cron-redispatch.js [--dry-run] [--no-throttle]
 *
 * Registry: check-cron-health.yml CRITICAL_CRONS, opted-in entries only (a
 * `redispatched` workflow_dispatch input). Decision rules and why:
 * scripts/lib/re-dispatcher.js. Exits 1 when a dispatch fails, or when a
 * re-dispatched workflow's own schedule has not fired in SCHEDULE_DEAD_DAYS
 * (re-dispatch keeps it alive, so check-cron-health would never notice). Reads with GH_TOKEN; dispatches with
 * DISPATCH_TOKEN when set (a PAT, so the dispatched run can start its own
 * downstream workflow_run chains, same as check-cron-health's self-heal).
 * Kill switch: repo variable CRON_REDISPATCH_DISABLED=true (checked in the
 * workflow before this runs).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseCriticalCronEntries, decideRedispatches, shouldThrottle, isScheduleDead, SCHEDULE_DEAD_DAYS } = require('./lib/re-dispatcher');

const USAGE = 'usage: node scripts/cron-redispatch.js [--dry-run] [--no-throttle]';
const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log(USAGE);
  process.exit(0);
}
const dry = argv.includes('--dry-run');
const noThrottle = argv.includes('--no-throttle');
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const WF_DIR = path.join(__dirname, '..', '.github', 'workflows');
const SELF = 'cron-redispatch.yml';

function ghJson(apiPath, token) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  return JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8', env, timeout: 30000 }));
}

// created_at of this run and of the newest earlier run that was not cancelled
// (a run cancelled while pending never swept, so it must not claim a window).
function sweepTimes() {
  const runs = ghJson(`repos/${repo}/actions/workflows/${SELF}/runs?per_page=10`).workflow_runs || [];
  const mine = String(process.env.GITHUB_RUN_ID || '');
  const idx = runs.findIndex((r) => String(r.id) === mine);
  if (idx === -1) return { myCreatedAt: null, prevRunCreatedAt: null };
  const prev = runs.slice(idx + 1).find((r) => r.conclusion !== 'cancelled');
  return { myCreatedAt: runs[idx].created_at, prevRunCreatedAt: prev ? prev.created_at : null };
}

function workflowStates() {
  const out = {};
  for (let page = 1; page <= 10; page++) {
    const rows = ghJson(`repos/${repo}/actions/workflows?per_page=100&page=${page}`).workflows || [];
    for (const w of rows) out[path.basename(w.path)] = w.state;
    if (rows.length < 100) break;
  }
  return out;
}

function main() {
  if (!noThrottle && process.env.GITHUB_RUN_ID) {
    let t = {};
    try { t = sweepTimes(); } catch (e) { console.log(`throttle check failed (${e.message.split('\n')[0]}), sweeping anyway`); }
    if (shouldThrottle(t)) {
      console.log(`Run created ${t.myCreatedAt}; an earlier run (${t.prevRunCreatedAt}) already owns this 30-min window. Skipping.`);
      return;
    }
  }

  const entries = parseCriticalCronEntries(fs.readFileSync(path.join(WF_DIR, 'check-cron-health.yml'), 'utf8'));
  const workflowYaml = {};
  for (const e of entries) {
    const p = path.join(WF_DIR, e.workflow);
    if (fs.existsSync(p)) workflowYaml[e.workflow] = fs.readFileSync(p, 'utf8');
  }
  let states = {};
  try { states = workflowStates(); } catch (e) { console.log(`state query failed: ${e.message.split('\n')[0]}`); }

  const lastRuns = {};
  for (const e of entries) {
    try {
      // Any event, any status: a queued or in-progress run also counts.
      const runs = ghJson(`repos/${repo}/actions/workflows/${e.workflow}/runs?branch=main&per_page=1`).workflow_runs || [];
      lastRuns[e.workflow] = { lastCreatedAt: runs[0] ? runs[0].created_at : null };
    } catch {
      lastRuns[e.workflow] = { lastCreatedAt: null, error: true };
    }
  }

  const { dispatch, skipped } = decideRedispatches({ entries, lastRuns, workflowYaml, states });
  const lines = [`## Cron re-dispatch sweep (${entries.length} critical crons)`, ''];
  if (!dispatch.length) lines.push('Nothing overdue.');
  let failed = 0;
  const dead = [];
  for (const d of dispatch) {
    const msg = `${d.name} (${d.workflow}): no run created for ${d.hoursSince}h (band ${d.maxHours}h)`;
    if (dry) { lines.push(`- would dispatch: ${msg}`); continue; }
    try {
      execFileSync('gh', ['api', '-X', 'POST', `repos/${repo}/actions/workflows/${d.workflow}/dispatches`, '-f', 'ref=main', '-f', 'inputs[redispatched]=true'], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, GH_TOKEN: process.env.DISPATCH_TOKEN || process.env.GH_TOKEN },
      });
      lines.push(`- dispatched: ${msg}`);
    } catch (e) {
      failed++;
      lines.push(`- DISPATCH FAILED: ${msg}: ${String(e.stderr || e.message).split('\n')[0]}`);
      continue;
    }
    try {
      const sr = ghJson(`repos/${repo}/actions/workflows/${d.workflow}/runs?event=schedule&branch=main&per_page=1`).workflow_runs || [];
      if (isScheduleDead(sr[0] && sr[0].created_at)) {
        dead.push(d.name);
        lines.push(`  - its schedule has not fired in ${SCHEDULE_DEAD_DAYS}d (last: ${sr[0] ? sr[0].created_at : 'never'}); kept alive only by re-dispatch`);
      }
    } catch (e) {
      lines.push(`  - schedule-run query failed: ${String(e.message).split('\n')[0]}`);
    }
  }
  const NOT_OPTED = 'not opted in (no redispatched input)';
  const notable = skipped.filter((s) => s.reason !== 'out of season' && s.reason !== NOT_OPTED);
  lines.push('', `${skipped.filter((s) => s.reason === NOT_OPTED).length} critical crons not opted in (see scripts/lib/re-dispatcher.js).`);
  if (notable.length) {
    lines.push('', 'Skipped:');
    for (const s of notable) lines.push(`- ${s.name} (${s.workflow}): ${s.reason}`);
  }
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  if (dead.length) console.log(`::error::schedule not firing for ${SCHEDULE_DEAD_DAYS}d, kept alive only by re-dispatch: ${dead.join(', ')}`);
  if (failed || dead.length) process.exitCode = 1;
}

main();
