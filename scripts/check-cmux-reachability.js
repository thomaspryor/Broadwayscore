#!/usr/bin/env node
/**
 * cmux socket reachability sentinel (BRO-2992).
 *
 * Runs OUTSIDE cmux, on the same launchd cadence as the automations BRO-2959
 * showed can go silently blind to the socket (bsc-reconcile's tab self-heal,
 * bsc-prune, dispatch-watchdog). Decision logic lives in
 * scripts/lib/cmux-reachability-check.js — see that file's header for the
 * full rationale and why it's shared with health-check.js's row.
 *
 * MUST run on this Mac, not GitHub Actions — cmux.app never exists on a CI
 * runner, same reason check-hook-liveness.js and check-claude-auth-health.js
 * are Mac-only launchd jobs.
 *
 * Install:  cp scripts/launchd/com.broadwayscore.cmux-reachability.plist ~/Library/LaunchAgents/
 *           launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.broadwayscore.cmux-reachability.plist
 * Manual run:   launchctl kickstart -k gui/$(id -u)/com.broadwayscore.cmux-reachability
 * Manual check: node scripts/check-cmux-reachability.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

require('./lib/load-env.js').loadEnv(path.join(__dirname, '..'));

const { hasHelpFlag } = require('./lib/cli-help.js');
const { cmuxSpawnEnv } = require('./lib/cmux-socket-auth.js');
const { runReachabilityCheck } = require('./lib/cmux-reachability-check.js');
const { planSocketModeRepair, backupsToPrune, isNoPasswordError } = require('./lib/cmux-socket-mode-repair.js');

const CMUX_DIR = path.join(os.homedir(), '.config', 'cmux');
const CMUX_CONFIG = path.join(CMUX_DIR, 'cmux.json');
const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';
// Owner override: touch this to stop the repair (e.g. after choosing a
// different socket mode in cmux Settings on purpose).
const REPAIR_OFF_FILE = path.join(os.homedir(), '.claude', 'state', 'cmux-mode-repair-off');
const BACKUPS_KEPT = 5;

// BRO-5567: a cmux.json that drifted to cmuxOnly locks every launchd job out
// and survives cmux restarts. Put it back to password mode so the next restart
// (or reload) recovers on its own. Never throws: the reachability check below
// must run regardless.
function socketReportsNoPassword() {
  try {
    execFileSync(CMUX_BIN, ['list-workspaces'], { stdio: 'pipe', timeout: 10000, env: cmuxSpawnEnv(process.env) });
    return false;
  } catch (err) {
    return isNoPasswordError(`${err.stderr || ''}${err.stdout || ''}${err.message || ''}`);
  }
}

function repairSocketMode() {
  try {
    if (fs.existsSync(REPAIR_OFF_FILE)) return 'repair disabled by ' + REPAIR_OFF_FILE;
    if (!fs.existsSync(CMUX_CONFIG)) return null;
    const plan = planSocketModeRepair({
      configText: fs.readFileSync(CMUX_CONFIG, 'utf8'),
      password: process.env.CMUX_SOCKET_PASSWORD,
      socketReportsNoPassword: socketReportsNoPassword(),
    });
    if (plan.action !== 'rewrite') {
      return plan.reason === 'already-password' ? null : `socket-mode repair skipped: ${plan.reason}`;
    }
    fs.copyFileSync(CMUX_CONFIG, path.join(CMUX_DIR, `cmux.json.bak-repair-${Date.now()}`));
    for (const old of backupsToPrune(fs.readdirSync(CMUX_DIR), BACKUPS_KEPT)) {
      fs.rmSync(path.join(CMUX_DIR, old), { force: true });
    }
    const tmp = `${CMUX_CONFIG}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, plan.newText, { mode: 0o600 });
      fs.renameSync(tmp, CMUX_CONFIG);
    } catch (err) {
      fs.rmSync(tmp, { force: true }); // it holds the password
      throw err;
    }
    let reloaded = false;
    try {
      // Usually refused while the socket still denies launchd; then the
      // repair takes effect at the next cmux restart.
      execFileSync(CMUX_BIN, ['reload-config'], { stdio: 'ignore', timeout: 10000, env: cmuxSpawnEnv(process.env) });
      reloaded = true;
    } catch { /* expected while locked out */ }
    return `REPAIRED cmux socket (${plan.reason}: ${plan.fromMode} -> password); ` +
      (reloaded ? 'config reloaded' : 'takes effect at next cmux restart (reload refused)');
  } catch (err) {
    return `socket-mode repair failed: ${err.message}`;
  }
}

const USAGE = `Usage: node scripts/check-cmux-reachability.js
  Restores cmux.json socket mode to "password" if it drifted (kill switch:
  ${REPAIR_OFF_FILE}), then checks the cmux socket is reachable. Exit 1 on error.`;

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const repairNote = repairSocketMode();
  if (repairNote) console.log(`[cmux-reachability] ${repairNote}`);
  const row = await runReachabilityCheck({});
  console.log(`[cmux-reachability] ${row.status.toUpperCase()} ${row.name}: ${row.message}`);
  process.exit(row.status === 'error' ? 1 : 0);
}

main().catch((err) => {
  console.error('[cmux-reachability] check threw:', err);
  process.exit(1);
});
