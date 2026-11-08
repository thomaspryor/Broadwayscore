#!/usr/bin/env node
'use strict';
/**
 * board-dispatch.js (BRO-7139 Step 2) — one nightly pass over the open board that says which
 * scheduled job owns each card, and which cards nothing owns (gaps).
 *
 * REPORT-ONLY for now: it reads Linear, classifies with board-categories.js, groups with
 * planDispatch() from board-handlers.js and appends ONE row to data/audit/board-dispatch.jsonl.
 * It never writes to Linear. Later landings move existing sweepers' card selection in here one
 * at a time (see the BRO-7139 plan); until then each sweeper still runs on its own cron.
 *
 * Kill switch: BOARD_DISPATCH_DISABLED=true (exits 0, writes nothing).
 * Usage: node scripts/board-dispatch.js [--json] [--no-write] [--ledger=<file>]
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const bc = require('./lib/board-categories.js');
const { planDispatch } = require('./lib/board-handlers.js');

const USAGE = 'Usage: node scripts/board-dispatch.js [--json] [--no-write] [--ledger=<file>]';
// Bump when a row's shape changes, so readers of the ledger can tell old rows from new ones.
const LEDGER_VERSION = 1;
const DEFAULT_LEDGER = path.join(__dirname, '..', 'data', 'audit', 'board-dispatch.jsonl');

function parseArgs(argv) {
  const opts = { json: false, write: true, ledger: DEFAULT_LEDGER };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--no-write') opts.write = false;
    else if (a.startsWith('--ledger=') && a.length > 9) opts.ledger = a.slice(9);
    else return { error: `unknown argument ${a}` };
  }
  return opts;
}

/** PURE. Where the run came from, so the freshness alarm counts only nightly CI rows. */
function runSource(env) {
  return env.GITHUB_RUN_ID ? { source: 'ci', runId: env.GITHUB_RUN_ID } : { source: 'local' };
}

function appendRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/** PURE. The ledger row for one run. */
function ledgerRow(plan, { now, broken = 0, env = process.env } = {}) {
  return {
    v: LEDGER_VERSION,
    ts: now.toISOString(),
    mode: 'report-only',
    ...runSource(env),
    open: plan.open,
    uncategorized: broken,
    handlers: Object.fromEntries(Object.entries(plan.handlers).map(([id, h]) => [id, { mode: h.mode, categories: h.categories, count: h.count, sample: h.sample }])),
    gaps: plan.gaps,
  };
}

async function main(argv = process.argv.slice(2), { graphql = null, now = new Date(), log = console.log, env = process.env } = {}) {
  if (hasHelpFlag(argv)) { log(USAGE); return 0; }
  if (env.BOARD_DISPATCH_DISABLED === 'true') { log('[board-dispatch] BOARD_DISPATCH_DISABLED=true, skipping'); return 0; }
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`${opts.error}\n${USAGE}`); return 2; }
  const gql = graphql || require('./lib/linear-client.js').graphql;
  let report;
  try {
    const issues = await bc.fetchOpenBoard({ graphql: gql });
    report = bc.categorizeBoard(issues, { now, secret: env.APPROVAL_HMAC_SECRET || null, lastRecheckStatusById: bc.readRecheckLedgerStatuses() });
  } catch (err) {
    console.error(`[board-dispatch] FAILED: ${err.message}`);
    // A failed night still leaves a row, so "ran but failing" differs from "never ran".
    if (opts.write) appendRow(opts.ledger, { v: LEDGER_VERSION, ts: now.toISOString(), mode: 'report-only', ...runSource(env), error: String(err.message).slice(0, 300) });
    return 1;
  }
  const broken = report.cards.filter((c) => /^categorize-error/.test(c.reason || '')).length;
  if (broken) console.error(`[board-dispatch] WARN ${broken} card(s) could not be categorized (counted under Other)`);
  const plan = planDispatch(report);
  const row = ledgerRow(plan, { now, broken, env });
  if (opts.write) appendRow(opts.ledger, row);
  if (opts.json) log(JSON.stringify(row, null, 2));
  else {
    log(`[board-dispatch] report-only: ${plan.open} open card(s)`);
    for (const [id, h] of Object.entries(plan.handlers)) log(`  ${id} (${h.mode}): ${h.count} [${h.sample.join(', ')}]`);
    const gapTotal = plan.gaps.reduce((a, g) => a + g.count, 0);
    log(`  gaps: ${gapTotal} card(s) nothing applies to${plan.gaps.length ? `: ${plan.gaps.map((g) => `${g.category} ${g.count}`).join(', ')}` : ''}`);
  }
  return 0;
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main, parseArgs, ledgerRow, runSource };
