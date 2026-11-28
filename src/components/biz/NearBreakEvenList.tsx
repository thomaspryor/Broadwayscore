/**
 * NearBreakEvenList (BRO-7246 lighter tier): running shows with no announced closing whose
 * 4-week average is just above our estimated break-even, or just under it in a slow season.
 * No date estimate: these could tip either way.
 */

import Link from 'next/link';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import type { NearBreakEvenShow } from '@/lib/data-types';
import { formatCurrency } from '@/lib/biz-format';

const TREND_LABELS: Record<NearBreakEvenShow['trend'], string> = {
  improving: 'Grosses up',
  steady: 'Grosses steady',
  declining: 'Grosses down',
  unknown: 'Not enough weeks',
};

export default function NearBreakEvenList({ shows }: { shows: NearBreakEvenShow[] }) {
  if (shows.length === 0) return null;
  return (
    <div className="mt-6" data-testid="near-breakeven">
      <h3 className="text-lg font-semibold text-white mb-1">Close to break-even</h3>
      <p className="text-gray-400 text-sm mb-3">
        Running shows up to 10% above our estimated break-even, or up to 10% under it only because it&apos;s a slow time
        of year. No closing estimate: they could tip either way. Shows marked New opened in the last two months and their
        weeks so far are mostly previews, so it&apos;s too early to judge.
      </p>
      <div className="card rounded-xl divide-y divide-white/5">
        {shows.map((show) => (
          <Link
            key={show.slug}
            href={`/show/${show.slug}`}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface-overlay focus-ring transition-colors"
            data-testid="near-breakeven-row"
          >
            <span className="flex items-center gap-2">
              <span className="font-medium text-white">{show.title}</span>
              {show.isNew && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-surface-overlay text-fg-muted whitespace-nowrap">
                  New, too early to judge
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-fg-muted whitespace-nowrap">
                {formatCurrency(show.avgWeeklyGross)} vs ~{formatCurrency(show.breakEven)}
              </span>
              <span className="text-score-tepid">
                ~{(show.seasonCleared || (show.isNew && show.breakEvenRatio < 1) ? Math.floor : Math.round)(show.breakEvenRatio * 100)}% of break-even
                {show.seasonCleared ? ' (slow season)' : ''}
              </span>
              {!show.isNew && (
                <span className={getTrendColor(show.trend, false)}>
                  <span aria-hidden="true">{getTrendIcon(show.trend, false)}</span> {TREND_LABELS[show.trend]}
                </span>
              )}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
