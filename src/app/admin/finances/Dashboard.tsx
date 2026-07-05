'use client';

import { useCallback, useEffect, useState } from 'react';

interface TrendMonth {
  month: string;
  expense: number;
  revenue: number;
  revenuePending: number;
  net: number;
  marginPct: number | null;
}

interface CategoryRow {
  category: string;
  amount: number;
}

interface VendorRow {
  vendorKey: string;
  vendor: string;
  amount: number;
  prevAmount: number;
  momPct: number | null;
}

interface Stats {
  asOfMonth: string;
  current: TrendMonth | null;
  previous: TrendMonth | null;
  momExpenseDeltaPct: number | null;
  trend: TrendMonth[];
  byCategory: CategoryRow[];
  byVendor: VendorRow[];
  recurringVsUsage: { recurring: number; usage: number };
  burnRate: number;
  runwayMonths: number | null;
  totals: { expense: number; revenue: number; net: number };
  ledgerCounts: { expenses: number; revenue: number };
  reviewQueueCount: number;
  updatedAt: string;
  cached?: boolean;
}

type Months = 6 | 12;

const fmtMoney = (n: number | undefined | null) =>
  typeof n === 'number'
    ? n < 0
      ? `-$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';

const fmtPct = (n: number | undefined | null) =>
  typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—';

// "2026-06" → "Jun ’26" (rows) / "June 2026" (header). The bare 2-digit form
// ("Jun 26") reads like a calendar date, so always disambiguate the year.
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })} ’${String(y).slice(2)}`;
};

const fmtMonthLong = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-raised border border-white/[0.06] rounded-lg p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </div>
  );
}

