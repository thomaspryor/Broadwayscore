'use client';
/**
 * Module 2: Shows per year. Single-hue gold bars, every bar labelled with its
 * count. Clicking a year scopes the whole view to it, which turns this chart
 * into month-by-month. Records beneath: busiest month, current streak.
 */

import { useMemo } from 'react';
import { MIN_DATED_FOR_YEAR_CHART, type StatsBundle } from '@/lib/stats-ui/bundle';
import { formatMonth, shortMonth } from '@/lib/stats-ui/format';
import { ModuleHeader, ModuleLocked, RecordPill, StatsCard, pressableClass } from './primitives';

const TRACK_PX = 120;

interface Bar {
  key: string;
  count: number;
  label: string;
  title: string;
  current: boolean;
  onClick?: () => void;
}

export default function ShowsPerYear({
  bundle,
  today,
  onSelectYear,
  onOpenMonth,
  onOpenRecord,
}: {
  bundle: StatsBundle;
  today: string;
  onSelectYear: (year: number) => void;
  onOpenMonth: (monthKey: string) => void;
  onOpenRecord: (kind: 'busiest' | 'streak') => void;
}) {
  const { diary, scope } = bundle;
  const byMonths = scope.kind !== 'all';
  const thisMonth = today.slice(0, 7);
  const thisYear = today.slice(0, 4);

  const bars = useMemo<Bar[]>(() => {
    if (byMonths) {
      // Pad to the scope's full month range (capped at this month for an
      // in-progress scope): byMonth only spans months with a show.
      const counts = new Map(diary.byMonth.map((b) => [b.month, b.count]));
      const firstKey = scope.start?.slice(0, 7) ?? diary.byMonth[0]?.month;
      let lastKey = scope.end?.slice(0, 7) ?? diary.byMonth[diary.byMonth.length - 1]?.month;
      if (scope.inProgress && lastKey && lastKey > thisMonth) lastKey = thisMonth;
      const months: { month: string; count: number }[] = [];
      if (firstKey && lastKey && firstKey <= lastKey) {
        let [y, m] = firstKey.split('-').map(Number);
        for (let i = 0; i < 15; i++) {
          const key = `${y}-${String(m).padStart(2, '0')}`;
          if (key > lastKey) break;
          months.push({ month: key, count: counts.get(key) ?? 0 });
          m += 1;
          if (m > 12) {
            m = 1;
            y += 1;
          }
        }
      }
      return (months.length ? months : diary.byMonth).map((b) => ({
        key: b.month,
        count: b.count,
        label: shortMonth(b.month),
        title: `${formatMonth(b.month)}: ${b.count} ${b.count === 1 ? 'show' : 'shows'}`,
        current: b.month === thisMonth,
        onClick: b.count > 0 ? () => onOpenMonth(b.month) : undefined,
      }));
    }
    return diary.byYear.map((b) => ({
      key: String(b.year),
      count: b.count,
      label: `’${String(b.year).slice(2)}`,
      title: b.count > 0 ? `${b.year}: ${b.count} ${b.count === 1 ? 'show' : 'shows'}. Click to scope everything to ${b.year}.` : `${b.year}: no shows logged`,
      current: String(b.year) === thisYear,
      onClick: b.count > 0 ? () => onSelectYear(b.year) : undefined,
    }));
  }, [byMonths, diary.byMonth, diary.byYear, scope, thisMonth, thisYear, onOpenMonth, onSelectYear]);

  if (diary.dated < MIN_DATED_FOR_YEAR_CHART) {
    const need = MIN_DATED_FOR_YEAR_CHART - diary.dated;
    return (
      <ModuleLocked
        title={byMonths ? 'Month by month' : 'Shows per year'}
        need={`Log ${need} more dated ${need === 1 ? 'entry' : 'entries'} to see this chart.`}
        scopeLabel={scope.kind !== 'all' ? scope.label : undefined}
      />
    );
  }
  if (!bars.length) return null;

  const max = bars.reduce((m, b) => Math.max(m, b.count), 0);
  // Highlight the current year/month; if the chart doesn't reach it, the peak.
  const highlightKey = bars.find((b) => b.current && b.count > 0)?.key ?? bars.find((b) => b.count === max)?.key;
  const scrolls = bars.length > 14;

  return (
    <StatsCard>
      <ModuleHeader
        title={byMonths ? 'Month by month' : 'Shows per year'}
        caption={byMonths ? scope.label : 'Click a year to scope everything below'}
      />
      <div className={scrolls ? 'overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0' : ''}>
        <div className="flex items-end gap-1 sm:gap-2" style={scrolls ? { minWidth: bars.length * 34 } : undefined} role="list">
          {bars.map((b) => {
            const h = max > 0 ? (b.count / max) * TRACK_PX : 0;
            const hi = b.key === highlightKey;
            return (
              <button
                key={b.key}
                type="button"
                role="listitem"
                data-testid={`stats-bar-${b.key}`}
                onClick={b.onClick}
                disabled={!b.onClick}
                title={b.title}
                aria-label={b.title}
                className={`${pressableClass} group flex-1 min-w-0 flex flex-col items-center rounded-md disabled:cursor-default`}
              >
                <span className={`text-xs tabular-nums mb-1 ${hi ? 'text-white font-bold' : 'text-gray-400 font-semibold'}`}>{b.count}</span>
                <span className="w-full flex items-end justify-center" style={{ height: TRACK_PX }}>
                  <span
                    className={`block w-[78%] max-w-[44px] rounded-t transition-colors ${
                      b.count === 0 ? 'bg-surface-overlay' : hi ? 'bg-brand' : 'bg-brand/40 group-hover:bg-brand/70'
                    }`}
                    style={{ height: b.count === 0 ? 3 : Math.max(h, 4) }}
                  />
                </span>
                <span className={`text-xs mt-1.5 whitespace-nowrap ${hi ? 'text-white font-semibold' : 'text-gray-400'}`}>{b.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {(diary.busiestMonth || diary.currentStreak > 0) && (
        <div className="grid grid-cols-2 gap-2 mt-4">
          {diary.busiestMonth && (
            <RecordPill
              testId="stats-record-busiest"
              label="Busiest month"
              value={`${formatMonth(diary.busiestMonth.month)} · ${diary.busiestMonth.count}`}
              onClick={() => onOpenRecord('busiest')}
            />
          )}
          {diary.currentStreak > 0 && (
            <RecordPill
              testId="stats-record-streak"
              label="Current streak"
              value={`${diary.currentStreak} ${diary.currentStreak === 1 ? 'month' : 'months'}`}
              onClick={() => onOpenRecord('streak')}
            />
          )}
        </div>
      )}
    </StatsCard>
  );
}
