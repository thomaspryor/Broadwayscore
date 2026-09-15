#!/usr/bin/env node
/**
 * Periodic Xcode toolchain repair + report (BRO-3375).
 *
 * Runs on THIS Mac via launchd (scripts/launchd/com.broadwayscore.xcode-
 * toolchain.plist), never in GitHub Actions — the thing it guards is this
 * machine's own PATH and its Xcode license state, neither of which a runner
 * can see. Same Mac-only rationale as check-claude-auth-health.js.
 *
 * WHY THIS EXISTS ON TOP OF THE SESSION-START HOOK
 * The hook in ~/.claude/hooks/session-start.sh repairs the shim whenever a new
 * session starts, which covers interactive work. It does NOT cover the half of
 * the machine that matters most here: the unattended launchd fleet, which can
 * run for days without a single new session starting. On 2026-09-15 the license
 * revocation took out both populations at once. This job closes the second one.
 *
 * THE ACTUAL LOGIC LIVES IN ~/.claude/hooks/lib/xcode-toolchain-guard.js, not
 * in this repo, and this script is a thin wrapper around it. That placement is
 * deliberate: the outage breaks the very `git` that would update a repo
 * checkout, so the guard must not depend on this checkout being present or
 * fresh. Requiring it across repos is the cost of that, and it is why the
 * require below is fail-soft rather than a hard dependency.
 */
'use strict';

const os = require('os');
const path = require('path');

require('./lib/load-env.js').loadEnv(path.join(__dirname, '..'));

const GUARD_LIB = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'xcode-toolchain-guard.js');

const USAGE = `check-xcode-toolchain.js — keep PATH \`git\` off Apple's
license-gated /usr/bin/git stub, and repair it if it has drifted. (BRO-3375)

Usage:
  node scripts/check-xcode-toolchain.js          repair + report
  node scripts/check-xcode-toolchain.js --dry-run  report only, change nothing
  --help, -h                                     show this message

Exits 1 only when something is broken that it could NOT repair.
`;

function log(msg) {
  console.log(`[xcode-toolchain] ${msg}`);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const dryRun = argv.includes('--dry-run');

  let guard;
  try {
    guard = require(GUARD_LIB);
  } catch (e) {
    // Fail SOFT, loudly. A missing guard lib is a real problem worth seeing in
    // the log, but it must not make this job look like a toolchain outage.
    log(`guard library unavailable at ${GUARD_LIB}: ${e.message}`);
    log('nothing to do — the machine-level guard is not installed here.');
    return;
  }

  const report = guard.ensureToolchain({ log, repair: !dryRun });

  for (const s of report.shims) {
    log(`shim ${s.target}: ${s.state}${s.note ? ` (${s.note})` : ''}`);
  }
  if (report.license) {
    log(`license: ${report.license.kind} — ${report.license.reason}`);
  }

  // Which git would a launchd job actually get? This is the question that
  // matters, and it is not the same as the one an interactive session asks:
  // the fleet's PATH has no ~/.claude/bin in it.
  const pathGit = guard.classifyPathGit(resolveGitOnPath(), {
    shimPaths: guard.shimTargets(),
  });
  log(`PATH git: ${pathGit.kind} — ${pathGit.reason}`);
  if (!pathGit.ok) report.problems.push(`PATH git: ${pathGit.reason}`);

  if (!report.problems.length) {
    log('healthy.');
    resolveIfPossible('toolchain:xcode-degraded');
    return;
  }

  for (const p of report.problems) log(`PROBLEM: ${p}`);
  await routeIfPossible(report, guard);
  process.exit(1);
}

function resolveGitOnPath() {
  const { spawnSync } = require('child_process');
  const r = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

function resolveIfPossible(conditionKey) {
  try {
    require('./lib/owner-alert-router.js').resolveCondition(conditionKey);
  } catch { /* alerting is optional here; the repair is the deliverable */ }
}

async function routeIfPossible(report, guard) {
  let routeAlert;
  try {
    ({ routeAlert } = require('./lib/owner-alert-router.js'));
  } catch (e) {
    log(`could not load the alert router (${e.message}) — repair already attempted, continuing`);
    return;
  }

  // Deliberately 'digest', not a page, and deliberately NOT added to
  // page-worthy-alerts.js. Before this guard existed, a revoked Xcode license
  // was a fleet-wide git outage and would have deserved a page. With the shim
  // invariant held, git keeps working and what is left is xcodebuild/xcrun/
  // swift being unavailable — real, worth telling the owner about, but not
  // worth waking them for. Paging for a condition the machine now routes
  // around is how a page stops being believed.
  const payload = {
    conditionKey: 'toolchain:xcode-degraded',
    title: 'Xcode toolchain degraded on the Mac (git is protected, other tools are not)',
    description:
      `${report.problems.join(' | ')}. ` +
      'The managed git shim keeps `git` off Apple\'s license-gated /usr/bin/git stub, so sessions and the launchd fleet still have git. ' +
      'xcodebuild/xcrun/swift/clang route through the gate and will fail until this is resolved.',
    severity: 'warning',
    disposition: 'digest',
    hint: (report.license && report.license.remedy) || guard.SUDOERS_INSTALL_HINT,
  };

  try {
    const res = await routeAlert(payload);
    log(`alert routed: ${res.action}`);
  } catch (e) {
    log(`alert failed to route: ${e.message}`);
  }
}

main().catch(err => {
  console.error('[xcode-toolchain] check threw:', err);
  process.exit(1);
});
