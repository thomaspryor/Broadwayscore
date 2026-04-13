import { getScoreColorClass } from '@/components/show-cards';
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

const THUMB_GRADIENTS = [
  'linear-gradient(145deg, #2d1b4e 0%, #1a1a2e 40%, #16213e 100%)',
  'linear-gradient(145deg, #1a2a1a 0%, #1a1a2e 40%, #2d1b3e 100%)',
  'linear-gradient(145deg, #2e1a1a 0%, #1a1a2e 40%, #1a2e2e 100%)',
  'linear-gradient(145deg, #1a1a3e 0%, #2e2a1a 40%, #1a2a2a 100%)',
  'linear-gradient(145deg, #1e2a1e 0%, #1a1a2e 40%, #2e1a2e 100%)',
  'linear-gradient(145deg, #2a1a2a 0%, #1a2a1a 40%, #1a1a3e 100%)',
];

export default function VideoReviewsShelf({ reviews, showTitle }: { reviews: VideoReview[]; showTitle: string }) {
  if (!reviews || reviews.length === 0) return null;

  const avgScore = Math.round(reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length);

  return (
    <section className="mt-8 pt-6 border-t border-white/5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-bold text-white">Video Reviews</h2>
            <div className={`score-badge w-9 h-9 text-sm rounded-lg font-bold ${getScoreColorClass(avgScore)}`}>
              {avgScore}
            </div>
          </div>
          <p className="text-gray-400 text-xs mt-0.5">
            {reviews.length} video {reviews.length === 1 ? 'review' : 'reviews'} &middot; scored from transcripts
          </p>
        </div>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {reviews.map((review, i) => {
          const gradient = THUMB_GRADIENTS[i % THUMB_GRADIENTS.length];
          return (
            <a
              key={review.handle + i}
              href={review.videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 w-28 sm:w-32 group"
            >
              {/* Thumbnail */}
              <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay mb-1.5">
                <div className="absolute inset-0 opacity-70" style={{ background: gradient }} />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-[1]" />

                {/* Play button */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-white/15 backdrop-blur-sm rounded-full flex items-center justify-center z-[2] opacity-60 group-hover:opacity-100 transition-opacity">
                  <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4 ml-0.5">
                    <polygon points="6,3 20,12 6,21" />
                  </svg>
                </div>

                {/* Platform badge */}
                <div className={`absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center z-[3] ${review.platform === 'youtube' ? 'bg-red-600/80' : 'bg-black/60'}`}>
                  {review.platform === 'youtube' ? <YouTubeIcon /> : <TikTokIcon />}
                </div>

                {/* Score badge — bottom-right, matching homepage shelf pattern */}
                <div className="absolute bottom-1.5 right-1.5 z-[3]">
                  <div className={`score-badge w-11 h-11 text-lg rounded-lg font-bold ${getScoreColorClass(review.score)}`}>
                    {review.score}
                  </div>
                </div>
              </div>

              {/* Info */}
              <h3 className="font-semibold text-white text-sm group-hover:text-brand transition-colors leading-tight truncate">
                {review.creatorName}
              </h3>
              {review.views && (
                <div className="flex items-center gap-1 mt-0.5">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3 text-gray-500">
                    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                  </svg>
                  <span className="text-gray-400 text-xs">{review.views}</span>
                </div>
              )}
            </a>
          );
        })}
      </div>
    </section>
  );
}
