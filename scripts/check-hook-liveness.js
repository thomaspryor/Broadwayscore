#!/usr/bin/env node
/**
 * Generalized hook liveness check (task #1104).
 *
 * scripts/check-infra-gate-registration.js (#1094/#1096) watches exactly ONE
 * hook — infra-plan-review-gate.sh. On 2026-08-06, hook-syntax-guard.sh
 * quarantined TWO healthy hooks in the same two minutes (bash-3.2-vs-5.3
 * bug): infra-plan-review-gate.sh was caught because #1094 watches it by
 * name; notion-card-required-stop.sh was silently disabled for ~4 hours
 * because nothing watched it at all. This script closes that gap by
 * treating ~/.claude/settings.json and this repo's .claude/settings.json as
 * the source of truth for every hook that is SUPPOSED to be running, and
 * checking each one — not just the #1079 gate — for existence, non-empty,
 * executable, and parseable under its own declared interpreter. See
 * scripts/lib/infra-gate-registration-check.js's "GENERALIZED HOOK LIVENESS"
 * section for the full design rationale.
 *
 * Also probes the adjacent gap the card flagged: hook-syntax-guard.sh itself
 * (the launchd job that quarantines broken hooks) has no positive heartbeat.
 *
 * MUST run on this Mac, not GitHub Actions — same reason
 * check-infra-gate-registration.js and check-claude-auth-health.js are
 * Mac-only launchd jobs: CI runners never see this machine's ~/.claude.
 */
'use strict';

const path = require('path');
const os = require('os');

require('./lib/load-env.js').loadEnv(path.join(__dirname, '..'));

const {
  runHookLivenessCheck,
  checkGuardHeartbeat,
  buildHookLivenessAlertPayload,
} = require('./lib/infra-gate-registration-check.js');

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const homeDir = os.homedir();

  const result = runHookLivenessCheck({
    settingsSources: [
      { settingsPath: path.join(homeDir, '.claude', 'settings.json'), homeDir, baseDir: homeDir, label: 'user (~/.claude)' },
      { settingsPath: path.join(repoRoot, '.claude', 'settings.json'), homeDir, baseDir: repoRoot, label: 'repo (Broadwayscore/.claude)' },
    ],
    repoRoot,
  });

  const heartbeat = checkGuardHeartbeat({ heartbeatPath: path.join(homeDir, '.claude', 'hook-syntax-guard.heartbeat') });

  console.log(`[hook-liveness] ok=${result.ok} hooks-checked=${result.hookCount}`);
  for (const h of result.hooks) {
    console.log(`[hook-liveness]   ${h.ok ? 'PASS' : 'FAIL'} ${path.basename(h.absPath)} [${h.label}/${h.event}]: ${h.detail}`);
  }
  for (const f of result.sourceFailures) {
    console.log(`[hook-liveness]   FAIL settings-source ${f.label}: ${f.detail}`);
  }
  console.log(`[hook-liveness]   ${heartbeat.ok ? 'PASS' : 'FAIL'} guard-heartbeat: ${heartbeat.detail}`);

  const overallOk = result.ok && heartbeat.ok;

  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');

  if (!overallOk) {
    const payload = result.ok
      ? {
          conditionKey: 'hook-liveness:guard-heartbeat-stalled',
          title: 'hook-syntax-guard.sh has no recent heartbeat',
          description: `check-hook-liveness.js: ${heartbeat.detail}. A stalled guard is indistinguishable from a quiet healthy run without this check — it would leave future broken hooks unquarantined. Repair: confirm com.broadwayscore.hook-syntax-guard is loaded (launchctl list) and re-bootstrap it if not.`,
          severity: 'error',
          disposition: 'digest',
          hint: 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.broadwayscore.hook-syntax-guard.plist',
        }
      : buildHookLivenessAlertPayload(result);
    await routeAlert(payload).catch((e) => console.error(`[hook-liveness] alert failed to send: ${e.message}`));
    process.exit(1);
  }

  resolveCondition('hook-liveness:broken');
  resolveCondition('hook-liveness:guard-heartbeat-stalled');
  console.log('[hook-liveness] healthy.');
}

main().catch((err) => {
  console.error('[hook-liveness] check threw:', err);
  process.exit(1);
});
