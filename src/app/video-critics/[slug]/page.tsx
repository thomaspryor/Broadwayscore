import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getVideoCreatorBySlug, getAllVideoCreatorSlugs } from '@/lib/data-video-critics';
import { getScoreColorClass } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';

export const revalidate = 86400;

export function generateStaticParams() {
  if (!featureFlags.videoReviews) return [];
  return getAllVideoCreatorSlugs().map(slug => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const creator = getVideoCreatorBySlug(params.slug);
  if (!creator) return { title: 'Video Critic Not Found' };

  const description = `${creator.name} has reviewed ${creator.reviewCount} Broadway shows on ${creator.platform === 'youtube' ? 'YouTube' : 'TikTok'} with an average VideoScore of ${creator.avgScore}/100.`;

  return {
    title: `${creator.name} — Video Critic on ${creator.platform === 'youtube' ? 'YouTube' : 'TikTok'}`,
    description,
    alternates: { canonical: `${BASE_URL}/video-critics/${params.slug}` },
  };
}

function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
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

function PlatformBadge({ platform }: { platform: string }) {
  if (platform === 'youtube') {
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/20 text-red-400 text-xs font-medium">YouTube</span>;
  }
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 text-gray-300 text-xs font-medium">TikTok</span>;
}

export default function VideoCreatorPage({ params }: { params: { slug: string } }) {
  if (!featureFlags.videoReviews) notFound();

  const creator = getVideoCreatorBySlug(params.slug);
  if (!creator) notFound();

  const avgScoreClass = getScoreColorClass(creator.avgScore);

  return (
    <>
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Breadcrumb items={[
          { label: 'Home', href: '/' },
          { label: 'Video Critics', href: '/video-critics' },
          { label: creator.name },
        ]} />

        {/* Profile header */}
        <div className="card p-5 sm:p-6 mb-6">
          <div className="flex items-center gap-4">
            {/* Avatar placeholder */}
            <div className="w-16 h-16 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
              <span className="text-2xl font-bold text-gray-400">
                {creator.name.split(' ').map(w => w[0]).join('').substring(0, 2)}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-white">{creator.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <PlatformBadge platform={creator.platform} />
                {creator.subscribers && (
                  <span className="text-gray-400 text-sm">{creator.subscribers} followers</span>
                )}
              </div>
            </div>
            {/* Avg score */}
            <div className="text-right flex-shrink-0">
              <div className={`score-badge w-14 h-14 text-2xl rounded-xl font-extrabold ${avgScoreClass}`}>
                {creator.avgScore}
              </div>
              <div className="text-xs text-gray-500 mt-1">avg score</div>
            </div>
          </div>

          {/* Stats row */}
          <div className="flex gap-6 mt-4 pt-4 border-t border-white/5">
            <div>
              <div className="text-xl font-bold text-white">{creator.reviewCount}</div>
              <div className="text-xs text-gray-500">reviews</div>
            </div>
            <div>
              <div className="text-xl font-bold text-white">{creator.avgScore}</div>
              <div className="text-xs text-gray-500">avg score</div>
            </div>
            <div>
              <div className="text-xl font-bold text-white">
                {creator.reviews.filter(r => r.score >= 83).length}
              </div>
              <div className="text-xs text-gray-500">raves</div>
            </div>
            <div>
              <div className="text-xl font-bold text-white">
                {creator.reviews.filter(r => r.score < 55).length}
              </div>
              <div className="text-xs text-gray-500">pans</div>
            </div>
          </div>
        </div>

        {/* Reviews list */}
        <div className="card p-5 sm:p-6">
          <h2 className="text-lg font-bold text-white mb-4">Reviews</h2>
          <div className="space-y-3">
            {creator.reviews.map((review) => {
              const date = formatDate(review.publishedAt);
              return (
                <article key={review.showId} className="flex gap-3 items-start">
                  {/* Show thumbnail */}
                  <Link href={`/show/${review.showSlug}`} className="w-12 h-16 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                    {review.showThumbnail ? (
                      <img
                        src={getOptimizedImageUrl(review.showThumbnail, 'thumbnail')}
                        alt={review.showTitle}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-lg">🎭</div>
                    )}
                  </Link>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Link href={`/show/${review.showSlug}`} className="font-bold text-white hover:text-brand transition-colors truncate text-sm">
                        {review.showTitle}
                      </Link>
                      <a
                        href={review.videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
                        title="Watch video"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                    {date && <p className="text-gray-500 text-xs">{date}</p>}
                    {review.keyQuote && (
                      <p className="text-gray-400 text-xs mt-1 line-clamp-2 italic">&ldquo;{review.keyQuote.substring(0, 150)}&rdquo;</p>
                    )}
                  </div>

                  {/* Score */}
                  <div className={`score-badge w-10 h-10 text-sm rounded-lg font-bold flex-shrink-0 ${getScoreColorClass(review.score)}`}>
                    {review.score}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
