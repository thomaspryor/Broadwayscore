'use client';

import { useCallback, useEffect, useState } from 'react';

// Shape written by scripts/lib/account-metrics.js buildDashboardData (BRO-4615).
interface Step { shown: number; started: number; completed: number; acted: number }
interface SourceRow extends Step { source: string; label: string; device: 'mobile' | 'desktop' | 'other' }
interface Payload {
  generatedAt: string;
  accounts: {
    total: number; newToday: number; newLast7: number; newLast30: number;
    signedInLast7: number; signedInLast30: number; providers: Record<string, number>;
    withRating: number; withWatchlist: number; withList: number; withAnything: number;
    ratings: number; watchlistItems: number; lists: number;
  } | null;
  daily: { date: string; newAccounts: number; signedInUsers: number | null }[];
  weeks: { week: string; newAccounts: number; partial: boolean }[];
  active: { dau: number; wau: number; mau: number } | null;
  actions: { event: string; label: string; last7: number; last30: number; users30: number }[] | null;
  funnel: { sources: SourceRow[]; totals: Record<'mobile' | 'desktop' | 'other' | 'all', Step> } | null;
  alerts?: { key: string; title: string; description: string }[];
  failed: string[];
  cached?: boolean;
}

const fmtN = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const fmtDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const pctOf = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
const PROVIDER: Record<string, string> = { google: 'Google', apple: 'Apple', email: 'Email' };
const DEVICE: Record<string, string> = { mobile: 'Phones', desktop: 'Computers', other: 'iPhone app / other' };

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="bg-surface-raised border border-white/[0.06] rounded-lg p-4 sm:p-5 min-w-0">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">{title}</h2>
      {children}
      {note && <p className="text-xs text-gray-500 mt-3">{note}</p>}
    </div>
  );
}

function Tile({ label, value, lines }: { label: string; value: string; lines: string[] }) {
  return (
    <div className="bg-surface-raised border border-white/[0.06] rounded-lg p-3 sm:p-4 min-w-0">
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-2xl sm:text-3xl font-extrabold tabular-nums mt-1 text-white">{value}</div>
      {lines.map((l, i) => <div key={i} className="text-xs text-gray-400 mt-0.5">{l}</div>)}
    </div>
  );
}

// The job runs every 3 hours; 12 hours means several runs in a row failed.
const STALE_MS = 12 * 3600 * 1000;

const FAILED_LABELS: Record<string, string> = {
  active: 'signed-in people',
  daily: 'signed-in people per day',
  actions: 'what signed-in people did',
  funnel: 'the sign-up funnel',
  health: 'the sign-in and saving alerts',
};

