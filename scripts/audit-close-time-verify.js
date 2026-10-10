#!/usr/bin/env node
/**
 * audit-close-time-verify.js — REPORT ONLY. How many in-flight cards would
 * the close-time acceptance verify (task #1003) refuse to close right now?
 *
 *   node scripts/audit-close-time-verify.js               # default: 25 cards, 20 min
 *   node scripts/audit-close-time-verify.js --limit 60 --time-budget-min 30
 *   node scripts/audit-close-time-verify.js --json
 *   node scripts/audit-close-time-verify.js --help
 *
 * This exists because arming a close-time check against a trunk that is red on
 * ~96% of runs could, if the scoping were wrong, deadlock every card in
 * flight. The card's pre-mortem review made this run MANDATORY before the
 * check went live: if the refused count is large, the scoping is wrong and
 * gets fixed before anything is armed.
 *
 * It writes nothing — no Notion, no ledger, no snapshot. It runs each card's
 * own acceptance command in ONE shared detached checkout of origin/main
 * (scripts/lib/acceptance-check-core.js) and folds the verdicts through the
 * same decision function notion-brain.js uses (scripts/lib/close-time-verify.js),
 * so the number it prints is the number that would actually happen.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const { hasHelpFlag } = require('./lib/cli-help.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { findCardDispatch, decideClose, summarizeDryRun } = require('./lib/close-time-verify.js');
const { makeFreshCheckout, removeCheckout, runVerify } = require('./lib/acceptance-check-core.js');

const REPO = path.join(__dirname, '..');
const PER_CARD_TIMEOUT_MS = Number(process.env.CLOSE_VERIFY_TIMEOUT_MS || 120000);

const USAGE = `audit-close-time-verify.js — report-only dry run of the close-time acceptance verify.

Usage:
  node scripts/audit-close-time-verify.js [--limit 25] [--time-budget-min 20] [--status "In progress"] [--json]
  node scripts/audit-close-time-verify.js --help

Prints how many currently-open cards would be REFUSED a close by
scripts/lib/close-time-verify.js. Writes nothing anywhere.`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const [k, inline] = t.slice(2).split('=');
    if (inline !== undefined) { a[k] = inline; continue; }
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true;
    else { a[k] = n; i++; }
  }
  return a;
}

function listOpenCards({ status, limit }) {
  const out = execFileSync('node', [
    path.join(__dirname, 'notion-brain.js'), 'search', '--status', status, '--limit', String(limit),
  ], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : (parsed.results || []);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return 0; }
  const args = parseArgs(process.argv.slice(2));
  const limit = Number(args.limit || 25);
  const status = typeof args.status === 'string' ? args.status : 'In progress';
  const budgetMs = Number(args['time-budget-min'] || 20) * 60000;
  const started = Date.now();

  const cards = listOpenCards({ status, limit });
  console.error(`[dry-run] ${cards.length} card(s) with status "${status}" (limit ${limit})`);

  const entries = dispatchLedger.readEntries();
  const results = [];
  let checkout = null;
  let deferred = 0;

  try {
    for (const card of cards) {
      const dispatch = findCardDispatch({ entries, notionId: card.id });
      // Cards with no command need no checkout and cost nothing — decide and
      // move on, so the time budget is spent only on cards that can block.
      if (!dispatch.verifyCmd) {
        const decision = decideClose({ dispatch });
        results.push({ cardId: card.id, subject: card.name, taskId: dispatch.taskId, decision });
        continue;
      }
      if (Date.now() - started > budgetMs) { deferred++; continue; }
      if (!checkout) {
        console.error('[dry-run] preparing one detached checkout of origin/main…');
        checkout = makeFreshCheckout({ repo: REPO, prefix: 'close-verify-dryrun-' });
      }
      const verifyResult = runVerify(checkout.wt, dispatch.verifyCmd, {
        attempts: 1, timeoutMs: PER_CARD_TIMEOUT_MS, prepared: checkout.prepared,
      });
      const decision = decideClose({ dispatch, verifyResult });
      results.push({ cardId: card.id, subject: card.name, taskId: dispatch.taskId, decision });
      console.error(`[dry-run] ${decision.allowed ? 'close' : 'REFUSE'}  ${decision.verdict.padEnd(24)} ${String(card.name).slice(0, 70)}`);
    }
  } finally {
    removeCheckout(checkout);
  }

  const summary = summarizeDryRun(results);
  // Cards skipped for time are NOT silently folded into "would close" — a
  // capped sweep that reads as full coverage is how a bad number hides.
  if (deferred) console.error(`[dry-run] ${deferred} card(s) NOT checked (time budget exhausted) — not counted either way`);

  if (args.json) {
    console.log(JSON.stringify({ ...summary, deferred, status, checkedAt: new Date().toISOString() }, null, 2));
  } else {
    console.log(`\n${summary.line}`);
    console.log(`  deferred (unchecked): ${deferred}`);
    for (const [verdict, n] of Object.entries(summary.counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(verdict).padEnd(26)} ${n}`);
    }
    if (summary.blockedCards.length) {
      console.log('\nWould be refused:');
      for (const b of summary.blockedCards) console.log(`  - ${b.subject || b.cardId}\n      ${b.verifyCmd}`);
    }
  }
  // Report-only, ALWAYS exit 0: a blocked card is this script's FINDING, not
  // its failure. (An earlier version had an exit-code branch its own call
  // pattern could never reach — dead code that read as a real gate.)
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main, USAGE, parseArgs };
