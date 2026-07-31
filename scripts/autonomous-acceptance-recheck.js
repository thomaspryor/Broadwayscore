#!/usr/bin/env node
/**
 * autonomous-acceptance-recheck.js — independently re-verify cards that were
 * marked Done (Sprint 3, S3-T2). SHADOW MODE: it reports, it never reopens.
 *
 *   node scripts/autonomous-acceptance-recheck.js            # normal nightly run
 *   node scripts/autonomous-acceptance-recheck.js --dry-run  # plan only, no ledger write
 *   node scripts/autonomous-acceptance-recheck.js --help
 *
 * "Done" on a card is a claim by whoever closed it — nothing has ever checked
 * it afterwards. This re-runs the card's OWN acceptance-criteria command
 * (captured at dispatch by scripts/bsc-next.js, validated then and re-validated
 * here) against a FRESH checkout of origin/main, days after the branch that
 * produced it is gone. That is the point: a check that only passes on the
 * author's branch proves nothing about the repo everyone else works in.
 *
 * Safety properties, in the order they matter:
 *   - SHADOW: no Notion writes, ever. Results land in the autonomous ledger and
 *     the morning email. Enforcement (auto-reopening a failed card) stays off
 *     until the shadow record clears an objective bar — see
 *     scripts/lib/autonomous-recheck-core.js shouldExitShadow.
 *   - The command is UNTRUSTED text from a card: it is re-validated against
 *     isSafeCheckCommand at execution time (not just at capture time) and run
 *     with the same secret-free, fake-HOME env as the check gauntlet.
 *   - A card someone is actively working right now is skipped, not re-checked.
 *   - One retry before calling a failure a failure: a transient npm/network
 *     flake must not manufacture a "your finished work is broken" line.
 *   - Its worktree is disposable and detached — it never touches the main
 *     checkout's branch state, which is why it is safe to run on nights when
 *     the executor itself is skipped (opening-night monitor lock).
 *
 * Named autonomous-* so the loop's own eligibility gate refuses to let a
 * tier-3 card edit the thing that audits its own completions.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { hasHelpFlag } = require('./lib/cli-help.js');
const ledger = require('./lib/autonomous-ledger.js');
const { shallowFetchArgs } = require('./lib/shallow-fetch-args.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { findClaimedTask } = require('./lib/autonomous-triage-core.js');
const { checksEnv, cardCheckArgv, prepareCheckWorkdir, CHECK_TIMEOUT_MS } = require('./lib/autonomous-checks.js');
const { selectRecheckTargets, summarize, describeResult, shouldExitShadow, SHADOW_EXIT, DEFAULT_WINDOW_HOURS } = require('./lib/autonomous-recheck-core.js');

const REPO = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
const MAX_CARDS = 10; // bounded work: this runs every night, not a backfill
// The recheck now runs BEFORE the executor and therefore before the morning
// email. 10 cards x 2 attempts x the 5-minute per-check cap is ~100 minutes of
// worst case sitting in front of the only thing the loop actually delivers, so
// the run gets its own deadline: past it, remaining cards are recorded as
// deferred rather than started (ship-check finding).
const RUN_DEADLINE_MS = 20 * 60 * 1000;

const USAGE = `autonomous-acceptance-recheck.js — re-verify recently-Done cards (shadow mode).

Usage:
  node scripts/autonomous-acceptance-recheck.js [--window-hours 24] [--limit 10]
  node scripts/autonomous-acceptance-recheck.js --dry-run   plan only — no checks run, no ledger write
  node scripts/autonomous-acceptance-recheck.js --help

Re-runs each card's own acceptance-criteria command (captured at dispatch) against a
fresh detached checkout of origin/main. Reports only: no card is ever reopened.`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true;
    else { a[k] = n; i++; }
  }
  return a;
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

// Same shared-task snapshot the triage pass uses for its claim-visibility
// pre-filter, so "someone is working this" means the same thing in both
// places (autonomous-triage.js loadSharedTaskState).
function loadSharedTaskState() {
  const dir = path.join(os.homedir(), '.claude', 'tasks', process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore');
  let notionMap = {};
  try { notionMap = JSON.parse(fs.readFileSync(path.join(dir, '.notion-map.json'), 'utf8')); } catch { /* no map yet */ }
  let files;
  try { files = fs.readdirSync(dir); } catch { return { notionMap: {}, tasksById: {} }; }
  const tasksById = {};
  for (const f of files) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    try { tasksById[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* skip corrupt */ }
  }
  return { notionMap, tasksById };
}

