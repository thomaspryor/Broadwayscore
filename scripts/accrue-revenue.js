#!/usr/bin/env node
/**
 * accrue-revenue.js — write affiliate commission into the finance revenue
 * ledger. Runs after ingest-finances.js in finance-ingest.yml.
 *
 * Uses getAffiliateStats (same module as /admin/affiliate and the affiliate
 * report) and books totals.commission ONLY — never totals.revenue (that's the
 * partner's ticket sales, not ours; see CLAUDE.md §Critic/commercial rules and
 * the revenueSources note in finance-vendors.json).
 *
 * Window math (Impact caps ranges at 45 days):
 * - current month  = last dayOfMonth days (≈ month-to-date) → 'pending' row
 * - prior month    = (last dayOfMonth + priorMonthLen days) − MTD, only fetched
 *   through the 12th (12 + 31 = 43 ≤ 45) → finalizes prior month to 'realized'
 *
 * Flags: --out=DIR (default data/finances) · --dry-run · --today=YYYY-MM-DD (tests)
 *
 * Aborts WITHOUT writing if the Impact provider errored or is skipped —
 * a partial fetch would silently understate the month.
 */
const fs = require('fs');
const path = require('path');
const { getAffiliateStats } = require('./lib/affiliate-stats');
const { computeAffiliateAccrual, daysInPriorMonth } = require('./lib/revenue-accrual');

function parseArgs(argv) {
  const a = { out: 'data/finances', dryRun: false, today: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg.startsWith('--out=')) a.out = arg.slice(6);
    else if (arg.startsWith('--today=')) a.today = arg.slice(8);
  }
  return a;
}

function impactHealthy(stats) {
  if ((stats.errors || []).some((e) => e.provider === 'impact')) return false;
  if (!stats.impact || stats.impact.skipped) return false;
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const todayIso = args.today || new Date().toISOString().slice(0, 10);
  const dom = Number(todayIso.slice(8, 10));

  const mtdStats = await getAffiliateStats({ days: Math.max(dom, 1) });
  if (!impactHealthy(mtdStats)) {
    console.error('Impact unavailable — refusing to accrue partial revenue.',
      JSON.stringify(mtdStats.errors || []), mtdStats.impact && mtdStats.impact.reason || '');
    process.exit(1);
  }
  const mtdCommission = mtdStats.totals.commission;

  let priorWindowCommission = null;
  if (dom <= 12) {
    const priorStats = await getAffiliateStats({ days: dom + daysInPriorMonth(todayIso) });
    if (impactHealthy(priorStats))

      priorWindowCommission = priorStats.totals.commission;
    else console.error('Prior-month window fetch failed — finalization deferred to a later run.');
  }

  const ledgerPath = path.join(args.out, 'revenue-ledger.json');
  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch { /* first run */ }

  const { ledger: next, changes } = computeAffiliateAccrual({ todayIso, mtdCommission, priorWindowCommission, ledger });
  for (const c of changes) console.log(`  ${c.month} affiliate $${c.amountUsd} (${c.status}) — ${c.action}`);

  if (args.dryRun) { console.log('[dry-run] nothing written.'); return; }
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(next, null, 2));
  console.log(`Wrote ${next.length} revenue rows → ${ledgerPath}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parseArgs, impactHealthy };
