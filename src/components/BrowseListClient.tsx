'use client';

import { useState, useMemo, startTransition } from 'react';
import { SCORE_TIERS, ToggleBar, ScoreToggle, ShowListCard } from '@/components/show-cards';
import { hasEnoughReviews } from '@/config/score-buckets';

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
  criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number };
  audienceCombinedScore: number | null;
  audienceGrade: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
  performances?: number;
  reviewYearNote?: string;
  category?: string;
  ticketLinks?: { platform: string; url: string; priceFrom?: number | null }[];
}

type ScoreMode = 'critics' | 'audience';
type SortOption = 'score' | 'alpha' | 'newest' | 'oldest' | 'closing' | 'performances' | 'custom';

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
  /** Optional per-show section labels computed server-side. Shows with the same
   *  label are grouped under an H2 heading. Only displayed when using default sort. */
  sectionLabels?: string[];
}


const SORT_LABELS: Record<SortOption, string> = {
  score: 'Critics',
  alpha: 'A-Z',
  newest: 'Newest',
  oldest: 'Oldest',
  closing: 'Closing',
  performances: 'Longest',
  custom: 'Default',
};

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
  sectionLabels,
}: BrowseListClientProps) {
  const [scoreMode, setScoreMode] = useState<ScoreMode>('critics');
  const [sort, setSort] = useState<SortOption>(
    defaultSort === 'custom' ? 'custom' :
    defaultSort === 'performances' ? 'performances' :
    defaultSort === 'closing-date' ? 'closing' :
    defaultSort === 'opening-date-asc' ? 'oldest' :
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
      const reviewCount = s.criticScore?.reviewCount ?? 0;
      const t1t2 = (s.criticScore?.tier1Count ?? 0) + (s.criticScore?.tier2Count ?? 0);
      if (!hasEnoughReviews(reviewCount, s.category, t1t2)) return -1;
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
          // Shows without openingDate sort to the end
          if (!a.openingDate && !b.openingDate) return 0;
          if (!a.openingDate) return 1;
          if (!b.openingDate) return -1;
          return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
        case 'oldest':
          if (!a.openingDate && !b.openingDate) return 0;
          if (!a.openingDate) return 1;
          if (!b.openingDate) return -1;
          return new Date(a.openingDate).getTime() - new Date(b.openingDate).getTime();
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
            <ToggleBar
              variant="pill"
              size="compact"
              options={[{ value: 'all' as const, label: 'All' }, { value: 'musical' as const, label: 'Musicals' }, { value: 'play' as const, label: 'Plays' }]}
              value={typeFilter}
              onChange={setTypeFilter}
              ariaLabel="Filter by show type"
            />
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
                onChange={(v) => startTransition(() => setScoreMode(v))}
                className="flex-shrink-0"
              />
            )}
          </div>
        </div>
      )}

      {/* Show List */}
      {filteredAndSorted.length > 0 ? (
        <div className="space-y-3">
          {filteredAndSorted.map((show, index) => {
            // Section headings: only show when using default sort and labels exist
            const isDefaultSort = sort === 'custom' || sort === 'score';
            const originalIndex = initialShows.indexOf(show);
            const label = sectionLabels && isDefaultSort ? sectionLabels[originalIndex] : undefined;
            const prevShow = index > 0 ? filteredAndSorted[index - 1] : null;
            const prevOriginalIndex = prevShow ? initialShows.indexOf(prevShow) : -1;
            const prevLabel = prevShow && sectionLabels && isDefaultSort ? sectionLabels[prevOriginalIndex] : undefined;
            const showSectionHeader = label && label !== prevLabel;

            return (
              <div key={show.id}>
                {showSectionHeader && (
                  <h2 className={`text-lg font-bold text-white ${index > 0 ? 'mt-6 mb-3' : 'mb-3'}`}>
                    {label}
                  </h2>
                )}
                <ShowListCard
                  show={show}
                  index={index}
                  variant="compact"
                  rank={showRanks ? index + 1 : undefined}
                  showFormatPill={isMixedType && typeFilter === 'all'}
                  isMixedStatus={isMixedStatus}
                  scoreMode={scoreMode}
                  showPerformances={hasPerformanceData}
                  showLowReviewCount
                  showTicketLink
                />
              </div>
            );
          })}
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
