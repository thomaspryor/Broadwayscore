#!/usr/bin/env node
/**
 * gap-recovery-nightly.js — the nightly review-text recovery job (BRO-7171
 * Stage 3). Run by launchd (scripts/launchd/com.broadwayscore.gap-recovery-nightly.plist)
 * from the main checkout after sync-audit-checkout.sh has fast-forwarded it.
 *
 * Order, each step a child run of scripts/gap-recovery-driver.js:
 *   0. kill switch (GAP_RECOVERY_DISABLED=1 or ~/.broadwayscore-state/gap-recovery-disabled)
 *      -> a 'disabled' row, nothing else
 *   1. whole-run lock (recovery-run-lock): a manual recover-*-browser.js run
 *      in progress -> a 'busy' row, nothing else
 *   2. seed the machine ledger ~/.broadwayscore-state/gap-recovery/attempts.jsonl
 *      from origin/main + the checkout's working copy
 *   3. driver --reconcile (recovered rows whose text is gone are reopened)
 *   4. driver live: retries pending pushes FIRST, then new work, recent shows
 *      first, under the nightly ceiling and spend caps. With the screen locked
 *      the browser strategy records browser_unavailable (non-evidence) and
 *      the free strategies still run.
 *   5. driver --dry-run --json: open-gap counts for the digest line
 *   6. one summary row (gap-recovery-nightly.buildNightlyRow) and publish both
 *      ledgers to origin/main by plumbing (gap-recovery-publish), never by
 *      writing the shared checkout.
 *
 * Usage:
 *   node scripts/gap-recovery-nightly.js            # the real run
 *   node scripts/gap-recovery-nightly.js --dry-run  # reconcile + plan only, writes and publishes nothing
 * Env (all optional; defaults are the conservative first-week values):
 *   GAP_RECOVERY_NIGHTLY_CEILING (60 accepted reviews)  BD_REQ_BUDGET (25)  SERP_QUERY_BUDGET (60)
 *   TIME_BUDGET_MIN (90)  GAP_RECOVERY_STATE_DIR (~/.broadwayscore-state/gap-recovery)
 *   GAP_RECOVERY_NIGHTLY_DRY_RUN=1 (same as --dry-run), or touch <state dir>/dry-run-once for one kickstarted dry run
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const L = require('./lib/gap-recovery-ledger');
const N = require('./lib/gap-recovery-nightly');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = process.env.GAP_RECOVERY_STATE_DIR || path.join(os.homedir(), '.broadwayscore-state', 'gap-recovery');
// One-shot dry run for a `launchctl kickstart` test (kickstart cannot pass
// flags): touch <state dir>/dry-run-once; the next run is a dry run and
// removes the file.
const DRY_ONCE = path.join(STATE_DIR, 'dry-run-once');
const DRY = process.argv.includes('--dry-run') || process.env.GAP_RECOVERY_NIGHTLY_DRY_RUN === '1' || (() => {
  try { fs.unlinkSync(DRY_ONCE); return true; } catch { return false; }
})();
const LEDGER_REL = path.join('data', 'audit', 'gap-recovery-attempts.jsonl');
const RUN_ID = `nightly-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${process.pid}`;

const log = (m) => console.log(`[gap-nightly ${new Date().toISOString()}] ${m}`);

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function driver(args, env, timeoutMin) {
  log(`driver ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'gap-recovery-driver.js'), ...args], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit', timeout: timeoutMin * 60000, killSignal: 'SIGTERM',
  });
  if (r.error) log(`driver ${args[0] || ''} error: ${r.error.message}`);
  return r.status === null ? 1 : r.status;
}

function publish(nightlyPath, ledgerPath) {
  if (DRY) return { pushed: false, dryRun: true };
  const { publishLedgers } = require('./lib/gap-recovery-publish');
  return publishLedgers({
    repoDir: ROOT,
    files: [{ rel: LEDGER_REL, localPath: ledgerPath }, { rel: N.NIGHTLY_REL, localPath: nightlyPath }],
    message: `data: gap-recovery nightly ledger (${RUN_ID}) [skip ci]\n\nBRO-7171 Stage 3 nightly job; counts-only rows, published by plumbing.`,
    log,
  });
}

function finishRow(row, nightlyPath, ledgerPath) {
  log(`summary row: ${JSON.stringify(row)}`);
  if (DRY) { log('dry run: row not recorded, nothing published'); return 0; }
  N.appendNightlyRow(row, nightlyPath);
  try {
    const p = publish(nightlyPath, ledgerPath);
    log(p.pushed ? `published ${p.commit}` : 'ledgers already on origin/main');
    return 0;
  } catch (e) {
    log(`PUBLISH FAILED: ${e.message} (rows stay in ${STATE_DIR}; the next run publishes them)`);
    return 1;
  }
}

function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const nightlyPath = path.join(STATE_DIR, 'nightly.jsonl');
  const ledgerPath = path.join(STATE_DIR, 'attempts.jsonl');
  const ceiling = N.nightlyCeiling();
  log(`${DRY ? 'DRY RUN' : 'LIVE'} ${RUN_ID}; checkout ${ROOT}; ceiling ${ceiling}`);
  const { seedStateFile } = require('./lib/gap-recovery-publish');
  // A dry run reads a scratch copy so it never creates or touches the machine ledger.
  const runLedger = DRY ? path.join(os.tmpdir(), `gap-nightly-dry-${process.pid}.jsonl`) : ledgerPath;
  // Early exits (kill switch, busy) read the state rows unseeded: seeding
  // rewrites the file (tmp + rename) and must only happen under the run lock.
  const early = { runId: RUN_ID, prevRows: N.readNightlyRows(nightlyPath), ceiling, counts: null };

  const ks = L.killSwitchActive();
  if (ks.active) {
    log(`kill switch active (${ks.why}); nothing run`);
    return finishRow(N.buildNightlyRow({ ...early, status: DRY ? 'dry_run' : 'disabled' }), nightlyPath, ledgerPath);
  }

  const { acquireRunLock, RunLockBusyError } = require('./lib/recovery-run-lock');
  if (!DRY) {
    try { acquireRunLock('gap-recovery-nightly'); } catch (e) {
      if (!(e instanceof RunLockBusyError)) throw e;
      log(e.message);
      return finishRow(N.buildNightlyRow({ ...early, status: 'busy' }), nightlyPath, ledgerPath);
    }
    seedStateFile({ repoDir: ROOT, rel: N.NIGHTLY_REL, localPath: nightlyPath });
  }
  const base = { ...early, prevRows: N.readNightlyRows(nightlyPath) };
  if (DRY && fs.existsSync(ledgerPath)) fs.copyFileSync(ledgerPath, runLedger);
  const n = seedStateFile({ repoDir: ROOT, rel: LEDGER_REL, localPath: runLedger });
  log(`ledger ${runLedger}: ${n} rows after seeding`);

  const env = {
    GAP_RECOVERY_LEDGER_PATH: runLedger,
    GAP_RECOVERY_RUN_LOCK_PARENT: String(process.pid),
    GAP_RECOVERY_RUN_CEILING: String(ceiling),
    BD_REQ_BUDGET: process.env.BD_REQ_BUDGET || '25',
    SERP_QUERY_BUDGET: process.env.SERP_QUERY_BUDGET || '60',
    TIME_BUDGET_MIN: process.env.TIME_BUDGET_MIN || '90',
  };
  const budget = parseInt(env.TIME_BUDGET_MIN, 10) || 90;
  const dryFlag = DRY ? ['--dry-run'] : [];
  const recSum = path.join(STATE_DIR, `reconcile-summary${DRY ? '-dry' : ''}.json`);
  const runSum = path.join(STATE_DIR, `run-summary${DRY ? '-dry' : ''}.json`);
  const planPath = path.join(STATE_DIR, `plan${DRY ? '-dry' : ''}.json`);
  for (const p of [recSum, runSum, planPath]) { try { fs.unlinkSync(p); } catch { /* none */ } }

  const recExit = driver(['--reconcile', ...dryFlag, `--summary=${recSum}`], env, 15);
  const reopened = (readJsonSafe(recSum) || {}).reopened || 0;

  let runExit = 0;
  let summary = null;
  if (!DRY) {
    runExit = driver([`--summary=${runSum}`], env, budget + 30);
    summary = readJsonSafe(runSum);
    if (runExit === 3) {
      log('driver reported the run lock busy');
      return finishRow(N.buildNightlyRow({ ...base, status: 'busy' }), nightlyPath, ledgerPath);
    }
  }
  const planExit = driver(['--dry-run', `--json=${planPath}`], env, 20);
  const plan = readJsonSafe(planPath);
  const counts = plan ? N.planCounts(plan.candidates) : null;
  if (!plan) log(`plan unavailable (driver exit ${planExit}); counts left empty`);

  const status = DRY ? 'dry_run' : (runExit !== 0 || recExit !== 0) ? 'failed' : 'ran';
  // BRO-7171 Stage 4: the owner batch scripts/gap-terminal.js --owner-batch wrote, until answered.
  const ownerBatch = readJsonSafe(path.join(STATE_DIR, 'owner-batch-pending.json'));
  const row = N.buildNightlyRow({
    ...base, status, summary, counts, reopened, ledgerRows: L.readRows(runLedger),
    driverExit: runExit || recExit, ownerBatch,
  });
  const code = finishRow(row, nightlyPath, ledgerPath);
  if (DRY) { try { fs.unlinkSync(runLedger); } catch { /* none */ } }
  return status === 'failed' ? 1 : code;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('FATAL:', e.stack || e.message);
  process.exitCode = 1;
}
