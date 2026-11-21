'use client';
/**
 * Module 7: Your ratings (scoped). Half-star histogram 0.5–5.0, the most
 * common rating in full gold, an average marker in neutral ink, and a footer
 * that opens the unrated entries.
 */

import { MIN_RATED_FOR_HISTOGRAM, type StatsBundle } from '@/lib/stats-ui/bundle';
import { ModuleHeader, ModuleLocked, StatsCard, pressableClass } from './primitives';

const TRACK_PX = 120;

export default function RatingsModule({
  bundle,
  onOpenBucket,
  onOpenUnrated,
}: {
  bundle: StatsBundle;
  onOpenBucket: (value: number) => void;
  onOpenUnrated: () => void;
}) {
  const { histogram, scope } = bundle;
  if (histogram.rated < MIN_RATED_FOR_HISTOGRAM) {
    const n = MIN_RATED_FOR_HISTOGRAM - histogram.rated;
    return (
      <ModuleLocked
        title="Your ratings"
        need={`Rate ${n} more show${n === 1 ? '' : 's'} to see your distribution.`}
        scopeLabel={scope.kind !== 'all' ? scope.label : undefined}
      />
    );
  }
  const max = histogram.buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const avg = histogram.average ?? 0;
  // 0.5★ is the centre of slot 0 (5%), 5.0★ the centre of slot 9 (95%).
  const markerPct = Math.min(Math.max(5 + ((avg - 0.5) / 4.5) * 90, 0), 100);

  return (
    <StatsCard>
      <ModuleHeader
        title="Your ratings"
        caption={`Average ${avg.toFixed(2)}★ · median ${histogram.median?.toFixed(1) ?? '–'}★${scope.kind !== 'all' ? ` · ${scope.label}` : ''}`}
      />
      <div className="relative pt-6">
        <div className="flex items-end gap-1 sm:gap-2">
          {histogram.buckets.map((b) => {
            const isMode = b.value === histogram.mode;
            const label = `${b.value}★: ${b.count} ${b.count === 1 ? 'show' : 'shows'}`;
            return (
              <button
                key={b.value}
                type="button"
                data-testid={`stats-histogram-${b.value}`}
                onClick={b.count > 0 ? () => onOpenBucket(b.value) : undefined}
                disabled={b.count === 0}
                title={label}
                aria-label={label}
                className={`${pressableClass} group flex-1 min-w-0 flex flex-col items-center rounded-md disabled:cursor-default`}
              >
                <span className={`text-xs tabular-nums mb-1 ${b.count === 0 ? 'text-transparent' : isMode ? 'text-white font-bold' : 'text-gray-400 font-semibold'}`}>
                  {b.count}
                </span>
                <span className="w-full flex items-end justify-center" style={{ height: TRACK_PX }}>
                  <span
                    className={`block w-[78%] max-w-[44px] rounded-t transition-colors ${
                      b.count === 0 ? 'bg-surface-overlay' : isMode ? 'bg-brand' : 'bg-brand/40 group-hover:bg-brand/70'
                    }`}
                    style={{ height: b.count === 0 ? 3 : Math.max((b.count / max) * TRACK_PX, 4) }}
                  />
                </span>
                <span className="text-xs text-gray-400 mt-1.5 tabular-nums min-h-[16px]">{b.value % 1 === 0 ? `${b.value}★` : ''}</span>
              </button>
            );
          })}
        </div>
        {/* Average marker: neutral ink, deliberately not gold. */}
        <div className="pointer-events-none absolute top-0 bottom-6" style={{ left: `${markerPct}%` }} aria-hidden="true">
          <div className="relative -translate-x-1/2 flex flex-col items-center h-full">
            <span className="text-xs font-bold text-white tabular-nums whitespace-nowrap">avg {avg.toFixed(1)}★</span>
            {/* Skip the count-label row so the line never crosses a number. */}
            <span className="h-5 flex-shrink-0" />
            <span className="flex-1 w-0.5 rounded-full bg-fg-placeholder/70" />
          </div>
        </div>
      </div>
      <button
        type="button"
        data-testid="stats-ratings-footer"
        onClick={histogram.unrated > 0 ? onOpenUnrated : undefined}
        disabled={histogram.unrated === 0}
        className={`${pressableClass} mt-3 text-xs text-gray-400 enabled:hover:text-gray-200 rounded`}
      >
        {histogram.rated} of {histogram.total} entries rated
        {histogram.unrated > 0 ? ` · ${histogram.unrated} to rate` : ''}
      </button>
    </StatsCard>
  );
}
