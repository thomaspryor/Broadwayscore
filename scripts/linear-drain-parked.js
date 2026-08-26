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
const { selectDrainCandidates } = require('./lib/linear-drain-parked.js');

require('./lib/load-env').loadEnv();

const REPO = '/Users/tompryor/Broadwayscore';
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'linear-drain-parked-ledger.jsonl');
const DISPATCH_CAP = 3;
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

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return { dispatched: [] }; }
  const args = parseArgs(argv);
  const dryRun = !!args['dry-run'];
  const cap = args.cap ? parseInt(args.cap, 10) : DISPATCH_CAP;

  const log = deps.log || ((m) => console.log(m));
  const listOpenIssuesWithDescriptionsFn =
    deps.listOpenIssuesWithDescriptions || require('./lib/linear-client.js').listOpenIssuesWithDescriptions;
  const dispatchFn = deps.dispatchFn || require('./lib/digest-autofix.js').dispatchDetached;
  const readLedgerFn = deps.readLedger || readLedger;
  const appendLedgerFn = deps.appendLedger || appendLedger;

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

  const alreadyAttempted = recentlyAttempted(readLedgerFn());
  const candidates = selectDrainCandidates(issues, { limit: cap, alreadyAttempted });

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
      dispatchFn(`linear:${issue.identifier}`, log, dispatched.length * 45);
      appendLedgerFn({ event: 'drain-parked-dispatch', identifier: issue.identifier, title: issue.title });
      dispatched.push(issue.identifier);
    } catch (e) {
      log(`[linear-drain-parked] WARN dispatch failed for ${issue.identifier}: ${e.message}`);
    }
  }
  if (dryRun) log(`[linear-drain-parked] DRY RUN: ${candidates.length} candidate(s), no dispatch/ledger writes`);
  else log(`[linear-drain-parked] dispatched ${dispatched.length}/${candidates.length}: ${dispatched.join(', ') || '(none)'}`);
  return { dispatched };
}

if (require.main === module) {
  main().catch((e) => { console.error(`[linear-drain-parked] fatal: ${e.stack || e.message}`); process.exit(1); });
}

module.exports = {
  parseArgs, readLedger, appendLedger, recentlyAttempted, main, USAGE,
  LEDGER_PATH, DISPATCH_CAP, RETRY_COOLDOWN_MS,
};