function BigStat({ label, value, accent, sub }: { label: string; value: string; accent?: 'pos' | 'neg' | null; sub?: string | null }) {
  const cls = accent === 'pos' ? 'text-green-400' : accent === 'neg' ? 'text-red-400' : 'text-white';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-2xl sm:text-3xl font-extrabold tabular-nums mt-1 ${cls}`}>{value}</div>
      <div className="text-[11px] text-gray-500 mt-1 h-4">{sub || ''}</div>
    </div>
  );
}

export default function Dashboard() {
  const [months, setMonths] = useState<Months>(6);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: Months, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ months: String(m) });
      if (refresh) params.set('refresh', '1');
      const res = await fetch(`/api/admin/finance-stats?${params.toString()}`, { cache: 'no-store' });
      if (res.status === 404) {
        setError('Unauthorized — your admin session has expired. Re-enter via /api/admin/login?token=…');
        setStats(null);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error || `HTTP ${res.status}`);
        return;
      }
      setStats((await res.json()) as Stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(months);
  }, [months, load]);

  const cur = stats?.current;
  const maxTrend = stats ? Math.max(...stats.trend.map(t => Math.max(t.expense, t.revenue)), 1) : 1;

  return (
    <div className="space-y-5">
      {/* Range tabs + refresh */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-white/[0.06] overflow-hidden">
          {([6, 12] as Months[]).map(m => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                months === m ? 'bg-white text-gray-900' : 'bg-transparent text-gray-400 hover:text-white'
              }`}
            >
              {m}mo
            </button>
          ))}
        </div>
        <button
          onClick={() => load(months, true)}
          disabled={loading}
          className="px-3 py-2 text-sm font-medium border border-white/[0.06] rounded-lg text-gray-300 hover:bg-surface-raised disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {stats && (
          <span className="text-xs text-gray-500 ml-auto">
            {stats.cached ? 'cached' : 'fresh'} · updated {new Date(stats.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div className="border border-red-800 bg-red-950/40 rounded-lg p-4 text-sm text-red-300">{error}</div>
      )}

      {stats && (
        <>
          {/* Top line: this month's P&L */}
          <Card title={`This month — ${fmtMonthLong(stats.asOfMonth)}`}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <BigStat
                label="Net"
                value={fmtMoney(cur?.net)}
                accent={cur == null ? null : cur.net >= 0 ? 'pos' : 'neg'}
                sub={cur?.marginPct != null ? `${cur.marginPct.toFixed(0)}% margin` : null}
              />
              <BigStat
                label="Revenue"
                value={fmtMoney(cur?.revenue)}
                sub={cur && cur.revenuePending > 0 ? `+${fmtMoney(cur.revenuePending)} pending` : null}
              />
              <BigStat
                label="Expenses"
                value={fmtMoney(cur?.expense)}
                sub={stats.momExpenseDeltaPct != null ? `${fmtPct(stats.momExpenseDeltaPct)} MoM` : null}
                accent={stats.momExpenseDeltaPct != null && stats.momExpenseDeltaPct > 25 ? 'neg' : null}
              />
              <BigStat
                label="Burn rate"
                value={fmtMoney(stats.burnRate)}
                sub={stats.runwayMonths != null ? `${stats.runwayMonths.toFixed(1)} mo runway` : 'trailing 3-mo avg'}
              />
            </div>
          </Card>

          {/* Monthly trend — paired bars, table-legible */}
          <Card title={`Monthly trend — last ${stats.trend.length} months`}>
            <div className="space-y-2">
              {stats.trend.map(t => (
                <div key={t.month} className="grid grid-cols-[3rem_1fr_5rem] items-center gap-2 text-sm">
                  <span className="text-gray-500 text-xs">{fmtMonth(t.month)}</span>
                  <div className="space-y-1">
                    <div className="h-2 rounded-sm bg-green-400/80" style={{ width: `${Math.max((t.revenue / maxTrend) * 100, t.revenue > 0 ? 2 : 0)}%` }} />
                    <div className="h-2 rounded-sm bg-red-400/70" style={{ width: `${Math.max((t.expense / maxTrend) * 100, t.expense > 0 ? 2 : 0)}%` }} />
                  </div>
                  <span
                    className={`text-right tabular-nums font-semibold ${
                      t.revenue === 0 && t.expense === 0
                        ? 'text-gray-600' // no activity that month — don't color a meaningless zero
                        : t.net >= 0
                        ? 'text-green-400'
                        : 'text-red-400'
                    }`}
                  >
                    {fmtMoney(t.net)}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex gap-4 text-[11px] text-gray-500 mt-3">
              <span><span className="inline-block w-2 h-2 rounded-sm bg-green-400/80 mr-1" />revenue</span>
              <span><span className="inline-block w-2 h-2 rounded-sm bg-red-400/70 mr-1" />expenses</span>
              <span className="ml-auto">
                {months}mo totals: {fmtMoney(stats.totals.revenue)} in · {fmtMoney(stats.totals.expense)} out ·{' '}
                <span className={stats.totals.net >= 0 ? 'text-green-400' : 'text-red-400'}>{fmtMoney(stats.totals.net)} net</span>
              </span>
            </div>
          </Card>

          {/* Category + recurring split */}
          <div className="grid sm:grid-cols-2 gap-5">
            <Card title="This month by category">
              {stats.byCategory.length === 0 ? (
                <div className="text-sm text-gray-500">No expenses booked this month yet.</div>
              ) : (
                <div className="space-y-2">
                  {stats.byCategory.map(c => (
                    <div key={c.category} className="flex items-center gap-2 text-sm">
                      <span className="w-32 text-gray-400 shrink-0">{c.category}</span>
                      <div className="flex-1 h-2 rounded-sm bg-white/[0.06] overflow-hidden">
                        <div
                          className="h-full bg-red-400/70"
                          style={{ width: `${(c.amount / (stats.byCategory[0]?.amount || 1)) * 100}%` }}
                        />
                      </div>
                      <span className="w-20 text-right text-white font-semibold tabular-nums">{fmtMoney(c.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Recurring vs usage">
              <div className="grid grid-cols-2 gap-3">
                <BigStat label="Subscriptions" value={fmtMoney(stats.recurringVsUsage.recurring)} sub="fixed monthly" />
                <BigStat label="Usage-based" value={fmtMoney(stats.recurringVsUsage.usage)} sub="APIs, recharges" />
              </div>
              {stats.reviewQueueCount > 0 && (
                <div className="mt-3 text-xs text-yellow-500">
                  {stats.reviewQueueCount} receipt{stats.reviewQueueCount === 1 ? '' : 's'} awaiting classification in the review queue.
                </div>
              )}
            </Card>
          </div>

          {/* Vendor table */}
          {stats.byVendor.length > 0 && (
            <Card title="This month by vendor">
              <div className="overflow-x-auto -mx-4 sm:-mx-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase tracking-wide">
                      <th className="text-left font-medium px-4 sm:px-5 pb-2">Vendor</th>
                      <th className="text-right font-medium px-2 pb-2">This mo</th>
                      <th className="text-right font-medium px-2 pb-2">Last mo</th>
                      <th className="text-right font-medium px-4 sm:px-5 pb-2">MoM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byVendor.map(v => (
                      <tr key={v.vendorKey} className="border-t border-white/[0.06]">
                        <td className="px-4 sm:px-5 py-2 text-white font-medium">{v.vendor}</td>
                        <td className="px-2 py-2 text-right text-white font-semibold tabular-nums">{fmtMoney(v.amount)}</td>
                        <td className="px-2 py-2 text-right text-gray-300 tabular-nums">{fmtMoney(v.prevAmount)}</td>
                        <td
                          className={`px-4 sm:px-5 py-2 text-right tabular-nums ${
                            v.momPct == null ? 'text-gray-600' : v.momPct > 25 ? 'text-red-400' : v.momPct < 0 ? 'text-green-400' : 'text-gray-300'
                          }`}
                        >
                          {fmtPct(v.momPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div className="text-xs text-gray-600">
            {stats.ledgerCounts.expenses} expense rows · {stats.ledgerCounts.revenue} revenue rows · amounts USD ·
            businessPct applied · pending revenue excluded from net.
          </div>
        </>
      )}
    </div>
  );
}
