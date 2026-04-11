'use client';

import { useCallback, useEffect, useState } from 'react';

interface CampaignSummary {
  name: string;
  count: number;
  revenue: number;
  payout: number;
}

interface TodaytixMix {
  newCount: number;
  existingCount: number;
  unknownCount: number;
  newRevenue: number;
  existingRevenue: number;
  newPayout: number;
  existingPayout: number;
  rateBumpUplift: number;
}

interface ImpactBlock {
  skipped?: boolean;
  reason?: string;
  conversions?: number;
  totalRevenue?: number;
  totalPayout?: number;
  byCampaign?: CampaignSummary[];
  todaytixMix?: TodaytixMix | null;
}

interface PartnerizeBlock {
  skipped?: boolean;
  reason?: string;
  clicks?: number;
  conversions?: number;
  conversionRate?: number;
}

interface PlatformCount {
  platform: string;
  count: number;
}

interface PosthogBlock {
  skipped?: boolean;
  reason?: string;
  pageviews?: number;
  showPageviews?: number;
  totalClicks?: number;
  byPlatform?: PlatformCount[];
}

interface WoWDelta {
  commissionPct: number | null;
  revenuePct: number | null;
  priorCommission: number;
  priorRevenue: number;
}

interface Funnel {
  showPageviews: number | null;
  ticketClicks: number | null;
  conversions: number;
  commission: number;
  rates: {
    clicksPerShowView: number | null;
    convsPerClick: number | null;
    epc: number | null;
  };
}

interface UnitEconomics {
  avgOrderValue: number | null;
  avgCommissionPerConv: number | null;
  takeRate: number | null;
  earningsPerClick: number | null;
}

interface PlatformRow {
  platform: string;
  clicks: number;
  conversions: number | null;
  commission: number | null;
  revenue: number | null;
  conversionRate: number | null;
  epc: number | null;
  affiliate: boolean;
}

interface Stats {
  window: { days: number; startDate: string; endDate: string };
  totals: { commission: number; revenue: number; conversions: number };
  funnel: Funnel;
  unitEconomics: UnitEconomics;
  perPlatform: PlatformRow[];
  wowDelta: WoWDelta | null;
  impact: ImpactBlock | null;
  partnerize: PartnerizeBlock | null;
  posthog: PosthogBlock | null;
  errors: { provider: string; message: string }[];
  updatedAt: string;
  cached?: boolean;
}

type Timeframe = 7 | 30;

const fmtMoney = (n: number | undefined | null) =>
  typeof n === 'number' ? `$${n.toFixed(2)}` : '—';

const fmtInt = (n: number | undefined | null) =>
  typeof n === 'number' ? n.toLocaleString() : '—';

const fmtPct = (n: number | undefined | null) =>
  typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </div>
  );
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: 'pos' | 'neg' | null }) {
  const accentClass =
    accent === 'pos' ? 'text-green-400' : accent === 'neg' ? 'text-red-400' : 'text-white';
  return (
    <div className="flex justify-between items-baseline py-1">
      <span className="text-sm text-gray-400">{label}</span>
      <span className={`text-base font-semibold tabular-nums ${accentClass}`}>{value}</span>
    </div>
  );
}

function FunnelStage({
  label,
  value,
  rateLabel,
  accent,
}: {
  label: string;
  value: string;
  rateLabel: string | null;
  accent?: boolean;
}) {
  return (
    <div className="bg-gray-950/60 border border-gray-800 rounded-md p-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-xl sm:text-2xl font-extrabold tabular-nums mt-1 ${accent ? 'text-green-400' : 'text-white'}`}>
        {value}
      </div>
      <div className="text-[11px] text-gray-500 mt-1 h-4">{rateLabel || ''}</div>
    </div>
  );
}

function UnitStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-xl font-bold text-white tabular-nums mt-1">{value}</div>
      <div className="text-[10px] text-gray-500 mt-0.5">{hint}</div>
    </div>
  );
}

