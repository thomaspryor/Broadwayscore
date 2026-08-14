/**
 * autofix-canary.js — daily end-to-end proof the autofix dispatch pipeline
 * still works, plus a throughput row with teeth (Digest-autofix S6, task
 * #1225, owner mandate 2026-08-10 / task #1184: the drain starved to ZERO
 * dispatches 8/5-8/9 and the only trace was a launchd log in /tmp).
 *
 * TWO SEPARATE SIGNALS, BOTH PURE FUNCTIONS OF LEDGER DATA:
 *
 * 1. CANARY (foldCanaryStage/assessCanaryRow): every morning, runAutofixCanary
 *    files ONE synthetic, trivially-fixable card ("touch, commit, and push
 *    data/audit/canary-<date>.marker") and dispatches it through the REAL
 *    pipeline — card filing -> notion-tasks-sync -> bsc-next --headless ->
 *    verify gate -> completion — reusing digest-autofix.js's own fileCard/
 *    syncTasks/dispatchDetached (task #1225 code review: a second copy of
 *    that sequence would drift the next time the real one is fixed, CLAUDE.md
 *    §15). The marker file is deliberately COMMITTED, not gitignored: a
 *    dispatched session runs in an isolated per-job git worktree
 *    (scripts/lib/bsc-runner.js) entirely separate from this checkout, and
 *    close-time-verify.js checks a card's acceptance command against a FRESH
 *    checkout of origin/main (scripts/lib/acceptance-check-core.js) — never
 *    the job's own worktree. A gitignored, merely-touched marker would make
 *    every successful canary self-report FAILED (Codex adversarial review,
 *    task #1225). The NEXT morning's health-check folds this module's own
 *    ledger (data/audit/autofix-canary-ledger.jsonl) against the SHARED
 *    dispatch-ledger.jsonl job lifecycle (same foldJobs/followRetryChain
 *    correlation digest-autofix.js already trusts for its own outcome
 *    reconciliation) to find the FURTHEST STAGE the previous day's canary
 *    reached — naming exactly where the pipeline broke, not just that it did.
 *
 * 2. THROUGHPUT (assessThroughputRow): reads data/audit/digest-autofix-
 *    ledger.jsonl + data/audit/backlog-drain-ledger.jsonl and rolls up daily
 *    dispatched/passed/net counts. 2 consecutive zero-dispatch days or 3
 *    consecutive zero-pass days is itself an ERROR — the exact shape of the
 *    8/5-8/9 starvation. Per task #1221 ("health digest is blind in CI — 6
 *    untracked ledgers make their rows pass because the input is missing"),
 *    a MISSING ledger (passed as `null`, not `[]`) is explicitly NEVER scored
 *    'pass' — only 'warn' ("not measurable here") or, if the OTHER source is
 *    readable and shows the dead pattern, 'error'.
 *
 * Pure logic only below (CLAUDE.md §15) — disk/process I/O lives in
 * runAutofixCanary() and the scripts/health-check.js wrapper that calls
 * assessCanaryRow/assessThroughputRow.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dispatchLedger = require('./dispatch-ledger.js');
// syncTasks no longer imported: Linear filings need no task-mirror sync
// (BRO-286) — the identifier fileCard returns is directly dispatchable.
const { fileCard, dispatchDetached } = require('./digest-autofix.js');
const { repoDepthArgs } = require('./shallow-fetch-args.js');

const REPO = path.join(__dirname, '..', '..');
const CANARY_LEDGER_PATH = path.join(REPO, 'data', 'audit', 'autofix-canary-ledger.jsonl');
const CANARY_TITLE_PREFIX = 'CANARY: touch';
// Same bound digest-autofix.js uses for its own orphan detection (see
// ORPHAN_TIMEOUT_H there) — a dispatch whose job-spawned event never arrives
// within this window is treated as refused, not "still running".
const ORPHAN_TIMEOUT_H = 3;
const ZERO_DISPATCH_ERROR_DAYS = 2;
const ZERO_PASS_ERROR_DAYS = 3;
const THROUGHPUT_WINDOW_DAYS = 7;

function canaryDateStr(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

function canaryMarkerRelPath(dateStr) {
  return `data/audit/canary-${dateStr}.marker`;
}

function canaryCardTitle(dateStr) {
  return `${CANARY_TITLE_PREFIX} ${canaryMarkerRelPath(dateStr)}`;
}

// >=300 chars + all four sections to satisfy notion-brain's card-quality gate
// (same shape digest-autofix.js's buildCardNotes uses); the acceptance
// command is the one SAFE_CHECK_FORMS entry autonomous-triage-core.js arms
// for this exact family (task #1225).
function buildCanaryCardNotes(dateStr) {
  const marker = canaryMarkerRelPath(dateStr);
  return [
    '## Problem',
    `Daily proof that the autofix dispatch pipeline (card filing -> notion-tasks-sync -> bsc-next --headless -> verify gate -> task completion) still works end to end. Owner mandate 2026-08-10 (task #1184): the pipeline starved to ZERO dispatches for 4 days with no trace but a /tmp launchd log — this canary exists so a future silent failure shows up in tomorrow's health digest instead.`,
    '',
    '## Evidence',
    `Auto-filed by the morning digest's canary driver (scripts/lib/autofix-canary.js). This card carries no real product work — it is a synthetic, trivially-fixable probe of the pipeline itself.`,
    '',
    '## Suggested approach',
    `Run: \`touch ${marker}\` to create the empty marker file, then \`git add ${marker}\` and commit + push it to origin/main (this file is intentionally NOT gitignored — the acceptance check below runs against a fresh checkout of origin/main, so the marker must actually be committed, not just created locally). That is the entire fix — do not do anything else.`,
    '',
    '## Acceptance criteria',
    `\`node scripts/check-canary-marker.js --date=${dateStr}\` passes on origin/main — i.e. the marker file was committed and pushed, not merely created locally.`,
  ].join('\n');
}

// Dedup: skip filing if today's card is already recorded in OUR ledger.
function planCanaryDispatch({ ledgerEntries, dateStr }) {
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const alreadyFiled = entries.some((e) => e && e.event === 'card-filed' && e.date === dateStr);
  return { shouldFile: !alreadyFiled };
}

// Same taskId correlation digest-autofix.js's findMyJob uses: the earliest
// SPAWNED event for this taskId at/after the card-filed ts, then follow any
// retry chain to a terminal (or still-open) state.
function findCanarySpawn(dispatchLedgerEntries, taskId, sinceTs) {
  const sinceMs = new Date(sinceTs).getTime() - 5000;
  const spawns = (dispatchLedgerEntries || [])
    .filter((e) => e && e.event === dispatchLedger.JOB_EVENTS.SPAWNED
      && String(e.taskId) === String(taskId) && new Date(e.ts).getTime() >= sinceMs)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (!spawns.length) return null;
  return dispatchLedger.followRetryChain(dispatchLedgerEntries, taskId, spawns[0].jobId);
}

/**
 * Furthest stage the canary filed on `dateStr` has reached, folding our own
 * ledger (card-filed/canary-pass/canary-fail) against the shared
 * dispatch-ledger job lifecycle for anything still unresolved.
 * @returns {{stage: string, taskId: string|null, jobId?: string}}
 *   stage: 'not-filed' | 'card-filed' | 'dispatched' | 'job-done' |
 *          'job-failed' | 'verified-pass' | <recorded canary-fail stage>
 */
