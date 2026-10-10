#!/usr/bin/env node
/**
 * sweep-open-backlog-acceptance.js — BRO-3551. SHADOW/report-only.
 *
 *   node scripts/sweep-open-backlog-acceptance.js            # normal run
 *   node scripts/sweep-open-backlog-acceptance.js --dry-run  # plan only, no checks run
 *   node scripts/sweep-open-backlog-acceptance.js --help
 *
 * The gap this closes: autonomous-acceptance-recheck.js only ever looks at
 * cards someone already claimed Done — it never asks whether a card that was
 * NEVER dispatched is already fixed. Measured live 2026-09-15: of 83 open
 * P1/P2 Backlog/Todo Linear issues that clear every headless-dispatch gate
 * (autofixFiledIssueGuard, then classifyHeadlessDispatchability's five
 * blockers), 29 (35%) already PASS their own acceptance command on main.
 * BRO-2511 is the motivating case — hand-dispatched, closed in 1m53s having
 * written zero code, because both cited failures were already fixed; its own
 * acceptance command would have answered that in 0.5s.
 *
 * This is a SWEEP, not a drain: it never closes, comments on, or otherwise
 * mutates a Linear issue. It re-runs each candidate's own acceptance command
 * against a fresh detached checkout of origin/main (the exact same
 * scripts/lib/acceptance-check-core.js runVerify() the nightly recheck and
 * notion-brain.js's close-time check both use — CLAUDE.md §15) and writes a
 * report of which ones already pass. Turning a passing result into an actual
 * Done/close is a deliberate SEPARATE owner decision — a passing command
 * proves the CARD'S OWN bar is cleared, not that the command covers what the
 * card was actually about (ship-check finding on the original proposal).
 *
 * Selection lives in scripts/lib/autonomous-recheck-core.js's
 * selectOpenBacklogSweepCandidates (unit-tested there and in
 * scripts/lib/linear-open-backlog-source.test.mjs); the Linear fetch lives in
 * scripts/lib/linear-open-backlog-source.js. This file is I/O glue only —
 * same split as autonomous-acceptance-recheck.js / autonomous-recheck-core.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { findClaimedTask } = require('./lib/autonomous-triage-core.js');
const { makeFreshCheckout: freshCheckout, removeCheckout, runVerify, CHECK_TIMEOUT_MS } = require('./lib/acceptance-check-core.js');
const { selectOpenBacklogSweepCandidates } = require('./lib/autonomous-recheck-core.js');
const { fetchOpenBacklogSweepCandidates } = require('./lib/linear-open-backlog-source.js');

const REPO = path.join(__dirname, '..');
const REPORT_PATH = path.join(REPO, 'data', 'audit', 'open-backlog-acceptance-sweep.json');
const DEFAULT_LIMIT = 30; // bounded work: one candidate can cost up to 2 x CHECK_TIMEOUT_MS
const RUN_DEADLINE_MS = 20 * 60 * 1000; // matches autonomous-acceptance-recheck.js's own run budget
const MIN_REMAINING_MS_TO_START = 60 * 1000;

const USAGE = `sweep-open-backlog-acceptance.js — report-only: which open P1/P2 Backlog/Todo
Linear issues already pass their OWN acceptance command on main (BRO-3551).

Usage:
  node scripts/sweep-open-backlog-acceptance.js [--limit 30] [--time-budget-min 20]
  node scripts/sweep-open-backlog-acceptance.js --dry-run   plan only — no checks run, no report write
  node scripts/sweep-open-backlog-acceptance.js --help

SHADOW: never closes, comments on, or otherwise mutates a Linear issue. Writes
${path.relative(REPO, REPORT_PATH)} — a candidate list for a human (or the morning
digest) to act on, never a state mutation on its own.`;

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

// Same shared-task snapshot the triage pass and the nightly recheck use, so
// "someone is working this" means the same thing everywhere (CLAUDE.md §15).
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
    try {
      const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      task._mtimeMs = fs.statSync(filePath).mtimeMs;
      tasksById[m[1]] = task;
    } catch { /* skip corrupt */ }
  }
  return { notionMap, tasksById };
}

function makeFreshCheckout() {
  return freshCheckout({ repo: REPO, prefix: 'open-backlog-sweep-' });
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(`${REPORT_PATH}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${REPORT_PATH}.tmp`, REPORT_PATH);
}

