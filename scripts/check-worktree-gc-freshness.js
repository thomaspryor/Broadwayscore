#!/usr/bin/env node
/**
 * Mac-local worktree-gc freshness deadman (BRO-2719, successor of the CI row
 * from BRO-2608).
 *
 * data/audit/worktree-gc.log is now gitignored (it was committed hourly and
 * blocked `git pull` on the shared checkout), so health-check.js on a GitHub
 * runner can no longer read it. This runs on the Mac that writes it, from
 * com.broadwayscore.worktree-gc-freshness. A MISSING log is an error too: a
 * deleted/never-written log must not read as healthy.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '../data/audit/worktree-gc.log');

/** Pure: returns an alert payload or null when healthy. logText null = log missing. */
function evaluate(logText, nowMs) {
  const { checkWorktreeGcFreshness, lastTimestampFromLog } = require('./lib/worktree-gc-freshness');
  const hint = 'launchctl bootout gui/$(id -u)/com.broadwayscore.worktree-gc 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.broadwayscore.worktree-gc.plist; launchctl kickstart -k gui/$(id -u)/com.broadwayscore.worktree-gc (BRO-3635: a stopped StartInterval timer still shows as loaded)';
  if (logText == null) {
    return {
      conditionKey: 'worktree-gc:log-missing',
      title: 'worktree-gc.log is missing',
      description: 'data/audit/worktree-gc.log does not exist on this Mac, so the hourly gc has never run or its log was deleted. It is the only automatic disk brake for abandoned worktrees.',
      severity: 'error', disposition: 'digest', hint,
    };
  }
  const stale = checkWorktreeGcFreshness(lastTimestampFromLog(logText), nowMs);
  if (!stale) return null;
  return {
    conditionKey: 'worktree-gc:stale',
    title: 'Infra: worktree GC log stale',
    description: `worktree-gc.log has no line in the last ${stale.hoursStale.toFixed(1)}h (launchd runs gc-merged-worktrees.sh hourly), so the only automatic disk brake may have stopped firing.`,
    severity: stale.severity, disposition: 'digest', hint,
  };
}

async function main() {
  require('./lib/load-env.js').loadEnv(path.join(__dirname, '..'));
  let logText = null;
  try { logText = fs.readFileSync(LOG_PATH, 'utf8'); } catch { /* missing */ }
  const payload = evaluate(logText, Date.now());
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');
  if (payload) {
    console.log(`[worktree-gc-freshness] FAIL ${payload.title}`);
    await routeAlert(payload).catch((e) => console.error(`[worktree-gc-freshness] alert failed: ${e.message}`));
    process.exit(1);
  }
  resolveCondition('worktree-gc:stale');
  resolveCondition('worktree-gc:log-missing');
  console.log('[worktree-gc-freshness] ok');
}

module.exports = { evaluate };
if (require.main === module) main();
