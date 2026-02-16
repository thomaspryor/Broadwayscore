'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge, getScoreTier, StatusBadge } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';
import { RankBadge } from '@/components/gold-list/GoldListCards';

export interface SerializedTonyShow {
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  status: string;
  compositeScore: number | null;
  reviewCount: number;
  thumbnailPath: string | null;
}

interface TonyPredictionsTableProps {
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function TierLabel({ score, reviewCount, status }: { score: number | null; reviewCount: number; status: string }) {
  if (status === 'previews' || reviewCount < 5) return null;
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

export default function TonyPredictionsTable({ title, description, shows, upcoming }: TonyPredictionsTableProps) {
  // Combine scored (sorted by score desc) and upcoming (sorted by opening date)
  const allShows = useMemo(() => {
    const scored = [...shows].sort((a, b) => {
      const aScore = a.compositeScore ?? -1;
      const bScore = b.compositeScore ?? -1;
      return bScore - aScore;
    });

    const upcomingSorted = [...upcoming].sort((a, b) =>
      (a.openingDate || '').localeCompare(b.openingDate || '')
    );

    return [...scored, ...upcomingSorted];
  }, [shows, upcoming]);

  if (allShows.length === 0) return null;

  const isUpcoming = (show: SerializedTonyShow) =>
    show.status === 'previews' || show.reviewCount < 5;

  return (
    <section className="mb-10">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <p className="text-sm text-gray-400 mt-1">{description}</p>
      </div>

      <div className="space-y-3 sm:space-y-4">
        {allShows.map((show, i) => {
          const upcoming = isUpcoming(show);
          const rank = !upcoming ? i + 1 : null;
          return (
            <Link
              key={show.slug}
              href={`/show/${show.slug}`}
              className={`card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group ${upcoming ? 'opacity-60' : ''}`}
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
                    alt={`${show.title} Broadway show`}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    width={96}
                    height={96}
                    loading={i < 4 ? 'eager' : 'lazy'}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-2xl">🎭</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <h3 className={`font-bold text-base sm:text-xl group-hover:text-brand transition-colors truncate ${upcoming ? 'text-gray-400' : 'text-white'}`}>
                  {show.title}
                </h3>
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  <StatusBadge status={show.status} />
                </div>
                <p className="text-xs text-gray-400 mt-1.5 truncate">
                  {upcoming
                    ? `Opens ${formatDate(show.openingDate)} · ${show.venue}`
                    : show.venue}
                </p>
              </div>

              {/* Score */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <TierLabel score={show.compositeScore} reviewCount={show.reviewCount} status={show.status} />
                <ScoreBadge score={show.compositeScore} size="lg" reviewCount={show.reviewCount} status={show.status} />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
