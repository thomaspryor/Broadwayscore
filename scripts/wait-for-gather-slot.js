#!/usr/bin/env node
/**
 * wait-for-gather-slot.js — hold this gather-reviews.yml run until fewer than
 * N older gather runs are active (BRO-4859; logic in scripts/lib/gather-slot.js).
 *
 * Never drops work: on an API error it retries, and at --max-wait-min it
 * proceeds anyway (a late start beats a lost show list). Exit code is always 0
 * unless the arguments are wrong.
 *
 * Usage: node scripts/wait-for-gather-slot.js --run-id=<id> [--slots=2]
 *          [--poll-sec=120] [--max-wait-min=180]
 * Needs GH_TOKEN and GITHUB_REPOSITORY (set in Actions).
 * Kill switch: repo variable GATHER_SLOT_GATE_DISABLED=true skips the step.
 */
'use strict';

const { execFileSync } = require('child_process');
const { slotDecision } = require('./lib/gather-slot');
const { hasHelpFlag } = require('./lib/cli-help');

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
}

// ONE API call per poll (this repo has zeroed its REST quota before): the newest
// 100 gather runs, filtered client-side. At ~15 dispatches a day an older run that is
// still active is always inside that window.
function listRecentGatherRuns(repo) {
  const out = execFileSync(
    'gh',
    ['api', `repos/${repo}/actions/workflows/gather-reviews.yml/runs?per_page=100`],
    // A page of 100 full run objects is several MB; the 1 MB default throws ENOBUFS.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  return (JSON.parse(out).workflow_runs || []).map((r) => ({ id: r.id, status: r.status, startedAt: r.run_started_at }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/wait-for-gather-slot.js --run-id=<id> [--slots=2] [--poll-sec=120] [--max-wait-min=180] [--once]');
    process.exit(0);
  }
  const runId = Number(arg('run-id', process.env.GITHUB_RUN_ID));
  const slots = Number(arg('slots', '2'));
  const pollSec = Number(arg('poll-sec', '120'));
  const maxWaitMin = Number(arg('max-wait-min', '180'));
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  const once = process.argv.includes('--once');
  if (!runId) {
    console.error('wait-for-gather-slot: --run-id (or GITHUB_RUN_ID) is required');
    process.exit(2);
  }

  const deadline = Date.now() + maxWaitMin * 60e3;
  for (;;) {
    let d;
    try {
      d = slotDecision(listRecentGatherRuns(repo), runId, slots);
    } catch (e) {
      console.log(`::warning::wait-for-gather-slot: run list failed (${String(e.message).split('\n')[0]}); retrying`);
    }
    if (d) {
      if (d.start) {
        console.log(`Slot free (${d.ahead.length} older active, slots=${slots}). Starting.`);
        return;
      }
      console.log(`Waiting: ${d.ahead.length} older gather run(s) active (${d.ahead.join(', ')}), slots=${slots}`);
    }
    if (once) return;
    if (Date.now() >= deadline) {
      console.log(`::warning::wait-for-gather-slot: waited ${maxWaitMin} min; starting anyway so this show list is not lost`);
      return;
    }
    await sleep(pollSec * 1000);
  }
}

main();
