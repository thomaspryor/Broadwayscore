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
    log(`guard library unavailable at ${GUARD_LIB}: ${e.message}`);
    // Do NOT return 0 here. A missing guard means this machine has no
    // protection at all, and in a launchd log that is indistinguishable from a
    // clean run — exactly the "detector exists but nobody gets told" shape this
    // whole card is about.
    await routeMissingGuard(e);
    process.exit(1);
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
  if (dryRun) {
    // A dry run reports; it does not alert, and it does not claim a failed run.
    log('(dry run — no alert routed, nothing changed)');
    return;
  }
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

async function routeMissingGuard(err) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    await routeAlert({
      conditionKey: 'toolchain:guard-missing',
      title: 'Xcode toolchain guard is not installed on this Mac',
      description:
        `check-xcode-toolchain.js could not load ${GUARD_LIB}: ${err.message}. ` +
        'Nothing is maintaining the managed git shim, so PATH `git` may be back on Apple\'s license-gated stub. ' +
        'Restore it from the claude-config repo (~/.claude/hooks/lib/).',
      severity: 'error',
      disposition: 'digest',
      hint: 'ls -la ~/.claude/hooks/lib/xcode-toolchain-guard.js',
    });
  } catch (e) {
    log(`could not route the missing-guard alert: ${e.message}`);
  }
}

async function routeIfPossible(report, guard) {
  let routeAlert;
  try {
    ({ routeAlert } = require('./lib/owner-alert-router.js'));
  } catch (e) {
    log(`could not load the alert router (${e.message}) — repair already attempted, continuing`);
    return;
  }

  // Whether git is actually protected is a FACT to check, not a reassurance to
  // recite. The first draft asserted "git is protected" in every alert body,
  // including the case where installing the shim had just failed — i.e. it was
  // most confidently wrong exactly when the machine was most broken.
  // 'not-applicable' (the directory does not exist on this machine) is neither
  // protection nor a problem, so it is ignored on both sides. 'blocked' IS a
  // problem: it covers a symlinked git, which fails every single invocation.
  const gitProtected =
    report.shims.some(s => ['current', 'repaired', 'left-alone'].includes(s.state)) &&
    !report.shims.some(s => ['failed', 'broken', 'blocked'].includes(s.state));

  if (!gitProtected) {
    // The 2026-09-15 shape: one bad OS update away from every session and every
    // launchd job losing git at once, with nothing able to fix it unattended.
    try {
      const res = await routeAlert({
        conditionKey: 'toolchain:git-unprotected',
        title: 'git is NOT protected on the Mac — the toolchain guard could not hold its invariant',
        description:
          `${report.problems.join(' | ')}. ` +
          'PATH `git` is not guaranteed to resolve to a real git binary, so the next Xcode license revocation will take it out across every session and every launchd job, as it did on 2026-09-15. ' +
          'Repair: run `node scripts/check-xcode-toolchain.js` and read why the shim install failed.',
        severity: 'error',
        disposition: 'digest',
        hint: 'node scripts/check-xcode-toolchain.js',
      });
      log(`alert routed: ${res.action}`);
    } catch (e) {
      log(`alert failed to route: ${e.message}`);
    }
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
