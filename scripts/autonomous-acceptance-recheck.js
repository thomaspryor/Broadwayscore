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
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { findClaimedTask } = require('./lib/autonomous-triage-core.js');
const { CHECK_TIMEOUT_MS } = require('./lib/autonomous-checks.js');
// ONE implementation of "check out origin/main and run the card's command",
// shared with notion-brain.js's close-time verify (task #1003, CLAUDE.md §15).
const { makeFreshCheckout: freshCheckout, removeCheckout, runVerify } = require('./lib/acceptance-check-core.js');
const { selectRecheckTargets, summarize, describeResult, shouldExitShadow, SHADOW_EXIT, DEFAULT_WINDOW_HOURS, needsOverflowHydration } = require('./lib/autonomous-recheck-core.js');

const REPO = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
// A DEDICATED ledger, never the shared data/audit/autonomous-ledger.jsonl
// default (task #695 ship-check finding, verified live): com.broadwayscore.
// autonomous-shadow is still loaded on the Mac Studio and appends shadow-*
// events to that default path every night via a `git fetch && merge
// --ff-only` update step. If this CI-hosted recheck shared that path, CI
// would commit new lines to a file the Mac checkout also has uncommitted
// local writes to — the shadow job's ff-only merge would start failing
// silently every night (falling back to "running with local code" forever,
// per its own plist comment) the first time the two diverged. This path is
// exclusively CI-owned and un-gitignored for exactly that reason.
const RECHECK_LEDGER_PATH = path.join(REPO, 'data', 'audit', 'autonomous-recheck-ledger.jsonl');
const MAX_CARDS = 10; // bounded work: this runs every night, not a backfill
// The recheck now runs BEFORE the executor and therefore before the morning
// email. 10 cards x 2 attempts x the 5-minute per-check cap is ~100 minutes of
// worst case sitting in front of the only thing the loop actually delivers, so
// the run gets its own deadline: past it, remaining cards are recorded as
// deferred rather than started (ship-check finding).
const RUN_DEADLINE_MS = 20 * 60 * 1000;

const USAGE = `autonomous-acceptance-recheck.js — re-verify recently-Done cards (shadow mode).

Usage:
  node scripts/autonomous-acceptance-recheck.js [--window-hours 24] [--limit 10] [--time-budget-min 20]
  node scripts/autonomous-acceptance-recheck.js --dry-run   plan only — no checks run, no ledger write
  node scripts/autonomous-acceptance-recheck.js --help

--time-budget-min caps this run's own wall clock (default 20). Set it below
the HOST's remaining job budget minus margin for its other steps — this
script's own deadline check cannot protect a job-level timeout-minutes that
fires first and kills every step, not just this one.

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

// ── Un-truncating the candidates (2026-08-14) ──────────────────────────────
//
// `list --include-notes` hands back the RAW Notion property, and notion-brain
// caps a property at 1800 chars: past that it stores a preview and puts the
// tail in the page body. `## Acceptance criteria` is written last on this
// repo's cards, so it is the first thing to fall off — 14 of the 18
// RECHECK-AFTER-stamped cards on the live board were truncated, their
// criteria invisible, and every one of them was dropped as "no runnable
// command" by a recheck that had simply never seen the command.
//
// Fixed on THIS side rather than by teaching `list` to stitch, deliberately:
// `get` (notion-brain's loadCard) is already the ONE canonical un-truncation
// path — readFieldWithOverflow, one implementation, used by `get` and by
// audit-card-verifiability.js with this same comment ("every card needs its
// own `get` to see the acceptance-criteria body"). Stitching inside `list`
// would add a second place that knows how, and would cost a page-body fetch
// for EVERY long card in the listing (128 of 200 Done+Paused rows carry the
// marker) on every nightly run. Hydrating here is bounded to the cards that
// actually promise a recheck: 14 today, and only because the stamp itself
// survives truncation (notion-brain hoists it to the front on write), so a
// stamped card is still recognisable from its preview.
//
// Best-effort per card, never fatal — same posture as
// audit-card-verifiability.js's fetchCard: a Notion blip on one card leaves
// that card truncated (exactly as bad as before, no worse) instead of
// sinking the whole night's run.
function hydrateOverflowCards(cards, label) {
  const needy = (cards || []).filter(needsOverflowHydration);
  if (!needy.length) return { cards, hydrated: 0, failed: 0 };
  let hydrated = 0;
  let failed = 0;
  const byId = new Map();
  for (const card of needy) {
    try {
      const full = notionBrain(['get', card.id]);
      byId.set(card.id, { ...card, notes: full.notes, outcome: full.outcome });
      hydrated++;
    } catch (err) {
      console.error(`[recheck] WARN could not re-read ${label} card ${card.id} for its full notes: ${String(err.message).slice(0, 160)}`);
      failed++;
    }
  }
  console.error(`[recheck] re-read ${hydrated}/${needy.length} truncated ${label} card(s) through \`get\` to recover their acceptance criteria${failed ? ` (${failed} failed)` : ''}`);
  return { cards: (cards || []).map(c => byId.get(c.id) || c), hydrated, failed };
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
    const filePath = path.join(dir, f);
    // _mtimeMs feeds findClaimedTask's staleness bound (task #1124) — see
    // autonomous-triage.js loadSharedTaskState for the full rationale.
    try {
      const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      task._mtimeMs = fs.statSync(filePath).mtimeMs;
      tasksById[m[1]] = task;
    } catch { /* skip corrupt */ }
  }
  return { notionMap, tasksById };
}

