'use client';
/**
 * Module 4: You vs. the critics (scoped), plus the two lifetime companions the
 * app shows next to it: Critical Gold coverage and the audience & you.
 * On desktop the contrarian lists and the two companion cards sit side by side.
 */

import { ScoreBadge } from '@/components/show-cards';
import { Poster } from '@/components/user/upcoming-cards';
import MiniStars from '@/components/user/Stars';
import type { StatsBundle } from '@/lib/stats-ui/bundle';
import { MIN_RATED_WITH_SCORE, type ContrarianPick } from '@/lib/stats-ui/critics';
import { ChipButton, GoldTrack, GroupLabel, ModuleError, ModuleHeader, ModuleLocked, StatsCard, pressableClass, type DataState } from './primitives';

function PickRow({ pick, onClick }: { pick: ContrarianPick; onClick: () => void }) {
  const delta = Math.round(pick.delta);
  return (
    <button
      type="button"
      data-testid="stats-contrarian-row"
      onClick={onClick}
      aria-label={`${pick.title}. You rated it ${pick.rating} stars, critics ${Math.round(pick.criticScore)}.`}
      className={`${pressableClass} group w-full flex items-center gap-3 py-2 rounded-lg hover:bg-white/[0.03]`}
    >
      <span className="flex-shrink-0 w-11 aspect-square rounded-lg overflow-hidden bg-surface-overlay">
        <Poster url={pick.poster} iconClass="text-base" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-white truncate group-hover:text-brand transition-colors">{pick.title}</span>
        <span className="flex items-center gap-2 mt-1">
          <span className="flex items-center gap-0.5">
            <MiniStars rating={pick.rating} filledOnly />
          </span>
          <span className="text-xs font-semibold text-gray-400 tabular-nums">
            {delta > 0 ? '+' : ''}
            {delta} pts
          </span>
        </span>
      </span>
      <ScoreBadge size="xs" score={pick.criticScore} category={pick.category ?? undefined} />
    </button>
  );
}

export function YouVsCritics({
  bundle,
  catalog,
  onRetryCatalog,
  onOpenAligned,
  onOpenPick,
}: {
  bundle: StatsBundle;
  catalog: DataState;
  onRetryCatalog: () => void;
  onOpenAligned: () => void;
  onOpenPick: (showId: string) => void;
}) {
  const { critics, scope } = bundle;
  if (catalog === 'error') {
    return <ModuleError title="You vs. the critics" what="critic scores" onRetry={onRetryCatalog} />;
  }
  if (catalog === 'loading') {
    return (
      <StatsCard>
        <ModuleHeader title="You vs. the critics" caption="Loading critic scores…" />
        <div className="h-2.5 rounded-full bg-surface-overlay animate-pulse" />
      </StatsCard>
    );
  }
  if (critics.comparable < MIN_RATED_WITH_SCORE) {
    const n = MIN_RATED_WITH_SCORE - critics.comparable;
    return (
      <ModuleLocked
        title="You vs. the critics"
        need={`Rate ${n} more show${n === 1 ? '' : 's'} with a critic score to see your taste profile.`}
        scopeLabel={scope.kind !== 'all' ? scope.label : undefined}
      />
    );
  }

  const pct = Math.round(critics.alignment * 100);
  const bias = Math.round(critics.bias);

  return (
    <StatsCard>
      <ModuleHeader
        title="You vs. the critics"
        caption={`Across ${critics.comparable} shows you rated that have a critic score${scope.kind !== 'all' ? ` · ${scope.label}` : ''}`}
      />
      <button
        type="button"
        data-testid="stats-alignment-gauge"
        onClick={onOpenAligned}
        aria-label={`${critics.label}, ${pct} percent. Opens the shows you agreed on.`}
        className={`${pressableClass} w-full text-left rounded-lg -mx-1 px-1 py-1 hover:bg-white/[0.03]`}
      >
        <span className="flex items-baseline justify-between gap-3 mb-2">
          <span className="text-base sm:text-lg font-bold text-white">{critics.label}</span>
          <span className="text-3xl font-extrabold text-brand tabular-nums leading-tight">{pct}%</span>
        </span>
        <GoldTrack pct={critics.alignment} thick />
        <span className="block text-xs text-gray-400 mt-2">
          {critics.aligned} of {critics.comparable} within 10 points ·{' '}
          {bias === 0
            ? 'dead level with the critics'
            : bias < 0
              ? `critics run ${Math.abs(bias)} pts colder than you`
              : `critics run ${bias} pts warmer than you`}
        </span>
      </button>

      {(critics.youLovedIt.length > 0 || critics.criticsRaved.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4 mt-5">
          {critics.youLovedIt.length > 0 && (
            <div className="min-w-0">
              <GroupLabel>You loved it, critics didn&apos;t</GroupLabel>
              {critics.youLovedIt.map((p) => (
                <PickRow key={p.showId} pick={p} onClick={() => onOpenPick(p.showId)} />
              ))}
            </div>
          )}
          {critics.criticsRaved.length > 0 && (
            <div className="min-w-0">
              <GroupLabel>Critics raved, you shrugged</GroupLabel>
              {critics.criticsRaved.map((p) => (
                <PickRow key={p.showId} pick={p} onClick={() => onOpenPick(p.showId)} />
              ))}
            </div>
          )}
        </div>
      )}
    </StatsCard>
  );
}

