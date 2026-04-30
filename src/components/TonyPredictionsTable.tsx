'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge, getScoreTier, StatusBadge, BlendedTrioDisplay } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';
import { getMarketLabel } from '@/lib/venue-classification';
import { RankBadge } from '@/components/gold-list/GoldListCards';
import type { SerializedTonyShow } from '@/lib/data-tony-predictions';

export type PredictionMode = 'combined' | 'critics' | 'audience';

export type { SerializedTonyShow };

export interface CategoryOutcome {
  status: 'correct' | 'missed';
  winnerTitle: string;
  winnerRank: number | null;
  predictedTitle: string | null;
}

interface TonyPredictionsTableProps {
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
  /** Unique key used as the section anchor ID */
  sectionId?: string;
  /** Global index offset so only the first few images across all sections are eager-loaded */
  startIndex?: number;
  /** Tony outcomes for historical seasons: slug → 'winner' | 'nominated' */
  outcomes?: Record<string, 'winner' | 'nominated'>;
  /** Past-season prediction result for THIS category (correct/missed + winner info). */
  categoryOutcome?: CategoryOutcome;
  /** Which scoring mode to rank and display */
  mode?: PredictionMode;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getEffectiveStatus(show: SerializedTonyShow): string {
  if (show.status !== 'previews') return show.status;
  const today = new Date().toISOString().slice(0, 10);
  const previewsStart = show.previewsStartDate || show.openingDate;
  if (previewsStart > today) return 'announced';
  return 'previews';
}

function TierLabel({ score, reviewCount, status }: { score: number | null; reviewCount: number; status: string }) {
  if (status === 'previews' || status === 'upcoming' || reviewCount < 5) return null;
  const tier = getScoreTier(score);
  if (!tier) return null;
  return (
    <span
      className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
      style={{ color: tier.color }}
    >
      {tier.label}
    </span>
  );
}

function getScoreForMode(show: SerializedTonyShow, mode: PredictionMode): number | null {
  switch (mode) {
    case 'combined': return show.blendedScore;
    case 'critics': return show.compositeScore;
    case 'audience': return show.audienceCombinedScore;
  }
}

function ScoreDisplay({ show, mode }: { show: SerializedTonyShow; mode: PredictionMode }) {
  if (mode === 'audience') {
    const grade = show.audienceGrade;
    if (!grade || grade.grade === '—') {
      return <span className="text-sm text-gray-500">—</span>;
    }
    return (
      <div
        className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center text-base sm:text-lg font-bold"
        style={{ backgroundColor: `${grade.color}20`, color: grade.color }}
        title={grade.tooltip}
      >
        {grade.grade}
      </div>
    );
  }

  if (mode === 'combined') {
    return (
      <BlendedTrioDisplay
        blendedScore={show.blendedScore}
        compositeScore={show.compositeScore}
        reviewCount={show.reviewCount}
        status={show.status}
        audienceGrade={show.audienceGrade}
        awardsScore={show.awardsScore}
        awardsWeighted={show.tonyCategoryKey === 'best-play'}
        size="md"
        showCrown
      />
    );
  }

  // critics mode — original behavior
  return (
    <div className="flex flex-col items-center gap-1">
      <TierLabel score={show.compositeScore} reviewCount={show.reviewCount} status={show.status} />
      <ScoreBadge score={show.compositeScore} size="lg" showCrown reviewCount={show.reviewCount} status={show.status} />
    </div>
  );
}

export default function TonyPredictionsTable({ title, description, shows, upcoming, sectionId, startIndex = 0, outcomes, categoryOutcome, mode = 'combined' }: TonyPredictionsTableProps) {
  // Re-sort scored shows by the active mode's score
  const scored = useMemo(() => {
    return [...shows].sort((a, b) => {
      const sa = getScoreForMode(a, mode);
      const sb = getScoreForMode(b, mode);
      // nulls sort to bottom
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sb - sa;
    });
  }, [shows, mode]);

  const upcomingSorted = [...upcoming].sort((a, b) =>
    (a.openingDate || '').localeCompare(b.openingDate || '')
  );
  const allShows = [...scored, ...upcomingSorted];

  if (allShows.length === 0) return null;

  const hasNotOpened = (show: SerializedTonyShow) =>
    getEffectiveStatus(show) === 'announced';

  return (
    <section className="mb-10" id={sectionId}>
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-xl font-bold text-white">{title}</h2>
          {categoryOutcome && (
            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold uppercase tracking-wide ${
              categoryOutcome.status === 'correct'
                ? 'bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-400/40'
                : 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/40'
            }`}>
              {categoryOutcome.status === 'correct' ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Correct
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Missed{categoryOutcome.winnerRank ? ` (#${categoryOutcome.winnerRank})` : ''}
                </>
              )}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-400 mt-1">{description}</p>
        {categoryOutcome && categoryOutcome.status === 'missed' && (
          <p className="text-xs text-gray-400 mt-1.5">
            Winner: <span className="text-white font-medium">{categoryOutcome.winnerTitle}</span>
            {categoryOutcome.predictedTitle && (
              <> · We picked <span className="text-gray-300">{categoryOutcome.predictedTitle}</span></>
            )}
          </p>
        )}
      </div>

      <div className="space-y-3 sm:space-y-4">
        {allShows.map((show, i) => {
          const isInUpcomingSection = upcoming.some(u => u.slug === show.slug);
          const notYetOpen = hasNotOpened(show);
          const rank = !isInUpcomingSection ? i + 1 : null;
          const globalIndex = startIndex + i;
          return (
            <Link
              key={show.slug}
              href={`/show/${show.slug}`}
              className={`card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group ${notYetOpen ? 'opacity-60' : ''}`}
            >
              {/* Rank badge or empty spacer */}
              {rank ? (
                <RankBadge rank={rank} />
              ) : (
                <div className="w-8 h-8 flex-shrink-0" />
              )}

              {/* Thumbnail */}
              <div className="w-16 h-16 sm:w-24 sm:h-24 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                {show.thumbnailPath ? (
                  <img
                    src={getOptimizedImageUrl(show.thumbnailPath, 'thumbnail')}
                    alt={`${show.title} ${getMarketLabel()} show`}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    width={96}
                    height={96}
                    loading={globalIndex < 3 ? 'eager' : 'lazy'}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-2xl">🎭</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                  <h3 className={`font-bold text-base sm:text-xl group-hover:text-brand transition-colors truncate w-full sm:w-auto sm:min-w-0 ${notYetOpen ? 'text-gray-400' : 'text-white'}`}>
                    {show.title}
                  </h3>
                  {rank === 1 && mode === 'combined' && !isInUpcomingSection && (
                    <span
                      className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white/85 rounded border border-white/30 bg-transparent"
                      title="Our model's #1 pick in this category."
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 20 20" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 1l2.39 4.84L17.3 6.9l-3.65 3.56.86 5.03L10 13.26l-4.51 2.23.86-5.03L2.7 6.9l4.91-.96L10 1z" />
                      </svg>
                      <span className="hidden sm:inline">Predicted Winner</span>
                      <span className="sm:hidden">Predicted</span>
                    </span>
                  )}
                  {outcomes?.[show.slug] === 'winner' && (
                    <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400 rounded border border-amber-500/20">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1l2.39 4.84L17.3 6.9l-3.65 3.56.86 5.03L10 13.26l-4.51 2.23.86-5.03L2.7 6.9l4.91-.96L10 1z" /></svg>
                      Winner
                    </span>
                  )}
                  {outcomes?.[show.slug] === 'nominated' && (
                    <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                      Nominated
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  <StatusBadge status={getEffectiveStatus(show)} />
                </div>
                <p className="text-xs text-gray-400 mt-1.5 truncate">
                  {notYetOpen
                    ? `Opens ${formatDate(show.openingDate)} · ${show.venue}`
                    : show.venue}
                </p>
              </div>

              {/* Score */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <ScoreDisplay show={show} mode={mode} />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
