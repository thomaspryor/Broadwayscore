'use client';

import { useId } from 'react';
import Link from 'next/link';
import type { ShowGrosses } from '@/lib/data-types';
import type { BoxOfficeHistoryStats } from '@/lib/data-grosses-history';

interface BoxOfficeStatsProps {
  grosses: ShowGrosses;
  weekEnding: string;
  history?: BoxOfficeHistoryStats | null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toLocaleString()}`;
}

function formatNumber(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

function formatPercentage(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toFixed(0)}%`;
}

// Calculate percentage change between two values
function calcPercentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

// Arrow icons
function ArrowUp({ className }: { className?: string }) {
  return (
    <svg className={className} width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M5 2L9 7H1L5 2Z" />
    </svg>
  );
}

function ArrowDown({ className }: { className?: string }) {
  return (
    <svg className={className} width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M5 8L1 3H9L5 8Z" />
    </svg>
  );
}

interface ChangeIndicatorProps {
  change: number | null;
  label: string;
}

function ChangeIndicator({ change, label }: ChangeIndicatorProps) {
  if (change === null) return null;

  const isPositive = change > 0;
  const isNegative = change < 0;
  const absChange = Math.abs(change);

  // Round UP using Math.ceil for display
  const formattedChange = Math.ceil(absChange);

  return (
    <div className="flex items-center justify-center gap-0.5 text-[10px]">
      {isPositive && <ArrowUp className="text-emerald-400" />}
      {isNegative && <ArrowDown className="text-red-400" />}
      <span className={isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-gray-500'}>
        {formattedChange}%
      </span>
      <span className="text-gray-500 ml-0.5">{label}</span>
    </div>
  );
}

interface StatCardProps {
  value: string;
  valueTitle?: string;
  label: string;
  wowChange?: number | null;
  yoyChange?: number | null;
}

function StatCard({ value, valueTitle, label, wowChange, yoyChange }: StatCardProps) {
  const hasChanges = wowChange !== undefined || yoyChange !== undefined;

  return (
    <div className="flex-1 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5 hover:bg-white/5 transition-colors">
      <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight" title={valueTitle}>
        {value}
      </div>
      <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
        {label}
      </div>
      {hasChanges && (
        <div className="flex flex-row flex-wrap justify-center gap-2 mt-1 sm:mt-1.5">
          <ChangeIndicator change={wowChange ?? null} label="WoW" />
          <ChangeIndicator change={yoyChange ?? null} label="YoY" />
        </div>
      )}
    </div>
  );
}

// Trailing gross sparkline (endpoint-emphasized, no axes) per the approved
// Box Office Scorecard mockup. Renders inside a stat-tile-style container.
function TrendSparkline({ points }: { points: { weekEnding: string; gross: number }[] }) {
  const gradientId = useId();
  if (points.length < 2) return null;

  const grossValues = points.map((p) => p.gross);
  const min = Math.min(...grossValues);
  const max = Math.max(...grossValues);
  const W = 400;
  const H = 42;
  const TOP = 6;
  const BOTTOM = 34;
  const span = max - min;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = span === 0 ? (TOP + BOTTOM) / 2 : BOTTOM - ((p.gross - min) / span) * (BOTTOM - TOP);
    return { x, y };
  });
  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const last = coords[coords.length - 1];

  return (
    <div className="bg-surface-overlay rounded-lg sm:rounded-xl border border-white/5 px-3.5 py-3 mb-4">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500">
          {points.length}-week trend
        </span>
        <span className="text-[11px] text-gray-500 tabular-nums">
          {min === max ? formatCurrency(min) : `${formatCurrency(min)} — ${formatCurrency(max)}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full h-[42px] text-brand"
        aria-label={`Weekly gross over the last ${points.length} weeks, from ${formatCurrency(min)} to ${formatCurrency(max)}`}
        role="img"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <circle cx={last.x} cy={last.y} r="3" fill="currentColor" />
      </svg>
    </div>
  );
}

export default function BoxOfficeStats({ grosses, weekEnding, history }: BoxOfficeStatsProps) {
  const hasThisWeek = grosses.thisWeek && (grosses.thisWeek.gross !== null || grosses.thisWeek.capacity !== null);
  const hasAllTime = grosses.allTime.gross !== null || grosses.allTime.performances !== null;

  if (!hasThisWeek && !hasAllTime) {
    return null;
  }

  // Calculate WoW and YoY changes for this week's stats
  const grossWoW = grosses.thisWeek ? calcPercentChange(grosses.thisWeek.gross, grosses.thisWeek.grossPrevWeek) : null;
  const grossYoY = grosses.thisWeek ? calcPercentChange(grosses.thisWeek.gross, grosses.thisWeek.grossYoY) : null;

  const capacityWoW = grosses.thisWeek ? calcPercentChange(grosses.thisWeek.capacity, grosses.thisWeek.capacityPrevWeek) : null;
  const capacityYoY = grosses.thisWeek ? calcPercentChange(grosses.thisWeek.capacity, grosses.thisWeek.capacityYoY) : null;

  const atpWoW = grosses.thisWeek ? calcPercentChange(grosses.thisWeek.atp, grosses.thisWeek.atpPrevWeek) : null;
  const atpYoY = grosses.thisWeek ? calcPercentChange(grosses.thisWeek.atp, grosses.thisWeek.atpYoY) : null;

  // undefined (not null) when history is absent so StatCard skips the change
  // row entirely instead of rendering an empty container.
  const attendanceWoW =
    grosses.thisWeek && history
      ? calcPercentChange(grosses.thisWeek.attendance, history.attendancePrevWeek)
      : undefined;
  const attendanceYoY =
    grosses.thisWeek && history
      ? calcPercentChange(grosses.thisWeek.attendance, history.attendanceYoY)
      : undefined;
  const hasAttendanceTile = hasThisWeek && grosses.thisWeek?.attendance != null;

  // One decimal below 10% (rounded to a whole number above), and suppressed
  // entirely under 0.05% — "0.0% market share" is worse than no chip.
  const marketShareLabel =
    history?.marketSharePct != null && history.marketSharePct >= 0.05
      ? `${history.marketSharePct >= 9.95 ? Math.round(history.marketSharePct) : history.marketSharePct.toFixed(1)}% market share`
      : null;
  const rankLabel =
    hasThisWeek && history?.rank ? ` · rank #${history.rank} on Broadway` : '';

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby="box-office-scorecard-heading">
      {/* Unified scorecard chrome: eyebrow + source attribution */}
      <header className="flex items-center justify-between gap-3 mb-1">
        <h2 id="box-office-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Box Office Scorecard</h2>
        <span className="text-[10px] tracking-[0.06em] text-gray-500 italic shrink-0">
          source · Broadway League, public
        </span>
      </header>
      {hasThisWeek && weekEnding ? (
        <p className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase italic m-0 mb-3">
          week of {weekEnding}{rankLabel}
        </p>
      ) : (
        <div className="mb-3" />
      )}

      {/* Chips: market share + weeks on the boards */}
      {hasThisWeek && (marketShareLabel || (history?.weeksOnBoards ?? 0) > 1) && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {marketShareLabel && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold text-brand bg-brand/10 border border-brand/30">
              {marketShareLabel}
              <span className="font-bold text-brand-light">this wk</span>
            </span>
          )}
          {(history?.weeksOnBoards ?? 0) > 1 && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold text-gray-300 bg-surface-overlay border border-white/5">
              {history!.weeksOnBoards!.toLocaleString()} weeks played
            </span>
          )}
        </div>
      )}

      {/* This Week Row */}
      {hasThisWeek && grosses.thisWeek && (
        <div className="mb-4">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500 mb-2">
            This Week
          </div>
          <div className={`grid grid-cols-2 ${hasAttendanceTile ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-2 sm:gap-3`}>
            <StatCard
              value={formatCurrency(grosses.thisWeek.gross)}
              label="Gross"
              wowChange={grossWoW}
              yoyChange={grossYoY}
            />
            <StatCard
              value={
                (grosses.thisWeek.capacity ?? 0) > 100
                  ? formatPercentage(grosses.thisWeek.capacity) + '*'
                  : formatPercentage(grosses.thisWeek.capacity)
              }
              valueTitle={
                (grosses.thisWeek.capacity ?? 0) > 100
                  ? 'Above 100% reflects extra performances or premium pricing reported by The Broadway League.'
                  : undefined
              }
              label="Capacity"
              wowChange={capacityWoW}
              yoyChange={capacityYoY}
            />
            <StatCard
              value={grosses.thisWeek.atp ? `$${grosses.thisWeek.atp.toFixed(0)}` : '—'}
              label="Avg Ticket"
              wowChange={atpWoW}
              yoyChange={atpYoY}
            />
            {hasAttendanceTile && (
              <StatCard
                value={(grosses.thisWeek.attendance as number).toLocaleString()}
                label="Attendance"
                wowChange={attendanceWoW}
                yoyChange={attendanceYoY}
              />
            )}
          </div>
          {(grosses.thisWeek.capacity ?? 0) > 100 && (
            <p className="text-[10px] sm:text-xs text-gray-500 mt-2">
              <span aria-hidden="true">*</span> Capacity above 100% reflects extra performances or premium pricing reported by The Broadway League.
            </p>
          )}
        </div>
      )}

      {/* 12-week gross trend */}
      {hasThisWeek && history && history.sparkline.length > 0 && (
        <TrendSparkline points={history.sparkline} />
      )}

      {/* All Time Row */}
      {hasAllTime && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500 mb-2">All Time</div>
          <div className="flex gap-2 sm:gap-3">
            <StatCard
              value={formatCurrency(grosses.allTime.gross)}
              label="Gross"
            />
            <StatCard
              value={formatNumber(grosses.allTime.performances)}
              label="Performances"
            />
            <StatCard
              value={formatNumber(grosses.allTime.attendance)}
              label="Attendance"
            />
          </div>
        </div>
      )}

      {/* Footer link to the cross-show box-office leaderboard */}
      <div className="mt-1.5 -mb-1 sm:-mb-2">
        <Link
          href="/box-office"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover transition-colors group"
        >
          <span>See all box office stats</span>
          <span className="inline-block transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
