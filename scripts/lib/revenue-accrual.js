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

function nextMonthOf(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Closed months whose affiliate row is missing or still 'pending'.
 *
 * Why this exists (BRO-8273): finalization used to be possible only on days
 * 1-12 of the following month (Impact's 45-day cap on a trailing window). The
 * accrual step is continue-on-error, so a few failed or missed runs inside
 * that window left September 2026 with NO row at all and August stuck on
 * 'pending' forever, while the bank showed the deposits. Every closed month
 * from the first affiliate row onward must end up 'realized'; the caller
 * fetches each returned month with an explicit month-sized Impact range
 * (31 days, inside the cap), so the window no longer matters.
 *
 * Months before the first affiliate row are never invented. Capped at
 * `maxMonths` most recent so one run stays a handful of API calls.
 *
 * @returns {string[]} 'YYYY-MM' months, oldest first
 */
function monthsNeedingFinalization({ todayIso, ledger = [], maxMonths = 6 }) {
  const rows = ledger.filter((r) => r.sourceKey === 'affiliate');
  if (!rows.length) return [];
  const first = rows.map((r) => r.month).sort()[0];
  const last = priorMonthOf(todayIso);
  const out = [];
  for (let m = first; m <= last; m = nextMonthOf(m)) {
    const row = rows.find((r) => r.month === m);
    if (!row || row.status !== 'realized') out.push(m);
  }
  return out.slice(-maxMonths);
}

/** First and last instant (UTC) of a 'YYYY-MM' month, for explicit Impact ranges. */
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0)),
    end: new Date(Date.UTC(y, m, 1, 0, 0, 0) - 1000),
  };
}

/**
 * Apply explicitly-fetched month totals as 'realized' rows. Pure.
 * @param {Array} ledger
 * @param {Array<{month:string, commission:number}>} finals
 * @param {string} todayIso
 */
function applyMonthFinalizations(ledger, finals, todayIso) {
  const out = ledger.map((r) => ({ ...r }));
  const changes = [];
  for (const f of finals) {
    const row = {
      month: f.month, sourceKey: 'affiliate', source: 'Affiliate commissions',
      amountUsd: round2(Math.max(f.commission, 0)), status: 'realized', accruedAt: todayIso,
    };
    changes.push({ month: f.month, action: upsert(out, row), amountUsd: row.amountUsd, status: row.status });
  }
  return { ledger: out, changes };
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

module.exports = {
  computeAffiliateAccrual, priorMonthOf, daysInPriorMonth,
  monthsNeedingFinalization, monthRange, applyMonthFinalizations,
};