/** Two-series daily bar chart: new accounts (brand) and signed-in people (sky). */
function DailyChart({ days }: { days: Payload['daily'] }) {
  const shown = days.slice(-30);
  // null = PostHog's daily query failed this run: draw no blue bars rather than zeros.
  const usersKnown = shown.some((d) => d.signedInUsers != null);
  const max = Math.max(1, ...shown.map((d) => Math.max(d.newAccounts, d.signedInUsers ?? 0)));
  const W = 600, H = 140, gap = 2;
  const slot = W / shown.length;
  const bw = Math.max(1, (slot - gap) / 2);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-36" role="img" aria-label="New accounts and signed-in people per day, last 30 days">
        {shown.map((d, i) => {
          const hA = (d.newAccounts / max) * (H - 4);
          const hU = ((d.signedInUsers ?? 0) / max) * (H - 4);
          return (
            <g key={d.date}>
              <title>{`${fmtDay(d.date)}: ${d.newAccounts} new accounts${d.signedInUsers == null ? '' : `, ${d.signedInUsers} signed-in people`}`}</title>
              <rect x={i * slot} y={H - hA} width={bw} height={hA} className="fill-brand" rx={1} />
              <rect x={i * slot + bw} y={H - hU} width={bw} height={hU} className="fill-sky-400" rx={1} />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>{shown[0] && fmtDay(shown[0].date)}</span>
        <span>{shown.length > 0 && fmtDay(shown[shown.length - 1].date)}</span>
      </div>
      <div className="flex gap-4 text-xs text-gray-400 mt-2">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-brand" />New accounts</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-sky-400" />Signed-in people{usersKnown ? '' : ' (not available this update)'}</span>
      </div>
    </div>
  );
}

function FunnelBars({ step, title }: { step: Step; title: string }) {
  const rows: [string, number][] = [
    ['Saw the sign-in box', step.shown],
    ['Started signing in', step.started],
    ['Finished signing in', step.completed],
    ['Then saved something', step.acted],
  ];
  const max = Math.max(1, step.shown, step.started);
  return (
    <div className="min-w-0">
      <div className="text-sm font-semibold text-white mb-2">{title}</div>
      {rows.map(([label, n], i) => (
        <div key={label} className="mb-2">
          <div className="flex justify-between text-xs text-gray-400">
            <span>{label}</span>
            <span className="tabular-nums text-gray-300">
              {fmtN(n)}{i > 0 && rows[i - 1][1] > 0 ? ` (${pctOf(n, rows[i - 1][1])})` : ''}
            </span>
          </div>
          <div className="h-2 bg-surface-overlay rounded mt-1 overflow-hidden">
            <div className="h-full bg-brand rounded" style={{ width: `${(n / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/account-stats${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as (Payload & { error?: string }) | null;
      if (!res.ok || !body || body.error) {
        setError(res.status === 404 && !body ? 'Your admin session has expired. Sign in again with the admin link.' : body?.error || `HTTP ${res.status}`);
        return;
      }
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const a = data?.accounts;
  const providers = a ? Object.entries(a.providers).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${PROVIDER[k] || k} ${v}`).join(' · ') : '';
  const sources = (data?.funnel?.sources || []).filter((s) => s.shown > 0 || s.started > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-xs text-gray-500">
        {data && <span>Updated {new Date(data.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="ml-auto px-3 py-1.5 rounded-md bg-surface-overlay text-gray-300 hover:text-white disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {data && Date.now() - new Date(data.generatedAt).getTime() > STALE_MS && (
        <div role="status" className="border border-score-tepid/40 bg-score-tepid/10 rounded-lg p-3 text-sm text-score-tepid">
          These numbers are more than 12 hours old. The update job may be failing; it is watched, and you will hear about it if it stays down.
        </div>
      )}

      {error && <div role="alert" className="border border-score-skip/40 bg-score-skip/10 rounded-lg p-4 text-sm text-score-skip">{error}</div>}

      {data?.alerts && data.alerts.length > 0 && (
        <div role="alert" className="border border-score-skip/40 bg-score-skip/10 rounded-lg p-4 text-sm text-score-skip space-y-1">
          {data.alerts.map((al) => <div key={al.key}><strong>{al.title}.</strong> {al.description}</div>)}
        </div>
      )}

      {a && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="Accounts" value={fmtN(a.total)} lines={[`${a.newToday} new today (UTC)`, providers]} />
          <Tile label="New accounts" value={fmtN(a.newLast7)} lines={['in the last 7 days', `${a.newLast30} in the last 30 days`]} />
          <Tile
            label="Signed-in people"
            value={fmtN(data?.active?.wau)}
            lines={data?.active ? ['used the site in the last 7 days', `${data.active.dau} in the last 24 hours · ${data.active.mau} in 30 days`] : ['not available this run']}
          />
          <Tile label="Saved something" value={fmtN(a.withAnything)} lines={[`${pctOf(a.withAnything, a.total)} of accounts`, `${a.withRating} rated · ${a.withWatchlist} watchlist · ${a.withList} lists`]} />
        </div>
      )}

      {data && data.daily.length > 0 && (
        <Card title="Last 30 days" note="Days are in UTC. Signed-in people counts anyone who used the site while signed in, including you.">
          <DailyChart days={data.daily} />
        </Card>
      )}

      {data?.funnel && (
        <Card
          title="Sign-up funnel, last 30 days"
          note="Each device is counted once, at the first place it saw the sign-in box. “Saved something” = rated a show, used the watchlist or a list."
        >
          <div className="grid sm:grid-cols-2 gap-6">
            <FunnelBars step={data.funnel.totals.mobile} title="Phones" />
            <FunnelBars step={data.funnel.totals.desktop} title="Computers" />
          </div>
          {sources.length > 0 && (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 pr-3 font-medium">Where they saw it</th>
                    <th className="py-1 pr-3 font-medium">Device</th>
                    <th className="py-1 pr-3 font-medium text-right">Saw</th>
                    <th className="py-1 pr-3 font-medium text-right">Started</th>
                    <th className="py-1 font-medium text-right">Finished</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={`${s.source}|${s.device}`} className="border-t border-white/[0.06] text-gray-300">
                      <td className="py-1.5 pr-3">{s.label}</td>
                      <td className="py-1.5 pr-3 text-gray-400">{DEVICE[s.device]}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.shown}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.started}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.completed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {data?.actions && (
          <Card title="What signed-in people did">
            {data.actions.length === 0 ? (
              <p className="text-sm text-gray-400">Nothing yet in the last 30 days.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 pr-3 font-medium" />
                    <th className="py-1 pr-3 font-medium text-right">7 days</th>
                    <th className="py-1 pr-3 font-medium text-right">30 days</th>
                    <th className="py-1 font-medium text-right">People</th>
                  </tr>
                </thead>
                <tbody>
                  {data.actions.map((x) => (
                    <tr key={x.event} className="border-t border-white/[0.06] text-gray-300">
                      <td className="py-1.5 pr-3">{x.label}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{x.last7}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{x.last30}</td>
                      <td className="py-1.5 text-right tabular-nums">{x.users30}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
        {data && data.weeks.length > 0 && (
          <Card title="New accounts per week">
            <table className="w-full text-sm">
              <tbody>
                {[...data.weeks].reverse().filter((w, i) => i < 8).map((w) => (
                  <tr key={w.week} className="border-t border-white/[0.06] first:border-0 text-gray-300">
                    <td className="py-1.5 pr-3">Week of {fmtDay(w.week)}{w.partial ? ' (so far)' : ''}</td>
                    <td className="py-1.5 text-right tabular-nums">{w.newAccounts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {a && <p className="text-xs text-gray-500 mt-3">All time: {fmtN(a.ratings)} ratings, {fmtN(a.watchlistItems)} watchlist entries, {fmtN(a.lists)} lists.</p>}
          </Card>
        )}
      </div>

      {data && data.failed.length > 0 && (
        <p className="text-xs text-gray-500">
          Not refreshed this update: {data.failed.map((k) => FAILED_LABELS[k] || k).join(', ')}. They come back on the next update.
        </p>
      )}
    </div>
  );
}
