'use client';
/**
 * Module 5: Aisle Mates + Your Paper of Record (lifetime). The critics and
 * outlets whose scores track your ratings, from the shared alignCritics over
 * /data/stats-reviews.json. Desktop: critics left, outlets + nemesis right.
 */

import { RISING_MIN_SHARED, type Alignment, type OutletAlignment } from '@/lib/stats';
import type { StatsBundle } from '@/lib/stats-ui/bundle';
import { displayNemesis, type Reviewer } from '@/lib/stats-ui/aisle-mates';
import { initials } from '@/lib/stats-ui/format';
import { GroupLabel, ModuleError, ModuleHeader, ModuleLocked, StatsCard, pressableClass, type DataState } from './primitives';

function biasLabel(bias: number): string {
  const r = Math.round(bias);
  if (r === 0) return 'dead level with you';
  const n = Math.abs(r);
  return `scores ${n} ${n === 1 ? 'pt' : 'pts'} ${r > 0 ? 'warmer' : 'colder'} than you`;
}

function MateRow({ a, muted, onClick, testId }: { a: Alignment; muted?: boolean; onClick: () => void; testId?: string }) {
  const pct = Math.round(a.alignment * 100);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-label={`${a.name}, ${pct} percent aligned across ${a.shared} shows. Opens the full history.`}
      className={`${pressableClass} group w-full flex items-center gap-3 py-2 rounded-lg hover:bg-white/[0.03]`}
    >
      <span className="flex-shrink-0 w-10 h-10 rounded-full bg-surface-overlay border border-white/10 flex items-center justify-center text-xs font-bold text-gray-300">
        {initials(a.name)}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-white truncate group-hover:text-brand transition-colors">{a.name}</span>
        <span className="block text-xs text-gray-400 mt-0.5 leading-snug">
          {a.shared} shows together · {biasLabel(a.bias)}
        </span>
      </span>
      <span className={`text-lg font-extrabold tabular-nums ${muted ? 'text-gray-400' : 'text-brand'}`}>{pct}%</span>
    </button>
  );
}

export default function AisleMates({
  bundle,
  data,
  onRetry,
  onOpenReviewer,
}: {
  bundle: StatsBundle;
  data: DataState;
  onRetry: () => void;
  onOpenReviewer: (who: Reviewer, label: string) => void;
}) {
  const { aisleMates, scope } = bundle;
  if (!aisleMates) {
    if (data === 'error') return <ModuleError title="Aisle Mates" what="critic reviews" onRetry={onRetry} />;
    return (
      <StatsCard>
        <ModuleHeader title="Aisle Mates" caption="Finding the critics who see theater the way you do…" />
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 rounded-lg bg-surface-overlay/60 animate-pulse" />
          ))}
        </div>
      </StatsCard>
    );
  }
  const { topMates, rising, highVolumeNemesis, topOutlets, nemesisOutlet, sharedShowCount } = aisleMates;
  const nemesis = displayNemesis(aisleMates);
  if (topMates.length === 0 && rising.length === 0) {
    return (
      <ModuleLocked
        title="Aisle Mates"
        need={`Rate ${RISING_MIN_SHARED} or more shows that have critic reviews to find the critics who see theater the way you do.`}
        scopeLabel={scope.kind !== 'all' ? 'all time' : undefined}
      />
    );
  }
  const openCritic = (c: Alignment) => onOpenReviewer({ kind: 'critic', index: c.index }, c.name);
  const openOutlet = (o: OutletAlignment) => onOpenReviewer({ kind: 'outlet', name: o.name }, o.name);

  return (
    <StatsCard>
      <ModuleHeader
        title="Aisle Mates"
        caption={`Critics who see theater the way you do · ${sharedShowCount} shows in common${scope.kind !== 'all' ? ' · all time' : ''}`}
      />
      <div className="grid md:grid-cols-2 gap-x-6 gap-y-5">
        <div className="min-w-0">
          {topMates.length > 0 && (
            <>
              <GroupLabel>Your closest critics</GroupLabel>
              {topMates.map((c) => (
                <MateRow key={c.name} a={c} testId="stats-aisle-mate-row" onClick={() => openCritic(c)} />
              ))}
            </>
          )}
          {rising.length > 0 && (
            <div className={topMates.length > 0 ? 'mt-4' : ''}>
              <GroupLabel>Rising matches</GroupLabel>
              {rising.map((c) => (
                <MateRow key={c.name} a={c} onClick={() => openCritic(c)} />
              ))}
            </div>
          )}
        </div>
        <div className="min-w-0">
          {topOutlets.length > 0 && (
            <>
              <GroupLabel>Your paper of record</GroupLabel>
              <MateRow a={topOutlets[0]} testId="stats-paper-of-record-row" onClick={() => openOutlet(topOutlets[0])} />
              {nemesisOutlet && nemesisOutlet.name !== topOutlets[0].name && (
                <button
                  type="button"
                  data-testid="stats-nemesis-outlet-row"
                  onClick={() => openOutlet(nemesisOutlet)}
                  className={`${pressableClass} text-xs text-gray-400 hover:text-gray-200 mt-1 rounded`}
                >
                  Least aligned outlet: {nemesisOutlet.name} ({Math.round(nemesisOutlet.alignment * 100)}%)
                </button>
              )}
            </>
          )}
          {nemesis && (
            <div className={topOutlets.length > 0 ? 'mt-4' : ''}>
              <GroupLabel>Critic nemesis</GroupLabel>
              <MateRow a={nemesis} muted testId="stats-critic-nemesis-row" onClick={() => openCritic(nemesis)} />
              {highVolumeNemesis && highVolumeNemesis.name !== nemesis.name && (
                <p className="text-xs text-gray-400 mt-1">
                  Most-read low match: {highVolumeNemesis.name}, {Math.round(highVolumeNemesis.alignment * 100)}% across {highVolumeNemesis.shared} shows.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </StatsCard>
  );
}
