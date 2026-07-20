/**
 * SeasonStatsCard - Displays season statistics (capital at risk, recoupment count)
 * Sprint 2, Task 2.1
 */

import Link from 'next/link';
import { formatEstimatedCurrency } from '@/lib/biz-format';

interface SeasonStatsCardProps {
  season: string;
  capitalAtRisk: number;
  recoupedCount: number;
  totalShows: number;
  recoupedShows: string[];
}

// Below this many tracked shows, a "N of M recouped" / "$X at risk" stat is
// a single- or near-single-datapoint average — statistically misleading
// rather than informative (P0-2: a season with 1 show read "~$0 at risk,
// 0 of 1 recouped", which looks like a data bug, not "too early to tell").
const MIN_TRACKED_SHOWS = 5;

export default function SeasonStatsCard({
  season,
  capitalAtRisk,
  recoupedCount,
  totalShows,
  recoupedShows,
}: SeasonStatsCardProps) {
  if (totalShows > 0 && totalShows < MIN_TRACKED_SHOWS) {
    return (
      <Link
        href={`/biz/season/${season}`}
        className="block bg-surface-overlay rounded-xl p-4 border border-white/5 hover:border-brand/30 hover:bg-surface-overlay/80 transition-all cursor-pointer group"
      >
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2 group-hover:text-gray-400">
          {season} Season
          <span className="ml-2 text-brand opacity-0 group-hover:opacity-100 transition-opacity">→</span>
        </div>
        <div className="text-sm text-gray-400">
          Season just started — {totalShows} show{totalShows === 1 ? '' : 's'} tracked so far
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={`/biz/season/${season}`}
      className="block bg-surface-overlay rounded-xl p-4 border border-white/5 hover:border-brand/30 hover:bg-surface-overlay/80 transition-all cursor-pointer group"
    >
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-2 group-hover:text-gray-400">
        {season} Season
        <span className="ml-2 text-brand opacity-0 group-hover:opacity-100 transition-opacity">→</span>
      </div>
      <div className="flex justify-between items-end">
        <div>
          <div className="text-xl font-bold text-white">
            {formatEstimatedCurrency(capitalAtRisk)}
          </div>
          <div className="text-xs text-gray-500">Capital at Risk</div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-white">
            {recoupedCount}{' '}
            <span className="text-sm text-gray-400">of {totalShows}</span>
          </div>
          <div className="text-xs text-gray-500">Recouped</div>
        </div>
      </div>
      {recoupedShows.length > 0 && (
        <div className="mt-2 text-xs text-gray-500">
          {recoupedShows.slice(0, 3).join(', ')}
          {recoupedShows.length > 3 && ` +${recoupedShows.length - 3} more`}
        </div>
      )}
      {totalShows === 0 && (
        <div className="mt-2 text-xs text-gray-500">
          No commercial shows this season
        </div>
      )}
    </Link>
  );
}