// One disposable worktree for the whole run, pinned to THIS script's repo
// root: every card verifies against the same origin/main, so N checkouts
// would be N copies of one tree. The body lives in
// scripts/lib/acceptance-check-core.js — see the note on its import above.
function makeFreshCheckout() {
  return freshCheckout({ repo: REPO, prefix: 'auto-recheck-' });
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
  // Kill switch (Codex ship-check finding, task #695): same pattern as
  // BROWSERBASE_KILL_SWITCH — a repo/org Actions variable lets the owner turn
  // this off instantly (a flaky check command wedging the health-check job,
  // an unwanted Notion write pattern) without reverting code or waiting for
  // a PR. `gh variable set ACCEPTANCE_RECHECK_KILL_SWITCH --body true`.
  if (process.env.ACCEPTANCE_RECHECK_KILL_SWITCH === 'true') {
    console.error('[recheck] ACCEPTANCE_RECHECK_KILL_SWITCH is set — skipping this run entirely');
    return;
  }
  const args = parseArgs(argv);
  const dryRun = !!args['dry-run'];
  const windowHours = Number(args['window-hours']) || DEFAULT_WINDOW_HOURS;
  const limit = Math.min(Number(args.limit) || MAX_CARDS, MAX_CARDS);
  const runId = `recheck-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  // Validated up front (ship-check finding): an unparseable/negative value
  // must fail loudly, not silently become NaN — a NaN deadline makes every
  // `Date.now() > deadline` check false forever, defeating the exact safety
  // margin this flag exists to add (the job could then run past its host's
  // timeout). Checked before any Notion I/O so a typo'd flag fails fast.
  let timeBudgetMs = RUN_DEADLINE_MS;
  if (args['time-budget-min'] !== undefined) {
    const parsed = Number(args['time-budget-min']);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`Error: --time-budget-min must be a positive number, got ${JSON.stringify(args['time-budget-min'])}`);
      process.exit(1);
    }
    timeBudgetMs = parsed * 60 * 1000;
  }
  const timeBudgetMinLabel = Math.round(timeBudgetMs / 60000);

  // 100 = Notion's page cap, PER STATUS. Originally one combined
  // `--status Done,Paused` call shared a single 100-card page across both
  // statuses — Done's daily churn (routinely 80-90+ edits/day on this brain)
  // crowded Paused cards out of the page entirely. Found 2026-08-07 (card
  // #1121): the combined page held 89 Done + 11 Paused, so 6 of 7 genuinely
  // stuck Paused P0/P1 cards (overdue RECHECK-AFTER stamps) were invisible to
  // this recheck every single night, no matter how starved they were —
  // selectRecheckTargets' starvation guard only reorders candidates that
  // already made it into the page. Querying each status separately gives
  // Paused its own full page (the brain runs ~30-40 Paused cards total, far
  // under 100), decoupled from however many cards close today.
  const DONE_LIST_LIMIT = 100;
  const PAUSED_LIST_LIMIT = 100;
  let doneCards = [];
  let pausedCards = [];
  // --sort edited: most-recently-touched cards first. The default Priority
  // sort returns the highest-priority cards EVER, so the cards completed
  // last night were never in the page (2026-07-26 root cause). Paused is
  // included alongside Done (task #695): a deferred-effect fix per /wrap-up's
  // process rule sits in Paused with a RECHECK-AFTER stamp until its own
  // stamp is due — selectRecheckTargets/doneWithinWindow refuse every Paused
  // card that lacks that stamp, so this widening never pulls in ordinary
  // paused backlog work.
  // Independent try/catch per status (ship-check finding, 2026-08-07): a
  // shared try/catch around both calls meant a transient failure fetching
  // Paused would discard an already-successful Done fetch (and vice versa),
  // silently reintroducing the crowding-out failure this split exists to fix
  // on any night one of the two calls has a blip.
  let doneErr = null;
  let pausedErr = null;
  try { doneCards = notionBrain(['list', '--status', 'Done', '--limit', String(DONE_LIST_LIMIT), '--sort', 'edited', '--include-notes']); }
  catch (err) { doneErr = err; }
  try { pausedCards = notionBrain(['list', '--status', 'Paused', '--limit', String(PAUSED_LIST_LIMIT), '--sort', 'edited', '--include-notes']); }
  catch (err) { pausedErr = err; }
  if (doneErr && pausedErr) {
    console.error(`[recheck] could not list Done or Paused cards: ${String(doneErr.message).slice(0, 200)}`);
    if (!dryRun) ledger.appendEntry({ event: 'recheck-skip', runId, note: `Notion listing failed for both statuses: ${String(doneErr.message).slice(0, 200)}` }, RECHECK_LEDGER_PATH);
    return;
  }
  if (doneErr) {
    console.error(`[recheck] could not list Done cards, proceeding with Paused only: ${String(doneErr.message).slice(0, 200)}`);
    if (!dryRun) ledger.appendEntry({ event: 'recheck-skip', runId, note: `Done listing failed, Paused still checked: ${String(doneErr.message).slice(0, 200)}` }, RECHECK_LEDGER_PATH);
  }
  if (pausedErr) {
    console.error(`[recheck] could not list Paused cards, proceeding with Done only: ${String(pausedErr.message).slice(0, 200)}`);
    if (!dryRun) ledger.appendEntry({ event: 'recheck-skip', runId, note: `Paused listing failed, Done still checked: ${String(pausedErr.message).slice(0, 200)}` }, RECHECK_LEDGER_PATH);
  }

  const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
  const enforcement = enforcementState(cfg, ledger.readEntries(RECHECK_LEDGER_PATH).entries || []);
  if (enforcement.requested && !enforcement.enforcing) console.error(`[recheck] ${enforcement.reason}`);
  if (enforcement.enforcing) console.error('[recheck] enforcement is ON — failures will still only be REPORTED until the reopen path ships (carry-forward)');

  // A full page means there may be cards we never saw — say so instead of
  // reporting "nothing to re-check" from a truncated list (ship-check finding).
  // `if (!dryRun)` on both appends (2026-08-14): --dry-run documents itself as
  // "plan only — no checks run, no ledger write", and every OTHER append in
  // this function already honours that — these two did not. Caught live while
  // dry-running this fix: four recheck-truncated rows landed in the CI-owned
  // ledger from planning runs that were supposed to write nothing, which is
  // both a dirty working tree for whoever runs it from a worktree and false
  // telemetry (a "coverage may be incomplete" row for a run that never ran).
  if (doneCards.length >= DONE_LIST_LIMIT) {
    console.error(`[recheck] WARN the Done listing came back full (${DONE_LIST_LIMIT}) — older Done cards in the window may have been cut off`);
    if (!dryRun) ledger.appendEntry({ event: 'recheck-truncated', runId, note: `Done listing hit the ${DONE_LIST_LIMIT}-card limit; coverage may be incomplete` }, RECHECK_LEDGER_PATH);
  }
  if (pausedCards.length >= PAUSED_LIST_LIMIT) {
    console.error(`[recheck] WARN the Paused listing came back full (${PAUSED_LIST_LIMIT}) — older Paused cards in the window may have been cut off`);
    if (!dryRun) ledger.appendEntry({ event: 'recheck-truncated', runId, note: `Paused listing hit the ${PAUSED_LIST_LIMIT}-card limit; coverage may be incomplete` }, RECHECK_LEDGER_PATH);
  }
  // Recover the acceptance criteria that Notion's 1800-char property cap cut
  // off, BEFORE anything judges these cards on their notes.
  doneCards = hydrateOverflowCards(doneCards, 'Done').cards;
  pausedCards = hydrateOverflowCards(pausedCards, 'Paused').cards;

  const taskState = loadSharedTaskState();
  // Starvation guard (ship-check finding): a permanently-due RECHECK-AFTER
  // card must not win the same slot every night forever once other cards
  // are also due. Build a per-card "last actually rechecked" timestamp from
  // this dedicated ledger's own history so selectRecheckTargets can put the
  // longest-neglected card first.
  const lastRecheckedByCard = new Map();
  for (const e of ledger.readEntries(RECHECK_LEDGER_PATH).entries || []) {
    if (e.event !== 'recheck' || !e.cardId) continue;
    const t = Date.parse(e.ts || '');
    if (!Number.isFinite(t)) continue;
    const prev = lastRecheckedByCard.get(e.cardId);
    if (prev === undefined || t > prev) lastRecheckedByCard.set(e.cardId, t);
  }
  // Cards in the window that never became targets — no RECHECK-AFTER stamp
  // AND no runnable acceptance criteria. selectRecheckTargets used to drop
  // these with a bare `continue`; they are deliberately not listed card by
  // card (see the drop branch there) but they ARE counted, and the count
  // rides in the summary the morning email renders. A class of card that can
  // disappear between "selected" and "reported" without leaving a number
  // behind is how the truncation bug stayed invisible for weeks.
  const dropped = [];
  const selectFrom = (cards) => selectRecheckTargets({
    doneCards: cards,
    launchEntries: dispatchLedger.readEntries(),
    windowHours,
    isClaimed: cardId => !!findClaimedTask(cardId, taskState),
    lastRecheckedAt: cardId => lastRecheckedByCard.get(cardId) ?? null,
    onDrop: d => dropped.push(d),
  });
  // Selected SEPARATELY per status, then merged with a reserved Paused share,
  // rather than concatenating the two lists and leaning on selectRecheckTargets'
  // starvation-guard sort to keep Paused visible. That sort's tie-break is
  // "never yet rechecked" (lastRecheckedAt ?? -Infinity) — it only favors Paused
  // while every Paused card is still unchecked. The FIRST night a Paused card
  // gets checked, its lastRecheckedAt stops being -Infinity, so it starts losing
  // to whatever still-never-checked Done card closed today — reproducing the
  // exact crowding-out bug one cycle later, since Done churns new never-checked
  // cards daily. Codex ship-check finding, 2026-08-07 (card #1121 follow-up).
  // Reserving half of tonight's slots for Paused makes the guarantee structural:
  // Paused gets real nightly attention regardless of check history, and Done
  // still gets a meaningful, bounded share for its own regression-checking job.
  const pausedTargets = selectFrom(pausedCards);
  const doneTargets = selectFrom(doneCards);
  const pausedShare = Math.min(pausedTargets.length, Math.ceil(limit / 2));
  const seen = new Set();
  const targets = [];
  for (const t of [...pausedTargets.slice(0, pausedShare), ...doneTargets]) {
    if (targets.length >= limit) break;
    // A card could theoretically transition Done<->Paused between the two
    // sequential Notion calls above and land in both lists — dedupe by id.
    if (seen.has(t.cardId)) continue;
    seen.add(t.cardId);
    targets.push(t);
  }

  console.error(`[recheck] ${targets.length} card(s) marked Done in the last ${windowHours}h have a dispatch record`);
  if (dropped.length) {
    console.error(`[recheck] ${dropped.length} card(s) in the window had no RECHECK-AFTER stamp and no runnable acceptance criteria — counted, not checked`);
  }
  if (!targets.length) {
    if (!dryRun) ledger.appendEntry({ event: 'recheck-summary', runId, note: 'nothing to re-check', counts: summarize([], { noCriteria: dropped.length }) }, RECHECK_LEDGER_PATH);
    return;
  }
  if (dryRun) {
    for (const t of targets) console.log(`  ${t.cardId} ${t.name} → ${t.skip ? `SKIP (${t.skip})` : (t.verifyCmd || `NOT VERIFIABLE (${t.reason})`)}`);
    for (const d of dropped) console.log(`  DROPPED ${d.cardId} ${d.name} → ${d.reason}`);
    return;
  }

  const needsCheckout = targets.some(t => !t.skip && t.verifyCmd);
  let checkout = null;
  if (needsCheckout) {
    try { checkout = makeFreshCheckout(); }
    catch (err) {
      console.error(`[recheck] could not build a fresh main checkout: ${String(err.message).slice(0, 200)}`);
      ledger.appendEntry({ event: 'recheck-skip', runId, note: `fresh checkout failed: ${String(err.message).slice(0, 200)}` }, RECHECK_LEDGER_PATH);
      return;
    }
  }

  const results = [];
  const deadline = Date.now() + timeBudgetMs;
  try {
    for (const t of targets) {
      let r;
      if (Date.now() > deadline && !t.skip) {
        const deferred = targets.slice(targets.indexOf(t)).length;
        console.error(`[recheck] ${timeBudgetMinLabel}min budget spent — deferring ${deferred} card(s) to tomorrow so the morning email is not held up`);
        ledger.appendEntry({ event: 'recheck-deferred', runId, note: `${deferred} card(s) not re-checked: the run hit its ${timeBudgetMinLabel}min budget` }, RECHECK_LEDGER_PATH);
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
      }, RECHECK_LEDGER_PATH);
      console.error(`[recheck] ${describeResult(r)}`);
    }
  } finally {
    if (checkout) removeCheckout(checkout);
  }

  const counts = summarize(results, { noCriteria: dropped.length });
  ledger.appendEntry({ event: 'recheck-summary', runId, counts, note: `${counts.pass} still work, ${counts.fail} do not, ${counts.unverifiable} not machine-verifiable, ${counts.skipped} skipped, ${counts.noCriteria} had no criteria to check` }, RECHECK_LEDGER_PATH);
  console.error(`[recheck] done: ${JSON.stringify(counts)}`);
}

if (require.main === module) main();

module.exports = { main, USAGE, parseArgs, loadSharedTaskState, runVerify, makeFreshCheckout, removeCheckout, enforcementState };