// `truncated` covers TWO independent ways this report can be partial (Codex
// ship-check finding): the Linear FETCH hit its page/deadline cap
// (fetchTruncated), or more eligible candidates existed than the run's
// --limit/time budget let it check (selectionTruncated — eligibleCandidates
// > checked). Collapsing both into one boolean would let a selection-capped
// run claim `truncated: false` and read as a complete sweep when most of the
// backlog was never even attempted. `checkoutSha` pins exactly which commit
// each verdict was measured against — without it a passing verdict has no
// way to be re-verified or trusted after main moves on (rollback/provenance
// gap, Codex finding). `shadow: true` matches the sibling nightly recheck
// ledger's own convention (autonomous-acceptance-recheck.js) marking every
// row as report-only, never a state mutation.
function buildReport({ generatedAt, totalCandidates, eligibleCandidates, results, fetchTruncated, fetchError, checkoutSha = null }) {
  const passed = results.filter(r => r.status === 'pass');
  const failed = results.filter(r => r.status === 'fail');
  const unverifiable = results.filter(r => r.status === 'unverifiable');
  const selectionTruncated = Number.isFinite(eligibleCandidates) && eligibleCandidates > results.length;
  return {
    generatedAt,
    shadow: true,
    checkoutSha,
    totalCandidates,
    eligibleCandidates: Number.isFinite(eligibleCandidates) ? eligibleCandidates : results.length,
    checked: results.length,
    truncated: !!fetchTruncated || selectionTruncated,
    fetchError: fetchError || null,
    counts: { pass: passed.length, fail: failed.length, unverifiable: unverifiable.length },
    // The whole point: cards a human can close today because their own bar
    // is already cleared on main. Never auto-closed — see file header. Detail
    // ("passed on retry (first run flaked)") is kept, not just on failures —
    // a card that only passed after a retry is worth a human's extra glance.
    alreadyDone: passed.map(r => ({ id: r.cardId, name: r.name, verifyCmd: r.verifyCmd, detail: r.detail || null })),
    failing: failed.map(r => ({ id: r.cardId, name: r.name, verifyCmd: r.verifyCmd, detail: r.detail })),
    // Per-card detail (ship-check finding) — previously only pass/fail cards
    // got a reason; a human couldn't tell WHY a card was unverifiable without
    // re-running it themselves.
    unverifiable: unverifiable.map(r => ({ id: r.cardId, name: r.name, verifyCmd: r.verifyCmd, detail: r.detail })),
  };
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);
  const dryRun = !!args['dry-run'];
  const limit = Math.max(1, Number(args.limit) || DEFAULT_LIMIT);
  let timeBudgetMs = RUN_DEADLINE_MS;
  if (args['time-budget-min'] !== undefined) {
    const parsed = Number(args['time-budget-min']);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`Error: --time-budget-min must be a positive number, got ${JSON.stringify(args['time-budget-min'])}`);
      process.exit(1);
    }
    timeBudgetMs = parsed * 60 * 1000;
  }

  const fetchResult = await fetchOpenBacklogSweepCandidates();
  if (fetchResult.error) {
    console.error(`[open-backlog-sweep] Linear fetch failed: ${fetchResult.error}`);
    if (!dryRun) writeReport(buildReport({ generatedAt: new Date().toISOString(), totalCandidates: 0, eligibleCandidates: 0, results: [], fetchTruncated: true, fetchError: fetchResult.error }));
    // Non-zero exit (ship-check finding): unlike the nightly recheck, this
    // sweep has only ONE candidate source. A dead LINEAR_API_KEY or GraphQL
    // outage must not look identical to "nothing to sweep tonight" to a
    // future cron/alerting wrapper.
    process.exitCode = 1;
    return;
  }
  if (fetchResult.truncated) {
    console.error('[open-backlog-sweep] WARN the Linear listing was truncated (page/deadline cap) — some candidates may be missing');
  }
  console.error(`[open-backlog-sweep] ${fetchResult.candidates.length} open (non-terminal) issue(s) fetched from Linear`);

  const taskState = loadSharedTaskState();
  const eligible = selectOpenBacklogSweepCandidates({
    issues: fetchResult.candidates,
    isClaimed: cardId => !!findClaimedTask(cardId, taskState),
  });
  const targets = eligible.slice(0, limit);
  if (eligible.length > targets.length) {
    console.error(`[open-backlog-sweep] WARN ${eligible.length} candidate(s) are eligible but --limit ${limit} caps this run to ${targets.length} — the rest are not yet checked (no rotation across runs; re-run with a higher --limit or narrow the backlog first)`);
  }

  console.error(`[open-backlog-sweep] ${eligible.length} candidate(s) clear the headless-dispatch gate (autofixFiledIssueGuard + classifyHeadlessDispatchability) and carry a safe-form acceptance command; checking ${targets.length} this run`);

  if (dryRun) {
    for (const t of targets) console.log(`  ${t.cardId} ${t.name} → ${t.verifyCmd}`);
    return;
  }
  if (!targets.length) {
    writeReport(buildReport({ generatedAt: new Date().toISOString(), totalCandidates: fetchResult.candidates.length, eligibleCandidates: eligible.length, results: [], fetchTruncated: fetchResult.truncated }));
    return;
  }

  const deadline = Date.now() + timeBudgetMs;
  let checkout;
  try { checkout = makeFreshCheckout(); }
  catch (err) {
    console.error(`[open-backlog-sweep] could not build a fresh main checkout: ${String(err.message).slice(0, 200)}`);
    writeReport(buildReport({ generatedAt: new Date().toISOString(), totalCandidates: fetchResult.candidates.length, eligibleCandidates: eligible.length, results: [], fetchTruncated: true, fetchError: `checkout failed: ${String(err.message).slice(0, 200)}` }));
    return;
  }

  const results = [];
  try {
    for (const t of targets) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < MIN_REMAINING_MS_TO_START) {
        console.error(`[open-backlog-sweep] time budget spent — deferring ${targets.length - results.length} candidate(s) to the next run`);
        break;
      }
      // prepared: checkout.prepared (ship-check finding) — without it, a
      // checkout whose node_modules link failed still executes every command
      // and scores it pass/fail instead of the correct 'unverifiable',
      // silently corrupting the one claim this feature exists to make
      // trustworthy. scripts/reconcile-landed-but-open.js and scripts/audit-
      // card-relevance.js both pass this; the sibling autonomous-acceptance-
      // recheck.js does not (its own pre-existing gap, not fixed here).
      const r = { ...t, ...runVerify(checkout.wt, t.verifyCmd, { timeoutMs: Math.min(CHECK_TIMEOUT_MS, Math.floor(remainingMs / 2)), prepared: checkout.prepared }) };
      results.push(r);
      console.error(`[open-backlog-sweep] ${r.cardId} ${r.name}: ${r.status}${r.detail ? ` (${String(r.detail).slice(0, 160)})` : ''}`);
    }
  } finally {
    removeCheckout(checkout);
  }

  const report = buildReport({
    generatedAt: new Date().toISOString(),
    totalCandidates: fetchResult.candidates.length,
    eligibleCandidates: eligible.length,
    results,
    fetchTruncated: fetchResult.truncated,
    checkoutSha: checkout.sha,
  });
  writeReport(report);
  console.log(`[open-backlog-sweep] ${report.counts.pass} already done, ${report.counts.fail} still fail, ${report.counts.unverifiable} unverifiable (of ${report.checked} checked, ${report.totalCandidates} candidates fetched)`);
  console.log(`Report written: ${path.relative(REPO, REPORT_PATH)}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## Open Backlog Acceptance Sweep (BRO-3551)',
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Candidates fetched | ${report.totalCandidates} |`,
      `| Checked this run | ${report.checked} |`,
      `| Already done (own command passes) | ${report.counts.pass} |`,
      `| Still fails | ${report.counts.fail} |`,
      `| Unverifiable | ${report.counts.unverifiable} |`,
      '',
      ...(report.alreadyDone.length ? [
        '### Already done', '',
        ...report.alreadyDone.map(c => `- ${c.id} ${c.name} — \`${c.verifyCmd}\``),
        '',
      ] : []),
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (require.main === module) main().catch(err => { console.error(`[open-backlog-sweep] fatal: ${err.message}`); process.exit(1); });

module.exports = { parseArgs, buildReport, writeReport, REPORT_PATH, DEFAULT_LIMIT, USAGE };
