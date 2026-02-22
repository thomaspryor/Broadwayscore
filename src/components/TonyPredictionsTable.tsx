import Link from 'next/link';
import { ScoreBadge, getScoreTier, StatusBadge } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';
import { RankBadge } from '@/components/gold-list/GoldListCards';
import type { SerializedTonyShow } from '@/lib/data-tony-predictions';

export type { SerializedTonyShow };

interface TonyPredictionsTableProps {
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
  /** Global index offset so only the first few images across all sections are eager-loaded */
  startIndex?: number;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getEffectiveStatus(show: SerializedTonyShow): string {
  if (show.status !== 'previews') return show.status;
  // If previews haven't started yet, show "announced" instead of "previews"
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

export default function TonyPredictionsTable({ title, description, shows, upcoming, startIndex = 0 }: TonyPredictionsTableProps) {
  // Sort scored shows by score desc, upcoming by opening date
  const scored = [...shows].sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1));
  const upcomingSorted = [...upcoming].sort((a, b) =>
    (a.openingDate || '').localeCompare(b.openingDate || '')
  );
  const allShows = [...scored, ...upcomingSorted];

  if (allShows.length === 0) return null;

  const hasNotOpened = (show: SerializedTonyShow) =>
    getEffectiveStatus(show) === 'announced';

  return (
    <section className="mb-10">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <p className="text-sm text-gray-400 mt-1">{description}</p>
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
                    alt={`${show.title} Broadway show`}
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
                <h3 className={`font-bold text-base sm:text-xl group-hover:text-brand transition-colors truncate ${notYetOpen ? 'text-gray-400' : 'text-white'}`}>
                  {show.title}
                </h3>
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
