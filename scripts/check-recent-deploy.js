#!/usr/bin/env node
'use strict';

/**
 * Shared pre-dispatch dedup check for workflows that manually trigger
 * vercel-deploy.yml via `gh workflow run vercel-deploy.yml` (fires
 * workflow_dispatch — scripts/lib/should-deploy-gate.js's unconditional
 * "ship now" lane, by design, reserved for genuine manual/emergency use).
 *
 * BRO-554: five automated pipeline dispatchers (gather-reviews.yml,
 * rebuild-fast.yml, rebuild-reviews.yml, update-show-status.yml,
 * weekly-grosses.yml) are not emergencies — they should respect the same
 * 30-min floor the schedule-tick gate now enforces. They each carried an
 * identical copy-pasted "was a NEWER vercel-deploy run created after mine"
 * check, which is a race check, not an age check — it never caught
 * sequential runs minutes apart each redeploying after the previous one had
 * already landed. This script replaces all five copies with one real
 * "how long ago did production actually deploy" check, using the same
 * ground-truth lookup (check-prod-deploy.js --json) the gate itself uses.
 *
 * Deliberately NOT wired into opening-night-broadcast.yml,
 * opening-night-express.yml, or opening-night-poller.yml — those are the
 * documented "ship NOW" opening-night paths, and opening-night-checklist.yml
 * pages the owner if a review sits un-deployed 30-60 minutes; silently
 * throttling those dispatchers would work against that alarm instead of it.
 *
 * Exit 0 = ok to dispatch a deploy (no recent deploy, or lookup failed/
 *          unknown — fails OPEN, since this script's only job is to reduce
 *          deploys, not to risk hiding a needed one)
 * Exit 1 = skip (a prod deploy landed within the window)
 *
 * Usage: node scripts/check-recent-deploy.js [--window-sec=1800]
 * Requires VERCEL_TOKEN (same as check-prod-deploy.js).
 * Kill switch: repo variable DEPLOY_GATE_DISABLED=true (same one
 * scripts/lib/should-deploy-gate.js honors, passed as GATE_DISABLED) always
 * exits 0.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { DEDUP_WINDOW_SEC } = require('./lib/should-deploy-gate.js');

/**
 * Pure decision — kept separate from the I/O below so it's directly
 * testable (CLAUDE.md rule 15: extract pure decision functions, require()
 * the real thing in tests rather than restating the logic there).
 * @param {object} i
 * @param {number|null} i.ageSec seconds since the last known prod deploy (null = unknown)
 * @param {number} i.windowSec dedup window
 * @param {boolean} i.gateDisabled kill switch
 * @returns {{skip: boolean, reason: string}}
 */
function shouldSkipDispatch({ ageSec, windowSec, gateDisabled }) {
  if (gateDisabled) return { skip: false, reason: 'kill-switch' };
  if (ageSec == null) return { skip: false, reason: 'no-age-fail-open' };
  if (ageSec < windowSec) return { skip: true, reason: 'recently-deployed' };
  return { skip: false, reason: 'window-elapsed' };
}

function getAgeSec() {
  try {
    const out = execFileSync(
      'node',
      [path.join(__dirname, 'check-prod-deploy.js'), '--json'],
      { encoding: 'utf8', timeout: 30000 }
    );
    const j = JSON.parse(out);
    return j.ageSec != null ? j.ageSec : null;
  } catch (e) {
    console.log(`::warning::[deploy-dedup] baseline lookup failed (${e.message.split('\n')[0]}) — failing open`);
    return null;
  }
}

function main() {
  const gateDisabled = process.env.GATE_DISABLED === 'true';
  const windowArg = process.argv.find((a) => a.startsWith('--window-sec='));
  const windowSec = windowArg ? Number(windowArg.split('=')[1]) : DEDUP_WINDOW_SEC;

  const ageSec = gateDisabled ? null : getAgeSec();
  const { skip, reason } = shouldSkipDispatch({ ageSec, windowSec, gateDisabled });

  const ageDisplay = ageSec != null ? `${ageSec}s` : 'unknown';
  console.log(`::notice::[deploy-dedup] ${skip ? 'SKIP' : 'PROCEED'} — reason=${reason} deployAge=${ageDisplay} window=${windowSec}s`);

  process.exit(skip ? 1 : 0);
}

module.exports = { shouldSkipDispatch, DEFAULT_WINDOW_SEC: DEDUP_WINDOW_SEC };

if (require.main === module) main();
