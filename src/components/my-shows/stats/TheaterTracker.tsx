'use client';
/**
 * Module 3: Broadway theaters. Completion ring "N of 42", the house checklist
 * (visited = gold tint + visit count, unvisited = outline), house records.
 * Lifetime: under a dated scope the caption says "all time".
 */

import type { HouseVisit } from '@/lib/stats';
import type { StatsBundle } from '@/lib/stats-ui/bundle';
import { houseShortName } from '@/lib/stats-ui/format';
import { ModuleHeader, ProgressRing, RecordPill, StatsCard, pressableClass, Chevron } from './primitives';

export type HouseRecord = 'home' | 'biggest' | 'smallest' | 'oldest';

export default function TheaterTracker({
  bundle,
  onOpenHouse,
  onOpenRecord,
  onOpenRing,
  onOpenExtraCredit,
}: {
  bundle: StatsBundle;
  onOpenHouse: (house: HouseVisit) => void;
  onOpenRecord: (kind: HouseRecord) => void;
  onOpenRing: () => void;
  onOpenExtraCredit: () => void;
}) {
  const { theaters, scope } = bundle;
  const { records } = theaters;
  const toGo = theaters.operating - theaters.visited;

  return (
    <StatsCard>
      <ModuleHeader
        title="Broadway theaters"
        caption={`${Math.round(theaters.completion * 100)}% of the operating houses${scope.kind !== 'all' ? ' · all time' : ''}`}
      />

      <div className="flex items-center gap-4 sm:gap-6 mb-5">
        <button
          type="button"
          data-testid="stats-theater-ring"
          onClick={onOpenRing}
          aria-label={`${theaters.visited} of ${theaters.operating} Broadway houses visited. Opens the list.`}
          className={`${pressableClass} flex-shrink-0 rounded-full hover:opacity-90`}
        >
          <ProgressRing pct={theaters.completion}>
            <span className="text-3xl font-extrabold text-white tabular-nums leading-tight">{theaters.visited}</span>
            <span className="text-xs text-gray-400 mt-1">of {theaters.operating}</span>
          </ProgressRing>
        </button>
        <div className="min-w-0">
          <p className="text-base sm:text-lg font-semibold text-white">
            {toGo === 0 ? 'Every operating house. Extraordinary.' : `${toGo} ${toGo === 1 ? 'house' : 'houses'} to go`}
          </p>
          {theaters.totalAudience > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              About {theaters.totalAudience.toLocaleString('en-US')} people shared the house with you (full houses).
            </p>
          )}
          {theaters.extraCredit.length > 0 && (
            <button
              type="button"
              data-testid="stats-extra-credit"
              onClick={onOpenExtraCredit}
              className={`${pressableClass} mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:text-brand-light rounded`}
            >
              + {theaters.extraCredit.length} venues beyond Broadway
              <Chevron className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1.5" data-testid="stats-house-grid">
        {theaters.houses.map((h) => (
          <button
            key={h.name}
            type="button"
            data-testid={`stats-house-chip${h.visited ? '' : '-unvisited'}`}
            onClick={() => onOpenHouse(h)}
            title={h.visited ? `${h.name}: ${h.count} ${h.count === 1 ? 'visit' : 'visits'}` : `${h.name}: not yet`}
            aria-label={h.visited ? `${h.name}. Visited ${h.count} ${h.count === 1 ? 'time' : 'times'}.` : `${h.name}. Not yet visited.`}
            className={`${pressableClass} relative flex items-center justify-center gap-1 rounded-lg border px-1.5 py-1.5 min-h-[44px] min-w-0 ${
              h.visited
                ? 'bg-brand/15 border-brand/40 hover:bg-brand/25 text-white'
                : 'border-white/10 hover:border-white/25 text-fg-muted hover:text-gray-300'
            }`}
          >
            <span className="text-xs font-semibold text-center leading-tight line-clamp-2 break-words">{houseShortName(h.name)}</span>
            {h.count > 1 && <span className="text-xs font-bold text-brand tabular-nums flex-shrink-0">{h.count}</span>}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 mt-4">
        {records.homeTheater && (
          <RecordPill
            testId="stats-house-record-home"
            label="Home theater"
            value={`${houseShortName(records.homeTheater.name)} · ${records.homeTheater.count}`}
            onClick={() => onOpenRecord('home')}
          />
        )}
        {records.biggest && (
          <RecordPill
            label="Biggest house"
            value={`${houseShortName(records.biggest.name)} · ${records.biggest.capacity?.toLocaleString('en-US')}`}
            onClick={() => onOpenRecord('biggest')}
          />
        )}
        {records.smallest && (
          <RecordPill
            label="Smallest house"
            value={`${houseShortName(records.smallest.name)} · ${records.smallest.capacity?.toLocaleString('en-US')}`}
            onClick={() => onOpenRecord('smallest')}
          />
        )}
        {records.oldest && (
          <RecordPill
            label="Oldest house"
            value={`${houseShortName(records.oldest.name)} · ${records.oldest.yearBuilt}`}
            onClick={() => onOpenRecord('oldest')}
          />
        )}
      </div>
    </StatsCard>
  );
}
