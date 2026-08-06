#!/usr/bin/env node
/**
 * Local Claude OAuth token liveness probe (task #1076).
 *
 * Runs ONLY on the Mac, where the token lives — this is a launchd job
 * (scripts/launchd/com.broadwayscore.claude-auth-health.plist), not a
 * GitHub Action. CI's check-secrets-health.js probes api.anthropic.com with
 * an API KEY and is structurally incapable of seeing this Mac's OAuth token.
 *
 * `claude auth status` is deliberately NOT used to decide pass/fail — it
 * only reports the on-disk token's presence, not its server-side validity.
 * On 2026-08-05 the token was revoked server-side and `claude auth status`
 * reported {loggedIn: true} for the entire outage. The only real check is a
 * live API call, which is what preflightAuth() (scripts/lib/claude-cli.js)
 * already does for cmux-launch.js's own auth gate — reusing it here means
 * this health check reports exactly what a real launch attempt would see.
 *
 * On failure: pages immediately via routeAlert's page-worthy allowlist
 * (category 2 — opening-night pipeline dead — since a revoked token disables
 * cmux-launch.js's launch gate entirely, not just tonight's monitor).
 */
'use strict';

const { spawnSync } = require('child_process');
const { preflightAuth } = require('./lib/claude-cli.js');
const { evaluateAuthHealth, buildAlertPayload } = require('./lib/claude-auth-health.js');

// Best-effort only — never allowed to affect the pass/fail verdict (see file
// header). Failure here just means the alert body's status note is omitted.
function getAuthStatus() {
  try {
    const r = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

async function main() {
  const preflight = preflightAuth({ log: msg => console.error(`[claude-auth-health] ${msg}`) });
  const authStatus = getAuthStatus();
  const health = evaluateAuthHealth({ preflight, authStatus });

  console.log(`[claude-auth-health] ok=${health.ok} mode=${health.mode} authStatus.loggedIn=${health.authStatusLoggedIn}`);
  console.log(`[claude-auth-health] ${health.reason}`);

  const { routeAlert, loadLedger, resolveCondition } = require('./lib/owner-alert-router.js');

  if (!health.ok) {
    await routeAlert(buildAlertPayload(health)).catch(e => console.error(`[claude-auth-health] alert failed to send: ${e.message}`));
    process.exit(1);
  }

  // Recovery: clear any still-open incident now that a real call succeeded —
  // mirrors check-secrets-health.js's recovery path so a later recurrence
  // inside the same cooldown window re-notifies instead of being swallowed.
  const ledger = loadLedger();
  if (ledger.conditions['claude-auth:revoked']) resolveCondition('claude-auth:revoked');

  if (health.mode === 'api-key') {
    // Not a launch-blocking failure (preflightAuth's fallback still lets
    // cmux-launch.js proceed), but billing silently switched from
    // subscription to pay-per-token — surface it in the log so it shows up
    // in the launchd log file, without paging (that's what the alert path
    // above is for).
    console.warn(`[claude-auth-health] WARNING: ${health.reason}`);
  }

  console.log('[claude-auth-health] healthy.');
}

main().catch(err => {
  console.error('[claude-auth-health] check threw:', err);
  process.exit(1);
});