export default function Dashboard() {
  const [timeframe, setTimeframe] = useState<Timeframe>(7);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: Timeframe, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (days === 7) params.set('wow', '1');
      if (refresh) params.set('refresh', '1');
      const res = await fetch(`/api/admin/affiliate-stats?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        setError('Unauthorized — your admin session has expired. Re-enter via /api/admin/login?token=…');
        setStats(null);
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as Stats;
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(timeframe);
  }, [timeframe, load]);

  const impact = stats?.impact;
  const partnerize = stats?.partnerize;
  const posthog = stats?.posthog;
  const wow = stats?.wowDelta;

  const commissionAccent: 'pos' | 'neg' | null = wow?.commissionPct == null
    ? null
    : wow.commissionPct >= 0
    ? 'pos'
    : 'neg';

  return (
    <div className="space-y-5">
      {/* Timeframe tabs + refresh */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-gray-800 overflow-hidden">
          {([7, 30] as Timeframe[]).map(d => (
            <button
              key={d}
              onClick={() => setTimeframe(d)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                timeframe === d
                  ? 'bg-white text-gray-900'
                  : 'bg-transparent text-gray-400 hover:text-white'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
        <button
          onClick={() => load(timeframe, true)}
          disabled={loading}
          className="px-3 py-2 text-sm font-medium border border-gray-800 rounded-lg text-gray-300 hover:bg-gray-900 disabled:opacity-50"
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
        <div className="border border-red-800 bg-red-950/40 rounded-lg p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {stats && (
        <>
          {/* Top-line: commission earned (our revenue) + WoW */}
          <Card title={`Our earnings — last ${stats.window.days} days`}>
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide">Commission earned</div>
              <div className="text-4xl sm:text-5xl font-extrabold text-white tabular-nums leading-none mt-1">
                {fmtMoney(stats.totals.commission)}
              </div>
              {wow?.commissionPct != null && (
                <div className={`text-sm font-semibold mt-2 ${commissionAccent === 'pos' ? 'text-green-400' : 'text-red-400'}`}>
                  {fmtPct(wow.commissionPct)} vs prior {stats.window.days}d
                </div>
              )}
            </div>
          </Card>

          {/* Funnel — pageviews → clicks → conversions → commission */}
          <Card title="Conversion funnel">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-2">
              <FunnelStage
                label="Show page views"
                value={fmtInt(stats.funnel.showPageviews)}
                rateLabel={null}
              />
              <FunnelStage
                label="Ticket clicks"
                value={fmtInt(stats.funnel.ticketClicks)}
                rateLabel={
                  stats.funnel.rates.clicksPerShowView != null
                    ? `${(stats.funnel.rates.clicksPerShowView * 100).toFixed(2)}% of views`
                    : null
                }
              />
              <FunnelStage
                label="Conversions"
                value={fmtInt(stats.funnel.conversions)}
                rateLabel={
                  stats.funnel.rates.convsPerClick != null
                    ? `${(stats.funnel.rates.convsPerClick * 100).toFixed(2)}% of clicks`
                    : null
                }
              />
              <FunnelStage
                label="Commission"
                value={fmtMoney(stats.funnel.commission)}
                rateLabel={
                  stats.funnel.rates.epc != null
                    ? `$${stats.funnel.rates.epc.toFixed(3)} / click`
                    : null
                }
                accent
              />
            </div>
          </Card>

          {/* Unit economics */}
          <Card title="Unit economics (per conversion)">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <UnitStat
                label="Avg order"
                value={fmtMoney(stats.unitEconomics.avgOrderValue)}
                hint="ticket sale value"
              />
              <UnitStat
                label="Avg commission"
                value={fmtMoney(stats.unitEconomics.avgCommissionPerConv)}
                hint="we earn"
              />
              <UnitStat
                label="Take rate"
                value={
                  stats.unitEconomics.takeRate != null
                    ? `${(stats.unitEconomics.takeRate * 100).toFixed(2)}%`
                    : '—'
                }
                hint="commission ÷ sale"
              />
              <UnitStat
                label="EPC"
                value={
                  stats.unitEconomics.earningsPerClick != null
                    ? `$${stats.unitEconomics.earningsPerClick.toFixed(3)}`
                    : '—'
                }
                hint="commission ÷ click"
              />
            </div>
          </Card>

          {/* Per-platform efficiency table */}
          {stats.perPlatform.length > 0 && (
            <Card title="By platform">
              <div className="overflow-x-auto -mx-4 sm:-mx-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase tracking-wide">
                      <th className="text-left font-medium px-4 sm:px-5 pb-2">Platform</th>
                      <th className="text-right font-medium px-2 pb-2">Clicks</th>
                      <th className="text-right font-medium px-2 pb-2">Conv</th>
                      <th className="text-right font-medium px-2 pb-2">CR</th>
                      <th className="text-right font-medium px-2 pb-2">Comm</th>
                      <th className="text-right font-medium px-4 sm:px-5 pb-2">EPC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.perPlatform.map(r => (
                      <tr key={r.platform} className="border-t border-gray-800">
                        <td className="px-4 sm:px-5 py-2 text-white font-medium">
                          {r.platform}
                          {!r.affiliate && (
                            <span className="ml-1 text-xs text-gray-500" title="No affiliate program">·</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-300 tabular-nums">{fmtInt(r.clicks)}</td>
                        <td className="px-2 py-2 text-right text-gray-300 tabular-nums">
                          {r.conversions != null ? fmtInt(r.conversions) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-300 tabular-nums">
                          {r.conversionRate != null ? `${(r.conversionRate * 100).toFixed(1)}%` : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-2 py-2 text-right text-white font-semibold tabular-nums">
                          {r.commission != null ? fmtMoney(r.commission) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-4 sm:px-5 py-2 text-right text-gray-300 tabular-nums">
                          {r.epc != null ? `$${r.epc.toFixed(3)}` : <span className="text-gray-600">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-xs text-gray-500 mt-3">
                · = no affiliate program; clicks shown for reference. CR = conversion rate. EPC = earnings per click.
              </div>
            </Card>
          )}

          {/* TodayTix customer mix */}
          {impact && !impact.skipped && impact.todaytixMix && (
            <Card title="TodayTix customer mix">
              {(() => {
                const m = impact.todaytixMix!;
                const total = m.newCount + m.existingCount;
                const newPct = total > 0 ? Math.round((m.newCount / total) * 100) : 0;
                return (
                  <>
                    <div className="text-xs text-gray-500 mb-3">
                      Inferred from payout / sale ratio (5% = new, 1% = existing under current contract)
                    </div>
                    <StatRow label={`New (${newPct}%)`} value={`${m.newCount} · ${fmtMoney(m.newPayout)} commission`} />
                    <StatRow label={`Existing (${100 - newPct}%)`} value={`${m.existingCount} · ${fmtMoney(m.existingPayout)} commission`} />
                    {m.rateBumpUplift > 0 && (
                      <StatRow
                        label="Rate-bump uplift vs old 2%"
                        value={`+${fmtMoney(m.rateBumpUplift)}`}
                        accent="pos"
                      />
                    )}
                  </>
                );
              })()}
            </Card>
          )}

          {/* Errors */}
          {stats.errors.length > 0 && (
            <Card title="Provider errors">
              <ul className="text-sm text-red-300 space-y-1">
                {stats.errors.map((e, i) => (
                  <li key={i}>
                    <span className="font-semibold">{e.provider}:</span> {e.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
