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
  totalClicks?: number;
  byPlatform?: PlatformCount[];
}

interface WoWDelta {
  commissionPct: number | null;
  revenuePct: number | null;
  priorCommission: number;
  priorRevenue: number;
}

interface Stats {
  window: { days: number; startDate: string; endDate: string };
  totals: { commission: number; revenue: number; conversions: number };
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
          {/* Top-line */}
          <Card title={`Total — last ${stats.window.days} days`}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Commission</div>
                <div className="text-2xl font-extrabold text-white tabular-nums">
                  {fmtMoney(stats.totals.commission)}
                </div>
                {wow?.commissionPct != null && (
                  <div className={`text-xs font-semibold ${commissionAccent === 'pos' ? 'text-green-400' : 'text-red-400'}`}>
                    {fmtPct(wow.commissionPct)} vs prior {stats.window.days}d
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Revenue</div>
                <div className="text-2xl font-extrabold text-white tabular-nums">
                  {fmtMoney(stats.totals.revenue)}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Conversions</div>
                <div className="text-2xl font-extrabold text-white tabular-nums">
                  {fmtInt(stats.totals.conversions)}
                </div>
              </div>
            </div>
          </Card>

          {/* TodayTix */}
          {impact && !impact.skipped && impact.todaytixMix && (
            <Card title="TodayTix (Impact)">
              {(() => {
                const m = impact.todaytixMix!;
                const total = m.newCount + m.existingCount;
                const newPct = total > 0 ? Math.round((m.newCount / total) * 100) : 0;
                const ttCampaign = impact.byCampaign?.find(c => c.name === 'TodayTix');
                return (
                  <>
                    {ttCampaign && (
                      <>
                        <StatRow label="Conversions" value={fmtInt(ttCampaign.count)} />
                        <StatRow label="Revenue" value={fmtMoney(ttCampaign.revenue)} />
                        <StatRow label="Commission" value={fmtMoney(ttCampaign.payout)} />
                      </>
                    )}
                    <div className="mt-3 pt-3 border-t border-gray-800">
                      <div className="text-xs text-gray-500 mb-2">
                        Customer mix (inferred from payout/sale ratio)
                      </div>
                      <StatRow label={`New (${newPct}%)`} value={`${m.newCount} · ${fmtMoney(m.newPayout)}`} />
                      <StatRow label={`Existing (${100 - newPct}%)`} value={`${m.existingCount} · ${fmtMoney(m.existingPayout)}`} />
                      {m.rateBumpUplift > 0 && (
                        <StatRow
                          label="Rate-bump uplift vs old 2%"
                          value={`+${fmtMoney(m.rateBumpUplift)}`}
                          accent="pos"
                        />
                      )}
                    </div>
                  </>
                );
              })()}
            </Card>
          )}

          {/* Other Impact campaigns */}
          {impact && !impact.skipped && impact.byCampaign && impact.byCampaign.filter(c => c.name !== 'TodayTix').length > 0 && (
            <Card title="Other Impact programs">
              {impact.byCampaign
                .filter(c => c.name !== 'TodayTix')
                .map(c => (
                  <div key={c.name} className="py-2 border-b border-gray-800 last:border-b-0">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm font-medium text-white">{c.name}</span>
                      <span className="text-sm font-semibold text-white tabular-nums">{fmtMoney(c.payout)}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {c.count} sales · {fmtMoney(c.revenue)} revenue
                    </div>
                  </div>
                ))}
            </Card>
          )}

          {/* Partnerize */}
          <Card title="StubHub (Partnerize)">
            {partnerize?.skipped ? (
              <div className="text-sm text-gray-500">Skipped — {partnerize.reason}</div>
            ) : partnerize ? (
              <>
                <StatRow label="Clicks" value={fmtInt(partnerize.clicks)} />
                <StatRow label="Conversions" value={fmtInt(partnerize.conversions)} />
                {partnerize.clicks && partnerize.clicks > 0 && (
                  <StatRow
                    label="Conversion rate"
                    value={`${((partnerize.conversionRate || 0) * 100).toFixed(2)}%`}
                  />
                )}
              </>
            ) : (
              <div className="text-sm text-red-400">Provider error</div>
            )}
          </Card>

          {/* PostHog clicks */}
          <Card title="Ticket clicks (PostHog)">
            {posthog?.skipped ? (
              <div className="text-sm text-gray-500">Skipped — {posthog.reason}</div>
            ) : posthog && posthog.byPlatform ? (
              <>
                <StatRow label="Total clicks" value={fmtInt(posthog.totalClicks)} />
                <div className="mt-2 pt-2 border-t border-gray-800">
                  {posthog.byPlatform.map(p => (
                    <StatRow key={p.platform} label={p.platform} value={fmtInt(p.count)} />
                  ))}
                </div>
              </>
            ) : (
              <div className="text-sm text-red-400">Provider error</div>
            )}
          </Card>

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
