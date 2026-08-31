#!/usr/bin/env node
/**
 * reconcile-landed-but-open — BRO-2558: find "In Progress" Linear issues
 * whose work already LANDED on origin/main and was never closed.
 *
 * reconcile-dead-completions.js (card #1144) catches the opposite direction
 * — cards marked done that were not. Nothing caught this one: measured
 * 2026-08-31, 38 of 144 In-Progress issues already had a merge commit on
 * origin/main matching `linear-BRO-<n>-`. That inflates every queue count
 * the fleet reports and buries genuinely-open work.
 *
 * Merge-commit presence ALONE is NOT sufficient — see scripts/lib/landed-
 * but-open-reconciler.js's header for the two counterexamples (BRO-80: a
 * merge commit AND a live dispatched worker right now; BRO-516: looks landed
 * by title similarity but its own ledger says job-failed) that make a naive
 * "has a merge commit therefore close it" sweep wrong. classifyLandedButOpen
 * requires ALL FOUR: merge commit, no live dispatch/lease, a terminal-success
 * (job-done) ledger event, and a passing re-run of the card's OWN acceptance
 * command against a fresh origin/main checkout.
 *
 * REPORT-ONLY. There is no --fix. Per BRO-2313's precedent for the sibling
 * reconciler (reconcile-dead-completions.js), this prints the candidate list
 * with per-card evidence and leaves closing them to a human or a separately
 * gated step — never an automatic close.
 *
 * Usage:
 *   node scripts/reconcile-landed-but-open.js             report only
 *   node scripts/reconcile-landed-but-open.js --json       machine-readable report
 *   node scripts/reconcile-landed-but-open.js --time-budget-min 20   cap wall clock (default 20)
 *   node scripts/reconcile-landed-but-open.js --help, -h   show this message
 *
 * --time-budget-min: gate 4 (re-running each candidate's own acceptance
 * command against a fresh checkout) is the one unbounded step here — a
 * card's command could be a slow test suite, and CHECK_TIMEOUT_MS alone
 * allows up to 10 minutes per card (autonomous-checks.js: 5min x 2 attempts).
 * Same "cron timeout needs its own script budget" discipline as
 * autonomous-acceptance-recheck.js's --time-budget-min: once the budget is
 * spent, remaining candidates are reported 'unverifiable' (deferred), never
 * silently skipped — deferred always reads as not-closable, the safe
 * direction, and is called out distinctly in the report.
 */

