#!/usr/bin/env node
/**
 * Pause/resume rebuild-all-reviews.js (Schmigadoon 2026 Bug #12).
 *
 * On opening morning, a direct hand-edit to reviews.json races any rebuild
 * that CI has queued or is running. This script writes a tombstone the
 * rebuild script reads at startup — if the tombstone is fresh, rebuild
 * exits cleanly (exit 0) without touching reviews.json.
 *
 * USAGE
 *   node scripts/pause-rebuild.js --minutes=30 --reason="opening-night hotfix"
 *   node scripts/pause-rebuild.js --minutes=30 --cancel-in-flight   # also cancel running rebuild-reviews runs
 *   node scripts/pause-rebuild.js --clear
 *   node scripts/pause-rebuild.js --status
 *
 * The tombstone lives at data/audit/rebuild-pause.json and must be COMMITTED
 * + PUSHED to the public repo for CI rebuild runs to see it. This script
 * writes the file; the caller is responsible for the commit/push (so the
 * pause workflow lives alongside the manual edit workflow).
 *
 * --cancel-in-flight additionally invokes `gh run cancel` on any currently-
 * running "Rebuild Reviews Data" or "Rebuild Reviews (Fast)" runs, because
 * a tombstone only stops the NEXT run, not one already past its startup check.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { REBUILD_PAUSE_PATH, readRebuildPause } = require('./lib/rebuild-pause');

function parseArgs(argv) {
  const args = { clear: false, status: false, cancel: false, minutes: null, reason: '', pausedBy: '' };
  for (const a of argv.slice(2)) {
    if (a === '--clear') args.clear = true;
    else if (a === '--status') args.status = true;
    else if (a === '--cancel-in-flight') args.cancel = true;
    else if (a.startsWith('--minutes=')) args.minutes = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--reason=')) args.reason = a.slice('--reason='.length);
    else if (a.startsWith('--paused-by=')) args.pausedBy = a.slice('--paused-by='.length);
  }
  return args;
}

function printStatus() {
  const entry = readRebuildPause();
  if (!entry) {
    console.log('No rebuild-pause tombstone. Rebuild runs normally.');
    return 0;
  }
  const now = Date.now();
  const active = entry.until.getTime() > now;
  const minutesLeft = Math.round((entry.until.getTime() - now) / 60000);
  console.log(`Rebuild pause tombstone: ${REBUILD_PAUSE_PATH}`);
  console.log(`  Active:    ${active ? 'YES' : 'no (expired)'}`);
  console.log(`  Reason:    ${entry.reason || '(none)'}`);
  console.log(`  Paused by: ${entry.pausedBy || '(unknown)'}`);
  console.log(`  Paused at: ${entry.pausedAt || '(unknown)'}`);
  console.log(`  Until:     ${entry.until.toISOString()}${active ? ` (${minutesLeft}min left)` : ''}`);
  return 0;
}

function clear() {
  if (!fs.existsSync(REBUILD_PAUSE_PATH)) {
    console.log('No tombstone to clear.');
    return 0;
  }
  fs.unlinkSync(REBUILD_PAUSE_PATH);
  console.log(`Cleared tombstone: ${REBUILD_PAUSE_PATH}`);
  console.log('Remember to commit + push so CI rebuilds see the cleared state.');
  return 0;
}

function cancelInFlightRebuilds() {
  const workflows = ['Rebuild Reviews Data', 'Rebuild Reviews (Fast)'];
  let cancelled = 0;
  for (const wf of workflows) {
    let runIds = [];
    try {
      const out = execSync(
        `gh run list --workflow="${wf}" --status=in_progress --json=databaseId --jq=".[].databaseId"`,
        { encoding: 'utf8' }
      );
      runIds = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      console.log(`  (skip ${wf}: gh run list failed — ${e.message.split('\n')[0]})`);
      continue;
    }
    if (runIds.length === 0) {
      console.log(`  ${wf}: no in-flight runs`);
      continue;
    }
    for (const id of runIds) {
      try {
        execSync(`gh run cancel ${id}`, { encoding: 'utf8' });
        console.log(`  ${wf}: cancelled run ${id}`);
        cancelled += 1;
      } catch (e) {
        console.log(`  ${wf}: failed to cancel ${id} — ${e.message.split('\n')[0]}`);
      }
    }
  }
  if (cancelled > 0) {
    console.log(`Cancelled ${cancelled} in-flight run(s). Cancellation can take ~60s to propagate.`);
  }
  return cancelled;
}

function setPause({ minutes, reason, pausedBy }) {
  const pausedAt = new Date();
  const until = new Date(pausedAt.getTime() + minutes * 60000);
  const dir = path.dirname(REBUILD_PAUSE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = {
    pausedAt: pausedAt.toISOString(),
    until: until.toISOString(),
    ttlMinutes: minutes,
    reason: reason || '',
    pausedBy: pausedBy || process.env.USER || 'unknown',
  };
  fs.writeFileSync(REBUILD_PAUSE_PATH, JSON.stringify(body, null, 2) + '\n');
  console.log(`Paused rebuild for ${minutes} minute(s).`);
  console.log(`  File:   ${REBUILD_PAUSE_PATH}`);
  console.log(`  Until:  ${until.toISOString()}`);
  console.log(`  Reason: ${body.reason || '(none)'}`);
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Commit + push this file so CI rebuilds see the pause:');
  console.log('       git add data/audit/rebuild-pause.json');
  console.log('       git commit -m "chore: pause rebuild for opening-night hotfix"');
  console.log('       git push');
  console.log('  2. Apply your manual edit to reviews.json in broadway-scorecard-data.');
  console.log('  3. Clear the tombstone once the edit is deployed:');
  console.log('       node scripts/pause-rebuild.js --clear');
  return 0;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.status) return printStatus();
  if (args.clear) return clear();

  if (!args.minutes || !Number.isFinite(args.minutes) || args.minutes < 1) {
    console.error('ERROR: --minutes=<N> is required to set a pause (integer >= 1).');
    console.error('       Use --status to inspect, --clear to remove an existing pause.');
    process.exit(2);
  }
  if (args.minutes > 180) {
    console.error('ERROR: --minutes capped at 180 (3h). Pauses longer than a single opening');
    console.error('       broadcast window are almost always unintentional. If you genuinely');
    console.error('       need this, re-run after 180 min or extend the cap deliberately.');
    process.exit(2);
  }

  const rc = setPause(args);
  if (args.cancel) {
    console.log('');
    console.log('Cancelling in-flight rebuild runs…');
    cancelInFlightRebuilds();
  }
  return rc;
}

process.exit(main());
