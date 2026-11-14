#!/usr/bin/env node
/**
 * seed-evidence-review-stubs.js (BRO-4290)
 *
 * Closed Off-West-End rows promoted from audit review evidence
 * (discoverySource 'audit-review-evidence') start with zero reviews and no
 * other job gathers them. For each, this fetches the ONE review URL that
 * proved the show exists, through ingest-review-from-url.js. A readable page
 * becomes a review file. An unreadable one writes nothing (no
 * --stub-on-failure, so collect-review-texts.yml never retries it with
 * untagged spend); the rollup marks it failed and this runner may retry it
 * after 30 days.
 *
 * Spend: a hard monthly cap (scripts/lib/evidence-catchup-spend.js,
 * EVIDENCE_CATCHUP_MONTHLY_CAP_USD). Before EVERY fetch it re-reads month-to-
 * date spend, stops if the worst case would cross the cap, and writes a
 * reservation row to data/audit/evidence-catchup-spend.json; after the fetch
 * it settles that row to the priced actual. Each child runs with
 * SCRAPER_SPEND_PURPOSE=evidence-catchup so its provider calls are tagged in
 * the shared spend ledger. A missing or unreadable rollup or ledger, or tagged
 * spend the rollup does not record, stops the run before any fetch.
 *
 * Usage:
 *   node scripts/seed-evidence-review-stubs.js --dry-run [--limit=5]
 *   node scripts/seed-evidence-review-stubs.js [--limit=N]   (N <= 5, default 2)
 *
 * --dry-run fetches nothing and writes nothing: it prints the candidates,
 * their URLs, projected dollars and whether the cap would bind. Both modes
 * write the cap-allowed count to $GITHUB_OUTPUT as `candidates`.
 */
'use strict';
require('./lib/cli-help').exitOnHelp(module);

// Labels every ingest-review-from-url.js run this script starts (BRO-6588).
process.env.INGEST_CALLER = process.env.INGEST_CALLER || 'seed-evidence-review-stubs';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { selectEvidenceSeedCandidates, DEFAULT_EVIDENCE_PER_BATCH } = require('./lib/zero-review-catchup');
const spend = require('./lib/evidence-catchup-spend');
const { LEDGER_PATH } = require('./lib/provider-telemetry');
const { isTestRun } = require('./lib/test-run-guard');

const ROOT = path.join(__dirname, '..');
// Fixture hooks honoured ONLY under a test run (test-run-guard.js), so no
// production env var can swap the fetcher or shrink the spacing.
const TEST = isTestRun();
const testEnv = (name, fallback) => (TEST && process.env[name]) || fallback;
const SHOWS_PATH = testEnv('EVIDENCE_CATCHUP_SHOWS_PATH', path.join(ROOT, 'data', 'shows.json'));
const REVIEWS_PATH = testEnv('EVIDENCE_CATCHUP_REVIEWS_PATH', path.join(ROOT, 'data', 'reviews.json'));
const REVIEW_TEXTS_DIR = testEnv('EVIDENCE_CATCHUP_REVIEW_TEXTS_DIR', path.join(ROOT, 'data', 'review-texts'));
const INGEST = testEnv('EVIDENCE_CATCHUP_INGEST', path.join(__dirname, 'ingest-review-from-url.js'));
const FETCH_SPACING_MS = Number(testEnv('EVIDENCE_CATCHUP_SPACING_MS', 12000)); // CLAUDE.md §8: 10s+ between fetches
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const SECRET_NAMES = ['BRIGHTDATA_TOKEN', 'BRIGHTDATA_ZONE', 'SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : DEFAULT_EVIDENCE_PER_BATCH;

function loadJsonArray(filePath, key) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(data) ? data : (data[key] || []);
}

function ledgerPath() {
  return process.env.SCRAPER_SPEND_LEDGER_PATH || LEDGER_PATH;
}

