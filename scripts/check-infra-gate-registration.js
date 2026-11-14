#!/usr/bin/env node
/**
 * Infra-review gate registration + liveness probe (task #1094).
 *
 * Runs ONLY on the Mac, where ~/.claude lives — this is a launchd job
 * (scripts/launchd/com.broadwayscore.infra-gate-registration.plist), not a
 * GitHub Action. health-check.js runs on ubuntu-latest CI runners, which
 * never see this machine's ~/.claude/settings.json or hooks — the same
 * reason check-claude-auth-health.js (task #1076) had to be a separate
 * Mac-only script rather than a health-check.js CATEGORY. This mirrors that
 * script's shape.
 *
 * The #1079 gate is enforced by ONE settings.json PreToolUse entry plus one
 * hook file. Either disappearing (a settings.json rewrite, an accidental
 * checkout in ~/.claude, a botched merge) stops the gate firing with zero
 * signal — a real 8-minute window happened on 2026-08-06 (#1093), caught only
 * because a human noticed. Checking that the files exist is not enough (the
 * vacuous-gate class #1063/#1066-#1069 closed for corpus audits): this also
 * RUNS the hook against a synthetic critical-infra edit and asserts it
 * actually blocks. See scripts/lib/infra-gate-registration-check.js for the
 * four checks.
 */
'use strict';

const path = require('path');

require('./lib/load-env.js').loadEnv(path.join(__dirname, '..'));

const { runInfraGateRegistrationCheck, buildAlertPayload } = require('./lib/infra-gate-registration-check.js');

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const result = runInfraGateRegistrationCheck({ repoRoot });

  console.log(`[infra-gate-registration] ok=${result.ok}`);
  for (const [name, check] of Object.entries(result.checks)) {
    // Three states, not two. A check that could not answer must not print PASS
    // — that is how a green log starts meaning "we didn't look" instead of "we
    // checked", which is the exact vacuous-gate failure this script exists to
    // catch. Same idiom as coverage-adversarial-probe.js's 'inconclusive'
    // verdict, which is deliberately not folded into 'clean'.
    const label = !check.ok ? 'FAIL' : check.inconclusive ? 'UNVERIFIED' : 'PASS';
    console.log(`[infra-gate-registration]   ${label} ${name}: ${check.detail}`);
  }

  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');

  if (!result.ok) {
    await routeAlert(buildAlertPayload(result)).catch((e) =>
      console.error(`[infra-gate-registration] alert failed to send: ${e.message}`)
    );
    process.exit(1);
  }

  resolveCondition('infra-gate-registration:broken');
  console.log('[infra-gate-registration] healthy.');
}

main().catch((err) => {
  console.error('[infra-gate-registration] check threw:', err);
  process.exit(1);
});
