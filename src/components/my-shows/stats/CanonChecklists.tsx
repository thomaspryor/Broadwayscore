'use client';
/**
 * Module 6: Tony & the canon (lifetime). Best Musical / Best Play winner
 * checklists: progress, a poster shelf with unseen winners dimmed, and the
 * "saw it before it won" flex (computed in the shared canonProgress).
 */

import ScrollRow from '@/components/ScrollRow';
import { Poster } from '@/components/user/upcoming-cards';
import type { CanonEntry, CanonList } from '@/lib/stats';
import type { StatsBundle } from '@/lib/stats-ui/bundle';
import { ChipButton, GoldTrack, ModuleError, ModuleHeader, StatsCard, pressableClass, type DataState } from './primitives';

export type CanonFilter = 'seen' | 'unseen' | 'before';

function CanonBlock({
  title,
  list,
  which,
  onOpenList,
  onOpenEntry,
}: {
  title: string;
  list: CanonList;
  which: 'musical' | 'play';
  onOpenList: (which: 'musical' | 'play', filter: CanonFilter) => void;
  onOpenEntry: (e: CanonEntry) => void;
}) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid={`stats-canon-${which}`}
        onClick={() => onOpenList(which, 'seen')}
        aria-label={`${title}: ${list.seen} of ${list.total} seen. Opens the list.`}
        className={`${pressableClass} w-full flex items-center justify-between gap-3 mb-1 rounded`}
      >
        <span className="text-sm font-bold text-white">{title}</span>
        <span className="text-sm font-bold text-gray-300 tabular-nums">
          {list.seen} <span className="text-fg-muted font-semibold">of {list.total}</span>
        </span>
      </button>
      <GoldTrack pct={list.completion} />
      <ScrollRow className="flex gap-2.5 overflow-x-auto py-3 -mx-4 px-4 sm:-mx-5 sm:px-5 scrollbar-hide">
        {list.entries.slice(0, 24).map((e) => (
          <button
            key={`${e.ceremony}:${e.id}`}
            type="button"
            data-testid={e.seen ? 'stats-canon-poster-seen' : 'stats-canon-poster-unseen'}
            onClick={() => onOpenEntry(e)}
            title={`${e.t} (${e.season})${e.seen ? (e.sawBeforeItWon ? ': seen before it won' : ': seen') : ''}`}
            aria-label={`${e.t}, ${e.season}. ${e.seen ? 'Seen' : 'Not seen'}.`}
            className={`${pressableClass} group flex-shrink-0 w-[84px] rounded-lg`}
          >
            <span
              className={`relative block w-full aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay border ${
                e.seen ? 'border-brand/50' : 'border-white/5 opacity-35 grayscale group-hover:opacity-60'
              } transition-opacity`}
            >
              <Poster url={e.img} iconClass="text-xl" title={e.t} />
              {e.sawBeforeItWon && (
                <span className="absolute top-1 right-1 rounded bg-surface/85 px-1 text-xs font-bold text-brand" aria-hidden="true">
                  ★
                </span>
              )}
            </span>
            <span className={`block text-xs tabular-nums mt-1 text-center ${e.seen ? 'text-gray-300 font-semibold' : 'text-fg-muted'}`}>{e.season}</span>
          </button>
        ))}
      </ScrollRow>
      <div className="flex flex-wrap gap-2">
        {list.sawBeforeItWon > 0 && (
          <ChipButton testId={`stats-canon-${which}-before`} onClick={() => onOpenList(which, 'before')}>
            <span className="text-brand">★</span> {list.sawBeforeItWon} saw it before it won
          </ChipButton>
        )}
        {list.unseen.length > 0 && (
          <ChipButton testId={`stats-canon-${which}-unseen`} onClick={() => onOpenList(which, 'unseen')}>
            {list.unseen.length} to go
          </ChipButton>
        )}
      </div>
    </div>
  );
}

export default function CanonChecklists({
  bundle,
  hasCanon,
  data,
  onRetry,
  onOpenList,
  onOpenEntry,
}: {
  bundle: StatsBundle;
  hasCanon: boolean;
  data: DataState;
  onRetry: () => void;
  onOpenList: (which: 'musical' | 'play', filter: CanonFilter) => void;
  onOpenEntry: (e: CanonEntry) => void;
}) {
  const { canonStats, scope } = bundle;
  if (data === 'error') return <ModuleError title="Tony & the canon" what="Tony winners" onRetry={onRetry} />;
  if (!hasCanon) return null;
  return (
    <StatsCard>
      <ModuleHeader
        title="Tony & the canon"
        caption={
          scope.kind === 'all'
            ? `${canonStats.totalSeen} winners seen · ${canonStats.totalSawBeforeItWon} before they won`
            : 'Winners you have ever seen · all time'
        }
      />
      <div className="space-y-6">
        <CanonBlock title="Best Musical winners" list={canonStats.bestMusical} which="musical" onOpenList={onOpenList} onOpenEntry={onOpenEntry} />
        <CanonBlock title="Best Play winners" list={canonStats.bestPlay} which="play" onOpenList={onOpenList} onOpenEntry={onOpenEntry} />
      </div>
    </StatsCard>
  );
}
