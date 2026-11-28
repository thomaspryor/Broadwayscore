#!/usr/bin/env node
/**
 * gap-recovery-batch.js (BRO-7944): chained, checkpointed rounds of the gap-recovery driver.
 *
 *   node scripts/gap-recovery-batch.js --rounds=3 [--round-budget-min=20] [--bd-cap=25] [--serp-cap=60]  (batch-wide totals; these are the defaults)
 *        [--round-ceiling=40] [--browser=0] [-- <driver args: --outlet=a,b --class=X --strategy=Y --recent-only --limit=N>]
 *
 * - Lanes (BRO-8288): `-- --outlet=a,b` takes per-outlet locks, so batches with disjoint outlets run in
 *   parallel; one lane owns the browser, others (or --browser=0) run with BROWSER_SESSION off.
 * - Rounds run in series under ONE whole-run lock (the driver children inherit it).
 * - Each round is a driver run with its own time budget; every round resumes from the
 *   ledger (strategy cooldowns/backoff are the driver's own eligibility logic, so a review
 *   tried in round 1 is not retried in round 2) and first lands what an earlier killed
 *   round accepted but never committed (see driver "adopt").
 * - Checkpoints: the driver commits+pushes every <=10 accepted reviews or <=10 minutes.
 * - Stops after two failed pushes, when the spend cap is used up, or when a round attempts nothing.
 * - One counts-only summary row per round -> <state dir>/batch-rounds.jsonl (and stdout).
 *
 * Lane spend caps (--bd-cap/--serp-cap) are PER LANE: give each lane its share of the nightly's budget.
 *
 * Known lane limits: the daily ceiling is read per item so N lanes can overshoot it by up to N-1; a
 * killed lane's pending pushes are drained by the next UNSCOPED run (lanes skip adopt/retry).
 *
 * Env: GAP_RECOVERY_STATE_DIR, GAP_RECOVERY_LEDGER_PATH (a scratch ledger is fine).
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('./lib/gap-recovery-batch');
const L = require('./lib/gap-recovery-ledger');

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd < 0 ? argv : argv.slice(0, dd);
const passthrough = dd < 0 ? [] : argv.slice(dd + 1);
const opt = (name, def = null) => { const h = own.find((a) => a.startsWith(`--${name}=`)); return h ? h.slice(name.length + 3) : def; };
const num = (v) => (v == null || v === '' ? null : Number(v));

const ROUNDS = Math.max(1, parseInt(opt('rounds', '1'), 10) || 1);
const ROUND_BUDGET_MIN = parseInt(opt('round-budget-min', process.env.TIME_BUDGET_MIN || '30'), 10) || 30;
// Batch-wide spend cap (NOT per round): defaults match one nightly's per-run budgets.
const CAP = { bd: num(opt('bd-cap', '25')), serp: num(opt('serp-cap', '60')) };
const ROUND_CEILING = opt('round-ceiling');
const STATE_DIR = process.env.GAP_RECOVERY_STATE_DIR || path.join(os.homedir(), '.broadwayscore-state', 'gap-recovery');
const ROWS_FILE = path.join(STATE_DIR, 'batch-rounds.jsonl');
const BATCH_ID = `batch-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${process.pid}`;
const log = (m) => console.log(`[gap-batch ${new Date().toISOString()}] ${m}`);

/** The children skip publishing (they run under our lock); publish the ledger once at the end. */
function publishLedger() {
  const lp = L.ledgerPathDefault();
  if (!L.manualRunShouldPublish({ dryRun: false, ledgerPath: lp, env: { ...process.env, GAP_RECOVERY_RUN_LOCK_PARENT: '' } })) return;
  try {
    const p = require('./lib/gap-recovery-publish').publishLedgers({ repoDir: path.join(__dirname, '..'), files: [{ rel: path.join('data', 'audit', 'gap-recovery-attempts.jsonl'), localPath: lp }], message: `data: gap-recovery batch ledger (${BATCH_ID}) [skip ci]\n\nBRO-7944 batch runner rows, published by plumbing.`, attempts: 3, log });
    log(p.pushed ? `ledger published ${p.commit}` : 'ledger already on origin/main');
  } catch (e) { log(`ledger publish FAILED: ${e.message} (rows stay in ${lp})`); }
}

