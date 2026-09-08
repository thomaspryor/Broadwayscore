#!/usr/bin/env node
/**
 * cmux-reachability-check — prose-independent sentinel for "can anything
 * outside cmux actually reach the control socket?" (BRO-2992).
 *
 * Why this exists: nothing in the fleet asserted this directly. Every
 * consumer degraded quietly instead — health-check.js's checkDispatchOutcomes
 * falls back to ledger-only, dispatch-watchdog-core.js goes report-only
 * DEGRADED, overnight-digest.js pushes one more line into digest.errors. That
 * is why the 2026-09-07 cmux security migration (BRO-2959) disabled
 * bsc-reconcile's tab self-heal, bsc-prune, and dispatch-watchdog
 * simultaneously for ~2h and nothing paged.
 *
 * BRO-2959 taught classifyCmuxError (cmux-socket-auth.js) to recognize
 * auth-denied failures by their ENGLISH PROSE and escalate on those. That
 * closes the incident it saw, but a future cmux release reworking its error
 * text, or a capability loss that returns a clean non-error empty result,
 * would still slip through silently. A reachability check that doesn't care
 * WHY the socket is unreachable — only THAT it is, for N consecutive checks —
 * catches the whole class instead of one instance of it.
 *
 * Two callers share this module (deliberately — one place decides whether to
 * page, so they can't develop divergent alert behavior for the same
 * condition):
 *   - scripts/check-cmux-reachability.js — a dedicated launchd sentinel that
 *     polls frequently, from OUTSIDE cmux (the same context the automations
 *     that broke in BRO-2959 run in).
 *   - scripts/health-check.js's checkCmuxReachability() — folds a row into
 *     the daily digest for visibility; on CI (ubuntu-latest, where cmux.app
 *     can never exist) this degrades to the "(unmeasurable here)" pattern
 *     checkDispatchHealth() already established, so a CI run never manufactures
 *     a permanent false "unreachable" streak and card-spams the owner.
 *
 * Pure decision logic (decideReachabilityAlert) is exported separately from
 * the I/O (probe, log, alert) so it can be tested without touching a real
 * socket, filesystem, or the alert router — per CLAUDE.md rule 15.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { summarizeFailureStreak } = require('./alert-dispatch-streak.js');

const CHECK_NAME = 'cmux socket: reachability';
const CONDITION_KEY = 'cmux-reachability:unreachable';

// 3 consecutive failed checks before queuing an alert. At the sentinel's
// 15-minute launchd cadence (scripts/launchd/com.broadwayscore.cmux-
// reachability.plist) that is a 30-45 minute DETECTION window — comfortably
// inside the 2h BRO-2959 outage this exists to catch next time — while still
// absorbing a single transient daemon hiccup (the "unavailable" case that
// made up 2241 of the 2600 historical rows in reconcile-report.jsonl)
// without alerting on it alone. Detection is not notification: this queues
// via routeAlert's disposition:'digest' (page-worthy-alerts.js's owner-
// approved allowlist doesn't cover this condition, so disposition:'human'
// would be silently downgraded to 'digest' anyway) — the owner sees it in
// the next digest send, not an immediate page.
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

const ATTEMPTS_RETENTION_DAYS = 7;

// Machine-local, outside every git checkout — same reasoning as
// owner-alert-router.js's LOCAL_LEDGER_PATH: this must survive a parallel
// session's git checkout/reset/rebase in the shared working tree, and a
// launchd sentinel run and an interactive health-check.js run in a worktree
// need to share ONE streak, not one per checkout.
const DEFAULT_ATTEMPTS_LOG_PATH = path.join(os.homedir(), '.broadwayscore-state', 'cmux-reachability-attempts.jsonl');
const ATTEMPTS_LOG_PATH = process.env.CMUX_REACHABILITY_ATTEMPTS_LOG_PATH || DEFAULT_ATTEMPTS_LOG_PATH;

// Guards against a forgotten test seam silently writing into this machine's
// real state file (same idiom as owner-alert-router.js's
// assertRealFileWriteIsSafeUnderTest) — belt-and-suspenders on top of every
// test in this repo passing an explicit logPath.
function assertRealFileWriteIsSafeUnderTest(logPath) {
  if (process.env.NODE_TEST_CONTEXT && logPath === DEFAULT_ATTEMPTS_LOG_PATH && !process.env.CMUX_REACHABILITY_ATTEMPTS_LOG_PATH) {
    throw new Error('cmux-reachability-check: refusing to write the REAL attempts log under node:test — pass an explicit logPath (a temp file) instead');
  }
}

// Appends one attempt record and prunes entries older than
// ATTEMPTS_RETENTION_DAYS. Never throws — logging the attempt must not
// itself become a new silent-failure vector for the very thing this check
// exists to catch.
function logReachabilityAttempt({ ok, error }, { logPath = ATTEMPTS_LOG_PATH, now = Date.now() } = {}) {
  assertRealFileWriteIsSafeUnderTest(logPath);
  try {
    const cutoff = now - ATTEMPTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let lines = [];
    try {
      lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    } catch { /* missing — first attempt */ }
    const kept = lines.filter((line) => {
      try { return new Date(JSON.parse(line).ts).getTime() >= cutoff; } catch { return false; }
    });
    kept.push(JSON.stringify({
      ts: new Date(now).toISOString(),
      ok: !!ok,
      error: error ? String(error).slice(0, 500) : null,
    }));
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Atomic write (same pattern as owner-alert-router.js's saveLedger) — a
    // kill mid-write must not truncate the streak history (ship-check
    // finding). Two overlapping writers (a launchd tick and an interactive
    // run landing at once) can still each read-modify-write and lose one
    // entry — same accepted race class owner-alert-router.js's own header
    // documents for its ledger; not solved here either.
    const tmp = `${logPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, kept.join('\n') + '\n');
    fs.renameSync(tmp, logPath);
  } catch (err) {
    console.error(`[cmux-reachability] failed to write attempts log (non-fatal): ${err.message}`);
  }
}

// Sorted oldest→newest by `ts` — summarizeFailureStreak (like
// owner-alert-router.js's readDispatchAttempts) relies on array order, and a
// rewrite-after-filter or manual edit could disturb append order.
function readReachabilityAttempts({ logPath = ATTEMPTS_LOG_PATH, days = ATTEMPTS_RETENTION_DAYS } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let lines = [];
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch { /* missing — no attempts logged yet */ }
  return lines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter((entry) => new Date(entry.ts).getTime() >= cutoff)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

// Pure: given attempts (oldest→newest, as readReachabilityAttempts returns
// them), decide whether the current streak crosses the alert threshold.
function decideReachabilityAlert(attempts, { threshold = CONSECUTIVE_FAILURE_THRESHOLD, now } = {}) {
  const { consecutiveFailures, forHowLong } = summarizeFailureStreak(attempts, now);
  return { consecutiveFailures, forHowLong, shouldAlert: consecutiveFailures >= threshold };
}

// Actually hits the socket. `cmuxAvailableFn`/`listWorkspacesFn` are
// test-only seams (same idiom as cmux-workspaces.js's own execFn injection).
function probeCmuxReachability({ cmuxAvailableFn, listWorkspacesFn } = {}) {
  const cmuxWs = require('./cmux-workspaces.js');
  const isAvailable = (cmuxAvailableFn || cmuxWs.cmuxAvailable)();
  if (!isAvailable) return { measurable: false };

  try {
    const list = (listWorkspacesFn || cmuxWs.listWorkspaces)();
    // An empty result is treated the SAME as cmux being unavailable — the
    // existing convention health-check.js's checkDispatchOutcomes documents
    // (cmux-workspaces.js's listWorkspaces() returns [] on a daemon hiccup or
    // malformed output, not a throw). Re-applied here deliberately, not
    // re-derived: this card's own motivation explicitly names "a capability
    // loss that returns a clean non-error empty result" as a failure mode
    // classifyCmuxError can't catch (it only classifies thrown errors) and
    // this check must — narrowing "unreachable" to thrown errors only (an
    // earlier draft did this) would silently drop exactly that case.
    //
    // Known limitation (ship-check finding, two independent reviewers):
    // a GENUINE zero-open-workspaces state parses to the same empty array
    // and would false-page after CONSECUTIVE_FAILURE_THRESHOLD checks (45
    // min straight with nothing open). Accepted for now — this fleet
    // normally runs dozens of concurrent dispatched workspaces (25 observed
    // live during this card's own implementation), so a real 45-minute
    // all-idle window is rare, and disposition:'digest' means a false
    // positive costs a line in the next digest, not a 2am page. Revisit if
    // it fires with no real outage behind it.
    const reachable = Array.isArray(list) && list.length > 0;
    return {
      measurable: true,
      reachable,
      workspaceCount: Array.isArray(list) ? list.length : 0,
      error: reachable ? null : 'listWorkspaces() returned empty — treated as unreachable per existing convention',
    };
  } catch (err) {
    return { measurable: true, reachable: false, workspaceCount: 0, error: err.message };
  }
}

// Orchestration shared by both callers (see file header). Returns a
// health-check.js-row-shaped object: { name, status, message, hint? }.
//
// `dryRun` mirrors checkDispatchOutcomes' contract in health-check.js: a
// probe/verification run must never perturb the streak state a REAL run
// compares against, and must never send a real alert.
async function runReachabilityCheck({
  dryRun = false,
  logPath = ATTEMPTS_LOG_PATH,
  now = Date.now(),
  probeFn = probeCmuxReachability,
  routeAlertFn,
  resolveConditionFn,
} = {}) {
  const probe = probeFn();

  if (!probe.measurable) {
    return {
      name: `${CHECK_NAME} (unmeasurable here)`,
      status: 'warn',
      message: 'cmux.app is not installed on this machine (or this is CI) — reachability cannot be measured from here.',
    };
  }

  if (!dryRun) logReachabilityAttempt({ ok: probe.reachable, error: probe.error }, { logPath, now });

  const attempts = readReachabilityAttempts({ logPath });
  const { consecutiveFailures, forHowLong, shouldAlert } = decideReachabilityAlert(attempts, { now });

  const routerLib = (!routeAlertFn || !resolveConditionFn) ? require('./owner-alert-router.js') : null;
  const doRouteAlert = routeAlertFn || routerLib.routeAlert;
  const doResolveCondition = resolveConditionFn || routerLib.resolveCondition;

  if (probe.reachable) {
    if (!dryRun) {
      try { doResolveCondition(CONDITION_KEY); } catch { /* best-effort — next healthy run retries */ }
    }
    return { name: CHECK_NAME, status: 'pass', message: `cmux socket reachable (${probe.workspaceCount} workspace(s) listed)` };
  }

  if (shouldAlert) {
    if (!dryRun) {
      try {
        await doRouteAlert({
          conditionKey: CONDITION_KEY,
          title: `cmux socket unreachable for ${forHowLong} (${consecutiveFailures} consecutive checks)`,
          description: `listWorkspaces() has failed to reach the cmux control socket on ${consecutiveFailures} consecutive checks (${forHowLong}). This check is prose-independent of classifyCmuxError (BRO-2959's auth-denied taxonomy) — it fires on reachability alone, so a future cmux release reworking its error text, or a capability loss that returns a clean empty result, still pages. Last error: ${probe.error || '(none captured)'}. This is the same failure class that disabled bsc-reconcile's tab self-heal, bsc-prune, and dispatch-watchdog simultaneously for ~2h on 2026-09-07 (BRO-2959) with nothing paging.`,
          severity: 'error',
          disposition: 'digest',
          cooldownHours: 24,
        });
      } catch (err) {
        console.error(`[cmux-reachability] alert failed to send: ${err.message}`);
      }
    }
    return {
      name: CHECK_NAME,
      status: 'error',
      message: `cmux unreachable for ${consecutiveFailures} consecutive checks (${forHowLong}). Last error: ${probe.error || '(none captured)'}`,
      hint: 'Check cmux.app is running and the socket auth config (scripts/lib/cmux-socket-auth.js) hasn\'t rotated — see BRO-2959.',
    };
  }

  return {
    name: CHECK_NAME,
    status: 'warn',
    message: `cmux unreachable (${consecutiveFailures} consecutive check${consecutiveFailures === 1 ? '' : 's'}, below the alert threshold of ${CONSECUTIVE_FAILURE_THRESHOLD}) — not yet paging.`,
  };
}

module.exports = {
  CHECK_NAME,
  CONDITION_KEY,
  CONSECUTIVE_FAILURE_THRESHOLD,
  ATTEMPTS_LOG_PATH,
  logReachabilityAttempt,
  readReachabilityAttempts,
  decideReachabilityAlert,
  probeCmuxReachability,
  runReachabilityCheck,
};
