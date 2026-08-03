#!/usr/bin/env node
/**
 * check-coverage-probe-clean.js — machine-checkable acceptance criteria for
 * Coverage Verdict S5 (task #903, the FINAL sprint of the Coverage Verdict
 * project).
 *
 * Exit 0 iff data/audit/coverage-adversarial-probe-status.json records that
 * the "two consecutive clean weeks" acceptance bar has been cleared
 * (scripts/lib/coverage-adversarial-probe.js's evaluateAcceptance()). This is
 * the safe-form verify command written into the #903 card at pause time, so
 * scripts/autonomous-acceptance-recheck.js's nightly shadow recheck can
 * re-run it against a fresh checkout.
 *
 * Deliberately READ-ONLY, same posture as check-health-row-absent.js: it
 * reads the status file the weekly cron (coverage-adversarial-probe.yml)
 * already writes instead of re-running the probe itself, which would spend a
 * live SERP call from inside the unattended nightly recheck — exactly the
 * invisible-credit-burn class documented in
 * memory/feedback_sb_serp_invisible_burn.md. Freshness is enforced instead: a
 * status file older than MAX_AGE_H means the cadence itself may have gone
 * quiet, which is a verification failure (exit 3), never a silent pass.
 *
 * Exit codes: 0 accepted (2 consecutive clean weeks) · 1 not yet accepted
 *             3 status file missing or stale (cannot verify)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATUS_PATH = path.join(__dirname, '..', 'data', 'audit', 'coverage-adversarial-probe-status.json');
const MAX_AGE_H = 24 * 9; // weekly cadence + slack, matches census-recall's own staleness bar

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/check-coverage-probe-clean.js');
    console.log('Exit 0 iff the coverage adversarial probe has recorded 2 consecutive clean weekly runs.');
    return 2;
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch (err) {
    console.error(`[check-coverage-probe-clean] status file unreadable (${STATUS_PATH}): ${err.message}`);
    return 3;
  }

  const ageH = (Date.now() - Date.parse(status.generatedAt || 0)) / 36e5;
  if (!Number.isFinite(ageH) || ageH > MAX_AGE_H) {
    console.error(`[check-coverage-probe-clean] status stale (${Number.isFinite(ageH) ? ageH.toFixed(1) + 'h' : 'no generatedAt'} > ${MAX_AGE_H}h) — cannot verify; the weekly probe cron may have stopped running`);
    return 3;
  }

  const acceptance = status.acceptance || {};
  if (acceptance.accepted === true) {
    console.log(`[check-coverage-probe-clean] PASS: ${acceptance.reason}`);
    return 0;
  }
  console.error(`[check-coverage-probe-clean] FAIL: not yet accepted — ${acceptance.reason || 'no acceptance record'}`);
  return 1;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { main, MAX_AGE_H };
