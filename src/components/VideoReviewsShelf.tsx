import Link from 'next/link';
import { getScoreColorClass } from '@/components/show-cards';
import type { VideoReview } from '@/lib/data-video-reviews';
import ShowImage from '@/components/ShowImage';
import ScrollRow from '@/components/ScrollRow';

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

  const countLabel = `${reviews.length} ${reviews.length === 1 ? 'review' : 'reviews'}`;

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-4 sm:mb-6" aria-labelledby="video-reviews-heading">
      {/* Phone: one compact header row (eyebrow left, score right) above the
          shelf. sm+: the score sits in a left column beside the shelf, so the
          card is only as tall as the thumbnails instead of adding a 56px
          header row above them. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <header className="flex items-center justify-between gap-3 sm:flex-col sm:items-start sm:justify-start sm:gap-3 sm:w-44 sm:shrink-0">
          <h2 id="video-reviews-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
            Video Score
          </h2>
          {showAggregate ? (
            <div className="flex flex-row-reverse items-center gap-2.5 shrink-0 sm:flex-row">
              <div className={`score-badge w-12 h-12 text-xl sm:w-16 sm:h-16 sm:text-2xl rounded-xl font-extrabold ${getScoreColorClass(avgScore)}`}>
                {avgScore}
              </div>
              {/* Number only: no tier label (owner, 2026-11-09). */}
              <div className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase">{countLabel}</div>
            </div>
          ) : (
            <span className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase shrink-0">
              {countLabel}
            </span>
          )}
        </header>

        {/* Horizontal shelf */}
        <div className="relative min-w-0 sm:flex-1">
          <ScrollRow
            className="flex gap-3 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide"
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
                        <ShowImage
                          sources={[review.thumbnail]}
                          sizes="(min-width: 640px) 128px, 112px"
                          fallback={<div className="absolute inset-0 bg-surface-elevated" />}
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

                  {/* Creator name + date — one link to their profile page. The
                      date lives inside the link because globals.css gives every
                      <a> a 44px min-height on phones: a name-only link grew to
                      44px and pushed the date ~20px down, leaving a gap. */}
                  <Link
                    href={`/video-critics/${review.creatorId || review.handle}`}
                    className="group/creator block"
                  >
                    <span className="font-semibold text-white text-sm group-hover/creator:text-brand transition-colors line-clamp-1 leading-tight">
                      {review.creatorName}
                    </span>
                    {date && (
                      <span className="block text-fg-muted text-xs mt-0.5">{date}</span>
                    )}
                  </Link>
                </div>
              );
            })}

          </ScrollRow>
        </div>
      </div>
    </section>
  );
}