function rollupPath() {
  return process.env.EVIDENCE_CATCHUP_ROLLUP_PATH || spend.ROLLUP_PATH;
}

/**
 * Month-to-date dollars from both sources. Throws (fail closed) if either is
 * unreadable or the ledger shows tagged spend the rollup does not record.
 */
function readMonthToDate(nowMs) {
  const rollup = spend.loadRollup(rollupPath());
  const ledgerRows = spend.loadTaggedLedgerRows(ledgerPath());
  spend.assertRollupCoversLedger(rollup, ledgerRows);
  return { rollup, ledgerRows, mtdUsd: spend.monthToDateUsd(rollup, ledgerRows, nowMs) };
}

/** The review file ingest wrote for this URL, or null. */
function findReviewFile(showId, url) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('_')); } catch { return null; }
  for (const n of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (data && data.url === url) return data;
    } catch { /* unreadable file: not ours to judge */ }
  }
  return null;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/**
 * Commit the rollup and push it with push-with-retry.sh, the same path as the
 * workflow's 'Commit spend rollup' step. Returns true on success. Under a test
 * run with GITHUB_ACTIONS=true, EVIDENCE_CATCHUP_PUSH_CMD must name a fake
 * command; a test never pushes the real repo.
 */
function pushRollup(file, message) {
  const fake = testEnv('EVIDENCE_CATCHUP_PUSH_CMD', '');
  if (TEST && !fake) throw new Error('test run without EVIDENCE_CATCHUP_PUSH_CMD refuses a real git push');
  const run = (cmd, argv, extraEnv = {}) => execFileSync(cmd, argv,
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  try {
    if (fake) { run(process.execPath, [fake, file, message]); return true; }
    run('git', ['add', file]);
    run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
      'commit', '-m', `${message}\n\nCo-Authored-By: github-actions[bot] <github-actions[bot]@users.noreply.github.com>`]);
    run('bash', [path.join(__dirname, 'lib', 'push-with-retry.sh')], { PUSH_RECONCILE_MERGED_JSON: '1' });
    return true;
  } catch (e) {
    console.error(`::error::evidence catch-up reservation push failed: ${e.message}`);
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runIngest(candidate) {
  const env = {
    ...process.env,
    SCRAPER_SPEND_PURPOSE: spend.EVIDENCE_CATCHUP_PURPOSE,
    SCRAPER_SPEND_SHOW_ID: candidate.id,
    SB_CREDIT_BUDGET: String(spend.CHILD_SB_CREDIT_BUDGET),
    SD_CREDIT_BUDGET: String(spend.CHILD_SD_CREDIT_BUDGET),
  };
  try {
    const out = execFileSync(process.execPath,
      [INGEST, `--show=${candidate.id}`, `--url=${candidate.url}`],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHILD_TIMEOUT_MS });
    process.stdout.write(out.split('\n').slice(-6).map((l) => `    ${l}`).join('\n') + '\n');
    return 0;
  } catch (e) {
    const tail = `${e.stdout || ''}${e.stderr || ''}`.split('\n').filter(Boolean).slice(-4).join(' | ');
    console.log(`    ingest exited ${e.status ?? e.signal}: ${tail}`);
    return e.status ?? 1;
  }
}

