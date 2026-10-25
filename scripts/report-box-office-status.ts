/**
 * Box Office Scorecard v2 (BRO-5007) build-time report on real data: one row
 * per running Broadway show with its status, multiple and cost basis.
 *
 *   npx tsx scripts/report-box-office-status.ts [--json] [--show=slug,slug]
 *
 * Read-only. The feature is unreleased; this is how the status table is
 * reviewed before any UI ships.
 */
import {
  getBoxOfficeV2StaleReasons,
  getRunningBoxOfficeV2,
  getShowBoxOfficeV2,
  type ShowBoxOfficeV2,
} from '../src/lib/data-commercial';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npx tsx scripts/report-box-office-status.ts [--json] [--show=slug,slug]');
  process.exit(0);
}
// Exit 2 on stale inputs (the getters would return nothing anyway).
const stale = getBoxOfficeV2StaleReasons();
if (stale.length) {
  console.error(`Stale inputs, refresh core data first:\n- ${stale.join('\n- ')}`);
  process.exit(2);
}
const showArg = args.find((a) => a.startsWith('--show='));
const rows: ShowBoxOfficeV2[] = showArg
  ? showArg.slice(7).split(',').map((s) => getShowBoxOfficeV2(s.trim())).filter((r): r is ShowBoxOfficeV2 => !!r)
  : getRunningBoxOfficeV2();

if (args.includes('--json')) {
  console.log(JSON.stringify(rows.map(({ series, closedRun, ...r }) => ({ ...r, chartWeeks: series.length, closedRun: closedRun && { ...closedRun, series: closedRun.series.length } })), null, 2));
  process.exit(0);
}

const k = (n: number | null | undefined) => (n == null ? '-' : `$${Math.round(n / 1000)}K`);
const x = (n: number | null | undefined) => (n == null ? '-' : `${n.toFixed(2)}x`);
console.log(['Show', 'Status', 'Multiple (range)', 'Break-even', 'Basis', 'Streak', 'Trend', 'Weeks'].join(' | '));
for (const r of rows) {
  const status = r.availability === 'ok' ? `${r.band}${r.nonprofit ? ' (nonprofit)' : ''}` : r.availability;
  const mult = r.multiple ? `${x(r.multiple.mid)} (${x(r.multiple.lo)}-${x(r.multiple.hi)})` : '-';
  const streak = r.streak ? `${r.streak.weeks}${r.streak.atLeast ? '+' : ''} ${r.streak.side}` : '-';
  console.log([r.title, status, mult, k(r.breakEven), r.costBasis ?? '-', streak, r.trend, r.weeksReported].join(' | '));
}
const noCost = rows.filter((r) => r.noCostReason);
if (noCost.length) {
  console.log('\nNo cost:');
  for (const r of noCost) console.log(`- ${r.title}: ${r.noCostReason}`);
}