function foldCanaryStage({ dateStr, canaryLedgerEntries, dispatchLedgerEntries, now = new Date() } = {}) {
  const entries = Array.isArray(canaryLedgerEntries) ? canaryLedgerEntries : [];
  const filed = entries.find((e) => e && e.event === 'card-filed' && e.date === dateStr);
  if (!filed) return { stage: 'not-filed', taskId: null };

  const resolvedPass = entries.find((e) => e && e.event === 'canary-pass' && e.date === dateStr);
  if (resolvedPass) return { stage: 'verified-pass', taskId: filed.taskId };

  const resolvedFail = entries.find((e) => e && e.event === 'canary-fail' && e.date === dateStr);
  if (resolvedFail) return { stage: resolvedFail.stage || 'card-filed', taskId: filed.taskId };

  const job = findCanarySpawn(dispatchLedgerEntries, filed.taskId, filed.ts);
  if (!job) return { stage: 'card-filed', taskId: filed.taskId };
  if (job.event === dispatchLedger.JOB_EVENTS.DONE) {
    return { stage: 'job-done', taskId: filed.taskId, jobId: job.jobId };
  }
  if (job.event === dispatchLedger.JOB_EVENTS.FAILED || job.event === dispatchLedger.JOB_EVENTS.ORPHANED) {
    return { stage: 'job-failed', taskId: filed.taskId, jobId: job.jobId };
  }
  return { stage: 'dispatched', taskId: filed.taskId, jobId: job.jobId };
}

