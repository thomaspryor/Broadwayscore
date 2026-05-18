'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge, getScoreTier, BlendedTrioDisplay } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';
import { getMarketLabel } from '@/lib/venue-classification';
import { RankBadge } from '@/components/gold-list/GoldListCards';
import type { SerializedTonyShow } from '@/lib/data-tony-predictions';

// Outlet badge metadata — update when new critic sources are added to data/tony-critic-picks.json
const CRITIC_PICK_SOURCES: Record<string, { shortName: string; color: string; outlet: string; critic: string }> = {
  nyt:     { shortName: 'NYT', color: '#1a1a1a', outlet: 'The New York Times', critic: 'Helen Shaw' },
  variety: { shortName: 'VAR', color: '#7b2d8b', outlet: 'Variety',            critic: 'Clayton Davis' },
  deadline:{ shortName: 'DL',  color: '#1565c0', outlet: 'Deadline',           critic: 'Greg Evans' },
};

export type PredictionMode = 'combined' | 'critics' | 'audience';

/** Softmax-based win probabilities within a category, temperature T=10.
 *  Shows with null blendedScore are excluded from the denominator. */
function computeWinProbabilities(shows: SerializedTonyShow[], mode: PredictionMode): Map<string, number> {
  const T = 10;
  const scored = shows.filter(s => getScoreForMode(s, mode) != null);
  if (scored.length === 0) return new Map();
  const exps = scored.map(s => Math.exp((getScoreForMode(s, mode) as number) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  const result = new Map<string, number>();
  scored.forEach((show, i) => result.set(show.slug, exps[i] / sum));
  return result;
}

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
  /** Shows opening in this season but ruled ineligible for this category by the Tony Administration Committee */
  ineligible?: Array<{ slug: string; title: string; note: string }>;
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

function CriticPickBadges({ picks }: { picks?: string[] }) {
  if (!picks || picks.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0">
      <div className="flex gap-0.5">
        {picks.map(id => {
          const src = CRITIC_PICK_SOURCES[id];
          if (!src) return null;
          return (
            <span
              key={id}
              className="inline-flex items-center justify-center px-1 h-4 rounded text-[8px] font-bold text-white leading-none whitespace-nowrap"
              style={{ backgroundColor: src.color }}
              title={`${src.outlet} (${src.critic}) picks this show to win`}
            >
              {src.shortName}
            </span>
          );
        })}
      </div>
      <span className="text-[8px] text-gray-600 uppercase tracking-wide leading-none">Press</span>
    </div>
  );
}

function getScoreForMode(show: SerializedTonyShow, mode: PredictionMode): number | null {
  switch (mode) {
    case 'combined': return show.blendedScore;
    case 'critics': return show.compositeScore;
    case 'audience': return show.audienceCombinedScore;
  }
}

function ScoreDisplay({ show, mode, winProbability }: { show: SerializedTonyShow; mode: PredictionMode; winProbability?: number }) {
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
    const ourPct = winProbability != null ? Math.round(winProbability * 100) : null;
    const gdPct = show.gdOdds != null ? Math.round(show.gdOdds * 100) : null;
    const hasOdds = ourPct != null || gdPct != null;

    if (!hasOdds) {
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

    return (
      <div className="flex items-center gap-3 sm:gap-4 flex-shrink-0">
        {/* Component scores — desktop only */}
        <div className="hidden sm:block">
          <BlendedTrioDisplay
            blendedScore={show.blendedScore}
            compositeScore={show.compositeScore}
            reviewCount={show.reviewCount}
            status={show.status}
            audienceGrade={show.audienceGrade}
            awardsScore={show.awardsScore}
            awardsWeighted={show.tonyCategoryKey === 'best-play'}
            size="sm"
            hideScore
          />
        </div>
        {/* Win probabilities */}
        <div className="flex items-stretch gap-2">
          {ourPct != null && (
            <div className="flex flex-col items-center justify-center min-w-[40px]">
              <span className="text-xl sm:text-2xl font-bold text-white leading-none">{ourPct}%</span>
              <span className="text-[9px] text-gray-500 uppercase tracking-wide mt-0.5">Our pick</span>
            </div>
          )}
          {gdPct != null && (
            <div className="flex flex-col items-center justify-center min-w-[40px] border-l border-white/10 pl-2 sm:pl-3">
              <span className="text-xl sm:text-2xl font-bold text-amber-400 leading-none">{gdPct}%</span>
              <span className="text-[9px] text-gray-500 uppercase tracking-wide mt-0.5">Gold Derby</span>
            </div>
          )}
        </div>
      </div>
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

export default function TonyPredictionsTable({ title, description, shows, upcoming, sectionId, startIndex = 0, outcomes, categoryOutcome, ineligible, mode = 'combined' }: TonyPredictionsTableProps) {
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

  // Softmax win probabilities within this category (combined mode only)
  const winProbabilities = useMemo(
    () => mode === 'combined' ? computeWinProbabilities(scored, mode) : new Map<string, number>(),
    [scored, mode]
  );

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
                      className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400 rounded border border-amber-500/40"
                      title="Our model's #1 pick in this category."
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M10 1l2.39 4.84L17.3 6.9l-3.65 3.56.86 5.03L10 13.26l-4.51 2.23.86-5.03L2.7 6.9l4.91-.96L10 1z" />
                      </svg>
                      <span className="hidden sm:inline">Predicted Winner</span>
                      <span className="sm:hidden">Our Pick</span>
                    </span>
                  )}
                  {outcomes?.[show.slug] === 'winner' && (
                    <span className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400 rounded border border-amber-500/20">
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1l2.39 4.84L17.3 6.9l-3.65 3.56.86 5.03L10 13.26l-4.51 2.23.86-5.03L2.7 6.9l4.91-.96L10 1z" /></svg>
                      Winner
                    </span>
                  )}
                </div>
                {notYetOpen && (
                  <p className="text-xs text-gray-500 mt-1">Opening {formatDate(show.openingDate)}</p>
                )}
              </div>

              {/* Critic press picks */}
              <CriticPickBadges picks={show.criticPicks} />

              {/* Score / Win probability */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <ScoreDisplay show={show} mode={mode} winProbability={winProbabilities.get(show.slug)} />
              </div>
            </Link>
          );
        })}
      </div>

      {/* Ruled-ineligible footer — shown when the Tony Administration Committee
          explicitly excluded a show in this category (e.g. solo storytelling,
          concert specials, Special Tony recipients). Turns a confusing absence
          into a credibility signal ("the site knows the rules"). */}
      {ineligible && ineligible.length > 0 && (
        <div className="mt-6 pt-4 border-t border-white/5">
          <h3 className="text-xs uppercase tracking-wide text-gray-500 font-medium mb-2">
            Ruled ineligible by the Tony Administration Committee
          </h3>
          <ul className="space-y-1.5">
            {ineligible.map(item => (
              <li key={item.slug} className="text-sm">
                <Link href={`/show/${item.slug}`} className="text-gray-300 hover:text-white font-medium">
                  {item.title}
                </Link>
                <span className="text-gray-500"> — {item.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
