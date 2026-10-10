/**
 * finance-stats.js — pure P&L rollup for the BWSC finance tracker. Single source
 * of truth shared by the admin API route (src/app/api/admin/finance-stats) and
 * the monthly report, mirroring the scripts/lib/affiliate-stats.js pattern.
 *
 * Takes already-loaded ledger arrays (the Gmail/GitHub fetch layer lives in
 * scripts/ingest-finances.js and the API route), so this stays network-free and
 * unit-testable.
 *
 * Expense row shape (see finance-matchers.toLedgerRow): { date, vendorKey,
 *   vendor, category, kind, amountUsd, businessPct, amountBusiness }.
 * Revenue row shape (see accrue-revenue): { month, sourceKey, source,
 *   amountUsd, status: 'realized'|'pending' }.
 */

function monthKey(dateStr) {
  return String(dateStr || '').slice(0, 7); // YYYY-MM
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pct(part, whole) {
  if (!whole) return null;
  return round2((part / whole) * 100);
}

// Enumerate the N most recent YYYY-MM keys ending at asOfMonth (inclusive).
function recentMonths(asOfMonth, monthsBack) {
  const [y, m] = asOfMonth.split('-').map(Number);
  const out = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function sumBy(rows, keyFn, valFn) {
  const acc = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    acc.set(k, round2((acc.get(k) || 0) + valFn(r)));
  }
  return acc;
}

/**
 * @param {object} opts
 * @param {Array} opts.expenses  expense ledger rows
 * @param {Array} opts.revenue   revenue ledger rows
 * @param {string} opts.asOfMonth 'YYYY-MM' (defaults to latest month present)
 * @param {number} opts.monthsBack how many months of trend (default 12)
 * @param {number|null} opts.cashOnHand optional, enables runway
 */
function computeFinanceStats({ expenses: rawExpenses = [], revenue = [], asOfMonth, monthsBack = 12, cashOnHand = null } = {}) {
  // Rows marked excluded (externally paid — see finance-vendors.json
  // externallyPaid) never count toward any total; surfaced separately below.
  const expenses = rawExpenses.filter((e) => !e.excluded);
  const excludedRows = rawExpenses.filter((e) => e.excluded);

  const allMonths = [
    ...expenses.map((e) => monthKey(e.date)),
    ...revenue.map((r) => r.month || monthKey(r.date)),
  ].filter(Boolean).sort();
  const latest = asOfMonth || allMonths[allMonths.length - 1] || monthKey(new Date().toISOString());
  const months = recentMonths(latest, monthsBack);
  const monthSet = new Set(months);

  // Business-booked expense per month (amountBusiness respects businessPct).
  const expByMonth = sumBy(
    expenses.filter((e) => monthSet.has(monthKey(e.date))),
    (e) => monthKey(e.date),
    (e) => (e.amountBusiness != null ? e.amountBusiness : e.amountUsd) || 0,
  );
  // Realized revenue per month (pending excluded from net).
  const realizedRev = revenue.filter((r) => (r.status || 'realized') === 'realized');
  const revByMonth = sumBy(
    realizedRev.filter((r) => monthSet.has(r.month || monthKey(r.date))),
    (r) => r.month || monthKey(r.date),
    (r) => r.amountUsd || 0,
  );
  const pendingByMonth = sumBy(
    revenue.filter((r) => r.status === 'pending' && monthSet.has(r.month || monthKey(r.date))),
    (r) => r.month || monthKey(r.date),
    (r) => r.amountUsd || 0,
  );

  const trend = months.map((month) => {
    const expense = expByMonth.get(month) || 0;
    const rev = revByMonth.get(month) || 0;
    const net = round2(rev - expense);
    return {
      month,
      expense,
      revenue: rev,
      revenuePending: pendingByMonth.get(month) || 0,
      net,
      marginPct: pct(net, rev),
    };
  });

  const current = trend[trend.length - 1] || null;
  const prev = trend[trend.length - 2] || null;

  // Current-month breakdowns.
  const curExpenses = expenses.filter((e) => monthKey(e.date) === latest);
  const prevExpenses = expenses.filter((e) => prev && monthKey(e.date) === prev.month);
  const val = (e) => (e.amountBusiness != null ? e.amountBusiness : e.amountUsd) || 0;

  const byCategory = [...sumBy(curExpenses, (e) => e.category, val).entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  const prevVendor = sumBy(prevExpenses, (e) => e.vendorKey, val);
  const byVendor = [...sumBy(curExpenses, (e) => e.vendorKey, val).entries()]
    .map(([vendorKey, amount]) => {
      const vendor = (curExpenses.find((e) => e.vendorKey === vendorKey) || {}).vendor || vendorKey;
      const prevAmt = prevVendor.get(vendorKey) || 0;
      return { vendorKey, vendor, amount, prevAmount: prevAmt, momPct: pct(amount - prevAmt, prevAmt) };
    })
    .sort((a, b) => b.amount - a.amount);

  const recurring = round2(curExpenses.filter((e) => e.kind === 'subscription').reduce((s, e) => s + val(e), 0));
  const usage = round2(curExpenses.filter((e) => e.kind !== 'subscription').reduce((s, e) => s + val(e), 0));

  // Burn = trailing-3-month average business expense.
  const last3 = trend.slice(-3);
  const burnRate = last3.length ? round2(last3.reduce((s, t) => s + t.expense, 0) / last3.length) : 0;
  const runwayMonths = cashOnHand != null && burnRate > 0 ? round2(cashOnHand / burnRate) : null;

  return {
    asOfMonth: latest,
    current,
    previous: prev,
    momExpenseDeltaPct: current && prev ? pct(current.expense - prev.expense, prev.expense) : null,
    trend,
    byCategory,
    byVendor,
    recurringVsUsage: { recurring, usage },
    burnRate,
    runwayMonths,
    excluded: {
      count: excludedRows.length,
      totalUsd: round2(excludedRows.reduce((s, e) => s + ((e.amountBusiness != null ? e.amountBusiness : e.amountUsd) || 0), 0)),
    },
    totals: {
      expense: round2(trend.reduce((s, t) => s + t.expense, 0)),
      revenue: round2(trend.reduce((s, t) => s + t.revenue, 0)),
      net: round2(trend.reduce((s, t) => s + t.net, 0)),
    },
  };
}

module.exports = { computeFinanceStats, monthKey, recentMonths };
