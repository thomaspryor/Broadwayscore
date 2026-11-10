#!/usr/bin/env node
'use strict';
/**
 * BRO-7247: exit 1 if the opening-night lane made any paid scraper call in [--from, --to) (default ledger
 * data/audit/scraper-spend-ledger.jsonl). Exit 0 = zero paid calls, 2 = bad usage.
 *   node scripts/lane-preembargo-spend-check.js --from=2026-11-10T00:30:00Z --to=2026-11-10T03:00:00Z [--show=ID] [--ledger=FILE]
 */
const path = require('path');
const { paidCallsInWindow, readLedgerFile } = require('./lib/lane-spend-window');

function main(argv) {
  const arg = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const from = arg('from'); const to = arg('to');
  if (!from || !to) { console.error('usage: lane-preembargo-spend-check.js --from=ISO --to=ISO [--show=ID] [--ledger=FILE]'); return 2; }
  let res;
  try {
    res = paidCallsInWindow(readLedgerFile(arg('ledger') || path.join(__dirname, '..', 'data', 'audit', 'scraper-spend-ledger.jsonl')), { from, to, showId: arg('show') || undefined });
  } catch (e) { console.error(String(e.message || e)); return 2; }
  if (res.paid.length) {
    console.log(`FAIL: ${res.paid.length} paid lane call(s), ${res.credits} credits in [${from}, ${to}): ${JSON.stringify(res.byProvider)}`);
    return 1;
  }
  console.log(`OK: zero paid lane calls in [${from}, ${to})`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
