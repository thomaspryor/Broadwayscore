/**
 * ClosingWatchCard (BRO-7246): a running show with no announced closing whose
 * 4-week average gross is under break-even, with our estimated closing window
 * from how long past Broadway shows in the same spot kept running. The
 * estimate is ours and the card says so. Window ends can be null (history never got that far).
 */

import Link from 'next/link';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import type { ClosingWatchShow } from '@/lib/data-types';
import { formatCurrency, formatMonthYear } from '@/lib/biz-format';

const TREND_LABELS: Record<ClosingWatchShow['trend'], string> = {
  improving: 'Grosses up',
  steady: 'Grosses steady',
  declining: 'Grosses down',
  unknown: 'Not enough weeks',
};

export default function ClosingWatchCard({
  slug,
  title,
  season,
  avgWeeklyGross,
  breakEven,
  breakEvenRatio,
  weeksBelowBreakEven,
  trend,
  recouped,
  likelyClosing,
  basis,
}: ClosingWatchShow) {
  const trendLabel = TREND_LABELS[trend];
  const deficit = Math.max(0, breakEven - avgWeeklyGross);
  const pct = Math.round(breakEvenRatio * 100);
  const median = formatMonthYear(likelyClosing?.median);
  const early = formatMonthYear(likelyClosing?.early);
  const late = formatMonthYear(likelyClosing?.late);

  return (
    <Link
      href={`/show/${slug}`}
      className="card rounded-xl p-4 block hover:bg-white/5 transition-colors border-l-2 border-score-tepid/50"
      data-testid="closing-watch-card"
    >
      <div className="flex justify-between items-start mb-2">
        <h3 className="font-semibold text-white">{title}</h3>
        <span className="text-xs px-2 py-1 rounded-full bg-score-tepid/20 text-score-tepid whitespace-nowrap">
          Closing Watch
        </span>
      </div>
      <div className="text-sm text-gray-400 mb-3">
        {season} Season{recouped ? ' · Recouped' : ''}
      </div>
      {median && (
        <div className="rounded-lg bg-surface-overlay px-3 py-2 mb-3" data-testid="closing-watch-estimate">
          <div className="text-xs text-fg-muted">Our estimate: likely closes around</div>
          <div className="text-lg font-semibold text-score-tepid">{median}</div>
          {(early || late) && (
            <div className="text-xs text-fg-muted">
              Likely window {early ?? 'soon'} to {late ?? 'later'}
            </div>
          )}
        </div>
      )}
      {!median && (
        <div className="rounded-lg bg-surface-overlay px-3 py-2 mb-3 text-xs text-fg-muted" data-testid="closing-watch-estimate">
          Too few past shows ran this far under break-even for us to estimate a date.
        </div>
      )}
      <div className="flex justify-between text-sm">
        <span className="text-fg-muted">Avg gross (4 wks)</span>
        <span className="text-white">{formatCurrency(avgWeeklyGross)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-fg-muted">Est. break-even</span>
        <span className="text-white">~{formatCurrency(breakEven)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-fg-muted">Running at</span>
        <span className="text-score-tepid">~{pct}% of break-even</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-fg-muted">Gap</span>
        <span className="text-red-400">-{formatCurrency(deficit)} a week</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-fg-muted">Weeks in a row under</span>
        <span className="text-white">{weeksBelowBreakEven}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-fg-muted">Trend (4 wks)</span>
        <span className={getTrendColor(trend, false)} aria-label={trendLabel}>
          {getTrendIcon(trend, false)} {trendLabel}
        </span>
      </div>
      {basis && (
        <p className="text-xs text-fg-muted mt-3">
          Of {basis.sample} past Broadway runs that{' '}
          {basis.weeksUnder > 0 ? `spent ${basis.weeksUnder}+ weeks` : 'fell'} under {basis.thresholdPct}% of
          break-even (adjusted for the season)
          {basis.cushion === 'thin' && ' without having earned back half their investment first'}
          {basis.cushion === 'banked' && ' after already earning back half their investment or more'}, half closed
          within {basis.medianWeeks} more weeks.
        </p>
      )}
    </Link>
  );
}
