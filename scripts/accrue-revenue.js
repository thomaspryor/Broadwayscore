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
const { getAffiliateStats, fetchImpactCommissionRange } = require('./lib/affiliate-stats');
const {
  computeAffiliateAccrual, daysInPriorMonth, monthsNeedingFinalization, monthRange, applyMonthFinalizations,
} = require('./lib/revenue-accrual');

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

  const mtdStats = await getAffiliateStats({ days: Math.max(dom, 1), retry: true });
  if (!impactHealthy(mtdStats)) {
    console.error('Impact unavailable — refusing to accrue partial revenue.',
      JSON.stringify(mtdStats.errors || []), mtdStats.impact && mtdStats.impact.reason || '');
    process.exit(1);
  }
  const mtdCommission = mtdStats.totals.commission;

  let priorWindowCommission = null;
  if (dom <= 12) {
    const priorStats = await getAffiliateStats({ days: dom + daysInPriorMonth(todayIso), retry: true });
    if (impactHealthy(priorStats))

      priorWindowCommission = priorStats.totals.commission;
    else console.error('Prior-month window fetch failed — finalization deferred to a later run.');
  }

  const ledgerPath = path.join(args.out, 'revenue-ledger.json');
  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch { /* first run */ }

  let { ledger: next, changes } = computeAffiliateAccrual({ todayIso, mtdCommission, priorWindowCommission, ledger });

  // Self-heal (BRO-8273): any closed month still missing or 'pending' is
  // finalized from an explicit month-sized Impact range, whatever day it is
  // today. A failed fetch for one month leaves it for the next run and is
  // surfaced as a workflow error annotation (this step is continue-on-error,
  // so an annotation is the only thing that makes a stuck month visible).
  const stuck = [];
  const finals = [];
  const allStuck = monthsNeedingFinalization({ todayIso, ledger: next, maxMonths: 1000 });
  const todo = allStuck.slice(-6);
  if (allStuck.length > todo.length) {
    console.error(`::warning title=Affiliate revenue backlog::${allStuck.length - todo.length} older month(s) not finalized this run (6 per run)`);
  }
  for (const month of todo) {
    const { start, end } = monthRange(month);
    let done = false;
    for (let attempt = 1; attempt <= 2 && !done; attempt++) {
      try {
        finals.push({ month, commission: await fetchImpactCommissionRange(start, end, { timeoutMs: 60000 }) });
        done = true;
      } catch (e) {
        if (attempt === 2) {
          stuck.push(month);
          console.error(`::error title=Affiliate revenue not finalized::${month}: ${e.message}`);
        }
      }
    }
  }
  if (finals.length) {
    const healed = applyMonthFinalizations(next, finals, todayIso);
    next = healed.ledger;
    changes = changes.concat(healed.changes);
  }
  for (const c of changes) console.log(`  ${c.month} affiliate $${c.amountUsd} (${c.status}) — ${c.action}`);

  if (args.dryRun) { console.log('[dry-run] nothing written.'); if (stuck.length) process.exit(1); return; }
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(next, null, 2));
  console.log(`Wrote ${next.length} revenue rows → ${ledgerPath}`);
  if (stuck.length) process.exit(1); // finalized months are saved above; non-zero fails the step loudly
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parseArgs, impactHealthy };