/**
 * The health-check row: did YESTERDAY's canary complete end to end?
 * No history at all (feature just shipped, or ledger unreadable in this
 * environment) -> 'warn', never 'pass' and never 'error' on day one.
 */
function assessCanaryRow({ canaryLedgerEntries, dispatchLedgerEntries, now = new Date() } = {}) {
  const name = 'Autofix: daily canary (dispatch pipeline proof)';
  const entries = Array.isArray(canaryLedgerEntries) ? canaryLedgerEntries : null;

  if (!entries || !entries.length) {
    return {
      name,
      status: 'warn',
      message: entries === null
        ? 'Cannot measure the autofix canary from this environment — data/audit/autofix-canary-ledger.jsonl is gitignored/per-machine and absent here.'
        : 'No autofix canary history yet — it will start filing/verifying from the next morning digest run.',
    };
  }

  const yesterday = canaryDateStr(new Date(new Date(now).getTime() - 24 * 3600 * 1000));
  const { stage } = foldCanaryStage({ dateStr: yesterday, canaryLedgerEntries: entries, dispatchLedgerEntries, now });

  if (stage === 'verified-pass') {
    return {
      name,
      status: 'pass',
      message: `Autofix pipeline canary passed end-to-end for ${yesterday} (card filed -> dispatched -> fix landed -> verified).`,
    };
  }

  // 'job-done' with no recorded canary-pass/canary-fail means runAutofixCanary
  // has not yet reached a verdict for this date (its own resolution step
  // defers rather than guessing on a transient git-fetch/task-load failure —
  // see markerExistsOnOriginMain's null case). That is AMBIGUOUS, not a
  // confirmed pipeline failure: the job genuinely finished, and reporting a
  // hard ERROR here could be a false alarm over this machine's own local
  // resolution trouble rather than the dispatch pipeline (Codex re-review,
  // task #1225). Every other stage (not-filed, card-filed, dispatched,
  // job-failed, or an explicitly recorded canary-fail) IS a confirmed signal
  // and stays an error.
  if (stage === 'job-done') {
    return {
      name,
      status: 'warn',
      message: `Autofix pipeline canary for ${yesterday} finished its dispatch but is not yet confirmed (marker not yet verified on origin/main, or this machine could not check) — not a confirmed failure yet.`,
    };
  }

  return {
    name,
    status: 'error',
    message: `Autofix pipeline canary FAILED at stage "${stage}" for ${yesterday} — the daily end-to-end dispatch-pipeline check (card filing -> notion-tasks-sync -> bsc-next --headless -> verify gate -> completion) did not complete. The real pipeline is broken at or before that stage.`,
    hint: 'Run `claude -p "hi"` on the dispatch host to rule out a logged-out CLI (2026-08-10 incident); cross-reference data/audit/autofix-canary-ledger.jsonl and data/audit/dispatch-ledger.jsonl for the stuck taskId.',
  };
}

// Daily dispatched/passed buckets for the trailing `windowDays`, most recent
// day last. `source` entries may be null (ledger unreadable in this
// environment) — callers must not conflate that with an empty-but-present []
// ledger, which is a legitimate "genuinely nothing happened" reading.
function dailyCounts(entries, dispatchEvent, windowDays, now) {
  const days = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    days.push(canaryDateStr(new Date(now.getTime() - i * 24 * 3600 * 1000)));
  }
  const dispatched = Object.fromEntries(days.map((d) => [d, 0]));
  const passed = Object.fromEntries(days.map((d) => [d, 0]));
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.ts) continue;
    const day = canaryDateStr(e.ts);
    if (!(day in dispatched)) continue;
    if (e.event === dispatchEvent) dispatched[day]++;
    else if (e.event === 'card-pass') passed[day]++;
  }
  return { days, dispatched, passed };
}

