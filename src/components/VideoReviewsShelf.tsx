import Link from 'next/link';
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

function formatDate(dateStr: string | undefined | null): string | null {
  if (!dateStr || dateStr === 'NA') return null;
  try {
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

  const showAggregate = reviews.length >= 2;
  const avgScore = Math.round(reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length);
  const tier = showAggregate ? getScoreTier(avgScore) : null;
  const hasOverflow = reviews.length > 3;

  return (
    <section className="card p-4 sm:p-5 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-white">Video Reviews</h2>
        <div className="flex items-center gap-2.5">
          {showAggregate ? (
            <>
              <div className="text-right">
                {tier && (
                  <div className={`text-sm font-bold ${getScoreTextColorClass(avgScore)}`}>{tier.label}</div>
                )}
                <div className="text-xs text-gray-500">{reviews.length} reviews</div>
              </div>
              <div className={`score-badge w-14 h-14 text-2xl rounded-xl font-extrabold ${getScoreColorClass(avgScore)}`}>
                {avgScore}
              </div>
            </>
          ) : (
            <span className="text-gray-400 text-sm">{reviews.length} review</span>
          )}
        </div>
      </div>

      {/* Horizontal shelf */}
      <div className="relative">
        <div
          className="flex gap-3 overflow-x-auto pb-1 -mx-4 px-4 sm:-mx-5 sm:px-5 scrollbar-hide"
          aria-label="Video reviews"
          role="list"
        >
          {reviews.map((review) => {
            const date = formatDate(review.publishedAt);
            return (
              <div
                key={review.videoUrl}
                className="flex-shrink-0 w-28 sm:w-32"
                role="listitem"
              >
                {/* Thumbnail — links to the video */}
                <a
                  href={review.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block group"
                  aria-label={`Watch ${review.creatorName}'s video review (scored ${review.score} out of 100)`}
                >
                  <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay mb-1.5">
                    {review.thumbnail ? (
                      <img
                        src={review.thumbnail}
                        alt=""
                        className={`absolute inset-0 w-full h-full object-cover ${review.platform === 'youtube' ? 'object-top' : ''}`}
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
                </a>

                {/* Creator name — links to their profile page */}
                <Link
                  href={`/video-critics/${review.handle}`}
                  className="block font-semibold text-white text-sm hover:text-brand transition-colors line-clamp-1 leading-tight"
                >
                  {review.creatorName}
                </Link>
                {date && (
                  <p className="text-gray-500 text-xs mt-0.5">{date}</p>
                )}
              </div>
            );
          })}

          {/* Scroll hint — shows a dimmed "more" indicator when cards overflow */}
          {hasOverflow && (
            <div className="flex-shrink-0 w-8 flex items-center justify-center self-stretch opacity-40" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-gray-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
