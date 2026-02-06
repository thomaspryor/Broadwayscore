'use client';

import { useMemo, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { getAllShows } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade } from '@/lib/data-audience';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import { getScoreTier, ScoreBadge, StatusBadge, FormatPill, ProductionPill } from '@/components/show-cards';
import type { ScoreTier } from '@/components/show-cards';

// NVP show IDs - shows invested in by Nothing Ventured Productions
const NVP_SHOW_IDS = [
  'two-strangers-bway-2025',
  'chess-2025',
  'cats-the-jellicle-ball-2026',
  'proof-2026',
  'sunset-boulevard-2024',
  'an-enemy-of-the-people-2024',
  'smash-2025',
  'good-night-and-good-luck-2025',
  'parade-2023',
  'redwood-2025',
  'once-upon-a-mattress-2024',
  'romeo-juliet-2024',
  'waiting-for-godot-2025',
  'cabaret-2024',
  'water-for-elephants-2024',
  'suffs-2024',
];

// Off-Broadway NVP investments (not in shows.json)
const NVP_OFF_BROADWAY = [
  { title: 'Hold On to Me Darling', venue: 'Lucille Lortel Theatre', year: '2024', note: 'Off-Broadway' },
];

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

function NVPPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Parse URL params
  const statusParam = (searchParams.get('status') as StatusParam) || DEFAULT_STATUS;
  const sortParam = (searchParams.get('sort') as SortParam) || DEFAULT_SORT;
  const typeParam = (searchParams.get('type') as TypeParam) || DEFAULT_TYPE;
  const scoreModeParam = (searchParams.get('scoreMode') as ScoreModeParam) || DEFAULT_SCORE_MODE;

  // Validate params
  const status: StatusParam = ['playing', 'all', 'closed'].includes(statusParam) ? statusParam : DEFAULT_STATUS;
  const sort: SortParam = ['score_desc', 'recent', 'alpha'].includes(sortParam) ? sortParam : DEFAULT_SORT;
  const type: TypeParam = ['all', 'musical', 'play'].includes(typeParam) ? typeParam : DEFAULT_TYPE;
  const scoreMode: ScoreModeParam = ['critics', 'audience'].includes(scoreModeParam) ? scoreModeParam : DEFAULT_SCORE_MODE;

  // Update URL helper
  const updateParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        params.delete(key);
      } else {
        const isDefault =
          (key === 'status' && value === DEFAULT_STATUS) ||
          (key === 'sort' && value === DEFAULT_SORT) ||
          (key === 'type' && value === DEFAULT_TYPE) ||
          (key === 'scoreMode' && value === DEFAULT_SCORE_MODE);

        if (isDefault) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
    }

    const paramString = params.toString();
    router.push(paramString ? `${pathname}?${paramString}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  const allShows = useMemo(() => getAllShows(), []);

  // Filter to NVP shows
  const nvpShows = useMemo(() => {
    let result = allShows.filter(show => NVP_SHOW_IDS.includes(show.id));

    // Status filter
    if (status === 'playing') {
      result = result.filter(s => s.status === 'open' || s.status === 'previews');
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
            const aAudience = a.status === 'previews' ? -1 : (getAudienceBuzz(a.id)?.combinedScore ?? -1);
            const bAudience = b.status === 'previews' ? -1 : (getAudienceBuzz(b.id)?.combinedScore ?? -1);
            return bAudience - aAudience;
          }
          // Sort by score, then open > previews > closed for ties
          const aScore = a.status === 'previews' ? -1 : (a.criticScore?.score ?? -1);
          const bScore = b.status === 'previews' ? -1 : (b.criticScore?.score ?? -1);
          if (bScore !== aScore) return bScore - aScore;
          const statusOrder = { open: 0, previews: 1, closed: 2 };
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
  }, [allShows, status, type, sort, scoreMode]);

  // Counts for summary badges (from full NVP list, not filtered)
  const allNvpShows = useMemo(() => allShows.filter(show => NVP_SHOW_IDS.includes(show.id)), [allShows]);
  const openCount = allNvpShows.filter(s => s.status === 'open').length;
  const previewCount = allNvpShows.filter(s => s.status === 'previews').length;
  const closedCount = allNvpShows.filter(s => s.status === 'closed').length;
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
      <div className="flex items-center justify-between gap-4 mb-4">
        {/* Type Filter Pills (Left) */}
        <div className="flex items-center gap-2" role="group" aria-label="Filter by type">
          {(['all', 'musical', 'play'] as const).map((t) => (
            <button
              key={t}
              onClick={() => updateParams({ type: t })}
              aria-pressed={type === t}
              className={`px-4 py-2.5 sm:py-2 rounded-full text-sm font-semibold transition-all min-h-[44px] sm:min-h-0 ${
                type === t
                  ? 'bg-brand text-gray-900 shadow-glow-sm'
                  : 'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20'
              }`}
            >
              {t === 'all' ? 'All' : t === 'musical' ? 'Musicals' : 'Plays'}
            </button>
          ))}
        </div>

        {/* Score Mode Toggle (Right) */}
        <div className="flex items-center gap-0 bg-surface-overlay rounded-lg p-0.5 border border-white/10" role="group" aria-label="Score mode">
          {(['audience', 'critics'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === 'audience') {
                  updateParams({ scoreMode: mode, sort: 'score_desc' });
                } else {
                  updateParams({ scoreMode: mode });
                }
              }}
              aria-pressed={scoreMode === mode}
              className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-[11px] sm:text-xs font-bold uppercase tracking-wider transition-all min-h-[44px] sm:min-h-0 ${
                scoreMode === mode
                  ? 'bg-brand text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {mode === 'critics' ? 'Critics' : 'Audience'}
            </button>
          ))}
        </div>
      </div>

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-4 sm:mb-6 text-sm">
        <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap" role="group" aria-label="Filter by status">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">STATUS:</span>
          {(['playing', 'all', 'closed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => updateParams({ status: s })}
              aria-pressed={status === s}
              className={`px-2 py-1.5 sm:px-2 sm:py-1 rounded transition-colors text-[11px] font-medium uppercase tracking-wider min-h-[36px] sm:min-h-0 ${
                status === s ? 'text-brand bg-brand/10 sm:bg-transparent' : 'text-gray-300 hover:text-white'
              }`}
            >
              {s === 'playing' ? 'PLAYING' : s === 'all' ? 'ALL' : 'CLOSED'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap" role="group" aria-label="Sort shows">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">SORT:</span>
          {(['score_desc', 'recent', 'alpha'] as const).map((s) => (
            <button
              key={s}
              onClick={() => updateParams({ sort: s })}
              aria-pressed={sort === s}
              className={`px-2 py-1.5 sm:px-2 sm:py-1 rounded text-[11px] font-medium uppercase tracking-wider transition-colors min-h-[36px] sm:min-h-0 ${
                sort === s ? 'text-brand bg-brand/10 sm:bg-transparent' : 'text-gray-300 hover:text-white'
              }`}
            >
              {s === 'score_desc' ? 'HIGHEST' : s === 'recent' ? 'NEWEST' : 'A-Z'}
            </button>
          ))}
        </div>
      </div>

      {/* Score Column Header */}
      <div className="flex justify-end items-center pr-4 sm:pr-5 mb-2">
        <span className="text-xs sm:text-sm font-semibold text-gray-400 tracking-wide">
          {scoreMode === 'audience' ? 'Audience Grade' : "Critics\u2019 Score"}
        </span>
      </div>

      {/* Show List */}
      {nvpShows.length > 0 ? (
        <div className="space-y-3" role="list" aria-label="NVP portfolio shows">
          {nvpShows.map((show, index) => {
            const isRevival = show.isRevival === true;

            // Get the appropriate score based on mode
            let tier: ScoreTier | null = null;
            let audienceGrade: ReturnType<typeof getAudienceGrade> | null = null;

            if (scoreMode === 'audience') {
              const audienceBuzz = getAudienceBuzz(show.id);
              if (audienceBuzz && show.status !== 'previews') {
                const grade = getAudienceGrade(audienceBuzz.combinedScore);
                audienceGrade = grade;
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
                        {show.status === 'previews' && (
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
                    {show.status === 'previews' ? (
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
                    audienceGrade ? (
                      <>
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                          style={{ color: audienceGrade.color }}
                          title={audienceGrade.tooltip}
                        >
                          {audienceGrade.label}
                        </span>
                        <div
                          className={`score-badge w-16 h-16 sm:w-20 sm:h-20 text-2xl sm:text-3xl rounded-xl font-bold${audienceGrade.grade === 'A+' ? ' audience-top-grade' : ''}`}
                          style={audienceGrade.grade === 'A+' ? {} : {
                            backgroundColor: audienceGrade.color,
                            color: audienceGrade.textColor,
                            boxShadow: `0 2px 8px ${audienceGrade.color}4d`,
                          }}
                          title={audienceGrade.tooltip}
                        >
                          {audienceGrade.grade}
                        </div>
                      </>
                    ) : show.status === 'previews' ? (
                      <div className="score-badge w-16 h-16 sm:w-20 sm:h-20 text-sm rounded-xl score-none font-bold text-gray-400">
                        TBD
                      </div>
                    ) : null
                  ) : (
                    <>
                      {tier && show.status !== 'previews' && (show.criticScore?.reviewCount ?? 0) >= 5 && (
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
      {NVP_OFF_BROADWAY.length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Off-Broadway</h3>
          <div className="space-y-3">
            {NVP_OFF_BROADWAY.map((show) => (
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
export default function NVPPage() {
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
      <NVPPageInner />
    </Suspense>
  );
}
