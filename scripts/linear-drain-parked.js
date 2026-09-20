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
 *      (`--headless` is linear-next's default since BRO-3652; still a valid alias)
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
 * binary to hand off to, so a headless dispatch can't run there. Real
 * dispatch runs on the Mac side via its own launchd tick (scripts/launchd/
 * com.broadwayscore.linear-drain-parked.plist), mirroring backlog-drain.js's
 * own launchd cadence rather than folding into send-morning-digest.js. That
 * agent was BOOTSTRAPPED 2026-09-08 (BRO-3060) and ticks 10:30/14:30/18:30
 * ET; before that it had never executed once, which is how 126 auto-filed
 * issues accumulated with no dispatch-ledger row at all. Check liveness with
 * `launchctl print gui/$(id -u)/com.broadwayscore.linear-drain-parked`, not
 * by reading the plist — ~/Library/LaunchAgents/ holds the installed copy
 * and can drift from the one in this repo.
 * BRO-3060: .github/workflows/check-linear-drain-health.yml runs this file's
 * own --dry-run daily as a READ-ONLY CI monitor (Linear API read only, no
 * spawn), and hands the resulting candidate count to
 * scripts/check-linear-drain-health.js. That script — NOT this one, and no
 * longer a threshold hardcoded in the YAML — decides health, by asking
 * whether this drain has written a `drain-parked-dispatch` row recently
 * enough while work was queued.
 *
 * The gate it replaced ("go red if eligible candidates pile up past one
 * dispatch cap") was dead on arrival: the workflow ran --dry-run with no
 * --cap, :445 below passes `limit: cap` with cap = DISPATCH_CAP = 3, and
 * lib/linear-drain-parked.js:85 slices to that limit — so the count it
 * compared against 3 could never exceed 3. The workflow now passes
 * `--cap 1000` so the printed count is the real backlog depth.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { selectDrainCandidates, isAutoFiledParked, hasSafeVerifyCommand } = require('./lib/linear-drain-parked.js');
const { checkPark, computeContentHash } = require('./lib/attempt-memory.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const dispatchReconcile = require('./lib/dispatch-reconcile.js');
// BRO-3454: this drain had neither of the two guards its sibling
// scripts/lib/digest-autofix.js just got in BRO-3412 (spend circuit breaker,
// concurrency ceiling) — same missing-guard gap, third instance of it found
// in the auto-fix dispatch family after scripts/backlog-drain.js (which has
// both natively). Imported, not re-derived (CLAUDE.md rule 15) — same
// functions/thresholds BRO-3412 wired into digest-autofix.js. Independently
// scoped to the taskIds THIS drain dispatched (see the guard block in main()
// below) — not a shared cross-drain budget.
const {
  computeSpendCircuitBreaker, computeConcurrency,
  DEFAULT_CONCURRENCY_CAP, DEFAULT_SPEND_THRESHOLD_USD,
} = require('./lib/backlog-drain.js');

require('./lib/load-env').loadEnv();

const REPO = '/Users/tompryor/Broadwayscore';
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'linear-drain-parked-ledger.jsonl');
const DISPATCH_CAP = 3;
// A dispatch's spawn (or its resolved outcome) is expected well inside this
// window — past it with no job-spawned event at all, the detached child was
// refused before it ever reached bsc-runner (same reasoning as
// digest-autofix.js's/backlog-drain.js's own ORPHAN_TIMEOUT_H).
// Single source of truth: scripts/lib/dispatch-reconcile.js, the module this
// value is handed straight back to as classifyDispatches' `orphanTimeoutH`.
// All three reconcilers used to declare their own `= 3` (BRO-3321).
const ORPHAN_TIMEOUT_H = dispatchReconcile.ORPHAN_TIMEOUT_H;
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

// Exact-duplicate lines are dropped, and that is load-bearing rather than
// tidiness (ship-check finding, 2026-09-08). This ledger carries `merge=union`
// so concurrent appends union instead of conflicting, and union can leave the
// SAME row twice — sync-audit-checkout.sh's recovery stage re-appends the
// locally-saved rows on top of origin's committed ones. attempt-memory.js's
// checkPark() then counts every 'card-fail' row in the newest-to-oldest
// streak with no dedupe of its own, and DEFAULT_MAX_FAILURES is 2 — so one
// duplicated fail row is enough to turn a single failure into a park and
// strand a card that only failed once. Stranded cards are the exact defect
// BRO-3060 was filed for; re-introducing them through the merge driver would
// be a poor trade.
//
// Exact-line equality is the right key: every row is stamped with an ISO
// millisecond `ts` at append time, so two genuinely distinct attempts never
// serialise identically, and appendLedger writes keys in a fixed order.
function readLedger(p = LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function appendLedger(entry, p = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// Strict variant (BRO-3454, same pattern as digest-autofix.js's
// readJsonlLedgerStrict from BRO-3412) — used ONLY by the spend/concurrency
// guard in main(). readLedger() above swallows every filesystem error into
// [], indistinguishable from "nothing here yet" — the common, healthy first-
// run state. Reusing that fail-soft read for a money guard means the ONE
// failure mode most likely to happen (a corrupt/inaccessible ledger) reads
// as "$0 spent, 0 alive" and lets dispatch through with ZERO protection —
// backwards for a guard whose job is to fail closed. ENOENT is NOT a
// failure — no ledger file yet must not halt dispatch — but any OTHER read
// error propagates so the guard's own try/catch can act on it.
//
// UNLIKE digest-autofix's strict reader: this ledger (not digest-autofix's)
// carries `merge=union` in .gitattributes and can genuinely contain
// duplicate lines from concurrent-append merges (see the exact-line dedup
// comment above readLedger()) — dropping that dedup here would double-count
// real spend and inflate the failure streak the breaker/park logic reads.
function readLedgerStrict(p = LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }
  const out = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line — matches readLedger */ }
  }
  return out;
}

// Same strict/ENOENT-tolerant contract, for the SHARED dispatch-ledger.jsonl
// (dispatchLedger.readEntries() also swallows every fs error into [], with
// no way to tell "empty" from "unreadable"). Reads dispatchLedger.LEDGER_PATH
// directly rather than calling readEntries() — this module doesn't own that
// ledger's format, but readEntries() offers no strict variant.
function readSharedDispatchLedgerStrict() {
  let raw;
  try { raw = fs.readFileSync(dispatchLedger.LEDGER_PATH, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
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
    if (kind === dispatchReconcile.DECISION_KINDS.ORPHAN) {
      newEntries.push({
      // ts (BRO-3868 regression fix, 2026-09-20): stamp the outcome at the
      // moment it is DECIDED, not only when a copy of it is serialized to
      // disk. These rows are handed straight to attempt-memory's checkPark
      // in memory (ledgerEntries.concat(newOutcomes)), and BRO-3868's new
      // finite-ts guard drops any row it cannot place chronologically — so
      // an unstamped row silently vanished from the very fail-streak it was
      // created to record, and nothing ever parked. Verified: the park
      // end-to-end test went red on main the moment that guard landed.
      // appendLedger's own `{ ts: <now>, ...entry }` spread preserves this
      // value, so the persisted ts now equals the in-memory one.
      ts: now.toISOString(),
        // usd: 0 (BRO-3454) — no job ever spawned, so no cost was incurred.
        // Mirrors digest-autofix.js's reconcileDigestOutcomes ORPHAN branch.
        event: 'card-fail', cardId, contentHash: d.contentHash, judgedDispatchTs: d.ts, usd: 0,
        note: `spawn never observed within ${ORPHAN_TIMEOUT_H}h of dispatch (likely refused: kill switch, verify gate, terminal-state guard, or lease already held)`,
      });
      continue;
    }
    if (kind === dispatchReconcile.DECISION_KINDS.RETRY_TIMEOUT) {
      // The retry chain ended at 'job-retried' and no successor spawned inside
      // the orphan bound: the resume child died before spawning, so it fails.
      newEntries.push({
      // ts (BRO-3868 regression fix, 2026-09-20): stamp the outcome at the
      // moment it is DECIDED, not only when a copy of it is serialized to
      // disk. These rows are handed straight to attempt-memory's checkPark
      // in memory (ledgerEntries.concat(newOutcomes)), and BRO-3868's new
      // finite-ts guard drops any row it cannot place chronologically — so
      // an unstamped row silently vanished from the very fail-streak it was
      // created to record, and nothing ever parked. Verified: the park
      // end-to-end test went red on main the moment that guard landed.
      // appendLedger's own `{ ts: <now>, ...entry }` spread preserves this
      // value, so the persisted ts now equals the in-memory one.
      ts: now.toISOString(),
        // usd (BRO-3454): the timed-out attempt's own cost, same field
        // digest-autofix.js's RETRY_TIMEOUT branch records.
        event: 'card-fail', cardId, contentHash: d.contentHash, judgedDispatchTs: d.ts, usd: Number(job.costUSD) || 0,
        note: `resume recorded (job ${job.jobId}) but no successor session spawned within ${ORPHAN_TIMEOUT_H}h`,
      });
      continue;
    }
    // Explicit, not fall-through (ship-check finding) — see the same guard in
    // scripts/backlog-drain.js's reconcileOutcomes: a new `kind` from the
    // shared lib must stop the pass rather than be silently treated as
    // terminal and dereference a job that may be null.
    if (kind !== dispatchReconcile.DECISION_KINDS.TERMINAL) throw new Error(`reconcileOutcomes: unhandled dispatch kind '${kind}'`);
    // KNOWN LIMITATION (BRO-3445, filed for digest-autofix.js's identical
    // shape and now also true here): job-done only proves the headless
    // session EXITED cleanly, not that the issue actually closed — the board
    // Done-audit verifies that separately, out-of-band. A session that exits
    // clean without resolving anything still counts as a `card-pass`
    // completion for computeSpendCircuitBreaker below, which can mask
    // ongoing spend and keep the breaker from tripping. Same tradeoff
    // BRO-3412/BRO-3445 accepted for digest-autofix.js — out of scope for
    // this wiring-only card.
    const outcome = job.event === dispatchLedger.JOB_EVENTS.DONE ? 'card-pass' : 'card-fail';
    newEntries.push({
      // ts (BRO-3868 regression fix, 2026-09-20): stamp the outcome at the
      // moment it is DECIDED, not only when a copy of it is serialized to
      // disk. These rows are handed straight to attempt-memory's checkPark
      // in memory (ledgerEntries.concat(newOutcomes)), and BRO-3868's new
      // finite-ts guard drops any row it cannot place chronologically — so
      // an unstamped row silently vanished from the very fail-streak it was
      // created to record, and nothing ever parked. Verified: the park
      // end-to-end test went red on main the moment that guard landed.
      // appendLedger's own `{ ts: <now>, ...entry }` spread preserves this
      // value, so the persisted ts now equals the in-memory one.
      ts: now.toISOString(),
      // usd (BRO-3454): what this dispatch actually cost, so
      // computeSpendCircuitBreaker (called from main() below) has something
      // to sum — this ledger never recorded cost before.
      event: outcome, cardId, contentHash: d.contentHash, judgedDispatchTs: d.ts, usd: Number(job.costUSD) || 0,
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
  // BRO-3454: single injection point for this drain's own ledger path, so
  // tests can point both the existing fail-soft reads/writes AND the new
  // strict guard reads at a temp file without a second dep shape.
  const ledgerPath = deps.ledgerPath || LEDGER_PATH;

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

  const ledgerEntries = readLedgerFn(ledgerPath);

  // Attempt-memory reconciliation: resolve prior dispatches into
  // card-pass/card-fail before computing park state. Fail-soft — a broken
  // dispatch-ledger read or reconcile degrades to "no park state known",
  // never blocks selection/dispatch this run.
  let effectiveLedgerEntries = ledgerEntries;
  try {
    const dispatchLedgerEntries = dispatchLedgerEntriesFn();
    const newOutcomes = reconcileOutcomes(ledgerEntries, dispatchLedgerEntries, now);
    for (const o of newOutcomes) {
      // `if (!dryRun)` — byte-for-byte the shape the sibling drain already
      // ships at scripts/backlog-drain.js:461. Without it --dry-run WROTE:
      // USAGE and the "no dispatch/ledger writes" line at the bottom of this
      // function both promised otherwise, but this append ran unconditionally,
      // above the first `if (!dryRun)` guard. That made the scheduled CI
      // health check a writer, and dirtied the tracked ledger on any local
      // preview. The log line stays unconditional (also as in backlog-drain)
      // so a dry run still SHOWS what it would have reconciled.
      if (!dryRun) appendLedgerFn(o, ledgerPath);
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

  // Spend circuit breaker + concurrency ceiling (BRO-3454, mirrors BRO-3412's
  // fix to scripts/lib/digest-autofix.js's runAutofix()). Deliberately fails
  // CLOSED (zero budget) if this computation itself throws — unlike the
  // attempt-memory reconcile above (fail-soft), a broken money/fleet-storm
  // guard failing OPEN would silently remove the protection this card exists
  // to add. Scoped to taskIds THIS drain dispatched (identifiers from its own
  // 'drain-parked-dispatch' rows, namespaced `linear:<identifier>` — the same
  // form reconcileOutcomes' taskIdOf and dispatchFn's call site below both
  // already use), never a shared cross-drain budget.
  //
  // Skipped entirely on --dry-run (BRO-3454, same choice BRO-3412 made for
  // digest-autofix.js, whose own dry-run branch returns before any of this
  // runs): dry-run was already an approximation, so it previews every
  // candidate rather than modeling a budget a live run might cap lower.
  //
  // Overridable via deps (concurrencyCap/spendThresholdUSD), same as
  // digest-autofix.js's runAutofix() params — not new numbers, just an
  // injection point so a test can hold the ceiling constant while it
  // exercises something else (e.g. --cap parsing).
  //
  // Reads via `deps.readLedger`/`deps.dispatchLedgerEntries` RAW (checked
  // directly, never the `readLedgerFn`/`dispatchLedgerEntriesFn` locals
  // above, which already have a fail-soft default baked in) — falling back
  // to the strict real-file readers ONLY when no dep is injected at all.
  // This is deliberately NOT the same shape as digest-autofix.js's own
  // strict-reader wiring: that file's tests always write real temp ledger
  // files, so its guard can unconditionally call the strict reader. THIS
  // file's existing test convention (tests/unit/linear-drain-parked.test.mjs)
  // is in-memory mock functions with no real file at all — reusing the raw
  // dep here means those existing mocks drive the guard too, instead of the
  // guard silently reading the REAL data/audit/linear-drain-parked-ledger.jsonl
  // out from under every test that never asked for real fs I/O. A real run
  // (no deps injected) still gets the strict, fail-closed-on-corruption
  // reader `readLedgerStrict`/`readSharedDispatchLedgerStrict` provide —
  // same protection BRO-3412 added, just reached via the raw dep check
  // instead of an unconditional call.
  let budget = candidates.length;
  if (!dryRun) {
    const concurrencyCap = Number.isFinite(deps.concurrencyCap) ? deps.concurrencyCap : DEFAULT_CONCURRENCY_CAP;
    const spendThresholdUSD = Number.isFinite(deps.spendThresholdUSD) ? deps.spendThresholdUSD : DEFAULT_SPEND_THRESHOLD_USD;
    let concurrency = { atCap: true, alive: null, cap: concurrencyCap, aliveTaskIds: [] };
    let breaker = { halt: true, reason: 'guard computation failed — failing closed, no dispatch this run', spentUSD: null, completions: null, thresholdUSD: spendThresholdUSD };
    try {
      const freshOwnLedgerEntries = (deps.readLedger || readLedgerStrict)(ledgerPath);
      const freshDispatchLedgerEntries = (deps.dispatchLedgerEntries || readSharedDispatchLedgerStrict)();
      const dispatchedTaskIds = new Set(
        freshOwnLedgerEntries.filter(e => e && e.event === 'drain-parked-dispatch' && e.identifier)
          .map(e => `linear:${e.identifier}`));
      concurrency = computeConcurrency(dispatchedTaskIds, freshDispatchLedgerEntries, concurrencyCap);
      breaker = computeSpendCircuitBreaker(freshOwnLedgerEntries, { thresholdUSD: spendThresholdUSD });
    } catch (e) {
      log(`[linear-drain-parked] WARN spend/concurrency guard computation failed (failing CLOSED — no dispatch this run): ${e.message}`);
    }
    if (concurrency.atCap) {
      log(`[linear-drain-parked] concurrency cap reached (${concurrency.alive}/${concurrencyCap} drain jobs alive: ${(concurrency.aliveTaskIds || []).join(', ')}) — dispatch budget reduced this run`);
    }
    if (breaker.halt) {
      log(`[linear-drain-parked] ${breaker.reason}`);
    }
    // NOTE: DEFAULT_CONCURRENCY_CAP (2) < DISPATCH_CAP (3) — even with zero
    // concurrent jobs, budget maxes at 2, not 3 at the defaults. DISPATCH_CAP
    // is not dead: it still bounds a run once concurrencyCap is raised (an
    // owner call, not this card's — neither default is touched here).
    budget = breaker.halt ? 0 : Math.min(candidates.length, Math.max(0, concurrencyCap - concurrency.alive));
  }

  const dispatched = [];
  for (const issue of candidates) {
    if (dryRun) {
      log(`[linear-drain-parked] DRY RUN would dispatch ${issue.identifier}: ${issue.title}`);
      continue;
    }
    if (budget <= 0) {
      log(`[linear-drain-parked] dispatch budget exhausted this run — ${issue.identifier} stays queued for a future run`);
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
      // allowAutomationParked (BRO-3060): every candidate here passed
      // isAutoFiledParked above, i.e. its description carries owner-alert-
      // router's PARKED marker — a second, independent guard from
      // autofixFiledIssueGuard that allowAutofixFiled does NOT waive. Without
      // this every dispatch this drain ever attempted was refused inside the
      // detached child (discovered live, 2026-09-08: all 3 of this run's
      // candidates were refused before this fix).
      dispatchFn(`linear:${issue.identifier}`, log, dispatched.length * 45, null, { allowAutofixFiled: true, allowAutomationParked: true });
      budget--;
      appendLedgerFn({
        event: 'drain-parked-dispatch', identifier: issue.identifier, title: issue.title,
        contentHash: computeIssueContentHash(issue),
      }, ledgerPath);
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