'use strict';

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const linear = require('./lib/linear-client.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const linearDispatch = require('./lib/linear-dispatch.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const { makeFreshCheckout, removeCheckout, runVerify } = require('./lib/acceptance-check-core.js');
const { readLease, pidLooksLikeClaude, REPO } = require('./lib/bsc-runner.js');
const { classifyLandedButOpen, lastLedgerEventForTask } = require('./lib/landed-but-open-reconciler.js');

const USAGE = `reconcile-landed-but-open — report In-Progress Linear issues whose work already landed on origin/main (BRO-2558).

Usage:
  node scripts/reconcile-landed-but-open.js                        report only (the only mode — no --fix)
  node scripts/reconcile-landed-but-open.js --json                 machine-readable report
  node scripts/reconcile-landed-but-open.js --time-budget-min 20   cap wall clock spent re-running acceptance commands (default 20)
  node scripts/reconcile-landed-but-open.js --help, -h             show this message
`;

const GIT_TIMEOUT_MS = 60000;
const DEFAULT_TIME_BUDGET_MIN = 20;

function ledgerTaskId(identifier) { return `linear:${identifier}`; }

const MERGE_SUBJECT_RE = /linear-([A-Za-z]+)-(\d+)-/;

// ONE git log call for the whole sweep, not one per candidate. An earlier cut
// of this shelled out to `git log --grep=linear-BRO-<n>-` per issue — 263
// issues meant 263 subprocess spawns, and against this repo's real history
// (measured live: ~5000 commits scanned, ~245 matches) that alone burned
// most of a --time-budget-min=3 run before a single acceptance re-check
// could start. One broad `--grep=linear-` pass plus a client-side regex over
// the ~245 matching subjects is the same evidence, at 1/263rd the process
// spawns. The repro command in BRO-2558 itself (`git log origin/main
// --oneline --grep="linear-BRO-<n>-"`) is this same match, just narrowed to
// one issue — real example found live: "Merge branch
// 'job/linear-BRO-406-msxc1v2h'".
//
// git log is newest-first, so the FIRST match for a key wins (most recent
// merge for that card) — `!map.has(key)` below preserves that.
function buildMergeCommitIndex() {
  const map = new Map(); // "BRO-2558" -> sha
  try {
    const out = execFileSync('git', [
      '-C', REPO, 'log', 'origin/main', '--oneline', '--grep=linear-',
    ], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!out) return map;
    for (const line of out.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      const sha = line.slice(0, sp);
      const m = MERGE_SUBJECT_RE.exec(line.slice(sp + 1));
      if (!m) continue;
      const key = `${m[1]}-${m[2]}`;
      if (!map.has(key)) map.set(key, sha);
    }
  } catch {
    // git failure (no origin/main locally, etc.) must fail SAFE — an EMPTY
    // index reads as "no merge commit" for every card, which the classifier
    // already treats as not-closable. Never crash the sweep over this.
  }
  return map;
}

function findMergeCommit(identifier, mergeIndex) {
  const sha = mergeIndex.get(identifier) || null;
  return { hasMergeCommit: !!sha, mergeCommit: sha };
}

function liveLeaseForTask(taskId) {
  const lease = readLease(taskId);
  return !!(lease && pidLooksLikeClaude(lease.pid));
}

// The correlationId linear-dispatch.js's buildDispatchComment embeds:
// "Dispatched <correlationId> to <ref> at <ts> (<mode>)".
const DISPATCH_COMMENT_CORRELATION_RE = /^Dispatched\s+([0-9a-f]+)\s+to\b/;

// Adversarial-review finding (Codex, BRO-2558): dispatch-ledger.jsonl and
// job-leases are host-local (dispatch-ledger.js's own header: "Mac-local").
// A dispatch running on a DIFFERENT machine is invisible to both — the one
// cross-machine signal this repo already has is the issue's OWN comment
// thread (linear-dispatch.js's findUnresolvedDispatchComment, the same check
// linear-next.js runs before dispatching to avoid double-dispatch). Re-fetches
// the issue fresh (not the batch-listed copy, which has no `comments` field)
// — best-effort: a fetch failure here must not block the LOCAL re-check
// result, so it degrades to "no cross-machine evidence found" rather than
// throwing.
//
// NOT a timestamp comparison — real bug caught live testing this against
// production: for a headless dispatch, linear-next.js AWAITS runJob() to
// completion (job-done/job-failed) BEFORE calling reportDispatchOnIssue
// (scripts/linear-next.js:753,780) — so the "Dispatched ..." comment's
// createdAt is a few SECONDS AFTER the local job-done ts, always, for the
// exact same dispatch. A "comment newer than job-done" filter therefore
// flagged every one of 82 real candidates as falsely cross-machine-live off
// their own already-finished dispatch's own comment. Every ledger entry for
// a dispatch (the 'launch'/job-spawned row written before runJob) carries the
// SAME correlationId as the comment linear-next.js posts for it
// (buildDispatchComment) — so identity, not chronology, is the correct test:
// a comment whose correlationId matches something already in THIS host's own
// ledger for this task is the dispatch we already know about; a comment with
// no match (unparseable, or a correlationId this ledger has never recorded)
// is the only genuine "something else dispatched this, we don't know about
// it" signal.
async function checkCrossMachineDispatch(identifier, taskId, freshEntries) {
  try {
    const fresh = await linear.getIssue(identifier);
    const comment = fresh && linearDispatch.findUnresolvedDispatchComment(fresh);
    if (!comment) return null;
    const m = DISPATCH_COMMENT_CORRELATION_RE.exec(String(comment.body || '').trim());
    if (!m) return comment; // unparseable — fail toward "possibly live"
    const correlationId = m[1];
    const known = (freshEntries || []).some((e) => e && String(e.taskId) === String(taskId) && e.correlationId === correlationId);
    return known ? null : comment;
  } catch {
    return null;
  }
}

// The live-ness re-check gate 4 (up to ~10min/card — autonomous-checks.js
// CHECK_TIMEOUT_MS x 2 attempts) must NOT be trusted from before it ran
// (TOCTOU: a dispatch beginning mid-sweep is invisible to a stale snapshot —
// adversarial review finding, BRO-2558). Re-derives all three "someone is
// working this right now" signals fresh, right before a card is reported
// closable — see landed-but-open-reconciler.js's header for why this lives
// in the CLI, not the pure classifier.
async function recheckLiveNow(taskId, identifier) {
  const freshEntries = dispatchLedger.readEntries();
  if (linearDispatch.hasLiveLedgerEntry(taskId, freshEntries)) return { live: true, kind: 'liveDispatch' };
  if (liveLeaseForTask(taskId)) return { live: true, kind: 'liveLease' };
  const comment = await checkCrossMachineDispatch(identifier, taskId, freshEntries);
  if (comment) return { live: true, kind: 'crossMachineDispatch' };
  return { live: false, kind: null };
}

async function fetchStartedIssues() {
  const issues = await linear.listOpenIssuesWithDescriptions();
  return issues.filter((i) => i && i.state && i.state.type === 'started');
}

function parseTimeBudgetMs(argv) {
  const tok = argv.find((a) => a.startsWith('--time-budget-min'));
  if (!tok) return DEFAULT_TIME_BUDGET_MIN * 60 * 1000;
  const eq = tok.indexOf('=');
  const raw = eq !== -1 ? tok.slice(eq + 1) : argv[argv.indexOf(tok) + 1];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--time-budget-min must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n * 60 * 1000;
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const asJson = argv.includes('--json');
  const timeBudgetMs = parseTimeBudgetMs(argv);
  const deadline = Date.now() + timeBudgetMs;

  // Best-effort refresh so the merge-commit grep sees recent pushes. Never
  // fatal — a stale local origin/main just means a just-landed merge is
  // under-reported this run (fails toward "still open", the safe direction).
  try { execFileSync('git', ['-C', REPO, 'fetch', 'origin', 'main'], { timeout: GIT_TIMEOUT_MS, stdio: 'ignore' }); }
  catch { /* best effort */ }

  if (!asJson) console.error('[reconcile-landed-but-open] fetching In-Progress issues from Linear...');
  const issues = await fetchStartedIssues();
  const entries = dispatchLedger.readEntries();
  if (!asJson) console.error(`[reconcile-landed-but-open] ${issues.length} In-Progress issue(s) fetched; scanning for merge commits...`);

  // Gates 1-3 (merge commit, live dispatch/lease, terminal ledger event) are
  // pure/cheap and computed for every candidate first. Gate 4 (re-running the
  // card's own acceptance command) provisions a real git worktree — reserved
  // for cards that already cleared 1-3, and all of them share ONE checkout
  // (acceptance-check-core.js's own convention: "every card verifies against
  // the same origin/main, so N checkouts would be N copies of one tree").
  const mergeIndex = buildMergeCommitIndex();
  if (!asJson) console.error(`[reconcile-landed-but-open] merge-commit index built (${mergeIndex.size} matching commit(s) on origin/main); computing per-card evidence...`);
  const preliminary = issues.map((issue) => {
    const identifier = issue.identifier;
    const taskId = ledgerTaskId(identifier);
    const { hasMergeCommit, mergeCommit } = findMergeCommit(identifier, mergeIndex);
    const liveDispatch = linearDispatch.hasLiveLedgerEntry(taskId, entries);
    const liveLease = liveLeaseForTask(taskId);
    const lastLedgerEvent = lastLedgerEventForTask(taskId, entries);
    return { issue, identifier, taskId, hasMergeCommit, mergeCommit, liveDispatch, liveLease, lastLedgerEvent };
  });

  const needsAcceptanceCheck = preliminary.filter((c) =>
    c.hasMergeCommit && !c.liveDispatch && !c.liveLease && c.lastLedgerEvent === 'job-done');

  const acceptanceByIdentifier = new Map();
  let deferredCount = 0;
  let checkoutSha = null;
  if (needsAcceptanceCheck.length) {
    if (!asJson) console.error(`[reconcile-landed-but-open] ${needsAcceptanceCheck.length} candidate(s) cleared gates 1-3 — re-running each one's own acceptance command against a fresh origin/main checkout (budget: ${Math.round(timeBudgetMs / 60000)}min)...`);
    let checkout = null;
    try {
      checkout = makeFreshCheckout({ repo: REPO, prefix: 'landed-but-open-' });
      checkoutSha = checkout.sha;
      for (const c of needsAcceptanceCheck) {
        // Time-budget guard (CLAUDE.md: "cron timeout needs its own script
        // budget") — gate 4 is the one unbounded step (a card's own command
        // could be a slow suite; CHECK_TIMEOUT_MS alone allows up to 10min/
        // card). Once spent, remaining candidates are reported 'unverifiable'
        // (deferred) rather than run — never silently skipped, and
        // 'unverifiable' already reads as not-closable (the safe direction).
        if (Date.now() >= deadline) {
          acceptanceByIdentifier.set(c.identifier, { status: 'unverifiable', detail: `deferred — this run's ${Math.round(timeBudgetMs / 60000)}min budget was spent before this card's acceptance re-check ran` });
          deferredCount++;
          continue;
        }
        const gate = evaluateVerifiability(c.issue.description || '');
        if (!gate.cmd) {
          // No machine-runnable acceptance command (owner-judgment marker, or
          // no parseable "## Acceptance criteria" section at all — BRO-2546:
          // this is most cards today). Fails toward not-closable, never
          // toward silently skipping the check.
          acceptanceByIdentifier.set(c.identifier, { status: 'unverifiable', detail: gate.reason || 'no machine-runnable acceptance command on the card' });
          continue;
        }
        if (!asJson) console.error(`[reconcile-landed-but-open]   re-checking ${c.identifier}: ${gate.cmd}`);
        const result = runVerify(checkout.wt, gate.cmd, { prepared: checkout.prepared });
        if (result.status === 'pass') {
          // TOCTOU close: the run above could have taken up to ~10 minutes.
          // Re-derive liveness fresh before trusting a 'pass' toward closable
          // — see recheckLiveNow's header.
          const live = await recheckLiveNow(c.taskId, c.identifier);
          if (live.live) {
            c[live.kind] = true;
            acceptanceByIdentifier.set(c.identifier, { status: result.status, detail: `${result.detail || 'passed'} (but became live again during this run — see ${live.kind})`, cmd: gate.cmd });
            continue;
          }
        }
        acceptanceByIdentifier.set(c.identifier, { status: result.status, detail: result.detail, cmd: gate.cmd });
      }
    } finally {
      removeCheckout(checkout);
    }
  }

  const results = preliminary.map((c) => {
    const acceptance = acceptanceByIdentifier.get(c.identifier) || null;
    const verdict = classifyLandedButOpen({
      hasMergeCommit: c.hasMergeCommit,
      mergeCommit: c.mergeCommit,
      liveDispatch: c.liveDispatch,
      liveLease: c.liveLease,
      crossMachineDispatch: c.crossMachineDispatch,
      lastLedgerEvent: c.lastLedgerEvent,
      acceptanceStatus: acceptance ? acceptance.status : null,
    });
    return {
      identifier: c.identifier,
      title: c.issue.title,
      url: c.issue.url,
      closable: verdict.closable,
      reasons: verdict.reasons,
      mergeCommit: c.mergeCommit,
      acceptanceCmd: acceptance ? acceptance.cmd || null : null,
      acceptanceDetail: acceptance ? acceptance.detail : null,
      // Audit trail for a human deciding whether to act on this: the EXACT
      // origin/main commit the acceptance command was re-run against (P1
      // adversarial-review finding, BRO-2558 — "human-action blast radius is
      // understated" without this). Same for every candidate in this run —
      // one shared checkout.
      checkoutSha: acceptance ? checkoutSha : null,
    };
  });

  const candidates = results.filter((r) => r.closable);
  const withMergeCommit = results.filter((r) => r.reasons[0] && r.reasons[0].startsWith('merge commit found')).length;

  if (asJson) {
    console.log(JSON.stringify({ scanned: results.length, withMergeCommit, closableCandidates: candidates.length, results }, null, 2));
    return { scanned: results.length, withMergeCommit, closableCandidates: candidates.length, results };
  }

  console.log(`[reconcile-landed-but-open] scanned ${results.length} In-Progress issue(s); ${withMergeCommit} carry a merge commit on origin/main; ${candidates.length} pass every gate and are closable.`);
  if (!candidates.length) {
    console.log('No closable candidates this run. (report-only — nothing was changed)');
  } else {
    console.log('\nClosable (merge commit + no live dispatch/lease + job-done + acceptance re-check passing):');
    for (const r of candidates) {
      console.log(`  ${r.identifier}  ${r.title}`);
      console.log(`    ${r.url}`);
      for (const reason of r.reasons) console.log(`    - ${reason}`);
      if (r.acceptanceCmd) console.log(`    acceptance command: ${r.acceptanceCmd}`);
      if (r.checkoutSha) console.log(`    re-verified against origin/main @ ${r.checkoutSha}`);
    }
  }
  const stillOpenWithMerge = results.filter((r) => !r.closable && r.reasons[0] && r.reasons[0].startsWith('merge commit found'));
  if (stillOpenWithMerge.length) {
    console.log(`\nHas a merge commit but correctly still classified open (${stillOpenWithMerge.length}):`);
    for (const r of stillOpenWithMerge) {
      console.log(`  ${r.identifier}  ${r.title} — ${r.reasons[r.reasons.length - 1]}`);
    }
  }
  if (deferredCount) {
    console.log(`\n${deferredCount} candidate(s) had their acceptance re-check deferred (time budget spent) — re-run to resolve them.`);
  }
  console.log('\nThis is report-only — nothing above was closed. Close a candidate by hand (or a separately gated step), per BRO-2313.');
  return { scanned: results.length, withMergeCommit, closableCandidates: candidates.length, results };
}

if (require.main === module) {
  main().catch((e) => { console.error(`[reconcile-landed-but-open] fatal: ${e.message}`); process.exit(1); });
}

module.exports = { main, USAGE, findMergeCommit, buildMergeCommitIndex, ledgerTaskId, liveLeaseForTask };
