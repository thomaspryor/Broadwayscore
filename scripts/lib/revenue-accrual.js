/**
 * revenue-accrual.js — pure upsert logic for the affiliate revenue ledger.
 * NO network: the Impact/Partnerize fetch lives in scripts/accrue-revenue.js.
 * Kept pure so the real function is `require()`d by the unit test (Rule 15).
 *
 * Model (cash-ish, month buckets):
 * - The current month accrues as a single 'pending' affiliate row, refreshed
 *   on every run with the month-to-date commission.
 * - Early next month (while the prior month still fits Impact's 45-day window)
 *   the prior month's row is finalized to 'realized' as
 *   (prior-window commission − MTD commission). finance-stats already excludes
 *   pending rows from net, so an accruing month never inflates the P&L.
 * - Non-affiliate rows (e.g. Buy Me A Coffee) are never touched.
 */

function round2(n) { return Math.round(n * 100) / 100; }

function monthOf(iso) { return String(iso).slice(0, 7); }

function priorMonthOf(iso) {
  const [y, m] = monthOf(iso).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInPriorMonth(iso) {
  const [y, m] = monthOf(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
}

function upsert(ledger, row) {
  const i = ledger.findIndex((r) => r.month === row.month && r.sourceKey === row.sourceKey);
  if (i === -1) { ledger.push(row); return 'inserted'; }
  const prev = ledger[i];
  // Never downgrade a realized month back to pending (a late re-run with a
  // shorter window must not reopen closed books).
  if (prev.status === 'realized' && row.status === 'pending') return 'kept-realized';
  ledger[i] = { ...prev, ...row };
  return 'updated';
}

/**
 * @param {object} opts
 * @param {string} opts.todayIso            'YYYY-MM-DD' (UTC)
 * @param {number} opts.mtdCommission       commission for the last dayOfMonth days
 * @param {number|null} opts.priorWindowCommission commission for the last
 *        (dayOfMonth + daysInPriorMonth) days, or null when not fetched
 * @param {Array} opts.ledger               existing revenue-ledger rows (mutated copy returned)
 */
function computeAffiliateAccrual({ todayIso, mtdCommission, priorWindowCommission = null, ledger = [] }) {
  const out = ledger.map((r) => ({ ...r }));
  const changes = [];
  const month = monthOf(todayIso);

  const cur = {
    month,
    sourceKey: 'affiliate',
    source: 'Affiliate commissions',
    amountUsd: round2(mtdCommission),
    status: 'pending',
    accruedAt: todayIso,
  };
  changes.push({ month, action: upsert(out, cur), amountUsd: cur.amountUsd, status: cur.status });

  if (priorWindowCommission != null) {
    const prior = {
      month: priorMonthOf(todayIso),
      sourceKey: 'affiliate',
      source: 'Affiliate commissions',
      amountUsd: round2(Math.max(priorWindowCommission - mtdCommission, 0)),
      status: 'realized',
      accruedAt: todayIso,
    };
    changes.push({ month: prior.month, action: upsert(out, prior), amountUsd: prior.amountUsd, status: prior.status });
  }

  return { ledger: out, changes };
}

module.exports = { computeAffiliateAccrual, priorMonthOf, daysInPriorMonth };
