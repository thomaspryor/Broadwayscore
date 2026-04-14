import Link from 'next/link';
import { Metadata } from 'next';
import { getAllVideoCreators } from '@/lib/data-video-critics';
import { getScoreColorClass } from '@/components/show-cards';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import { notFound } from 'next/navigation';
import Breadcrumb from '@/components/Breadcrumb';

export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'Video Critics — TikTok & YouTube Theater Reviewers',
  description: 'Meet the video critics who review Broadway shows on TikTok and YouTube. See their reviews, scores, and review histories.',
  alternates: { canonical: `${BASE_URL}/video-critics` },
};

function PlatformBadge({ platform }: { platform: string }) {
  if (platform === 'youtube') {
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-600/20 text-red-400 text-[10px] font-medium">YouTube</span>;
  }
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/10 text-gray-300 text-[10px] font-medium">TikTok</span>;
}

export default function VideoCriticsIndexPage() {
  if (!featureFlags.videoReviews) notFound();

  const creators = getAllVideoCreators();

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Video Critics' },
      ]} />

      <h1 className="text-3xl font-bold text-white mb-2">Video Critics</h1>
      <p className="text-gray-400 mb-6">
        Theater reviewers on TikTok and YouTube, scored from their video transcripts.
      </p>

      <div className="space-y-3">
        {creators.map(creator => (
          <Link
            key={creator.slug}
            href={`/video-critics/${creator.slug}`}
            className="card p-4 flex items-center gap-4 hover:bg-surface-overlay transition-colors"
          >
            {/* Avatar */}
            <div className="w-12 h-12 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
              <span className="text-lg font-bold text-gray-400">
                {creator.name.split(' ').map(w => w[0]).join('').substring(0, 2)}
              </span>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-sm">{creator.name}</span>
                <PlatformBadge platform={creator.platform} />
              </div>
              <p className="text-gray-500 text-xs mt-0.5">
                {creator.reviewCount} reviews
                {creator.subscribers && ` · ${creator.subscribers} followers`}
              </p>
            </div>

            {/* Avg score */}
            <div className={`score-badge w-10 h-10 text-sm rounded-lg font-bold flex-shrink-0 ${getScoreColorClass(creator.avgScore)}`}>
              {creator.avgScore}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
