'use client';

import { useMemo, useCallback, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import { getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/audience-grade-utils';
import ShowImage from '@/components/ShowImage';
import { getScoreTier, ScoreBadge, StatusBadge, FormatPill, ProductionPill, ToggleBar, ScoreToggle } from '@/components/show-cards';
import type { ScoreTier } from '@/components/show-cards';

// Serialized show type — pre-computed by server component
export interface NVPShow {
  id: string;
  slug: string;
  title: string;
  type: string;
  status: string;
  isRevival: boolean;
  openingDate: string;
  closingDate?: string;
  images?: {
    thumbnail?: string;
    poster?: string;
    hero?: string;
  };
  criticScore: { score: number | null; reviewCount: number } | null;
  audienceCombinedScore: number | null;
  audienceHasEnoughReviews: boolean;
}

interface NVPOffBroadway {
  title: string;
  venue: string;
  year: string;
  note: string;
}

// URL parameter types
type StatusParam = 'playing' | 'all' | 'closed';
type SortParam = 'score_desc' | 'recent' | 'alpha';
type TypeParam = 'all' | 'musical' | 'play';
type ScoreModeParam = 'critics' | 'audience';

const DEFAULT_STATUS: StatusParam = 'all';
const DEFAULT_SORT: SortParam = 'score_desc';
const DEFAULT_TYPE: TypeParam = 'all';
const DEFAULT_SCORE_MODE: ScoreModeParam = 'critics';

// Use UTC-based formatting to avoid timezone-related hydration mismatch
function formatOpeningDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function NVPPageInner({ shows, offBroadway }: { shows: NVPShow[]; offBroadway: NVPOffBroadway[] }) {
  const initialSearchParams = useSearchParams();

  // Local state for instant updates (no full-page reload)
  const [filters, setFilters] = useState(() => ({
    status: (['playing', 'all', 'closed'].includes(initialSearchParams.get('status') as string)
      ? initialSearchParams.get('status') as StatusParam : DEFAULT_STATUS),
    sort: (['score_desc', 'recent', 'alpha'].includes(initialSearchParams.get('sort') as string)
      ? initialSearchParams.get('sort') as SortParam : DEFAULT_SORT),
    type: (['all', 'musical', 'play'].includes(initialSearchParams.get('type') as string)
      ? initialSearchParams.get('type') as TypeParam : DEFAULT_TYPE),
    scoreMode: (['critics', 'audience'].includes(initialSearchParams.get('scoreMode') as string)
      ? initialSearchParams.get('scoreMode') as ScoreModeParam : DEFAULT_SCORE_MODE),
  }));

  const status = filters.status;
  const sort = filters.sort;
  const type = filters.type;
  const scoreMode = filters.scoreMode;

  // Update state + URL without reload
  const updateParams = useCallback((updates: Record<string, string | null>) => {
    setFilters(prev => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          (next as Record<string, string>)[key] =
            key === 'status' ? DEFAULT_STATUS :
            key === 'sort' ? DEFAULT_SORT :
            key === 'type' ? DEFAULT_TYPE :
            key === 'scoreMode' ? DEFAULT_SCORE_MODE : '';
        } else {
          (next as Record<string, string>)[key] = value;
        }
      }

      const urlParams = new URLSearchParams();
      if (next.status !== DEFAULT_STATUS) urlParams.set('status', next.status);
      if (next.sort !== DEFAULT_SORT) urlParams.set('sort', next.sort);
      if (next.type !== DEFAULT_TYPE) urlParams.set('type', next.type);
      if (next.scoreMode !== DEFAULT_SCORE_MODE) urlParams.set('scoreMode', next.scoreMode);

      const paramString = urlParams.toString();
      window.history.replaceState({}, '', paramString ? `/nvp?${paramString}` : '/nvp');

      return next;
    });
  }, []);

  // Filter and sort NVP shows
  const nvpShows = useMemo(() => {
    let result = [...shows];

    // Status filter
    if (status === 'playing') {
      result = result.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming');
    } else if (status === 'closed') {
      result = result.filter(s => s.status === 'closed');
    }

    // Type filter
    if (type !== 'all') {
      result = result.filter(show => {
        const isMusical = show.type === 'musical';
        return type === 'musical' ? isMusical : !isMusical;
      });
    }

    // Sort
    result.sort((a, b) => {
      switch (sort) {
        case 'score_desc': {
          if (scoreMode === 'audience') {
            const aAudience = (a.status === 'previews' || a.status === 'upcoming') ? -1 : (a.audienceCombinedScore ?? -1);
            const bAudience = (b.status === 'previews' || b.status === 'upcoming') ? -1 : (b.audienceCombinedScore ?? -1);
            return bAudience - aAudience;
          }
          // Sort by score, then open > previews > closed for ties
          const aScore = (a.status === 'previews' || a.status === 'upcoming') ? -1 : (a.criticScore?.score ?? -1);
          const bScore = (b.status === 'previews' || b.status === 'upcoming') ? -1 : (b.criticScore?.score ?? -1);
          if (bScore !== aScore) return bScore - aScore;
          const statusOrder = { open: 0, previews: 1, upcoming: 1, closed: 2 };
          return (statusOrder[a.status as keyof typeof statusOrder] ?? 3) - (statusOrder[b.status as keyof typeof statusOrder] ?? 3);
        }
        case 'alpha':
          return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
        case 'recent':
        default:
          return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
      }
    });

    return result;
  }, [shows, status, type, sort, scoreMode]);

  // Counts for summary badges (from full NVP list, not filtered)
  const openCount = shows.filter(s => s.status === 'open').length;
  const previewCount = shows.filter(s => s.status === 'previews' || s.status === 'upcoming').length;
  const closedCount = shows.filter(s => s.status === 'closed').length;
  const playingCount = openCount + previewCount;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold text-lg">
            NVP
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">NVP Portfolio</h1>
            <p className="text-gray-400 text-sm">Nothing Ventured Productions</p>
          </div>
        </div>

        <p className="text-gray-300 leading-relaxed mb-4">
          Shows invested in by <a href="https://www.nvpbroadway.com/" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Nothing Ventured Productions</a>,
          a four-time Tony nominated production company founded by Alexandra Cavoulacos, Kathryn Minshew, and Christina Wallace.
        </p>

        <div className="flex flex-wrap gap-3 text-sm">
          <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
            {playingCount} Playing
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-gray-500/10 text-gray-400">
            {closedCount} Closed
          </div>
        </div>
      </div>

      {/* Type Pills & Score Mode Toggle Row */}
      <div className="flex items-center justify-between gap-2 sm:gap-4 mb-4">
        {/* Type Filter Pills (Left) */}
        <ToggleBar
          variant="pill"
          options={[{ value: 'all' as const, label: 'All' }, { value: 'musical' as const, label: 'Musicals' }, { value: 'play' as const, label: 'Plays' }]}
          value={type}
          onChange={(t) => updateParams({ type: t })}
          ariaLabel="Filter by type"
        />

        {/* Score Mode Toggle (Right) */}
        <ScoreToggle
          value={scoreMode}
          onChange={(mode) => {
            if (mode === 'audience') {
              updateParams({ scoreMode: mode, sort: 'score_desc' });
            } else {
              updateParams({ scoreMode: mode });
            }
          }}
          audienceFirst
          size="large"
          ariaLabel="Score mode"
        />
      </div>

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-4 sm:mb-6 text-sm">
        <ToggleBar
          label="STATUS:"
          options={[
            { value: 'playing' as StatusParam, label: 'PLAYING' },
            { value: 'all' as StatusParam, label: 'ALL' },
            { value: 'closed' as StatusParam, label: 'CLOSED' },
          ]}
          value={status}
          onChange={(s) => updateParams({ status: s })}
          ariaLabel="Filter by status"
        />

        <ToggleBar
          label="SORT:"
          options={[
            { value: 'score_desc' as SortParam, label: 'HIGHEST' },
            { value: 'recent' as SortParam, label: 'NEWEST' },
            { value: 'alpha' as SortParam, label: 'A-Z' },
          ]}
          value={sort}
          onChange={(s) => updateParams({ sort: s })}
          ariaLabel="Sort shows"
        />
      </div>

      {/* Score Column Header */}
      <div className="flex justify-end items-center pr-4 sm:pr-5 mb-2">
        <span className="text-xs sm:text-sm font-semibold text-gray-400 tracking-wide">
          {scoreMode === 'audience' ? 'AudienceGrade' : "Critics\u2019 Score"}
        </span>
      </div>

      {/* Show List */}
      {nvpShows.length > 0 ? (
        <div className="space-y-3" role="list" aria-label="NVP portfolio shows">
          {nvpShows.map((show, index) => {
            const isRevival = show.isRevival === true;

            // Get the appropriate score based on mode
            let tier: ScoreTier | null = null;
            let audienceGradeData: ReturnType<typeof getAudienceGrade> | null = null;

            if (scoreMode === 'audience') {
              if (show.audienceHasEnoughReviews && show.audienceCombinedScore != null && show.status !== 'previews') {
                const grade = getAudienceGrade(show.audienceCombinedScore);
                audienceGradeData = grade;
                tier = { label: grade.grade, color: grade.color, tooltip: grade.tooltip, range: '', glow: false };
              }
            } else {
              tier = getScoreTier(show.criticScore?.score);
            }

            return (
              <Link
                key={show.id}
                href={`/show/${show.slug}`}
                role="listitem"
                className="group card-interactive flex gap-4 p-4 animate-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                style={{ animationDelay: `${index * 30}ms` }}
              >
                {/* Thumbnail */}
                <div className="flex-shrink-0 w-24 h-24 sm:w-28 sm:h-28 rounded-lg overflow-hidden bg-surface-overlay">
                  <ShowImage
                    sources={[
                      show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
                      show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'thumbnail') : null,
                      show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'thumbnail') : null,
                    ]}
                    alt={`${show.title} Broadway ${show.type}`}
                    priority={index < 4}
                    loading={index < 4 ? "eager" : "lazy"}
                    width={112}
                    height={112}
                    decoding="async"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 will-change-transform"
                    fallback={
                      <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 px-2" aria-hidden="true">
                        <div className="text-2xl mb-0.5">🎭</div>
                        {(show.status === 'previews' || show.status === 'upcoming') && (
                          <div className="text-[9px] text-gray-500 text-center font-medium leading-tight">Images<br/>soon</div>
                        )}
                      </div>
                    }
                  />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors truncate">
                    {show.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <FormatPill type={show.type} />
                    <ProductionPill isRevival={isRevival} />
                    <StatusBadge status={show.status} />
                  </div>
                  <p className="text-sm text-gray-400 mt-2.5 truncate">
                    {show.status === 'previews' || show.status === 'upcoming' ? (
                      <>Opens {formatOpeningDate(show.openingDate)}</>
                    ) : show.closingDate ? (
                      <>
                        <span className="text-amber-400">{show.status === 'closed' ? 'Closed' : 'Closes'} {formatOpeningDate(show.closingDate)}</span>
                        <span className="text-gray-500"> • Opened {formatOpeningDate(show.openingDate)}</span>
                      </>
                    ) : (
                      <>Opened {formatOpeningDate(show.openingDate)}</>
                    )}
                  </p>
                </div>

                {/* Score Badge */}
                <div className="flex-shrink-0 flex flex-col items-center gap-1.5 w-20 sm:w-24">
                  {scoreMode === 'audience' ? (
                    audienceGradeData ? (
                      <>
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                          style={{ color: audienceGradeData.color }}
                          title={audienceGradeData.tooltip}
                        >
                          {audienceGradeData.label}
                        </span>
                        <div
                          className={`score-badge w-16 h-16 sm:w-20 sm:h-20 text-2xl sm:text-3xl rounded-xl font-bold${audienceGradeData.grade === 'A+' ? ' audience-top-grade' : ''}`}
                          style={audienceGradeData.grade === 'A+' ? {} : {
                            backgroundColor: audienceGradeData.color,
                            color: audienceGradeData.textColor,
                            boxShadow: `0 2px 8px ${audienceGradeData.color}4d`,
                          }}
                          title={audienceGradeData.tooltip}
                        >
                          {audienceGradeData.grade}
                        </div>
                      </>
                    ) : show.status === 'previews' || show.status === 'upcoming' ? (
                      <div className="score-badge w-16 h-16 sm:w-20 sm:h-20 text-sm rounded-xl score-none font-bold text-gray-400">
                        TBD
                      </div>
                    ) : null
                  ) : (
                    <>
                      {tier && show.status !== 'previews' && show.status !== 'upcoming' && (show.criticScore?.reviewCount ?? 0) >= 5 && (
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                          style={{ color: tier.color }}
                          title={tier.tooltip}
                        >
                          {tier.label}
                        </span>
                      )}
                      <ScoreBadge
                        score={show.criticScore?.score}
                        size="lg"
                        showCrown
                        reviewCount={show.criticScore?.reviewCount}
                        status={show.status}
                      />
                    </>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card p-8 text-center">
          <div className="text-4xl mb-4">🎭</div>
          <h2 className="text-xl font-bold text-white mb-2">No Shows Found</h2>
          <p className="text-gray-400">No NVP shows match your current filters.</p>
        </div>
      )}

      <div className="mt-4 text-sm text-gray-400">
        <span>{nvpShows.length} shows</span>
      </div>

      {/* Off-Broadway */}
      {offBroadway.length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Off-Broadway</h3>
          <div className="space-y-3">
            {offBroadway.map((show) => (
              <div key={show.title} className="card p-4 flex items-center gap-4 opacity-70">
                <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-lg bg-surface-overlay flex-shrink-0 flex items-center justify-center">
                  <span className="text-3xl">🎭</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-bold text-white text-lg truncate">{show.title}</h2>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-indigo-500/20 text-indigo-400">
                      {show.note}
                    </span>
                  </div>
                  <p className="text-sm text-gray-400 mt-2.5 truncate">{show.venue} • {show.year}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer Note */}
      <div className="mt-8 p-4 rounded-xl bg-surface-overlay/50 border border-white/5">
        <p className="text-xs text-gray-500 text-center">
          This is an unofficial fan page. Visit <a href="https://www.nvpbroadway.com/" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white">nvpbroadway.com</a> for official NVP information.
        </p>
      </div>

      {/* Back to Home */}
      <div className="mt-6 text-center">
        <Link href="/" className="text-brand hover:text-brand-hover text-sm font-medium transition-colors">
          ← Back to all shows
        </Link>
      </div>
    </div>
  );
}

// Main export with Suspense boundary for useSearchParams
export default function NVPClient({ shows, offBroadway }: { shows: NVPShow[]; offBroadway: NVPOffBroadway[] }) {
  return (
    <Suspense fallback={
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-12 bg-surface-overlay rounded-xl w-2/3"></div>
          <div className="h-6 bg-surface-overlay rounded w-1/2"></div>
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-28 bg-surface-overlay rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    }>
      <NVPPageInner shows={shows} offBroadway={offBroadway} />
    </Suspense>
  );
}