/**
 * Throughput row with teeth (task #1225): rolls up daily dispatched/passed
 * counts from BOTH dispatch sources over `windowDays`. `digestLedgerEntries`/
 * `backlogLedgerEntries` are each independently `null` (unreadable in this
 * environment) or an array (possibly empty). Both null -> 'warn', NEVER
 * 'pass' (closes the #1221 "renders green on missing input" class).
 */
function assessThroughputRow({ digestLedgerEntries, backlogLedgerEntries, now = new Date(), windowDays = THROUGHPUT_WINDOW_DAYS } = {}) {
  const name = 'Autofix: throughput (dispatched/passed, daily)';
  const digestNull = digestLedgerEntries === null || digestLedgerEntries === undefined;
  const backlogNull = backlogLedgerEntries === null || backlogLedgerEntries === undefined;

  if (digestNull && backlogNull) {
    return {
      name,
      status: 'warn',
      message: 'Autofix throughput is not measurable from this environment — both data/audit/digest-autofix-ledger.jsonl and data/audit/backlog-drain-ledger.jsonl are gitignored/per-machine and absent here.',
    };
  }

  const digestDaily = dailyCounts(digestNull ? [] : digestLedgerEntries, 'auto-dispatch', windowDays, now);
  const backlogDaily = dailyCounts(backlogNull ? [] : backlogLedgerEntries, 'drain-dispatch', windowDays, now);

  const days = digestDaily.days;
  const dispatchedTotal = days.map((d) => digestDaily.dispatched[d] + backlogDaily.dispatched[d]);
  const passedTotal = days.map((d) => digestDaily.passed[d] + backlogDaily.passed[d]);

  let zeroDispatchStreak = 0;
  for (let i = dispatchedTotal.length - 1; i >= 0 && dispatchedTotal[i] === 0; i--) zeroDispatchStreak++;
  let zeroPassStreak = 0;
  for (let i = passedTotal.length - 1; i >= 0 && passedTotal[i] === 0; i--) zeroPassStreak++;

  const partialNote = digestNull ? ' (digest-autofix ledger unreadable here — backlog-drain only)'
    : backlogNull ? ' (backlog-drain ledger unreadable here — digest-autofix only)' : '';

  if (zeroDispatchStreak >= ZERO_DISPATCH_ERROR_DAYS) {
    return {
      name,
      status: 'error',
      message: `Autofix throughput DEAD: 0 dispatches on each of the last ${zeroDispatchStreak} day(s)${partialNote} — this is the exact 8/5-8/9 starvation shape (task #1184).`,
    };
  }
  if (zeroPassStreak >= ZERO_PASS_ERROR_DAYS) {
    return {
      name,
      status: 'error',
      message: `Autofix throughput DEAD: 0 passes on each of the last ${zeroPassStreak} day(s)${partialNote} — dispatches are launching but nothing is landing.`,
    };
  }

  const dSum = dispatchedTotal.reduce((a, b) => a + b, 0);
  const pSum = passedTotal.reduce((a, b) => a + b, 0);
  // A source being unreadable is partial blindness, not confirmed health —
  // the visible source alone cannot prove the UNREADABLE source isn't
  // starved. 'pass' must mean BOTH sources were actually checked (Codex
  // re-review, task #1225: the earlier version could report 'pass' off one
  // healthy source while the other silently starved).
  if (digestNull || backlogNull) {
    return {
      name,
      status: 'warn',
      message: `Autofix throughput partially measurable over the last ${windowDays}d${partialNote}: ${dSum} dispatched, ${pSum} passed from the readable source — the unreadable source could be starved without this row catching it.`,
    };
  }
  return {
    name,
    status: 'pass',
    message: `Autofix throughput over the last ${windowDays}d: ${dSum} dispatched, ${pSum} passed (net ${dSum - pSum}).`,
  };
}

function appendJsonlLedger(p, entry) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