// ONE disposable worktree for the whole run: every card verifies against the
// same origin/main, so N checkouts would be N copies of one tree. Detached —
// it creates no branch and cannot disturb the main checkout's state.
function makeFreshCheckout() {
  // Depth-bound the fetch when REPO is a SHALLOW clone (task #420/#466). This
  // runs from the nightly loop, which is reachable from shallow-checkout
  // workflows; there an unbounded fetch makes upload-pack send the whole
  // ~2.1 GB / 165k-commit repo instead of the delta. Anchor the window on the
  // local boundary commit so `worktree add origin/main` below still resolves.
  // A complete clone (the owner's Mac, the usual case here) gets no extra
  // flags — bounding it would truncate a full clone into a shallow one.
  let isShallow = false;
  try {
    isShallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO, encoding: 'utf8' }).trim() === 'true';
  } catch { /* fail open — treat as complete */ }
  let oldestCommitEpoch = 0;
  if (isShallow) {
    try {
      const sha = execFileSync('git', ['rev-list', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').pop();
      oldestCommitEpoch = Number(execFileSync('git', ['log', '-1', '--format=%ct', sha], { cwd: REPO, encoding: 'utf8' }).trim());
    } catch { /* helper falls back to a bounded --deepen */ }
  }
  const depthArgs = shallowFetchArgs({ isShallow, oldestCommitEpoch });
  // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
  execFileSync('git', ['fetch', ...depthArgs, 'origin', 'main'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-recheck-'));
  const wt = path.join(dir, 'main');
  execFileSync('git', ['worktree', 'add', '--detach', wt, 'origin/main'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  prepareCheckWorkdir(wt, REPO);
  return { dir, wt };
}

function removeCheckout(co) {
  try { execFileSync('git', ['worktree', 'remove', '--force', co.wt], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { /* leave for git worktree prune */ }
  try { fs.rmSync(co.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// One retry, then believe the failure. A transient flake that reported a
// finished card as broken would cost more trust than it saves.
function runVerify(cwd, cmd) {
  const argv = cardCheckArgv(cmd, isSafeCheckCommand);
  if (!argv) return { status: 'unverifiable', detail: `command failed safe-form re-validation at run time: ${String(cmd).slice(0, 120)}` };
  const env = checksEnv();
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      execFileSync(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT_MS, encoding: 'utf8', env });
      return { status: 'pass', detail: attempt > 1 ? 'passed on retry (first run flaked)' : null };
    } catch (err) {
      last = String(err.stderr || err.stdout || err.message).slice(0, 400);
    }
  }
  return { status: 'fail', detail: last };
}

// ── Enforcement gate (S3-T5) ────────────────────────────────────────────────
//
// Enforcement means acting on a failed recheck (reopening the card) instead of
// just reporting it. It is OFF by default and cannot be turned on by config
// alone: the shadow record itself has to clear shouldExitShadow's bar. A flag
// that flips behavior on its own would let a future "just set it to true"
// bypass exactly the evidence this whole shadow phase exists to collect.
function enforcementState(cfg, entries) {
  const requested = cfg && cfg.recheckEnforcement === true;
  if (!requested) return { enforcing: false, requested: false, reason: 'enforcement not requested (default)' };
  const rechecks = entries.filter(e => e.event === 'recheck');
  const first = rechecks.length ? new Date(rechecks[0].ts).getTime() : Date.now();
  const days = (Date.now() - first) / 86400000;
  // falsePositives are recorded by the OWNER, not inferred: a recheck the loop
  // called a failure that turned out to be fine is a human judgment, logged as
  // a 'recheck-false-positive' ledger entry. Nothing self-certifies here.
  const falsePositives = entries.filter(e => e.event === 'recheck-false-positive').length;
  const ok = shouldExitShadow({ days, rechecks: rechecks.length, falsePositives });
  return {
    enforcing: ok, requested: true,
    reason: ok
      ? `shadow record clears the bar (${Math.floor(days)}d, ${rechecks.length} rechecks, ${falsePositives} false positives)`
      : `enforcement requested but the shadow record does not justify it yet (${Math.floor(days)}d, ${rechecks.length} rechecks, ${falsePositives} false positives; needs ${SHADOW_EXIT.minDays}d + ${SHADOW_EXIT.minRechecks} rechecks + 0 false positives)`,
  };
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);
  const dryRun = !!args['dry-run'];
  const windowHours = Number(args['window-hours']) || DEFAULT_WINDOW_HOURS;
  const limit = Math.min(Number(args.limit) || MAX_CARDS, MAX_CARDS);
  const runId = `recheck-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // 100 = Notion's page cap. Under --sort edited the page holds the NEWEST
  // 100 edits, so a burst day would have to edit >100 Done/Paused cards
  // before anything in the window is cut off (Codex finding: 50 was lossier).
  const DONE_LIST_LIMIT = 100;
  let doneCards = [];
  // --sort edited: most-recently-touched cards first. The default Priority
  // sort returns the highest-priority cards EVER, so the cards completed
  // last night were never in the page (2026-07-26 root cause). Paused is
  // included alongside Done (task #695): a deferred-effect fix per /wrap-up's
  // process rule sits in Paused with a RECHECK-AFTER stamp until its own
  // stamp is due — selectRecheckTargets/doneWithinWindow refuse every Paused
  // card that lacks that stamp, so this widening never pulls in ordinary
  // paused backlog work.
  try { doneCards = notionBrain(['list', '--status', 'Done,Paused', '--limit', String(DONE_LIST_LIMIT), '--sort', 'edited']); }
  catch (err) {
    console.error(`[recheck] could not list Done/Paused cards: ${String(err.message).slice(0, 200)}`);
    if (!dryRun) ledger.appendEntry({ event: 'recheck-skip', runId, note: `Notion listing failed: ${String(err.message).slice(0, 200)}` });
    return;
  }

  const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
  const enforcement = enforcementState(cfg, ledger.readEntries().entries || []);
  if (enforcement.requested && !enforcement.enforcing) console.error(`[recheck] ${enforcement.reason}`);
  if (enforcement.enforcing) console.error('[recheck] enforcement is ON — failures will still only be REPORTED until the reopen path ships (carry-forward)');

  // A full page means there may be Done cards we never saw — say so instead of
  // reporting "nothing to re-check" from a truncated list (ship-check finding).
  if (doneCards.length >= DONE_LIST_LIMIT) {
    console.error(`[recheck] WARN the Done listing came back full (${DONE_LIST_LIMIT}) — older Done cards in the window may have been cut off`);
    ledger.appendEntry({ event: 'recheck-truncated', runId, note: `Done listing hit the ${DONE_LIST_LIMIT}-card limit; coverage may be incomplete` });
  }

  const taskState = loadSharedTaskState();
  const targets = selectRecheckTargets({
    doneCards,
    launchEntries: dispatchLedger.readEntries(),
    windowHours,
    isClaimed: cardId => !!findClaimedTask(cardId, taskState),
  }).slice(0, limit);

  console.error(`[recheck] ${targets.length} card(s) marked Done in the last ${windowHours}h have a dispatch record`);
  if (!targets.length) {
    if (!dryRun) ledger.appendEntry({ event: 'recheck-summary', runId, note: 'nothing to re-check', counts: { pass: 0, fail: 0, unverifiable: 0, skipped: 0 } });
    return;
  }
  if (dryRun) {
    for (const t of targets) console.log(`  ${t.cardId} ${t.name} → ${t.skip ? `SKIP (${t.skip})` : (t.verifyCmd || `NOT VERIFIABLE (${t.reason})`)}`);
    return;
  }

  const needsCheckout = targets.some(t => !t.skip && t.verifyCmd);
  let checkout = null;
  if (needsCheckout) {
    try { checkout = makeFreshCheckout(); }
    catch (err) {
      console.error(`[recheck] could not build a fresh main checkout: ${String(err.message).slice(0, 200)}`);
      ledger.appendEntry({ event: 'recheck-skip', runId, note: `fresh checkout failed: ${String(err.message).slice(0, 200)}` });
      return;
    }
  }

  const results = [];
  const deadline = Date.now() + RUN_DEADLINE_MS;
  try {
    for (const t of targets) {
      let r;
      if (Date.now() > deadline && !t.skip) {
        const deferred = targets.slice(targets.indexOf(t)).length;
        console.error(`[recheck] ${RUN_DEADLINE_MS / 60000}min budget spent — deferring ${deferred} card(s) to tomorrow so the morning email is not held up`);
        ledger.appendEntry({ event: 'recheck-deferred', runId, note: `${deferred} card(s) not re-checked: the run hit its ${RUN_DEADLINE_MS / 60000}min budget` });
        break;
      }
      if (t.skip) r = { ...t, status: null };
      else if (!t.verifyCmd) r = { ...t, status: 'unverifiable', detail: t.reason };
      else r = { ...t, ...runVerify(checkout.wt, t.verifyCmd) };
      results.push(r);
      ledger.appendEntry({
        event: 'recheck', runId, cardId: t.cardId, name: t.name,
        // STRUCTURED fields, not just prose: the morning email reads status/
        // skip directly. It used to re-parse the note string, which meant any
        // future wording change silently corrupted the counts the owner sees
        // (ship-check finding). note stays for the human reading the ledger.
        status: r.skip ? null : r.status,
        skip: r.skip || null,
        detail: r.detail ? String(r.detail).slice(0, 300) : null,
        note: `${r.skip ? `skipped: ${r.skip}` : r.status}${r.detail ? `: ${String(r.detail).slice(0, 300)}` : ''}`,
        verifyCmd: t.verifyCmd || null,
        shadow: true,
      });
      console.error(`[recheck] ${describeResult(r)}`);
    }
  } finally {
    if (checkout) removeCheckout(checkout);
  }

  const counts = summarize(results);
  ledger.appendEntry({ event: 'recheck-summary', runId, counts, note: `${counts.pass} still work, ${counts.fail} do not, ${counts.unverifiable} not machine-verifiable, ${counts.skipped} skipped` });
  console.error(`[recheck] done: ${JSON.stringify(counts)}`);
}

if (require.main === module) main();

module.exports = { main, USAGE, parseArgs, loadSharedTaskState, runVerify, makeFreshCheckout, removeCheckout, enforcementState };
