'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Shape written by scripts/lib/traffic-metrics.js buildDashboardData (BRO-4136).
interface Tile { label: string; value: string; lines: string[] }
interface Week { week: string; visits: number; visitors: number | null; pageviews: number | null; channels: Record<string, number>; partialStart: boolean }
interface Month { month: string; visits: number; visitors: number | null; partial: boolean }
interface PageRow { path: string; name: string; visits: number }
interface KeyRow { key: string; visits: number }
interface TopSet { pages: PageRow[]; referrers: KeyRow[]; countries: KeyRow[] }
interface Payload {
  generatedAt: string;
  through: string;
  dataStart: string | null;
  source: string;
  tiles: Tile[];
  weeks: Week[];
  months: Month[];
  channelGroups: string[];
  top: { lastWeek: TopSet; last4Weeks: TopSet & { from: string } };
  cached?: boolean;
}

const fmtN = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const fmtDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtMonth = (ym: string) => {
  const d = new Date(ym + '-01T00:00:00Z');
  return `${d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })} ’${ym.slice(2, 4)}`;
};
const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Chart palette as Tailwind classes (design-system tokens; literal strings so JIT keeps them).
const CHANNEL_STYLE: Record<string, { fill: string; dot: string }> = {
  Search: { fill: 'fill-brand', dot: 'bg-brand' },
  Direct: { fill: 'fill-sky-400', dot: 'bg-sky-400' },
  Social: { fill: 'fill-status-previews', dot: 'bg-status-previews' },
  Email: { fill: 'fill-status-open', dot: 'bg-status-open' },
  'AI assistants': { fill: 'fill-amber-300', dot: 'bg-amber-300' },
  'Other sites': { fill: 'fill-orange-500', dot: 'bg-orange-500' },
  Other: { fill: 'fill-status-closed', dot: 'bg-status-closed' },
};

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-surface-raised border border-white/[0.06] rounded-lg p-4 sm:p-5 min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">{title}</h2>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </div>
  );
}

function TileCard({ t }: { t: Tile }) {
  return (
    <div className="bg-surface-raised border border-white/[0.06] rounded-lg p-3 sm:p-4 min-w-0">
      <div className="text-xs uppercase tracking-wide text-gray-500">{t.label}</div>
      <div className={`${t.value.length > 12 ? 'text-lg sm:text-xl leading-tight' : 'text-2xl sm:text-3xl'} font-extrabold tabular-nums mt-1 text-white break-words`}>
        {t.value}
      </div>
      {t.lines.map((l, i) => {
        const m = l.match(/^([+−-]\d+%)(.*)$/);
        return (
          <div key={i} className="text-xs text-gray-500 mt-0.5">
            {m ? (
              <>
                <span className={`font-semibold ${m[1].startsWith('+') ? 'text-status-open' : 'text-score-skip'}`}>{m[1]}</span>
                {m[2]}
              </>
            ) : l}
          </div>
        );
      })}
    </div>
  );
}

