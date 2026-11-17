#!/usr/bin/env node
/**
 * check-outlet-fulltext-floors.js — BRO-7702 floor guard for major-outlet full text
 * on 2025/2026 productions (rules: scripts/lib/outlet-fulltext.js).
 *
 * Fails (exit 1) when an outlet is below its floor (wsj/times-uk/standard/washpost 98%,
 * other majors 95%) while some of its gaps were never attempted, or when ANY gap older
 * than 7 days has no row in the gap-recovery attempts ledger: a gap is either being
 * worked by the nightly queue or it is a defect (owner rule: no write-off without logged
 * attempts). Advisory first (CLAUDE.md §19): CI runs it with continue-on-error, the
 * nightly job records its verdict in the nightly row and the morning digest line.
 *
 * Usage: node scripts/check-outlet-fulltext-floors.js [--json] [--ledger=PATH] [--stale-days=7]
 * Env: REVIEW_TEXTS_DIR (corpus), GAP_RECOVERY_LEDGER_PATH (ledger; default data/audit/gap-recovery-attempts.jsonl)
 */
'use strict';
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { computeOutletFulltext, evaluateFloors } = require('./lib/outlet-fulltext');

const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const asJson = argv.includes('--json');

function main() {
  const root = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
  const base = fs.existsSync(path.join(root, 'data', 'review-texts')) ? path.join(root, 'data', 'review-texts') : root;
  if (!fs.existsSync(base)) { console.error(`check-outlet-fulltext-floors: no review-texts corpus at ${base}`); return 2; }
  const ledger = opt('ledger', process.env.GAP_RECOVERY_LEDGER_PATH || path.join(__dirname, '..', 'data', 'audit', 'gap-recovery-attempts.jsonl'));
  const attemptedKeys = new Set();
  let ledgerRows = 0;
  try {
    for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.reviewKey) { attemptedKeys.add(r.reviewKey); ledgerRows++; } } catch { /* torn line */ }
    }
  } catch (e) { console.error(`check-outlet-fulltext-floors: ledger unreadable (${ledger}): ${e.message}`); return 2; }
  const { rates, gaps } = computeOutletFulltext({ base });
  const v = evaluateFloors({ rates, gaps, attemptedKeys, staleDays: parseInt(opt('stale-days', '7'), 10) || 7 });
  if (asJson) { console.log(JSON.stringify({ ...v, ledgerRows, gapCount: gaps.length }, null, 1)); return v.ok ? 0 : 1; }
  console.log(`Major-outlet full text, 2025/26 productions (ledger ${ledgerRows} rows, ${gaps.length} gaps):`);
  for (const x of v.outlets) {
    console.log(`  ${x.outlet.padEnd(16)} ${String(x.pct).padStart(5)}%  floor ${x.floor}%  gaps ${String(x.gaps).padStart(3)}  never attempted ${String(x.unattempted).padStart(3)}${x.fail ? '  FAIL' : x.below ? '  below floor (all gaps attempted)' : ''}`);
  }
  if (v.staleUnattempted.length) {
    console.log(`\n${v.staleUnattempted.length} gap(s) older than the stale window with no recovery attempt logged:`);
    for (const g of v.staleUnattempted.slice(0, 40)) console.log(`  ${g.reviewKey} [${g.tier}] ${g.ageDays == null ? 'undated' : `${g.ageDays}d`}`);
  }
  console.log(v.ok ? '\nOK: every outlet is at its floor or every gap is being worked.' : `\nFAIL: ${v.failingOutlets.length} outlet(s) below floor with unattempted gaps; ${v.staleUnattempted.length} stale unattempted gap(s).`);
  return v.ok ? 0 : 1;
}

process.exitCode = main();
