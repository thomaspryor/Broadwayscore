'use client';

import { useState, useMemo, memo } from 'react';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import { SCORE_TIERS, getScoreTier, ScoreBadge, FormatPill, ProductionPill, AudienceChip, ToggleBar, ScoreToggle } from '@/components/show-cards';
import type { ScoreTier } from '@/components/show-cards';
import { getBroadwayDuration } from '@/lib/date-utils';

// Serialized show data passed from server component
export interface BrowseShow {
  id: string;
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  closingDate?: string;
  status: string;
  type: string;
  isRevival?: boolean;
  runtime?: string;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  criticScore?: { score?: number; reviewCount?: number };
  audienceCombinedScore: number | null;
  audienceGrade: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
  performances?: number;
  reviewYearNote?: string;
  category?: string;
}

type ScoreMode = 'critics' | 'audience';
type SortOption = 'score' | 'alpha' | 'newest' | 'closing' | 'performances';

interface BrowseListClientProps {
  shows: BrowseShow[];
  showRanks: boolean;
  isMixedType: boolean;
  isMixedStatus: boolean;
  defaultSort: string;
  hasPerformanceData: boolean;
  /** Which sort options to offer (context-dependent) */
  availableSorts: SortOption[];
  /** Whether to show the type filter (All/Musicals/Plays) */
  showTypeFilter: boolean;
  /** Whether to show the score mode toggle */
  showScoreToggle: boolean;
  /** Optional subtitle shown on same line as toggle (e.g. "Last updated: Feb 2026") */
  subtitle?: string;
}


function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
      isTop3 ? 'bg-accent-gold text-gray-900' : 'bg-surface-overlay text-gray-400 border border-white/10'
    }`}>
      {rank}
    </div>
  );
}

const SORT_LABELS: Record<SortOption, string> = {
  score: 'Highest',
  alpha: 'A-Z',
  newest: 'Newest',
  closing: 'Closing',
  performances: 'Longest',
};

const ShowCard = memo(function ShowCard({
  show,
  rank,
  showRanks,
  isMixedType,
  isMixedStatus,
  scoreMode,
}: {
  show: BrowseShow;
  rank: number;
  showRanks: boolean;
  isMixedType: boolean;
  isMixedStatus: boolean;
  scoreMode: ScoreMode;
}) {
  const isOpen = show.status === 'open' || show.status === 'previews' || show.status === 'upcoming';
  const isWestEnd = show.category === 'west-end';
  const isOffBroadway = show.category === 'off-broadway';
  const durationSuffix = isWestEnd ? 'in the West End' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';
  const duration = isOpen ? getBroadwayDuration(show.openingDate, durationSuffix) : null;

  // Determine which score/tier to display
  let tier: ScoreTier | null = null;
  let displayScore: number | undefined;

  if (scoreMode === 'audience') {
    // Audience mode: use audience grade
    displayScore = show.audienceCombinedScore ?? undefined;
    tier = getScoreTier(displayScore);
  } else {
    displayScore = show.criticScore?.score;
    tier = getScoreTier(displayScore);
  }

  return (
    <div className="flex items-center gap-3">
      {showRanks && <RankBadge rank={rank} />}
      <Link
        href={`/show/${show.slug}`}
        className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group flex-1 min-w-0"
      >
        {/* Thumbnail */}
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
          {show.images?.thumbnail ? (
            <img
              src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
              alt={`${show.title} ${isWestEnd ? 'West End' : isOffBroadway ? 'Off-Broadway' : 'Broadway'} ${show.type}`}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-2xl">🎭</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h2 className="font-bold text-lg text-white group-hover:text-brand transition-colors truncate">
            {show.title}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            {isMixedType && <FormatPill type={show.type} />}
            {show.isRevival && <ProductionPill isRevival={true} />}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-gray-500">
            {show.performances ? (
              <span className="text-emerald-400">{show.performances.toLocaleString()} performances</span>
            ) : (
              <>
                {duration && <span>{duration}</span>}
                {isOpen && show.closingDate && (
                  <span className="text-amber-400">
                    {duration && '·'} Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
                {(show.status === 'previews' || show.status === 'upcoming') && show.openingDate && (
                  <span className="text-purple-400">
                    Opens {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
              </>
            )}
            {isMixedStatus && !isOpen && (
              <span className="text-orange-400">
                Closed{show.closingDate ? ` ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* Review Year Note - hidden on mobile */}
        {show.reviewYearNote && scoreMode === 'critics' && (
          <span className="hidden sm:flex flex-shrink-0 text-[10px] text-gray-400 leading-tight text-right max-w-[4.5rem] self-center">
            {show.reviewYearNote}
          </span>
        )}

        {/* Score */}
        <div className="flex-shrink-0 flex flex-col items-center gap-1.5 w-20 sm:w-24">
          {scoreMode === 'audience' ? (
            show.audienceGrade ? (
              <>
                <span
                  className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                  style={{ color: show.audienceGrade.color }}
                >
                  {show.audienceGrade.label}
                </span>
                <div
                  className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center font-bold text-xl sm:text-2xl"
                  style={{ backgroundColor: show.audienceGrade.color, color: show.audienceGrade.textColor }}
                  title={show.audienceGrade.tooltip}
                >
                  {show.audienceGrade.grade}
                </div>
              </>
            ) : (
              <>
                <span className="text-[9px] font-semibold uppercase tracking-wide text-gray-600 whitespace-nowrap">
                  No Data
                </span>
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center font-bold text-lg bg-surface-overlay text-gray-600 border border-white/10">
                  --
                </div>
              </>
            )
          ) : (
            <>
              {tier ? (
                <span
                  className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                  style={{ color: tier.color }}
                >
                  {tier.label}
                </span>
              ) : null}
              <ScoreBadge score={displayScore} size="md" showCrown reviewCount={show.criticScore?.reviewCount} category={show.category} />
              {show.criticScore?.reviewCount && show.criticScore.reviewCount <= 2 ? (
                <span className="text-[9px] text-gray-500 whitespace-nowrap">
                  {show.criticScore.reviewCount} review{show.criticScore.reviewCount > 1 ? 's' : ''}
                </span>
              ) : show.audienceGrade ? (
                <div className="mt-0.5">
                  <AudienceChip grade={show.audienceGrade} />
                </div>
              ) : null}
            </>
          )}
        </div>
      </Link>
    </div>
  );
});

