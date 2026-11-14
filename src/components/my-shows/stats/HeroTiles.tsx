'use client';
/**
 * Module 1: Your Scorecard. Shows · Hours in a seat · Theaters · Years logged
 * (the fourth tile only under All time, where it is not a repeat of Shows).
 */

import type { StatsBundle } from '@/lib/stats-ui/bundle';
import { wholeHours } from '@/lib/stats-ui/format';
import { periodTileLabel } from '@/lib/stats-ui/scope';
import { ModuleHeader, StatTile, StatsCard } from './primitives';

export type HeroTile = 'shows' | 'hours' | 'theaters' | 'period';

export default function HeroTiles({ bundle, onOpen }: { bundle: StatsBundle; onOpen: (which: HeroTile) => void }) {
  const { diary, distinctShows, scope, hoursEstimated } = bundle;
  const showPeriod = scope.kind === 'all';

  return (
    <StatsCard>
      <ModuleHeader title="Your Scorecard" caption={scope.label} />
      <div className={`grid grid-cols-2 gap-2 sm:gap-3 ${showPeriod ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
        <StatTile
          testId="stats-tile-shows"
          value={String(distinctShows)}
          label={distinctShows === 1 ? 'Show' : 'Shows'}
          sublabel={diary.total > distinctShows ? `${diary.total} entries` : undefined}
          onClick={() => onOpen('shows')}
        />
        <StatTile
          testId="stats-tile-hours"
          value={wholeHours(diary.minutesInSeat)}
          label="Hours in a seat"
          sublabel={hoursEstimated ? 'estimated' : undefined}
          onClick={() => onOpen('hours')}
        />
        <div className={showPeriod ? 'contents' : 'col-span-2 sm:col-span-1 grid'}>
          <StatTile
            testId="stats-tile-theaters"
            value={String(diary.distinctTheaters)}
            label={diary.distinctTheaters === 1 ? 'Theater' : 'Theaters'}
            sublabel={`${diary.distinctBroadwayHouses} Broadway`}
            onClick={() => onOpen('theaters')}
          />
        </div>
        {showPeriod && (
          <StatTile
            testId="stats-tile-period"
            value={String(diary.byYear.filter((b) => b.count > 0).length)}
            label={periodTileLabel(scope)}
            sublabel={diary.firstSeen ? `since ${diary.firstSeen.slice(0, 4)}` : undefined}
            onClick={() => onOpen('period')}
          />
        )}
      </div>
      {hoursEstimated && (
        <p className="text-xs text-fg-muted mt-3">
          Hours are estimated: {Math.round(diary.runtimeFallbackShare * 100)}% of these shows have no runtime on file, so they count as 2h 30m
          (musicals) or 2h (plays).
        </p>
      )}
    </StatsCard>
  );
}