function readJsonlLedger(p) {
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

// Ground-truth check for whether the marker landed on origin/main — NOT a
// local fs.existsSync(REPO, ...) check. Dispatched sessions run in an
// isolated, per-job git worktree (scripts/lib/bsc-runner.js) entirely
// separate from this checkout, and close-time-verify.js (the gate that
// decides whether a card may move to Done) runs the card's acceptance
// command in a FRESH checkout of origin/main (scripts/lib/
// acceptance-check-core.js) — never the job's own worktree, never this
// process's local disk. A local existsSync check would see the marker as
// permanently absent even on a fully successful fix (Codex adversarial
// review, task #1225).
// @returns {boolean|null} true=present, false=CONFIRMED absent (cat-file -e
//   exit 1), null=could not resolve this run (fetch failed, or any other git
//   error) — deliberately distinct from `false`: a transient network/git
//   hiccup must never be scored the same as a confirmed-absent marker, or a
//   genuinely successful canary could be recorded canary-fail on a bad
//   connection alone (Codex re-review, task #1225). Callers must treat null
//   as "still unresolved", same as an in-flight dispatch under the orphan
//   bound — not as failure evidence.
/**
 * Pure classifier for a `git cat-file -e <tree-ish>:<path>` failure: does
 * this error mean the path is CONFIRMED absent from the tree (as opposed to
 * a transient/unexpected git or network failure)? Exit code is NOT a
 * reliable signal here — see the caller's comment — so this matches the
 * stderr text git actually prints for that case.
 * @returns {boolean}
 */
function isPathAbsentFromTreeError(err) {
  const stderrText = err && err.stderr ? String(err.stderr) : '';
  return /does not exist in/.test(stderrText);
}

function markerExistsOnOriginMain(dateStr, log = () => {}) {
  // Depth-bound the fetch (task #466 class): reachable from ~170 shallow
  // (fetch-depth: 1) CI checkouts, where an unbounded `git fetch origin
  // main` pulls the WHOLE ~2.1 GB / 165k-commit repo instead of the small
  // delta and stalls until timeout. Same helper acceptance-check-core.js
  // uses for the identical reason.
  // repoDepthArgs() is this derivation extracted verbatim — it fails open to []
  // the same way this inline copy did. infra-gate-registration-check.js needs
  // the identical "fetch origin/main from a possibly-shallow checkout" step, so
  // it lives in shallow-fetch-args.js next to the pure function it feeds rather
  // than being pasted a third time.
  const depthArgs = repoDepthArgs({ repoRoot: REPO });
  try {
    // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
    execFileSync('git', ['fetch', ...depthArgs, '--quiet', 'origin', 'main'], { cwd: REPO, timeout: 30000, stdio: 'pipe' });
  } catch (err) {
    log(`[autofix-canary] WARN could not fetch origin/main to check the ${dateStr} marker (network/git issue) — unresolved this run, not evidence of absence: ${String(err.message).slice(0, 120)}`);
    return null;
  }
  try {
    execFileSync('git', ['cat-file', '-e', `origin/main:${canaryMarkerRelPath(dateStr)}`], { cwd: REPO, timeout: 10000, stdio: 'pipe' });
    return true;
  } catch (err) {
    // `git cat-file -e <tree-ish>:<path>` for a path absent from that tree
    // prints "fatal: path '<path>' does not exist in '<tree-ish>'" and exits
    // 128 on this git version — NOT exit 1 (exit 1 is what older docs/some
    // git releases document for a missing bare object SHA, which this call
    // never passes). Checked directly against the actual git binary here:
    // an existing path exits 0, a missing tree path exits 128, and even an
    // invalid raw object name exits 128. A status-only check therefore never
    // matches a genuinely-missing marker, so the confirmed-absent branch was
    // unreachable and the canary could never self-report a marker-absent
    // failure (found chasing #1264's RECHECK — BRO-326's 2026-08-13 marker
    // sat >24h past the orphan window still logging "could not confirm").
    // Match on the stderr message, not the exit code, so this is portable
    // across git versions either way.
    if (isPathAbsentFromTreeError(err)) return false; // confirmed absent from the tree
    log(`[autofix-canary] WARN could not check origin/main for the ${dateStr} marker: ${String(err.message).slice(0, 120)}`);
    return null;
  }
}

/**
 * Daily driver, called once per morning digest run (fail-soft throughout —
 * never throws, never blocks the digest send, mirrors digest-autofix.js's
 * runAutofix / backlog-drain.js conventions exactly):
 *   1. Resolve YESTERDAY's still-pending canary (marker committed to
 *      origin/main + task completion), appending canary-pass/canary-fail.
 *   2. File + dispatch TODAY's canary if not already filed.
 */
function runAutofixCanary({ dryRun = false, log = () => {}, now = new Date(), loadTasksFn = null } = {}) {
  let tasks = [];
  let tasksLoadFailed = false;
  try {
    if (loadTasksFn) tasks = loadTasksFn();
    else { const bn = require('../bsc-next.js'); tasks = bn.loadTasks(bn.TASKS_DIR); }
  } catch (err) {
    tasksLoadFailed = true;
    log(`[autofix-canary] WARN could not load tasks (dedup/resolution degraded): ${String(err.message).slice(0, 120)}`);
  }
  const tasksById = new Map(tasks.map((t) => [String(t.id), t]));

  let ledgerEntries = readJsonlLedger(CANARY_LEDGER_PATH);
  let dispatchLedgerEntries = [];
  try { dispatchLedgerEntries = dispatchLedger.readEntries(); } catch { /* degrades to card-filed-only stage folding */ }

  // 1. Resolve yesterday's pending canary.
  const yesterday = canaryDateStr(new Date(now.getTime() - 24 * 3600 * 1000));
  const yState = foldCanaryStage({ dateStr: yesterday, canaryLedgerEntries: ledgerEntries, dispatchLedgerEntries, now });
  const alreadyResolved = ledgerEntries.some((e) => e && (e.event === 'canary-pass' || e.event === 'canary-fail') && e.date === yesterday);
  if (tasksLoadFailed) {
    // A broken task-list read must not masquerade as "task not completed" —
    // that would record a false canary-fail for a genuinely successful
    // canary purely because THIS run couldn't read local task state (Codex
    // re-review, task #1225). Defer entirely, same as an unresolved marker
    // check.
    log(`[autofix-canary] ${yesterday} canary: task list unreadable this run — resolution deferred, not evidence of failure`);
  } else if (!alreadyResolved && yState.stage !== 'not-filed') {
    const markerExists = markerExistsOnOriginMain(yesterday, log); // true | false | null (unresolved)
    // BRO-286: Linear-tracked canaries ('linear:BRO-N' taskIds) have no
    // Notion-mirror task to check — the committed marker + job DONE already
    // prove the pipeline end-to-end, and the Phase-3 board Done-audit is the
    // independent check that the issue itself closed.
    const isLinearCanary = /^linear:/.test(String(yState.taskId || ''));
    const task = (!isLinearCanary && yState.taskId) ? tasksById.get(String(yState.taskId)) : null;
    const taskCompleted = isLinearCanary ? true : !!(task && task.status === 'completed');
    if (yState.stage === 'job-done' && markerExists === true && taskCompleted) {
      if (!dryRun) appendJsonlLedger(CANARY_LEDGER_PATH, { event: 'canary-pass', date: yesterday, taskId: yState.taskId });
      log(`[autofix-canary] ${yesterday} canary PASSED (marker committed to origin/main, task completed)`);
    } else if (markerExists === null) {
      // A git fetch/check failure is NOT evidence of absence — resolving on
      // this signal alone could fail a genuinely successful canary over a
      // transient network hiccup (Codex re-review, task #1225).
      log(`[autofix-canary] ${yesterday} canary: could not confirm marker state on origin/main this run — resolving next run`);
    } else {
      // Still genuinely in flight (dispatched/job-done but under the orphan
      // bound, marker not yet visible) — don't call it a failure prematurely.
      const filed = ledgerEntries.find((e) => e && e.event === 'card-filed' && e.date === yesterday);
      const ageH = filed ? (now.getTime() - new Date(filed.ts).getTime()) / 3600e3 : Infinity;
      if (ageH < ORPHAN_TIMEOUT_H && yState.stage !== 'job-failed') {
        log(`[autofix-canary] ${yesterday} canary still in flight at stage "${yState.stage}" (${ageH.toFixed(1)}h old) — resolving next run`);
      } else {
        if (!dryRun) {
          appendJsonlLedger(CANARY_LEDGER_PATH, {
            event: 'canary-fail', date: yesterday, taskId: yState.taskId, stage: yState.stage,
            note: markerExists ? 'marker on origin/main but task not marked completed' : 'marker never landed on origin/main',
          });
        }
        log(`[autofix-canary] ${yesterday} canary FAILED at stage "${yState.stage}"`);
      }
    }
    ledgerEntries = readJsonlLedger(CANARY_LEDGER_PATH);
  }

  // 2. File + dispatch today's canary.
  const today = canaryDateStr(now);
  const { shouldFile } = planCanaryDispatch({ ledgerEntries, dateStr: today });
  if (!shouldFile) return { filed: false, reason: 'already filed today' };
  if (dryRun) return { filed: false, reason: 'dry-run' };

  const title = canaryCardTitle(today);
  // Live task-list cross-check BEFORE filing (same reasoning as
  // digest-autofix.js's matchOpenTask): the ledger-only dedup above only
  // catches a card THIS process already recorded. A prior run whose sync
  // lagged (filed the card, but resolved no taskId before this run started —
  // see the sync-lag branch below) would otherwise re-file a duplicate every
  // morning until sync finally caught up. An open task with today's exact
  // title is authoritative regardless of what our own ledger says.
  const existingTask = tasks.find((t) => t && (t.status === 'pending' || t.status === 'in_progress') && t.subject === title);
  if (existingTask) {
    appendJsonlLedger(CANARY_LEDGER_PATH, { event: 'card-filed', date: today, taskId: String(existingTask.id) });
    // Was it actually dispatched? A prior run's sync-lag branch (below) can
    // leave a card filed+synced with NO spawn ever attempted — backfilling
    // the ledger without checking would strand that canary at 'card-filed'
    // forever (Codex re-review, task #1225: found via a matching taskId with
    // no card-filed entry yet still not dispatched).
    const alreadySpawned = !!findCanarySpawn(dispatchLedgerEntries, String(existingTask.id), new Date(0).toISOString());
    if (alreadySpawned) {
      log(`[autofix-canary] today's canary already has an open, dispatched task (#${existingTask.id}) — backfilling ledger only`);
      return { filed: true, dispatched: false, taskId: String(existingTask.id), reason: 'already dispatched' };
    }
    log(`[autofix-canary] today's canary has an open, never-dispatched task (#${existingTask.id}) from a prior sync-lag run — dispatching now`);
    try {
      dispatchDetached(existingTask.id, log, 0, null);
      return { filed: true, dispatched: true, taskId: String(existingTask.id) };
    } catch (err) {
      log(`[autofix-canary] WARN dispatch spawn failed for canary #${existingTask.id}: ${String(err.message).slice(0, 120)}`);
      return { filed: true, dispatched: false, taskId: String(existingTask.id) };
    }
  }

  // BRO-286: fileCard files a Linear issue and returns its identifier
  // immediately — the old syncTasks → reload → title-match → sync-lag dance
  // existed only because Notion card ids had to round-trip through the task
  // mirror to become dispatchable numbers. The Linear identifier is
  // dispatchable the moment it exists.
  const filedIssue = fileCard(title, buildCanaryCardNotes(today), { log });
  if (!filedIssue.ok) return { filed: false, reason: 'card create failed' };
  const canaryTaskId = `linear:${filedIssue.identifier}`;

  try {
    dispatchDetached(canaryTaskId, log, 0, null);
    appendJsonlLedger(CANARY_LEDGER_PATH, { event: 'card-filed', date: today, taskId: canaryTaskId });
    return { filed: true, dispatched: true, taskId: canaryTaskId };
  } catch (err) {
    log(`[autofix-canary] WARN dispatch spawn failed for canary ${canaryTaskId}: ${String(err.message).slice(0, 120)}`);
    appendJsonlLedger(CANARY_LEDGER_PATH, { event: 'card-filed', date: today, taskId: canaryTaskId });
    return { filed: true, dispatched: false, taskId: canaryTaskId };
  }
}

module.exports = {
  CANARY_LEDGER_PATH,
  CANARY_TITLE_PREFIX,
  ZERO_DISPATCH_ERROR_DAYS,
  ZERO_PASS_ERROR_DAYS,
  THROUGHPUT_WINDOW_DAYS,
  canaryDateStr,
  canaryMarkerRelPath,
  canaryCardTitle,
  buildCanaryCardNotes,
  planCanaryDispatch,
  foldCanaryStage,
  assessCanaryRow,
  assessThroughputRow,
  runAutofixCanary,
  isPathAbsentFromTreeError,
  readJsonlLedger,
  appendJsonlLedger,
};
