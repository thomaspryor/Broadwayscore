#!/usr/bin/env node
/**
 * linear-drain-parked.js — Linear-side drain for parked, auto-filed issues
 * (BRO-293, BRO-286 Phase 2 completion).
 *
 * BRO-286 repointed owner-alert-router.js's dispatchCard() to file PARKED
 * Linear issues instead of Notion Action Queue cards. The old Notion path
 * had the Action Queue poller / P0-P1 auto-dispatch rule that drained a
 * parked card automatically; nothing does that for Linear yet, so an
 * alert-filed issue just sits in Backlog until a human dispatches it by
 * hand (surfaced honestly in the digest as "filed for triage" until then).
 * This script is that drain.
 *
 * Each run:
 *   1. Lists open Linear issues (with descriptions).
 *   2. Selects up to DISPATCH_CAP candidates via
 *      scripts/lib/linear-drain-parked.js's selectDrainCandidates — an
 *      auto-filed marker in the body, still sitting in Backlog, AND
 *      carrying a safe-form backticked acceptance-criteria command
 *      (linear-next.js's own verify-gate requirement — this drain never
 *      passes --allow-unverifiable).
 *   3. Dispatches each via digest-autofix.js's dispatchDetached() — the
 *      SAME detached `node scripts/linear-next.js --id X --headless` spawn
 *      the digest's own autofix rows use for their `linear:BRO-N` taskId
 *      form, so this drain gets linear-next's full guard stack (kill
 *      switch, idempotency, terminal-state, dead-dispatch, verify gate) for
 *      free rather than re-implementing any of it.
 *   4. Journals each attempt to this drain's own ledger
 *      (data/audit/linear-drain-parked-ledger.jsonl) so a re-run within
 *      RETRY_COOLDOWN_MS doesn't re-spawn a dispatch whose detached child
 *      hasn't had time to move the issue out of Backlog yet.
 *
 * Attempt-memory / permanent park (BRO-2434): RETRY_COOLDOWN_MS alone caps
 * how OFTEN a dead issue gets re-attempted, not how MANY TIMES — an issue
 * whose dispatch keeps failing/refusing forever (stale verify command,
 * permanently human-gated, a standing LINEAR_NEXT_DISABLED window) was
 * retried every 6h with no escalation. Before selecting candidates each
 * run, reconcileOutcomes() resolves prior 'drain-parked-dispatch' entries
 * against the SHARED dispatch-ledger's job lifecycle for `linear:<id>` into
 * card-pass/card-fail (same correlation pattern as
 * scripts/lib/digest-autofix.js's reconcileDigestOutcomes/findMyJob and
 * scripts/backlog-drain.js's own reconcileOutcomes — this one is simpler
 * because every dispatch here is Linear-tracked, so job-done alone is the
 * pass signal, no task-mirror status to also check). scripts/lib/
 * attempt-memory.js's checkPark() then runs per-issue against this drain's
 * own ledger: an issue that has failed DEFAULT_MAX_FAILURES (2) times in a
 * row on UNCHANGED content (title+description) is parked — skipped and
 * logged instead of re-dispatched — until the issue is edited (a changed
 * contentHash resets the streak). checkPark also supports an explicit owner
 * override that clears a park without an edit, but neither this drain nor
 * either of its sibling reference implementations (digest-autofix.js,
 * backlog-drain.js) currently wires attempt-memory.js's loadParkOverrides()
 * in — same inherited gap, not new here.
 *
 * Kill switch: LINEAR_NEXT_DISABLED=1 is checked here too (not just inside
 * linear-next.js) so a disabled run logs ONE clear line instead of spawning
 * N children that would each individually refuse.
 *
 * Usage:
 *   node scripts/linear-drain-parked.js               dispatch up to 3 eligible parked issues
 *   node scripts/linear-drain-parked.js --dry-run      preview selection, no dispatch/ledger writes
 *   node scripts/linear-drain-parked.js --cap N        override the per-run dispatch cap (default 3)
 *   --help, -h   show this message, do nothing else
 *
 * Wiring: NOT a data-health-check.yml step — the runner has no `claude`
 * binary to hand off to, so a headless dispatch can't run there. Wired on
 * the Mac side via its own launchd tick (scripts/launchd/
 * com.broadwayscore.linear-drain-parked.plist, disabled by default — see
 * that file's header for the install command), mirroring backlog-drain.js's
 * own launchd cadence rather than folding into send-morning-digest.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { selectDrainCandidates, isAutoFiledParked, hasSafeVerifyCommand } = require('./lib/linear-drain-parked.js');
const { checkPark, computeContentHash } = require('./lib/attempt-memory.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const dispatchReconcile = require('./lib/dispatch-reconcile.js');

require('./lib/load-env').loadEnv();

const REPO = '/Users/tompryor/Broadwayscore';
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'linear-drain-parked-ledger.jsonl');
const DISPATCH_CAP = 3;
// A dispatch's spawn (or its resolved outcome) is expected well inside this
// window — past it with no job-spawned event at all, the detached child was
// refused before it ever reached bsc-runner (same reasoning as
// digest-autofix.js's/backlog-drain.js's own ORPHAN_TIMEOUT_H).
const ORPHAN_TIMEOUT_H = 3;
// A parked issue this drain already spawned a dispatch for stays "pending
// its dispatch" until linear-next.js's detached child actually runs and
// moves it out of Backlog (or writes the shared dispatch-ledger 'launch'
// entry linear-next's own idempotency guard would then see). Without a
// cooldown, a drain tick that fires again before that child even starts
// would see the SAME issue still sitting in Backlog and re-spawn a second
// dispatch for it. 6h comfortably covers the gap for any dispatch that
// actually starts; one that never spawns at all (refused before reaching
// bsc-runner) is retried automatically once the cooldown clears.
const RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const USAGE = `linear-drain-parked.js — dispatch parked, auto-filed Linear issues (BRO-293).

Usage:
  node scripts/linear-drain-parked.js               dispatch up to ${DISPATCH_CAP} eligible parked issues
  node scripts/linear-drain-parked.js --dry-run      preview selection, no dispatch/ledger writes
  node scripts/linear-drain-parked.js --cap N        override the per-run dispatch cap (default ${DISPATCH_CAP})
  --help, -h   show this message, do nothing else

Kill switch: LINEAR_NEXT_DISABLED=1 refuses to dispatch anything this run
(checked here AND inside linear-next.js itself).
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function readLedger(p = LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function appendLedger(entry, p = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// Which identifiers were dispatched within the cooldown window, regardless
// of outcome — a refused/failed attempt is retried once the cooldown clears
// (past-cooldown entries are simply ignored, not cleaned up: the ledger is
// append-only, same convention as dispatch-ledger.js/digest-autofix.js).
function recentlyAttempted(entries, { now = Date.now(), cooldownMs = RETRY_COOLDOWN_MS } = {}) {
  const set = new Set();
  for (const e of entries || []) {
    if (!e || e.event !== 'drain-parked-dispatch' || !e.identifier || !e.ts) continue;
    const age = now - Date.parse(e.ts);
    if (Number.isFinite(age) && age >= 0 && age < cooldownMs) set.add(e.identifier);
  }
  return set;
}

// Same {name, notes} shape attempt-memory.computeContentHash expects — a
// Linear issue's title + description is the content that determines what a
// dispatch would actually attempt.
function computeIssueContentHash(issue) {
  return computeContentHash({ name: issue && issue.title, notes: issue && issue.description });
}

// Correlation logic shared with scripts/backlog-drain.js and
// scripts/lib/digest-autofix.js since BRO-2542 — see dispatch-reconcile.findMyJob
// for why "latest ts for this taskId" is unsafe, and why any retry chain is
// followed to read the job's current terminal state. Re-exported, not
// re-implemented: all three files previously carried a byte-for-byte copy.
const findMyJob = dispatchReconcile.findMyJob;

// A dispatch is resolved by an outcome recorded AT OR AFTER it, not by "this
// identifier+contentHash has an outcome somewhere in history" (ship-check
// Codex finding). The content-hash-keyed Set that scripts/lib/digest-autofix.js's
// reconcileDigestOutcomes uses collapses two dispatches of the SAME unchanged
// content onto one shared key — exactly the repeated-failure case this drain
// exists to detect — so a card re-dispatched after its first attempt failed
// would never produce a SECOND card-fail at all, and attempt-memory's
// failure streak could never reach maxFailures. This ts-ordered check is the
// same fix scripts/backlog-drain.js's own isDispatchResolved already applies
// (see its header comment for the "old card-id Set" postmortem this mirrors).
const RESOLVING_EVENTS = new Set(['card-pass', 'card-fail']);
// Arity-3 wrapper binding this module's own outcome vocabulary — the shared
// implementation takes the event set as a 4th argument, since
// scripts/backlog-drain.js resolves on a richer set (card-stranded,
// completion-unattributed) than this module's plain pass/fail.
function isDispatchResolved(ledgerEntries, identifier, dispatchTs) {
  return dispatchReconcile.isDispatchResolved(ledgerEntries, identifier, dispatchTs, RESOLVING_EVENTS);
}

// Resolves prior 'drain-parked-dispatch' breadcrumbs (this drain's own
// ledger) into card-pass/card-fail by cross-referencing the SHARED
// dispatch-ledger's job lifecycle for `linear:<identifier>`. Emitted entries
// carry `cardId` (not `identifier`) because that's the field attempt-memory.js's
// checkPark/attemptOutcomesForCard key on; `identifier` stays on the
// 'drain-parked-dispatch' entries only, where recentlyAttempted() already
// expects it.
//
// The correlation, resolution and same-pass jobId race guard live in
// scripts/lib/dispatch-reconcile.js since BRO-2542 — including the
// Number.isFinite(ts) filter and the "check only the IMMUTABLE pre-pass
// entries" rule, whose postmortems (this file's own BRO-2434 among them) are
// in that file's header. What stays here is this drain's own two-outcome
// vocabulary and note text.
function reconcileOutcomes(ledgerEntries, dispatchLedgerEntries, now = new Date()) {
  const decisions = dispatchReconcile.classifyDispatches({
    ledgerEntries,
    dispatchLedgerEntries,
    // Entries written before this feature shipped carry no contentHash and are
    // silently excluded — same convention attempt-memory.js's own header
    // documents for pre-feature ledger history.
    isDispatchRow: e => e.event === 'drain-parked-dispatch' && e.identifier && e.contentHash,
    resolvingEvents: RESOLVING_EVENTS,
    orphanTimeoutH: ORPHAN_TIMEOUT_H,
    cardIdOf: d => d.identifier,
    taskIdOf: d => `linear:${d.identifier}`,
    now,
  });
  const newEntries = [];
  for (const { dispatch: d, cardId, job, kind } of decisions) {
    if (kind === 'orphan') {
      newEntries.push({
        event: 'card-fail', cardId, contentHash: d.contentHash,
        note: `spawn never observed within ${ORPHAN_TIMEOUT_H}h of dispatch (likely refused: kill switch, verify gate, terminal-state guard, or lease already held)`,
      });
      continue;
    }
    if (kind === 'retry-timeout') {
      // The retry chain ended at 'job-retried' and no successor spawned inside
      // the orphan bound: the resume child died before spawning, so it fails.
      newEntries.push({
        event: 'card-fail', cardId, contentHash: d.contentHash,
        note: `resume recorded (job ${job.jobId}) but no successor session spawned within ${ORPHAN_TIMEOUT_H}h`,
      });
      continue;
    }
    const outcome = job.event === dispatchLedger.JOB_EVENTS.DONE ? 'card-pass' : 'card-fail';
    newEntries.push({
      event: outcome, cardId, contentHash: d.contentHash,
      note: outcome === 'card-pass'
        ? 'session finished (job-done)'
        : `job ${job.event}${job.stage ? `: ${job.stage}` : ''}`,
    });
  }
  return newEntries;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return { dispatched: [] }; }
  const args = parseArgs(argv);
  const dryRun = !!args['dry-run'];
  const log = deps.log || ((m) => console.log(m));
  // A bare `--cap` with no value parses to `args.cap === true` (parseArgs
  // treats a following `--`-prefixed token, or nothing, as flag-not-value) —
  // parseInt(true, 10) is NaN, and Math.max(0, NaN)/.slice(0, NaN) both
  // silently collapse the candidate list to [], reading as "no eligible
  // issues" instead of the bad-flag it actually is (ship-check finding).
  // Loud, not silent: fall back to the default and say so.
  let cap = DISPATCH_CAP;
  if (typeof args.cap === 'string') {
    const parsed = parseInt(args.cap, 10);
    if (Number.isInteger(parsed) && parsed > 0) cap = parsed;
    else log(`[linear-drain-parked] WARN --cap "${args.cap}" is not a positive integer — using default ${DISPATCH_CAP}`);
  } else if (args.cap !== undefined) {
    log(`[linear-drain-parked] WARN --cap requires a value (e.g. --cap 5) — using default ${DISPATCH_CAP}`);
  }
  const listOpenIssuesWithDescriptionsFn =
    deps.listOpenIssuesWithDescriptions || require('./lib/linear-client.js').listOpenIssuesWithDescriptions;
  const dispatchFn = deps.dispatchFn || require('./lib/digest-autofix.js').dispatchDetached;
  const readLedgerFn = deps.readLedger || readLedger;
  const appendLedgerFn = deps.appendLedger || appendLedger;
  const dispatchLedgerEntriesFn = deps.dispatchLedgerEntries || (() => dispatchLedger.readEntries());
  const now = deps.now || new Date();

  if (process.env.LINEAR_NEXT_DISABLED === '1') {
    log('[linear-drain-parked] LINEAR_NEXT_DISABLED=1 — dispatcher is switched off; nothing dispatched this run.');
    return { dispatched: [] };
  }

  let issues;
  try {
    issues = await listOpenIssuesWithDescriptionsFn();
  } catch (e) {
    log(`[linear-drain-parked] FATAL Linear fetch failed: ${e.message}`);
    process.exitCode = 1;
    return { dispatched: [] };
  }

  const ledgerEntries = readLedgerFn();

  // Attempt-memory reconciliation: resolve prior dispatches into
  // card-pass/card-fail before computing park state. Fail-soft — a broken
  // dispatch-ledger read or reconcile degrades to "no park state known",
  // never blocks selection/dispatch this run.
  let effectiveLedgerEntries = ledgerEntries;
  try {
    const dispatchLedgerEntries = dispatchLedgerEntriesFn();
    const newOutcomes = reconcileOutcomes(ledgerEntries, dispatchLedgerEntries, now);
    for (const o of newOutcomes) {
      appendLedgerFn(o);
      log(`[linear-drain-parked] attempt-memory: ${o.cardId} ${o.event} (${o.note})`);
    }
    if (newOutcomes.length) effectiveLedgerEntries = ledgerEntries.concat(newOutcomes);
  } catch (e) {
    log(`[linear-drain-parked] WARN attempt-memory reconcile failed (park checks skipped this run): ${e.message}`);
  }

  const alreadyAttempted = recentlyAttempted(effectiveLedgerEntries);

  // Permanent park: check only issues that would otherwise be selectable
  // (auto-filed, parked, verifiable) — no point computing/logging park state
  // for issues this drain would never touch anyway.
  const parkedIds = new Set();
  for (const iss of issues) {
    if (!iss || !iss.identifier || !isAutoFiledParked(iss) || !hasSafeVerifyCommand(iss)) continue;
    const hash = computeIssueContentHash(iss);
    const park = checkPark(effectiveLedgerEntries, iss.identifier, hash);
    if (park.parked) {
      parkedIds.add(iss.identifier);
      log(`[linear-drain-parked] ${iss.identifier} skipped — ${park.reason}`);
    }
  }
  const excluded = parkedIds.size ? new Set([...alreadyAttempted, ...parkedIds]) : alreadyAttempted;

  const candidates = selectDrainCandidates(issues, { limit: cap, alreadyAttempted: excluded });

  if (!candidates.length) {
    log('[linear-drain-parked] no eligible parked issues this run.');
    return { dispatched: [] };
  }

  const dispatched = [];
  for (const issue of candidates) {
    if (dryRun) {
      log(`[linear-drain-parked] DRY RUN would dispatch ${issue.identifier}: ${issue.title}`);
      continue;
    }
    try {
      // Staggered start (dispatched.length * 45s), same reasoning
      // dispatchDetached's own header documents for digest-autofix: parallel
      // detached spawns race the main repo's `git worktree add` lock.
      // allowAutofixFiled (BRO-2499, ship-check P0): this drain's own
      // population overlaps the one linear-dispatch.js's autofixFiledIssueGuard
      // refuses. scripts/health-check.js:3951 routes actionable health rows
      // through owner-alert-router with a "BSC Daily: <row>" title, so an
      // alert-filed tracker carries the SAME title convention as a
      // digest-autofix-filed one (only the PARKED marker differs). Measured
      // against the live snapshot at the time of the fix: 13 of the 14 issues
      // selectDrainCandidates returns would have been refused. Silently, too —
      // the ledger row below records "attempted" either way, and the refusal
      // exists only in the detached child's log file.
      // Passed here, at the call site that owns this population — not inside
      // dispatchDetached, which would waive it for every future caller too.
      dispatchFn(`linear:${issue.identifier}`, log, dispatched.length * 45, null, { allowAutofixFiled: true });
      appendLedgerFn({
        event: 'drain-parked-dispatch', identifier: issue.identifier, title: issue.title,
        contentHash: computeIssueContentHash(issue),
      });
      dispatched.push(issue.identifier);
    } catch (e) {
      log(`[linear-drain-parked] WARN dispatch failed for ${issue.identifier}: ${e.message}`);
    }
  }
  if (dryRun) {
    log(`[linear-drain-parked] DRY RUN: ${candidates.length} candidate(s), no dispatch/ledger writes`);
  } else {
    // "attempted", not "dispatched" (ship-check finding, same honesty rule
    // backlog-drain.js/digest-autofix.js already follow): dispatchFn only
    // proves spawn() was called — linear-next.js's own guards (kill switch,
    // idempotency, verify gate, human-gate) can still refuse inside the
    // detached child. Per-attempt outcome lives in that child's own log
    // file (dispatchDetached() prints the path) and, on a real dispatch,
    // the shared dispatch-ledger's 'launch' entry.
    log(`[linear-drain-parked] dispatch attempted for ${dispatched.length}/${candidates.length}: ${dispatched.join(', ') || '(none)'}`);
  }
  return { dispatched };
}

if (require.main === module) {
  main().catch((e) => { console.error(`[linear-drain-parked] fatal: ${e.stack || e.message}`); process.exit(1); });
}

module.exports = {
  parseArgs, readLedger, appendLedger, recentlyAttempted, main, USAGE,
  LEDGER_PATH, DISPATCH_CAP, RETRY_COOLDOWN_MS, ORPHAN_TIMEOUT_H,
  computeIssueContentHash, findMyJob, reconcileOutcomes, isDispatchResolved,
};
