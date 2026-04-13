import { getScoreColorClass, getScoreTier, getScoreTextColorClass } from '@/components/show-cards';
import type { VideoReview } from '@/lib/data-video-reviews';

function TikTokIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="white" className="w-3 h-3">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.47a8.35 8.35 0 0 0 4.76 1.49V6.51a4.79 4.79 0 0 1-1-.18z" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="white" className="w-3 h-3">
      <path d="M23.5 6.19a3 3 0 0 0-2.11-2.12C19.55 3.5 12 3.5 12 3.5s-7.55 0-9.39.57A3 3 0 0 0 .5 6.19 31.16 31.16 0 0 0 0 12a31.16 31.16 0 0 0 .5 5.81 3 3 0 0 0 2.11 2.12c1.84.57 9.39.57 9.39.57s7.55 0 9.39-.57a3 3 0 0 0 2.11-2.12A31.16 31.16 0 0 0 24 12a31.16 31.16 0 0 0-.5-5.81zM9.6 15.6V8.4L15.84 12 9.6 15.6z" />
    </svg>
  );
}

/** Normalize dates: handles YYYYMMDD, YYYY-MM-DD, and NA/null */
function formatDate(dateStr: string | undefined | null): string | null {
  if (!dateStr || dateStr === 'NA') return null;
  try {
    // Normalize YYYYMMDD to YYYY-MM-DD
    const normalized = dateStr.length === 8 && /^\d{8}$/.test(dateStr)
      ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
      : dateStr;
    const d = new Date(normalized + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return null;
  }
}

export default function VideoReviewsShelf({ reviews }: { reviews: VideoReview[] }) {
  if (!reviews || reviews.length === 0) return null;

  const avgScore = Math.round(reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length);
  const tier = getScoreTier(avgScore);

  return (
    <section className="card p-5 sm:p-6 mb-6">
      {/* Header — title left, tier label + score badge right */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">Video Reviews</h2>
        <div className="flex items-center gap-2.5">
          <div className="text-right">
            {tier && (
              <div className={`text-sm font-bold ${getScoreTextColorClass(avgScore)}`}>{tier.label}</div>
            )}
            <div className="text-xs text-gray-500">{reviews.length} {reviews.length === 1 ? 'review' : 'reviews'}</div>
          </div>
          <div className={`score-badge w-14 h-14 text-2xl rounded-xl font-extrabold ${getScoreColorClass(avgScore)}`}>
            {avgScore}
          </div>
        </div>
      </div>

      {/* Methodology note */}
      <p className="text-gray-500 text-xs mb-3 -mt-2">Scores estimated from video transcript analysis</p>

      {/* Horizontal shelf with right fade when overflowing */}
      <div className="relative">
        {reviews.length > 3 && (
          <div className="absolute right-0 top-0 bottom-1 w-12 bg-gradient-to-l from-surface-raised to-transparent z-10 pointer-events-none rounded-r-lg" />
        )}
        <div
          className="flex gap-3 overflow-x-auto pb-1 -mx-5 px-5 sm:-mx-6 sm:px-6 scrollbar-hide"
          aria-label="Video reviews"
          role="list"
        >
        {reviews.map((review) => {
          const date = formatDate(review.publishedAt);
          return (
            <a
              key={review.videoUrl}
              href={review.videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 w-28 sm:w-32 group"
              role="listitem"
              aria-label={`${review.creatorName} scored ${review.score} out of 100`}
            >
              {/* Thumbnail */}
              <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay mb-1.5">
                {review.thumbnail ? (
                  <img
                    src={review.thumbnail}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="absolute inset-0 bg-surface-elevated" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent z-[1]" />

                {/* Play button */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center z-[2] opacity-70 group-hover:opacity-100 transition-opacity">
                  <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4 ml-0.5" aria-hidden="true">
                    <polygon points="6,3 20,12 6,21" />
                  </svg>
                </div>

                {/* Platform badge */}
                <div className={`absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center z-[3] ${review.platform === 'youtube' ? 'bg-red-600/80' : 'bg-black/60'}`}>
                  {review.platform === 'youtube' ? <YouTubeIcon /> : <TikTokIcon />}
                </div>

                {/* Score badge — bottom-right */}
                <div className="absolute bottom-1.5 right-1.5 z-[3]">
                  <div className={`score-badge w-11 h-11 text-lg rounded-lg font-bold ${getScoreColorClass(review.score)}`}>
                    {review.score}
                  </div>
                </div>
              </div>

              {/* Creator name + date */}
              <h3 className="font-semibold text-white text-sm group-hover:text-brand transition-colors line-clamp-1 leading-tight">
                {review.creatorName}
              </h3>
              {date && (
                <p className="text-gray-500 text-xs mt-0.5">{date}</p>
              )}
            </a>
          );
        })}
        </div>
      </div>
    </section>
  );
}
