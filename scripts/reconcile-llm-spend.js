#!/usr/bin/env node
/**
 * Compare the LLM usage ledger to vendor receipts for a month (BRO-7521).
 * Receipts live in data/audit/llm-vendor-receipts.json (month -> provider ->
 * {usd, source}); add a month once the invoice is in. A provider whose ledger
 * total is >20% off its receipt prints a GAP line and, in CI, a ::warning::.
 *   node scripts/reconcile-llm-spend.js [--month=YYYY-MM]   (default: last month)
 * Exit 0 always: reconciliation is observation, not a gate.
 */
const fs = require('fs');
const path = require('path');
const { readRows } = require('./lib/llm-usage-summary');
const { reconcile, previousMonth } = require('./lib/llm-spend-reconcile');

const RECEIPTS = path.join(__dirname, '..', 'data', 'audit', 'llm-vendor-receipts.json');
const arg = process.argv.find((a) => a.startsWith('--month='));
const month = arg ? arg.slice(8) : previousMonth();
let receipts = {};
try { receipts = JSON.parse(fs.readFileSync(RECEIPTS, 'utf8')); } catch { /* no receipts yet */ }
const res = reconcile({ rows: readRows(), receipts, month });
if (!receipts[month]) console.log(`${month}: no receipts in data/audit/llm-vendor-receipts.json; ledger only`);
for (const l of res.lines) console.log(l);
// Warn in CI only during the first week of the month so a standing gap does not repeat daily.
if (process.env.GITHUB_ACTIONS && res.flagged.length && (arg || new Date().getUTCDate() <= 7)) console.log(`::warning title=LLM spend gap::${month} ${res.flagged.join(', ')} ledger differs from receipts by more than 20%`);
