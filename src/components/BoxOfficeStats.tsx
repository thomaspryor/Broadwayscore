'use client';

import { ShowGrosses } from '@/lib/data';

interface BoxOfficeStatsProps {
  grosses: ShowGrosses;
  weekEnding: string;
}

function formatCurrency(value: number | null): string {
  if (value === null) return '—';
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

function formatNumber(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

function formatPercentage(value: number | null): string {
  if (value === null) return '—';
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

  // Format the change - show decimal for small changes
  const formattedChange = absChange < 10 ? absChange.toFixed(1) : absChange.toFixed(0);

  return (
    <div className="flex items-center justify-center gap-0.5 text-[10px]">
      {isPositive && <ArrowUp className="text-emerald-400" />}
      {isNegative && <ArrowDown className="text-red-400" />}
      <span className={isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-gray-500'}>
        {formattedChange}%
      </span>
      <span className="text-gray-600 ml-0.5">{label}</span>
    </div>
  );
}

interface StatCardProps {
  value: string;
  label: string;
  wowChange?: number | null;
  yoyChange?: number | null;
}

function StatCard({ value, label, wowChange, yoyChange }: StatCardProps) {
  const hasChanges = wowChange !== undefined || yoyChange !== undefined;

  return (
    <div className="flex-1 bg-surface-overlay rounded-xl p-4 text-center border border-white/5">
      <div className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
        {value}
      </div>
      <div className="text-xs text-gray-500 uppercase tracking-wide mt-1 font-medium">
        {label}
      </div>
      {hasChanges && (
        <div className="flex flex-col gap-0.5 mt-1.5">
          <ChangeIndicator change={wowChange ?? null} label="WoW" />
          <ChangeIndicator change={yoyChange ?? null} label="YoY" />
        </div>
      )}
    </div>
  );
}

export default function BoxOfficeStats({ grosses, weekEnding }: BoxOfficeStatsProps) {
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

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Box Office</h2>

      {/* This Week Row */}
      {hasThisWeek && grosses.thisWeek && (
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-2 font-medium">
            This Week <span className="text-gray-600">({weekEnding})</span>
          </div>
          <div className="flex gap-2 sm:gap-3">
            <StatCard
              value={formatCurrency(grosses.thisWeek.gross)}
              label="Gross"
              wowChange={grossWoW}
              yoyChange={grossYoY}
            />
            <StatCard
              value={formatPercentage(grosses.thisWeek.capacity)}
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
          </div>
        </div>
      )}

      {/* All Time Row */}
      {hasAllTime && (
        <div>
          <div className="text-xs text-gray-500 mb-2 font-medium">All Time</div>
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
    </div>
  );
}
