#!/usr/bin/env node
/**
 * autonomous-acceptance-recheck.js — independently re-verify cards that were
 * marked Done (Sprint 3, S3-T2). Reports by default. BRO-7697: once enforcementState()
 * clears the shadow bar, a Done card whose own check fails on fresh main is REOPENED
 * (Done -> Todo, evidence comment, cap 5/night, max 2 reopens then parked; kill switch
 * RECHECK_REOPEN=off). Rules: scripts/lib/recheck-reopen.js.
 * BRO-6240 (owner decision 2026-10-25): with --autoclose (or the repo variable
 * RECHECK_AUTOCLOSE=true) it also CLOSES an open stamped card whose real test
 * passed on fresh origin/main, with an evidence comment (command, commit, run
 * URL). Failures are still only reported. Rules: decideAutoClose in
 * scripts/lib/autonomous-recheck-core.js.
 *
 *   node scripts/autonomous-acceptance-recheck.js            # normal nightly run
 *   node scripts/autonomous-acceptance-recheck.js --dry-run  # plan only, no ledger write
 *   node scripts/autonomous-acceptance-recheck.js --autoclose [--backlog]
 *   node scripts/autonomous-acceptance-recheck.js --ids BRO-1,BRO-2  also re-check these cards whatever their age (BRO-7559)
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
 *     the morning email. The only Linear write is the BRO-6240 auto-close above.
 *     Enforcement (auto-reopening a failed card) stays off
 *     until the shadow record clears an objective bar — see
 *     scripts/lib/autonomous-recheck-core.js shouldExitShadow (now wired: reopenMode in recheck-reopen.js).
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

const { hasHelpFlag } = require('./lib/cli-help.js');
const { redactEmails } = require('./lib/pii-scan.js');
const ledger = require('./lib/autonomous-ledger.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { findClaimedTask } = require('./lib/autonomous-triage-core.js');
const { CHECK_TIMEOUT_MS } = require('./lib/autonomous-checks.js');
// ONE implementation of "check out origin/main and run the card's command",
// shared with notion-brain.js's close-time verify (task #1003, CLAUDE.md §15).
const { makeFreshCheckout: freshCheckout, removeCheckout, runVerify } = require('./lib/acceptance-check-core.js');
const { selectRecheckTargets, summarize, decideAutoClose, describeResult, shouldExitShadow, SHADOW_EXIT, DEFAULT_WINDOW_HOURS } = require('./lib/autonomous-recheck-core.js');
// Linear candidate source (BRO-3373), the only source since BRO-3488 removed
// the frozen Notion mirror's leg (mirror froze 2026-08-20, CLAUDE.md §6).
const { closeCardAfterPass } = require('./lib/recheck-autoclose.js');
const { decideHandoff, handoffCard } = require('./lib/recheck-handoff.js');
const reopenLib = require('./lib/recheck-reopen.js');
const { routeMode, heldForOwner, buildRouteBatch, fileRouteBatch, buildCoverIndex, coveredBy, selectRewatchTargets, refreshRewatchTargets, MAX_REWATCH } = require('./lib/recheck-route.js');
const { verifiabilityForCard } = require('./lib/autonomous-recheck-core.js');
const { mapIssueToCard } = require('./lib/linear-recheck-source.js');
const { fetchLinearRecheckCandidates, fetchRecentlyCompletedLinearCandidates, fetchLinearIssuesByIdentifier } = require('./lib/linear-recheck-source.js');
const { resolveStaleCheck, isWholeSuiteCommand, applyMovedResult } = require('./lib/stale-check-path.js');
const { causeOfRecheckRow, retryCandidateIds, stillDoneCards } = require('./lib/recheck-retry.js');

const linearClient = require('./lib/linear-client.js');
const REPO = path.join(__dirname, '..');
// --backlog doubles as the shadow-era backfill: rewatch looks back to the first recheck of the report-only weeks.
const BACKFILL_SINCE = '2026-10-15';
const MAX_REROUTES_LABEL = require('./lib/recheck-route.js').MAX_REROUTES;
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
// BRO-6853: 10/night left 15 of 28 due cards never rechecked. The run's own time budget
// (--time-budget-min, deferral at MIN_REMAINING_MS_TO_START) is the real bound; this cap only
// stops a runaway list. Cards with no runnable test cost no checkout and are exempt (below).
const MAX_CARDS = 30;
// Hand-offs are Linear writes (a comment plus a state move) inside a shared CI step: cap them per night.
const MAX_HANDOFFS = 25;
// BRO-7559: slots on top of the cap for Done cards whose last recheck had no verdict.
const RETRY_SLOTS = 6;
// --backlog (BRO-6240): a manual one-off to clear the due backlog; the nightly run never sets it.
const MAX_CARDS_BACKLOG = 80;
// Below this much budget left, starting another check is worse than deferring
// it: the check would be SIGTERMed mid-flight and reported 'unverifiable',
// which the morning digest renders as "no way to check this automatically" —
// a false statement about the CARD rather than an honest "ran out of time".
// Matches the MIN_REMAINING_MS_TO_START shape used by the other time-budgeted
// scripts here (reconcile-recoupment-claims.js, deep-research-commercial.js).
const MIN_REMAINING_MS_TO_START = 60 * 1000;
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
  node scripts/autonomous-acceptance-recheck.js --autoclose close open stamped cards whose real test passed (also RECHECK_AUTOCLOSE=true; RECHECK_AUTOCLOSE_DISABLED=true turns it off)
  node scripts/autonomous-acceptance-recheck.js --route-dry-run  print the batch card the LAST run's real failures route to (BRO-7138); no writes
  node scripts/autonomous-acceptance-recheck.js --ids BRO-1,BRO-2  also re-check these Done cards whatever their age (BRO-7559)
  node scripts/autonomous-acceptance-recheck.js --backlog   raise the card cap to ${MAX_CARDS_BACKLOG} for a one-off sweep (use a larger --time-budget-min)
  node scripts/autonomous-acceptance-recheck.js --help

--time-budget-min caps this run's own wall clock (default 20). Set it below
the HOST's remaining job budget minus margin for its other steps — this
script's own deadline check cannot protect a job-level timeout-minutes that
fires first and kills every step, not just this one.

Re-runs each card's own acceptance-criteria command (captured at dispatch) against a
fresh detached checkout of origin/main. A failing Done card is reopened only when enforcementState allows (BRO-7697); with --autoclose a
passed, stamped, still-open card with a real test is closed with an evidence comment.`;

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

// BRO-7138 part 3: tonight's real failures (not env, not handed off, not
// routed before) go to ONE worker card. Shadow until RECHECK_ROUTE_FROM: the
// ledger row says what it would have filed. Never throws: routing is a side
// channel and must not cost the night's summary row.
async function routeRealFailures({ runId, results, handedOff, held = [], sha = null, env = process.env, now = Date.now(), file = fileRouteBatch, coverIndex = null, maxBatches = 1 } = {}) {
  try {
    const mode = routeMode({ env, now });
    if (mode.mode === 'off') { console.error('[recheck] routing off (RECHECK_ROUTE=off)'); return null; }
    // Stamp the commit (rows with a sha key keep their write-time env verdict,
    // check-env-cause.js) and redact emails before any output reaches a card.
    const rows = (results || []).map((r) => ({ ...r, sha, detail: r.detail ? redactEmails(String(r.detail)) : r.detail, note: r.note ? redactEmails(String(r.note)) : r.note }));
    // BRO-7557: a backlog sweep can fail more cards than one batch holds; each filed batch's cards
    // join the hand-off list so the next pass builds the next batch from the rest.
    const done = [...(handedOff || [])];
    let last = null;
    for (let i = 0; i < Math.max(1, maxBatches); i++) {
      const batch = buildRouteBatch({ rows, handedOff: done, held, sha, ledgerEntries: ledger.readEntries(RECHECK_LEDGER_PATH).entries || [], now, coverIndex });
      if (!batch.title) break;
      const cardIds = batch.cards.map((c) => c.cardId);
      let out = { filed: false, identifier: null, error: null };
      if (mode.mode === 'live') out = await file({ title: batch.title, body: batch.body });
      ledger.appendEntry({ event: 'recheck-route', runId, mode: mode.mode, filed: out.filed, ...(out.maybeFiled ? { maybeFiled: true } : {}), identifier: out.identifier, cardIds, overflow: batch.overflow, skipped: batch.skipped, note: mode.mode === 'shadow' ? `would file "${batch.title}" (${mode.why})` : out.filed ? `filed ${out.identifier}` : `route refused: ${out.error}` }, RECHECK_LEDGER_PATH);
      console.error(`[recheck] route (${mode.mode}): ${cardIds.length} card(s)${out.identifier ? ` -> ${out.identifier}` : ''}${out.error ? ` refused: ${out.error}` : ''}`);
      last = { mode: mode.mode, ...out, cardIds };
      if (mode.mode !== 'live' || !out.filed) break; // shadow/refused: do not loop on the same cards
      done.push(...cardIds);
    }
    return last;
  } catch (err) {
    console.error(`[recheck] route skipped: ${String(err && err.message || err).slice(0, 200)}`);
    return null;
  }
}

async function printRouteDryRun() {
  const entries = ledger.readEntries(RECHECK_LEDGER_PATH).entries || [];
  const lastRun = [...entries].reverse().find((e) => e && e.event === 'recheck' && e.runId);
  if (!lastRun) { console.log('No recheck rows in the ledger yet.'); return; }
  const rows = entries.filter((e) => e && e.event === 'recheck' && e.runId === lastRun.runId);
  const handedOff = entries.filter((e) => e && e.event === 'recheck-handoff' && e.runId === lastRun.runId && e.handedOff).map((e) => e.cardId);
  const before = entries.filter((e) => e && e.ts < (rows[0] && rows[0].ts || ''));
  const mode = routeMode();
  const sha = (rows.find((r) => r.sha) || {}).sha || null;
  // BRO-8403: apply the live run's owner-hold rule too. Read-only Linear fetch; on failure the
  // preview says so and holds nothing back (it can only over-report, never hide a regression).
  let held = [];
  const failIds = [...new Set(rows.filter((r) => r.status === 'fail' && r.cardId).map((r) => r.cardId))];
  if (failIds.length) {
    const got = await fetchLinearIssuesByIdentifier(null, failIds).catch((e) => ({ cards: [], error: String(e && e.message || e) }));
    if (got.error) console.log(`(could not read the failing cards from Linear, owner holds not applied: ${got.error})`);
    held = heldForOwner(rows, new Map((got.cards || []).map((c) => [c.id, c])));
  }
  const batch = buildRouteBatch({ rows, handedOff, held, sha, ledgerEntries: before });
  console.log(`Run ${lastRun.runId}: ${rows.length} rechecked; mode tonight: ${mode.mode} (${mode.why})`);
  console.log(`Not routed: ${batch.skipped.env} could not run here, ${batch.skipped.handedOff} handed off, ${batch.skipped.held || 0} held for the owner, ${batch.skipped.routed} routed before, ${batch.skipped.coveredOpen} covered by an open card, ${batch.skipped.exhausted} retried the maximum times`);
  if (!batch.title) { console.log('Nothing to route.'); return; }
  console.log(`\nTITLE: ${batch.title}\n\n${batch.body}`);
}

async function main(argv = process.argv.slice(2)) {
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
  if (args['route-dry-run']) { await printRouteDryRun(); return; }
  const dryRun = !!args['dry-run'];
  const windowHours = Number(args['window-hours']) || DEFAULT_WINDOW_HOURS;
  // RECHECK_AUTOCLOSE_DISABLED (repo variable) is the off switch, like ACCEPTANCE_RECHECK_KILL_SWITCH:
  // no code change needed to stop closing cards.
  const autoclose = (!!args.autoclose || process.env.RECHECK_AUTOCLOSE === 'true') && process.env.RECHECK_AUTOCLOSE_DISABLED !== 'true';
  // RECHECK_HANDOFF_DISABLED=true (repo variable) stops the worker hand-offs without a code change.
  const handoffOn = process.env.RECHECK_HANDOFF_DISABLED !== 'true';
  const maxCards = args.backlog ? MAX_CARDS_BACKLOG : MAX_CARDS;
  const limit = Math.min(Number(args.limit) || maxCards, maxCards);
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

  // BRO-3488: Linear is the only candidate source. The Notion leg (Done +
  // Paused listings through notion-brain.js, plus overflow re-reads) was
  // removed: the Notion mirror froze 2026-08-20 (CLAUDE.md section 6), so it
  // could only ever re-surface stale frozen cards, and it kept a live
  // schedule (data-health-check.yml) coupled to the retired board.
  // BRO-3469: `doneCards` is fed by a separate, completedAt-bounded Linear
  // query (fetched after the non-terminal one below). When it is empty or
  // switched off, the Paused share widens to the whole limit.
  let doneCards = [];
  let pausedCards = [];
  // fetchLinearRecheckCandidates never throws; this try/catch is a backstop
  // for a genuinely unexpected bug, not the expected failure paths (auth,
  // network, timeout), which it reports via the returned `error` field.
  try {
    const linearResult = await fetchLinearRecheckCandidates();
    pausedCards = linearResult.cards;
    if (linearResult.error) {
      console.error(`[recheck] Linear candidate fetch failed: ${linearResult.error}`);
      if (!dryRun) ledger.appendEntry({ event: 'recheck-skip', runId, note: `Linear listing failed: ${linearResult.error}` }, RECHECK_LEDGER_PATH);
      return;
    }
    if (linearResult.truncated) {
      // A fetch that silently stops growing is exactly BRO-3373's own
      // failure shape, so it is reported, never swallowed.
      console.error('[recheck] WARN the Linear listing was truncated (page/deadline cap) — some candidates may be missing');
      if (!dryRun) ledger.appendEntry({ event: 'recheck-truncated', runId, note: 'Linear listing hit its page/deadline cap; coverage may be incomplete' }, RECHECK_LEDGER_PATH);
    }
  } catch (err) {
    console.error(`[recheck] could not list Linear candidates: ${String(err.message).slice(0, 200)}`);
    if (!dryRun) ledger.appendEntry({ event: 'recheck-skip', runId, note: `Linear listing failed: ${String(err.message).slice(0, 200)}` }, RECHECK_LEDGER_PATH);
    return;
  }
  console.error(`[recheck] ${pausedCards.length} Linear issue(s) fetched as recheck candidates`);

  // BRO-3469: recently completed Linear cards. Isolated from the fetch above
  // on purpose: a failure here is reported and leaves doneCards empty, it
  // never discards the non-terminal candidates or ends the run.
  try {
    const completed = await fetchRecentlyCompletedLinearCandidates(null, { windowHours });
    if (completed.skipped) {
      console.error('[recheck] completed Linear cards skipped (RECHECK_INCLUDE_COMPLETED_LINEAR=0)');
    } else {
      doneCards = completed.cards;
      if (completed.error) {
        console.error(`[recheck] WARN completed-card fetch failed: ${completed.error} (keeping ${doneCards.length} fetched before the failure)`);
        if (!dryRun) ledger.appendEntry({ event: 'recheck-truncated', runId, note: `Linear completed listing failed: ${completed.error}` }, RECHECK_LEDGER_PATH);
      } else if (completed.truncated) {
        console.error('[recheck] WARN the completed-card listing was truncated (page/deadline cap) — some Done cards may be missing');
        if (!dryRun) ledger.appendEntry({ event: 'recheck-truncated', runId, note: 'Linear completed listing hit its page/deadline cap; coverage may be incomplete' }, RECHECK_LEDGER_PATH);
      }
      console.error(`[recheck] ${doneCards.length} Linear issue(s) completed in the last ${windowHours}h (+24h slack) fetched as Done candidates`);
    }
  } catch (err) {
    console.error(`[recheck] WARN could not list completed Linear cards: ${String(err.message).slice(0, 200)}`);
  }

  const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
  const enforcement = enforcementState(cfg, ledger.readEntries(RECHECK_LEDGER_PATH).entries || []);
  if (enforcement.requested && !enforcement.enforcing) console.error(`[recheck] ${enforcement.reason}`);
  if (enforcement.enforcing) console.error('[recheck] enforcement is ON — a failing Done card is reopened (cap and kill switch: scripts/lib/recheck-reopen.js)');

  const cardsById = new Map([...pausedCards, ...doneCards].map(c => [c.id, c]));
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
  // Paused is guaranteed half the slots, and also gets whatever Done does
  // not use (one Done target must not leave four slots empty, BRO-3469).
  const pausedIds = new Set(pausedTargets.map(t => t.cardId));
  const doneOnly = doneTargets.filter(t => !pausedIds.has(t.cardId)).length;
  const pausedShare = Math.min(pausedTargets.length, Math.max(Math.ceil(limit / 2), limit - doneOnly));
  const seen = new Set();
  const targets = [];
  for (const t of [...pausedTargets.slice(0, pausedShare), ...doneTargets]) {
    if (targets.length >= limit) break;
    // Defensive: never run the same card twice if it appears in both buckets.
    if (seen.has(t.cardId)) continue;
    seen.add(t.cardId);
    targets.push(t);
  }
  // BRO-7559: Done cards whose last recheck had no verdict (test not landed
  // yet, alert ledger behind, out of budget) left the completion window after
  // ONE try. Re-fetch them by id and re-check them inside tonight's cap.
  // --ids names cards explicitly (a manual sweep); otherwise the ledger picks.
  {
    const explicit = typeof args.ids === 'string' ? args.ids.split(',').map((x) => x.trim()).filter(Boolean) : [];
    const retryIds = explicit.length ? explicit : retryCandidateIds(ledger.readEntries(RECHECK_LEDGER_PATH).entries || [], { backlog: !!args.backlog, exclude: seen });
    // A reserved share on top of the cap, not inside it: on a busy night the
    // in-window cards fill all `limit` slots and a retry would never run.
    const retryCap = limit + (explicit.length ? explicit.length : RETRY_SLOTS);
    if (retryIds.length) {
      const got = await fetchLinearIssuesByIdentifier(null, retryIds.filter((id) => !seen.has(id)));
      if (got.error) console.error(`[recheck] WARN retry fetch failed: ${got.error}`);
      // Fetched by id, so the card may have been reopened since: only a card
      // still Done is a done claim to re-check (a reopened one is being worked).
      const stillDone = stillDoneCards(got.cards);
      for (const c of stillDone) cardsById.set(c.id, c);
      const retryTargets = selectRecheckTargets({
        doneCards: stillDone,
        launchEntries: dispatchLedger.readEntries(),
        windowHours: 24 * 3650, // age is bounded by retryCandidateIds, not the completion window
        isClaimed: (cardId) => !!findClaimedTask(cardId, taskState),
        lastRecheckedAt: (cardId) => lastRecheckedByCard.get(cardId) ?? null,
        onDrop: () => {},
      });
      for (const t of retryTargets) {
        if (targets.length >= retryCap) break;
        if (seen.has(t.cardId)) continue;
        seen.add(t.cardId);
        targets.push({ ...t, retry: true });
      }
      console.error(`[recheck] ${retryTargets.length} earlier no-verdict card(s) re-selected (${explicit.length ? '--ids' : 'retry'})`);
    }
  }
  // BRO-6853: a due Paused/Backlog card with no runnable test costs no checkout, so the cap must not
  // leave it out: it is either handed to a worker tonight or at least gets a ledger row.
  for (const t of pausedTargets) {
    if (seen.has(t.cardId) || t.skip || t.verifyCmd) continue;
    seen.add(t.cardId);
    targets.push(t);
  }

  // BRO-7557: a Done card is rechecked on one night only, so a failure (shadow era, or one that
  // outlived its route card) never came back. Re-run cards whose latest recheck is a real fail
  // and that nothing covers: no open card names them and no live route is inside the retry
  // window. --backlog (the CI one-shot sweep) is also the backfill: every such card since 2026-10-15.
  let coverIndex = null;
  try {
    coverIndex = buildCoverIndex(await linearClient.listOpenIssuesWithDescriptions());
  } catch (err) {
    console.error(`[recheck] open-card index unavailable (${String(err.message).slice(0, 120)}); rewatch and routing use the long dedupe window`);
  }
  const rewatchSince = args.backlog ? BACKFILL_SINCE : new Date(Date.now() - 30 * 86400000).toISOString();
  const picked = selectRewatchTargets({ ledgerEntries: ledger.readEntries(RECHECK_LEDGER_PATH).entries || [], limit: args.backlog ? MAX_CARDS_BACKLOG : MAX_REWATCH, since: rewatchSince, exclude: [...seen], coverIndex });
  if (picked.exhausted.length) console.error(`[recheck] rewatch gave up on ${picked.exhausted.length} card(s) already routed ${MAX_REROUTES_LABEL}x: ${picked.exhausted.join(', ')}`);
  if (picked.targets.length) {
    const fresh = await refreshRewatchTargets(picked.targets, { getIssue: linearClient.getIssue, toCard: mapIssueToCard, gateFor: verifiabilityForCard });
    for (const d of fresh.dropped) console.error(`[recheck] rewatch skips ${d.cardId}: ${d.why}`);
    for (const t of fresh.targets) { seen.add(t.cardId); targets.push(t); }
    console.error(`[recheck] rewatch: ${fresh.targets.length} still-failing card(s) re-run (${fresh.dropped.length} dropped)`);
  }

  // Free (no-test) targets first: they cost no checkout, so a spent budget must never be what drops them.
  targets.sort((a, b) => (a.skip || a.verifyCmd ? 1 : 0) - (b.skip || b.verifyCmd ? 1 : 0));
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

  // The deadline starts BEFORE the checkout, not after it (BRO-3434
  // ship-check finding). makeFreshCheckout allows up to 120s per git call, and
  // starting the clock afterwards spent all of that outside the budget the
  // step timeout is sized against. It also used to fire only on nights that
  // already had an armed card; now that the verifyCmd fallback arms more of
  // them, it fires on nights that previously did no work at all.
  const deadline = Date.now() + timeBudgetMs;

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
  const closed = [];
  const keptOpen = [];
  const handedOff = [];
  // BRO-7697: reopen a Done card whose own check fails on fresh main. Live only once enforcementState
  // clears the shadow bar; RECHECK_REOPEN=off stops it with no code change. The cap is counted from the
  // ledger so a manual --backlog run and the nightly run share ONE budget.
  const reopenEntries = ledger.readEntries(RECHECK_LEDGER_PATH).entries || [];
  const reopenSt = reopenLib.reopenMode({ enforcement: enforcementState(cfg, reopenEntries) });
  const reopenCounts = reopenLib.reopenCounts(reopenEntries);
  const reopenParked = reopenLib.parkedIds(reopenEntries);
  const queued = [];
  let reopenBudget = Math.max(0, reopenLib.reopenCap() - reopenLib.reopenedWithin(reopenEntries));
  const reopened = [];
  const parked = [];
  console.error(`[recheck] reopen: ${reopenSt.mode} (${reopenSt.why}); budget tonight ${reopenBudget}`);
  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  try {
    for (const t of targets) {
      let r;
      // Stop when there is not enough budget LEFT TO FINISH a check, not once
      // the budget is already blown (BRO-3434 ship-check finding). The old
      // `Date.now() > deadline` test let a card start with one second left and
      // then run for up to 2 x CHECK_TIMEOUT_MS = 10 minutes, inside a job
      // whose step timeout is 8 (data-health-check.yml). Overrunning is worse
      // than deferring: that step's own comment records that a hard kill drops
      // mid-run with NO ledger write at all, losing every result already
      // computed, whereas a deferred card is simply re-checked tomorrow. This
      // was survivable while nearly every target was 'unverifiable' and cost
      // zero runtime; the verifyCmd fallback above arms real commands, so the
      // unbounded case stopped being hypothetical.
      // Folded into THIS branch, deliberately, rather than added as a second
      // per-card skip: the existing branch is what emits the single
      // 'recheck-deferred' row, and a separate path that dropped a card
      // without one would recreate exactly the silent drop this file's big
      // comment says was already fixed once.
      const remainingMs = deadline - Date.now();
      if (!t.skip && t.verifyCmd && remainingMs < MIN_REMAINING_MS_TO_START) {
        const deferred = targets.slice(targets.indexOf(t)).length;
        console.error(`[recheck] ${timeBudgetMinLabel}min budget spent — deferring ${deferred} card(s) to tomorrow so the morning email is not held up`);
        // cardIds (BRO-7559): a Done card leaves its completion window, so
        // "re-checked tomorrow" only holds if the retry pass can find it.
        ledger.appendEntry({ event: 'recheck-deferred', runId, cardIds: targets.slice(targets.indexOf(t)).filter((x) => !x.skip && x.verifyCmd).map((x) => x.cardId), note: `${deferred} card(s) not re-checked: the run hit its ${timeBudgetMinLabel}min budget` }, RECHECK_LEDGER_PATH);
        break;
      }
      let closeRefused = null;
      if (t.skip) r = { ...t, status: null };
      else if (!t.verifyCmd) r = { ...t, status: 'unverifiable', detail: t.reason };
      // Halve the remaining budget so BOTH attempts fit inside it. The retry
      // is kept rather than dropped to attempts:1 (ship-check finding): a
      // spurious fail is not merely reported — dispatch-watchdog raises it in
      // the owner's NEEDS-YOU banner, and each one the owner judges wrong is
      // logged as a recheck-false-positive, which permanently blocks shadow
      // exit (maxFalsePositives: 0). Absorbing a flake is worth more than the
      // extra wall-clock.
      // BRO-7559: the whole unit suite proves nothing about one card and never
      // fits the nightly budget (7 of 8 recheck timeouts): report it as a stale
      // check to rewrite instead of starting it and SIGTERMing it.
      else if (isWholeSuiteCommand(t.verifyCmd)) r = { ...t, status: 'unverifiable', cause: 'whole-suite', detail: 'check is the whole unit suite, not this card\'s test: rewrite the VERIFY to name the test the claim rests on' };
      else {
        // BRO-7559: a path absent from main is a stale check (moved, never
        // landed, other repo), never "the fix broke". A uniquely moved test is
        // re-pointed and run; the pass then cannot auto-close (decideAutoClose).
        const stale = checkout.prepared ? resolveStaleCheck(checkout.wt, t.verifyCmd) : { kind: 'ok' };
        if (stale.kind === 'missing') r = { ...t, status: 'unverifiable', cause: 'missing-path', missingPath: true, detail: stale.detail };
        else {
          const cmd = stale.kind === 'moved' ? stale.cmd : t.verifyCmd;
          r = { ...t, ...runVerify(checkout.wt, cmd, { timeoutMs: Math.min(CHECK_TIMEOUT_MS, Math.floor(remainingMs / 2)), prepared: checkout.prepared, unpreparedReason: checkout.unpreparedReason }) };
          if (stale.kind === 'moved') r = applyMovedResult(r, stale, cmd);
        }
      }
      if (r.status === 'unverifiable' && !r.cause) r.cause = causeOfRecheckRow(r);
      results.push(r);
      ledger.appendEntry({
        event: 'recheck', runId, cardId: t.cardId, name: t.name,
        // STRUCTURED fields, not just prose: the morning email reads status/
        // skip directly. It used to re-parse the note string, which meant any
        // future wording change silently corrupted the counts the owner sees
        // (ship-check finding). note stays for the human reading the ledger.
        status: r.skip ? null : r.status,
        skip: r.skip || null,
        detail: r.detail ? redactEmails(String(r.detail).slice(0, 300)) : null,
        note: `${r.skip ? `skipped: ${r.skip}` : r.status}${r.detail ? `: ${redactEmails(String(r.detail).slice(0, 300))}` : ''}`,
        verifyCmd: t.verifyCmd || null,
        // BRO-7559: structured no-verdict cause (missing-path | exit3 | exit3-no-ledger | timeout | whole-suite),
        // the command actually run when a moved test was re-pointed, and whether this was a retry.
        ...(r.cause ? { cause: r.cause } : {}),
        ...(r.ranCmd ? { ranCmd: r.ranCmd } : {}),
        ...(t.retry ? { retry: true } : {}),
        // BRO-7138: the fresh-main commit this ran on, so a routed failure names it.
        sha: (checkout && checkout.sha) || null,
        // BRO-7138: set when the check failed on something this machine
        // withholds by design (check-env-cause.js); status is then unverifiable.
        ...(r.envCause ? { envCause: r.envCause } : {}),
        shadow: true,
      }, RECHECK_LEDGER_PATH);
      console.error(`[recheck] ${describeResult(r)}`);

      // BRO-6240: close a card whose real test just passed. Decision is pure
      // (decideAutoClose); the close goes through linear-brain's Done gate.
      if (autoclose && !t.rewatch && !r.skip && r.status === 'pass' && deadline - Date.now() >= MIN_REMAINING_MS_TO_START) {
        const verdict = decideAutoClose({ card: cardsById.get(t.cardId), target: t, result: r });
        if (!verdict.close) {
          keptOpen.push({ cardId: t.cardId, reason: verdict.reason });
          console.error(`[recheck] ${t.cardId} stays open: ${verdict.reason}`);
        } else {
          const out = await closeCardAfterPass({ identifier: t.cardId, expectStateType: (cardsById.get(t.cardId) || {}).stateType, cmd: t.verifyCmd, sha: checkout && checkout.sha, runUrl });
          if (out.closed) closed.push(t.cardId); else { keptOpen.push({ cardId: t.cardId, reason: out.error }); closeRefused = out.error; }
          ledger.appendEntry({ event: 'recheck-autoclose', runId, cardId: t.cardId, name: t.name, closed: out.closed, verifyCmd: t.verifyCmd, sha: (checkout && checkout.sha) || null, runUrl, note: out.closed ? 'closed on a passing real test' : `close refused: ${out.error}` }, RECHECK_LEDGER_PATH);
          console.error(`[recheck] ${t.cardId} ${out.closed ? 'CLOSED' : `close refused (${out.error})`}`);
        }
      }

      // BRO-6853: a due card nothing above closed goes to a worker (decideHandoff is idempotent).
      if (handoffOn && !t.rewatch && handedOff.length < MAX_HANDOFFS && (!t.verifyCmd || deadline - Date.now() >= MIN_REMAINING_MS_TO_START)) {
        const card = cardsById.get(t.cardId);
        const closeVerdict = !r.skip && r.status === 'pass' ? decideAutoClose({ card, target: t, result: r }) : null;
        const h = decideHandoff({ card, target: t, result: r, closeVerdict, closeRefused });
        if (h.handoff) {
          const out = await handoffCard({ identifier: t.cardId, why: h.why });
          if (out.handedOff) handedOff.push(t.cardId);
          ledger.appendEntry({ event: 'recheck-handoff', runId, cardId: t.cardId, name: t.name, reason: h.reason, handedOff: out.handedOff, verifyCmd: t.verifyCmd || null, note: out.handedOff ? `handed to a worker: ${h.reason}${out.unparkError ? `; PARKED line not cleared: ${out.unparkError}` : ''}` : `handoff refused: ${out.error}` }, RECHECK_LEDGER_PATH);
          console.error(`[recheck] ${t.cardId} ${out.handedOff ? `handed to a worker (${h.reason})` : `handoff refused (${out.error})`}`);
        }
      }

      // BRO-7697: a Done card whose own check just failed on fresh main goes back to a worker.
      if (reopenSt.mode !== 'off' && !r.skip && r.status === 'fail' && (t.rewatch || (cardsById.get(t.cardId) || {}).stateType === 'completed') && !dryRun) {
        const row = { ...r, cardId: t.cardId, verifyCmd: t.verifyCmd, sha: (checkout && checkout.sha) || null };
        // No cover index (Linear list failed) means we cannot tell whether an open card owns it: do not reopen.
        const cov = !coverIndex ? 'cover index unavailable' : coverIndex.has(t.cardId) ? coveredBy(t.cardId, { coverIndex }) : null;
        const d = reopenLib.decideReopen({ row, reopenCount: reopenCounts.get(t.cardId) || 0, parked: reopenParked.has(t.cardId), covered: cov });
        const base = { event: 'recheck-reopen', runId, cardId: t.cardId, name: t.name, verifyCmd: t.verifyCmd, sha: row.sha, runUrl, mode: reopenSt.mode };
        if (d.action === 'reopen' || d.action === 'park') {
          const isPark = d.action === 'park';
          if (!isPark && reopenBudget <= 0) {
            ledger.appendEntry({ ...base, action: 'queued', ok: false, note: `over the ${reopenLib.reopenCap()}/night cap; stays Done, rewatch picks it up on a later night` }, RECHECK_LEDGER_PATH);
            queued.push(t.cardId); // keep it out of tonight's batch card so a later night can still reopen it
          } else if (reopenSt.mode === 'shadow') {
            ledger.appendEntry({ ...base, action: isPark ? 'would-park' : 'would-reopen', ok: false, note: `shadow: ${d.reason} (${reopenSt.why})` }, RECHECK_LEDGER_PATH);
            console.error(`[recheck] ${t.cardId} would be ${isPark ? 'parked' : 'reopened'} (shadow)`);
          } else {
            const count = reopenCounts.get(t.cardId) || 0;
            const comment = isPark ? reopenLib.buildParkComment({ row, sha: row.sha, runUrl }) : reopenLib.buildReopenComment({ row, sha: row.sha, runUrl, reopenCount: count });
            const out = await (isPark ? reopenLib.parkCard : reopenLib.reopenCard)({ identifier: t.cardId, comment });
            if (out.moved) {
              if (isPark) parked.push(t.cardId); else { reopened.push(t.cardId); reopenBudget--; reopenCounts.set(t.cardId, count + 1); }
            }
            ledger.appendEntry({ ...base, action: isPark ? 'parked' : 'reopened', ok: out.moved, note: out.moved ? `${isPark ? 'parked' : 'reopened'}: ${d.reason}${out.unparkError ? `; PARKED line not cleared: ${out.unparkError}` : ''}` : `${isPark ? 'park' : 'reopen'} refused: ${out.error}` }, RECHECK_LEDGER_PATH);
            console.error(`[recheck] ${t.cardId} ${out.moved ? (isPark ? 'PARKED' : 'REOPENED') : `reopen refused (${out.error})`}`);
          }
        }
      }
    }
  } finally {
    if (checkout) removeCheckout(checkout);
  }

  // BRO-8403: same hold rule decideHandoff applies, so an owner-blocked Paused card is never routed.
  const held = heldForOwner(results, cardsById);
  await routeRealFailures({ runId, results, handedOff: [...handedOff, ...reopened, ...parked, ...queued], held, sha: (checkout && checkout.sha) || null, coverIndex, maxBatches: args.backlog ? 3 : 1 });

  const counts = summarize(results, { noCriteria: dropped.length });
  const couldNotRun = results.filter((x) => !x.skip && x.envCause).length;
  const closeNote = autoclose ? `; auto-close: ${closed.length} closed, ${keptOpen.length} passed but stayed open` : '';
  ledger.appendEntry({ event: 'recheck-summary', runId, counts, autoclose: autoclose ? { closed, keptOpen } : null, handedOff, reopened, parked, note: `${counts.pass} still work, ${counts.fail} do not, ${counts.unverifiable} not machine-verifiable (${couldNotRun} of them could not run on this machine), ${counts.skipped} skipped, ${counts.noCriteria} had no criteria to check${closeNote}${handedOff.length ? `; ${handedOff.length} handed to a worker` : ''}${reopened.length ? `; ${reopened.length} reopened` : ''}${parked.length ? `; ${parked.length} parked` : ''}` }, RECHECK_LEDGER_PATH);
  console.error(`[recheck] done: ${JSON.stringify(counts)}${autoclose ? ` autoclose=${JSON.stringify({ closed, keptOpen })}` : ''}`);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });

module.exports = { main, routeRealFailures, USAGE, parseArgs, loadSharedTaskState, runVerify, makeFreshCheckout, removeCheckout, enforcementState };
