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

interface StatCardProps {
  value: string;
  label: string;
  subValue?: string;
}

function StatCard({ value, label, subValue }: StatCardProps) {
  return (
    <div className="flex-1 bg-surface-overlay rounded-xl p-4 text-center border border-white/5">
      <div className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
        {value}
      </div>
      <div className="text-xs text-gray-500 uppercase tracking-wide mt-1 font-medium">
        {label}
      </div>
      {subValue && (
        <div className="text-xs text-gray-600 mt-0.5">{subValue}</div>
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
            />
            <StatCard
              value={formatPercentage(grosses.thisWeek.capacity)}
              label="Capacity"
            />
            <StatCard
              value={grosses.thisWeek.atp ? `$${grosses.thisWeek.atp.toFixed(0)}` : '—'}
              label="Avg Ticket"
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