function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const ks = L.killSwitchActive();
  if (ks.active) { log(`kill switch active (${ks.why}); nothing run`); return 0; }
  const { acquireRunLock, acquireLaneLock, RunLockBusyError } = require('./lib/recovery-run-lock');
  // BRO-8288: a batch scoped with --outlet=a,b is a lane (per-outlet locks, lanes run in parallel;
  // exactly one lane gets the Chrome). An unscoped batch keeps the whole-run lock.
  const laneOutlets = B.outletsFromArgs(passthrough);
  if (passthrough.includes('--outlet')) { log('use --outlet=a,b (the driver ignores the space form)'); return 2; }
  if (laneOutlets.length && passthrough.some((a) => a === '--reconcile' || a === '--retry-pending')) { log('--reconcile/--retry-pending touch every outlet: run them unscoped, not as a lane'); return 2; }
  let noBrowser = false;
  try {
    if (laneOutlets.length) {
      const lane = acquireLaneLock(`gap-recovery-batch lane ${laneOutlets.join(',')}`, laneOutlets, { browser: opt('browser', '1') !== '0' });
      noBrowser = !lane.browser;
      log(`lane ${laneOutlets.join(',')}: ${lane.browser ? 'owns the browser session' : 'browser-less (another lane or --browser=0)'}`);
    } else acquireRunLock('gap-recovery-batch');
  } catch (e) {
    if (e instanceof RunLockBusyError) { log(e.message); return 3; }
    throw e;
  }
  const spend = { bd: 0, serp: 0 };
  let failedPushes = 0; let lastWork = 0; let stopWhy = null;
  for (let round = 1; round <= ROUNDS; round++) {
    const d = B.stopDecision({ failedPushes, spend, cap: CAP, roundsDone: round - 1, rounds: ROUNDS, lastRoundWork: round === 1 ? 1 : lastWork });
    if (d.stop) { stopWhy = d.why; break; }
    const rem = B.remainingBudget(CAP, spend);
    // The driver reads BD_REQ_BUDGET/SERP_QUERY_BUDGET=0 as "no cap": a spent budget must stop here, never reach it.
    if (rem.bd === 0 || rem.serp === 0) { stopWhy = `spend cap reached (BD left ${rem.bd}, SERP left ${rem.serp})`; break; }
    const sumPath = path.join(STATE_DIR, `batch-${BATCH_ID}-r${round}.json`);
    try { fs.unlinkSync(sumPath); } catch { /* none */ }
    const env = {
      ...process.env,
      GAP_RECOVERY_RUN_LOCK_PARENT: String(process.pid),
      ...(laneOutlets.length ? { GAP_RECOVERY_LANE: '1' } : {}),
      ...(noBrowser ? { GAP_RECOVERY_DISABLE_BROWSER: '1' } : {}),
      TIME_BUDGET_MIN: String(ROUND_BUDGET_MIN),
      ...(rem.bd != null ? { BD_REQ_BUDGET: String(rem.bd) } : {}),
      ...(rem.serp != null ? { SERP_QUERY_BUDGET: String(rem.serp) } : {}),
      ...(ROUND_CEILING ? { GAP_RECOVERY_RUN_CEILING: ROUND_CEILING } : {}),
    };
    const startedAt = new Date().toISOString();
    log(`round ${round}/${ROUNDS} start (budget ${ROUND_BUDGET_MIN} min${rem.bd != null ? `, BD left ${rem.bd}` : ''}${rem.serp != null ? `, SERP left ${rem.serp}` : ''})`);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'gap-recovery-driver.js'), `--summary=${sumPath}`, ...passthrough], {
      cwd: path.join(__dirname, '..'), env, stdio: 'inherit', timeout: (ROUND_BUDGET_MIN + 30) * 60000, killSignal: 'SIGTERM',
    });
    const exit = r.status === null ? 1 : r.status;
    let summary = null; try { summary = JSON.parse(fs.readFileSync(sumPath, 'utf8')); } catch { /* none */ }
    // A round with no summary (killed/timed out) has unknown spend: assume it used its whole allowance.
    const used = B.roundSpend(summary, rem); spend.bd += used.bd; spend.serp += used.serp;
    if (summary && (summary.pushFailed || summary.pushRetryFailed)) failedPushes++;
    // No summary (killed/timed out): work is unknown, not zero; never read it as an idle round.
    lastWork = summary ? (summary.attempted || 0) + (summary.landed || 0) + (summary.adopted || 0) : 1;
    if (!summary) log(`round ${round}: no summary written (exit ${exit}); spend unknown`);
    const post = B.stopDecision({ failedPushes, spend, cap: CAP, roundsDone: round, rounds: ROUNDS, lastRoundWork: lastWork });
    const row = B.buildRoundRow({ batchId: BATCH_ID, round, startedAt, endedAt: new Date().toISOString(), exit, summary, spendTotal: { ...spend }, stopWhy: post.stop ? post.why : null, adopted: summary ? summary.adopted || 0 : 0, orphansGone: summary ? summary.orphansGone || 0 : 0 });
    fs.appendFileSync(ROWS_FILE, JSON.stringify(row) + '\n');
    log(`round ${round} summary: ${JSON.stringify(row)}`);
    if (exit === 3) { stopWhy = 'run lock busy'; break; }
    if (post.stop) { stopWhy = post.why; break; }
  }
  publishLedger();
  log(`batch ${BATCH_ID} done: ${stopWhy || 'rounds complete'}`);
  return failedPushes >= B.MAX_FAILED_PUSHES ? 1 : 0;
}

try { process.exitCode = main(); } catch (e) { console.error('FATAL:', e.stack || e.message); process.exitCode = 1; }