async function main() {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer (got ${limitArg})`);
  const now = Date.now();
  const projected = spend.projectedReservationUsd();
  const cap = spend.EVIDENCE_CATCHUP_MONTHLY_CAP_USD;

  // Fail closed before selection: no readable spend record, no fetch.
  const first = readMonthToDate(now);
  const alreadyFetched = spend.blockedShowIds(first.rollup, now);
  const shows = loadJsonArray(SHOWS_PATH, 'shows');
  const reviews = loadJsonArray(REVIEWS_PATH, 'reviews');
  const { batch, exempt, eligible } = selectEvidenceSeedCandidates(shows, reviews, alreadyFetched, { now, limit });

  console.log(`Evidence catch-up (${dryRun ? 'DRY RUN' : 'live'}): ${eligible} eligible, taking ${batch.length} (limit ${limit})`);
  if (exempt.length) console.log(`Exempt (noReviewsExpected): ${exempt.join(', ')}`);
  console.log(`Secrets: ${SECRET_NAMES.map((n) => `${n}=${process.env[n] ? 'set' : 'MISSING'}`).join(' ')}`);
  console.log(`Review texts dir: ${fs.existsSync(REVIEW_TEXTS_DIR) ? 'present' : 'MISSING'}`);
  console.log(`Spend ${spend.monthKey(now)}: $${first.mtdUsd.toFixed(4)} of $${cap} cap; reserved per show $${projected.toFixed(4)} (fetch $${spend.projectedFetchUsd().toFixed(4)} + collect-retry allowance $${spend.downstreamAllowanceUsd().toFixed(4)})`);
  const allowed = spend.allowedFetchCount({ mtdUsd: first.mtdUsd, projectedUsd: projected, capUsd: cap, count: batch.length });
  console.log(`Cap allows ${allowed} of ${batch.length} this run`);
  writeOutput('candidates', allowed);

  let simulatedMtd = first.mtdUsd;
  let fetched = 0;
  for (let i = 0; i < batch.length; i++) {
    const c = batch[i];
    const mtdUsd = dryRun ? simulatedMtd : readMonthToDate(Date.now()).mtdUsd;
    const verdict = spend.decideFetch({ mtdUsd, projectedUsd: projected, capUsd: cap });
    if (!verdict.proceed) {
      console.log(`STOP before ${c.id}: ${verdict.reason}`);
      break;
    }
    if (dryRun) {
      console.log(`  would fetch ${c.id}: ${c.url} (projected $${projected.toFixed(4)}; ${verdict.reason})`);
      simulatedMtd += projected;
      continue;
    }
    if (fetched > 0) await sleep(FETCH_SPACING_MS);
    // Reserve the worst case BEFORE fetching: a crash or lost push after this
    // point leaves the money counted and the show blocked.
    const startMs = Date.now();
    const id = spend.reserveFetch(rollupPath(), { showId: c.id, url: c.url, nowMs: startMs, usd: projected });
    // Durable before the fetch: in CI the reservation is pushed now, not at
    // job end, so a hard kill mid-fetch cannot lose it. Throws on failure.
    const persisted = spend.persistReservation({ rollupFile: rollupPath(), showId: c.id, dryRun, pushRollup });
    console.log(`  reservation ${persisted}; fetching ${c.id}: ${c.url}`);
    const exit = runIngest(c);
    fetched++;
    // Price what the child actually wrote to the shared ledger.
    const cost = spend.spendForFetch(spend.loadTaggedLedgerRows(ledgerPath()), c.id, new Date(startMs).toISOString());
    const downstreamUsd = exit === 0 && !spend.isCollectComplete(findReviewFile(c.id, c.url)) ? spend.downstreamAllowanceUsd() : 0;
    spend.settleFetch(rollupPath(), id, { ...cost, exit, nowMs: Date.now(), downstreamUsd });
    console.log(`    exit ${exit}; spent $${cost.usd.toFixed(4)} (${cost.estimated ? 'estimated, no ledger rows' : `${cost.rows} ledger rows`})${downstreamUsd ? `; held $${downstreamUsd.toFixed(4)} for collect-review-texts retries of an incomplete text` : ''}`);
  }
  if (dryRun) {
    console.log(`Projected for this batch: $${(simulatedMtd - first.mtdUsd).toFixed(4)}; month after: $${simulatedMtd.toFixed(4)} of $${cap}`);
  } else {
    console.log(`Fetched ${fetched} of ${batch.length}`);
  }
}

main().catch((e) => {
  console.error(`::error::seed-evidence-review-stubs: ${e.message} (no further fetches)`);
  process.exit(1);
});