export default function BrowseListClient({
  shows: initialShows,
  showRanks,
  isMixedType,
  isMixedStatus,
  defaultSort,
  hasPerformanceData,
  availableSorts,
  showTypeFilter,
  showScoreToggle,
  subtitle,
}: BrowseListClientProps) {
  const [scoreMode, setScoreMode] = useState<ScoreMode>('critics');
  const [sort, setSort] = useState<SortOption>(
    defaultSort === 'performances' ? 'performances' :
    defaultSort === 'closing-date' ? 'closing' :
    defaultSort === 'opening-date-asc' ? 'newest' :
    defaultSort === 'opening-date' ? 'newest' :
    'score'
  );
  const [typeFilter, setTypeFilter] = useState<'all' | 'musical' | 'play'>('all');

  const hasAnyAudienceData = useMemo(
    () => initialShows.some(s => s.audienceCombinedScore !== null),
    [initialShows]
  );

  const filteredAndSorted = useMemo(() => {
    let result = [...initialShows];

    // Type filter
    if (typeFilter !== 'all') {
      result = result.filter(s => s.type === typeFilter);
    }

    // Helper: effective score for sorting (TBD shows sort to bottom)
    const getEffectiveScore = (s: BrowseShow) => {
      const minReviews = (s.category === 'off-broadway' || s.category === 'west-end') ? 3 : 5;
      if ((s.criticScore?.reviewCount ?? 0) < minReviews) return -1;
      return s.criticScore?.score ?? -1;
    };

    // Sort
    result.sort((a, b) => {
      switch (sort) {
        case 'score':
          if (scoreMode === 'audience') {
            return (b.audienceCombinedScore ?? -1) - (a.audienceCombinedScore ?? -1);
          }
          return getEffectiveScore(b) - getEffectiveScore(a);
        case 'alpha':
          return a.title.localeCompare(b.title);
        case 'newest':
          return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
        case 'closing':
          // Shows with closing dates first (sorted by soonest), then others
          if (a.closingDate && b.closingDate) {
            return new Date(a.closingDate).getTime() - new Date(b.closingDate).getTime();
          }
          if (a.closingDate) return -1;
          if (b.closingDate) return 1;
          return getEffectiveScore(b) - getEffectiveScore(a);
        case 'performances':
          return (b.performances ?? 0) - (a.performances ?? 0);
        default:
          return 0;
      }
    });

    return result;
  }, [initialShows, typeFilter, sort, scoreMode]);

  const showControls = availableSorts.length > 1 || showTypeFilter || (showScoreToggle && hasAnyAudienceData);

  return (
    <>
      {/* Controls */}
      {showControls && (
        <div className={availableSorts.length > 1 || showTypeFilter ? 'mb-5 space-y-2.5' : '-mt-4 mb-4'}>
          {/* Type filter row (only if mixed types) */}
          {showTypeFilter && (
            <div className="flex items-center gap-1.5" role="group" aria-label="Filter by show type">
              {(['all', 'musical', 'play'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  aria-pressed={typeFilter === t}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider transition-colors min-h-[36px] ${
                    typeFilter === t
                      ? 'bg-brand text-gray-900'
                      : 'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20'
                  }`}
                >
                  {t === 'all' ? 'All' : t === 'musical' ? 'Musicals' : 'Plays'}
                </button>
              ))}
            </div>
          )}

          {/* Sort + Toggle row (all on one line) */}
          <div className="flex items-center justify-between gap-1">
            {availableSorts.length > 1 ? (
              <ToggleBar
                label="Sort:"
                options={availableSorts.map(s => ({ value: s, label: SORT_LABELS[s] }))}
                value={sort}
                onChange={setSort}
                ariaLabel="Sort shows"
              />
            ) : subtitle ? (
              <span className="text-gray-500 text-sm">{subtitle}</span>
            ) : <div />}

            {/* Score mode toggle */}
            {showScoreToggle && hasAnyAudienceData && (
              <ScoreToggle
                value={scoreMode}
                onChange={setScoreMode}
                className="flex-shrink-0"
              />
            )}
          </div>
        </div>
      )}

      {/* Show List */}
      {filteredAndSorted.length > 0 ? (
        <div className="space-y-3">
          {filteredAndSorted.map((show, index) => (
            <ShowCard
              key={show.id}
              show={show}
              rank={index + 1}
              showRanks={showRanks}
              isMixedType={isMixedType && typeFilter === 'all'}
              isMixedStatus={isMixedStatus}
              scoreMode={scoreMode}
            />
          ))}
        </div>
      ) : (
        <div className="card p-6 sm:p-8 text-center">
          <div className="text-3xl sm:text-4xl mb-4">🎭</div>
          <h2 className="text-lg sm:text-xl font-bold text-white mb-2">No Shows Match</h2>
          <p className="text-gray-400 text-sm sm:text-base">
            Try adjusting your filters to see more shows.
          </p>
        </div>
      )}
    </>
  );
}