/** Container width, so charts render at real pixels (readable text on a phone). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const PAD = { l: 44, r: 12, t: 10, b: 26 };
const H = 240;

function Axes({ w, max, labels }: { w: number; max: number; labels: string[] }) {
  const iw = w - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(iw / 70))));
  return (
    <g>
      {ticks.map((f) => (
        <g key={f}>
          <line x1={PAD.l} x2={w - PAD.r} y1={PAD.t + ih * (1 - f)} y2={PAD.t + ih * (1 - f)} className="stroke-white/10" />
          <text x={PAD.l - 6} y={PAD.t + ih * (1 - f) + 4} textAnchor="end" className="fill-gray-500 text-[11px]">{fmtN(max * f)}</text>
        </g>
      ))}
      {labels.map((l, i) => {
        if (i % every !== 0) return null;
        // First/last labels sit on the plot edge: anchor them inward so they are not clipped.
        const anchor = labels.length > 1 && i === 0 ? 'start' : labels.length > 1 && i === labels.length - 1 ? 'end' : 'middle';
        return <text key={i} x={PAD.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1))} y={H - 8} textAnchor={anchor} className="fill-gray-500 text-[11px]">{l}</text>;
      })}
    </g>
  );
}

/** Line chart with a hover readout (GA-style): one line per series. */
function LineChart({ labels, series }: { labels: string[]; series: { name: string; stroke: string; dot: string; values: (number | null)[] }[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))));
  const iw = Math.max(1, w - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1));
  const y = (v: number) => PAD.t + ih * (1 - v / max);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - PAD.l) / iw) * (labels.length - 1));
    setHover(Math.min(labels.length - 1, Math.max(0, i)));
  };
  return (
    <div ref={ref} className="relative">
      {w > 0 && (
        <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Visits per week">
          <Axes w={w} max={max} labels={labels} />
          {series.map((s) => {
            const pts = s.values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
            return <polyline key={s.name} points={pts} fill="none" strokeWidth={2} className={s.stroke} />;
          })}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} className="stroke-white/30" />}
          {hover != null && series.map((s) => (s.values[hover] == null ? null : (
            <circle key={s.name} cx={x(hover)} cy={y(s.values[hover] as number)} r={4} className={s.stroke.replace('stroke-', 'fill-')} />
          )))}
        </svg>
      )}
      {hover != null && (
        <div
          className="absolute top-2 pointer-events-none bg-surface-elevated border border-white/10 rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(x(hover) - 70, 0), Math.max(0, w - 150)) }}
        >
          <div className="text-gray-400 mb-1">Week of {labels[hover]}</div>
          {series.map((s) => (
            <div key={s.name} className="flex items-center gap-2 text-white whitespace-nowrap">
              <span className={`inline-block w-2 h-2 rounded-sm ${s.dot}`} />
              {s.name}: <span className="font-semibold tabular-nums">{fmtN(s.values[hover])}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-4 flex-wrap text-xs text-gray-500 mt-2">
        {series.map((s) => (
          <span key={s.name}><span className={`inline-block w-2 h-2 rounded-sm mr-1 ${s.dot}`} />{s.name}</span>
        ))}
      </div>
    </div>
  );
}

/** Stacked weekly bars by channel group (where visits came from). */
function ChannelChart({ weeks, groups }: { weeks: Week[]; groups: string[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const present = groups.filter((g) => weeks.some((wk) => (wk.channels[g] || 0) > 0));
  const totals = weeks.map((wk) => present.reduce((t, g) => t + (wk.channels[g] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const iw = Math.max(1, w - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const slot = iw / Math.max(1, weeks.length);
  const bw = Math.max(2, slot * 0.72);
  const labels = weeks.map((wk) => fmtDay(wk.week));
  return (
    <div ref={ref} className="relative">
      {w > 0 && (
        <svg width={w} height={H} onMouseLeave={() => setHover(null)} role="img" aria-label="Visits per week by source">
          {/* Axes labels use bar centres; reuse Axes for gridlines + y ticks, draw x labels here. */}
          <Axes w={w} max={max} labels={[]} />
          {weeks.map((wk, i) => {
            let acc = 0;
            const cx = PAD.l + slot * i + (slot - bw) / 2;
            return (
              <g key={wk.week} onMouseEnter={() => setHover(i)}>
                <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} className="fill-transparent" />
                {present.map((g) => {
                  const v = wk.channels[g] || 0;
                  const h = (v / max) * ih;
                  acc += v;
                  return v ? <rect key={g} x={cx} y={PAD.t + ih * (1 - acc / max)} width={bw} height={h} className={`${CHANNEL_STYLE[g]?.fill || 'fill-status-closed'} ${hover === i ? '' : 'opacity-85'}`} /> : null;
                })}
              </g>
            );
          })}
          {labels.map((l, i) => (i % Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(iw / 70)))) === 0 ? (
            <text key={i} x={PAD.l + slot * i + slot / 2} y={H - 8} textAnchor="middle" className="fill-gray-500 text-[11px]">{l}</text>
          ) : null))}
        </svg>
      )}
      {hover != null && (
        <div
          className="absolute top-2 pointer-events-none bg-surface-elevated border border-white/10 rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(PAD.l + slot * hover - 70, 0), Math.max(0, w - 170)) }}
        >
          <div className="text-gray-400 mb-1">Week of {labels[hover]} · {fmtN(totals[hover])} visits</div>
          {[...present].reverse().map((g) => (
            <div key={g} className="flex items-center gap-2 text-white whitespace-nowrap">
              <span className={`inline-block w-2 h-2 rounded-sm ${CHANNEL_STYLE[g]?.dot || 'bg-status-closed'}`} />
              {g}: <span className="font-semibold tabular-nums">{fmtN(weeks[hover].channels[g] || 0)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-4 flex-wrap text-xs text-gray-500 mt-2">
        {present.map((g) => (
          <span key={g}><span className={`inline-block w-2 h-2 rounded-sm mr-1 ${CHANNEL_STYLE[g]?.dot || 'bg-status-closed'}`} />{g}</span>
        ))}
      </div>
    </div>
  );
}

function BarTable({ rows, unit = 'visits' }: { rows: { label: string; visits: number }[]; unit?: string }) {
  if (!rows.length) return <div className="text-sm text-gray-500">No data.</div>;
  const max = rows[0].visits || 1;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="relative text-sm">
          <div className="absolute inset-y-0 left-0 rounded-sm bg-brand/15" style={{ width: `${(r.visits / max) * 100}%` }} />
          <div className="relative flex items-center gap-2 px-2 py-1">
            <span className="text-gray-200 truncate min-w-0" title={r.label}>{r.label}</span>
            <span className="ml-auto text-white font-semibold tabular-nums shrink-0">{fmtN(r.visits)}</span>
          </div>
        </div>
      ))}
      <div className="text-xs text-gray-500 pt-1">{unit}</div>
    </div>
  );
}

type Range = 'lastWeek' | 'last4Weeks';

export default function Dashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>('lastWeek');

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/traffic-stats${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
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

  const top = data ? data.top[range] : null;
  const lastWeek = data?.weeks[data.weeks.length - 1]?.week;
  const rangeLabel = !data ? '' : range === 'lastWeek' ? (lastWeek ? `Week of ${fmtDay(lastWeek)}` : '') : `4 weeks from ${fmtDay(data.top.last4Weeks.from)}`;
  const fullMonths = data ? data.months.filter((m) => !m.partial) : [];
  const monthMax = data ? Math.max(1, ...data.months.map((m) => m.visits)) : 1;
  const hasVisitors = !!data && data.weeks.some((w) => w.visitors != null);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="px-3 py-2 text-sm font-medium border border-white/[0.06] rounded-lg text-gray-300 hover:bg-surface-raised disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {data && (
          <span className="text-xs text-gray-500 ml-auto">
            Numbers through {fmtDay(data.through)} · updated {new Date(data.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      {error && <div className="border border-score-skip/40 bg-score-skip/10 rounded-lg p-4 text-sm text-score-skip">{error}</div>}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
            {data.tiles.map((t) => <TileCard key={t.label} t={t} />)}
          </div>

          <Card title={`Visits per week — last ${data.weeks.length} weeks`}>
            <LineChart
              labels={data.weeks.map((w) => fmtDay(w.week))}
              series={[
                { name: 'Visits', stroke: 'stroke-brand', dot: 'bg-brand', values: data.weeks.map((w) => w.visits) },
                ...(hasVisitors ? [{ name: 'Visitors (people)', stroke: 'stroke-sky-400', dot: 'bg-sky-400', values: data.weeks.map((w) => w.visitors) }] : []),
              ]}
            />
            {data.weeks[0]?.partialStart && <div className="text-xs text-gray-500 mt-1">The first week is partial: tracking began {fmtDay(data.dataStart || data.weeks[0].week)}.</div>}
          </Card>

          <Card title="Where visits came from, by week">
            <ChannelChart weeks={data.weeks} groups={data.channelGroups} />
          </Card>

          <Card title="Visits per month">
            <div className="space-y-1">
              {data.months.map((m) => {
                const i = fullMonths.findIndex((x) => x.month === m.month);
                const prev = i > 0 ? fullMonths[i - 1] : null;
                const p = !m.partial && prev ? pct(m.visits, prev.visits) : null;
                return (
                  <div key={m.month} className="grid grid-cols-[4rem_1fr_5rem_3.5rem] items-center gap-2 text-sm py-1">
                    <span className="text-gray-500 text-xs">{fmtMonth(m.month)}</span>
                    <div className="h-2.5 rounded-sm bg-white/[0.06] overflow-hidden">
                      <div className={`h-full ${m.partial ? 'bg-brand/40' : 'bg-brand'}`} style={{ width: `${(m.visits / monthMax) * 100}%` }} />
                    </div>
                    <span className="text-right tabular-nums text-white font-semibold">{fmtN(m.visits)}</span>
                    <span className={`text-right tabular-nums text-xs ${p == null ? 'text-gray-600' : p >= 0 ? 'text-status-open' : 'text-score-skip'}`}>
                      {m.partial ? 'so far' : p == null ? '' : `${p > 0 ? '+' : ''}${p}%`}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="text-xs text-gray-500 mt-2">Change is against the month before. Part-months (the current month, and the month tracking began) are shaded.</div>
          </Card>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-white/[0.06] overflow-hidden">
              {(['lastWeek', 'last4Weeks'] as Range[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${range === r ? 'bg-brand/10 text-brand' : 'text-gray-400 hover:text-white'}`}
                >
                  {r === 'lastWeek' ? 'Last week' : 'Last 4 weeks'}
                </button>
              ))}
            </div>
            <span className="text-xs text-gray-500">{rangeLabel}</span>
          </div>

          {top && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              <Card title="Top landing pages">
                <BarTable rows={top.pages.slice(0, 10).map((p) => ({ label: cap(p.name.replace(/ page$/, '')), visits: p.visits }))} />
              </Card>
              <Card title="Top referrers">
                <BarTable rows={top.referrers.slice(0, 10).map((r) => ({ label: r.key, visits: r.visits }))} />
              </Card>
              <Card title="Top countries">
                <BarTable rows={top.countries.slice(0, 10).map((c) => ({ label: c.key, visits: c.visits }))} />
              </Card>
            </div>
          )}

          <p className="text-xs text-gray-500">{data.source}. Direct visits are not a referrer, so they are not in the referrer list.</p>
        </>
      )}
    </div>
  );
}