export function GoldCard({ bundle, onOpenGold }: { bundle: StatsBundle; onOpenGold: (which: 'seen' | 'unseen') => void }) {
  const { gold, scope } = bundle;
  if (gold.total === 0) return null;
  return (
    <StatsCard>
      <ModuleHeader title="Critical Gold, open now" caption={scope.kind !== 'all' ? 'All time' : 'The top-scored shows playing right now'} />
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-3xl font-extrabold text-white tabular-nums leading-tight">{gold.seen}</span>
        <span className="text-sm text-gray-400">of {gold.total} seen</span>
      </div>
      <GoldTrack pct={gold.total ? gold.seen / gold.total : 0} />
      <div className="flex flex-wrap gap-2 mt-4">
        <ChipButton testId="stats-gold-seen" onClick={() => onOpenGold('seen')}>
          Seen
        </ChipButton>
        {gold.total - gold.seen > 0 && (
          <ChipButton testId="stats-gold-unseen" onClick={() => onOpenGold('unseen')}>
            {gold.total - gold.seen} to see
          </ChipButton>
        )}
      </div>
    </StatsCard>
  );
}

export function AudienceCard({ bundle, onOpen }: { bundle: StatsBundle; onOpen: () => void }) {
  const { audience, scope } = bundle;
  if (audience.comparable < MIN_RATED_WITH_SCORE) return null;
  const pct = Math.round(audience.alignment * 100);
  return (
    <StatsCard>
      <ModuleHeader title="The audience & you" caption={scope.kind !== 'all' ? 'All time' : `Across ${audience.comparable} shows with an audience grade`} />
      <button
        type="button"
        data-testid="stats-audience-row"
        onClick={onOpen}
        aria-label={`You agree with the audience grade ${pct} percent of the time. Opens the list.`}
        className={`${pressableClass} w-full text-left rounded-lg -mx-1 px-1 py-1 hover:bg-white/[0.03]`}
      >
        <span className="flex items-baseline gap-2 mb-2">
          <span className="text-3xl font-extrabold text-brand tabular-nums leading-tight">{pct}%</span>
          <span className="text-sm text-gray-400">agreement</span>
        </span>
        <GoldTrack pct={audience.alignment} />
        <span className="block text-sm text-gray-300 mt-3 leading-snug">
          {audience.alignment >= 0.7
            ? 'One of the crowd: you land within a grade of the audience most nights.'
            : audience.alignment >= 0.45
              ? 'You go your own way sometimes, but mostly agree with the room.'
              : 'A true contrarian: the room rarely agrees with you.'}
        </span>
      </button>
    </StatsCard>
  );
}
