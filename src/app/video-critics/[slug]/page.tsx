import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getVideoCreatorBySlug, getAllVideoCreatorSlugs } from '@/lib/data-video-critics';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import VideoCreatorDetailClient from './VideoCreatorDetailClient';

export const revalidate = 86400;

export function generateStaticParams() {
  if (!featureFlags.videoReviews) return [];
  return getAllVideoCreatorSlugs().map(slug => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const creator = getVideoCreatorBySlug(params.slug);
  if (!creator) return { title: 'Video Critic Not Found' };

  const platformLabel = creator.platform === 'youtube' ? 'YouTube' : 'TikTok';
  const description = `${creator.name} has reviewed ${creator.reviewCount} Broadway shows on ${platformLabel} with an average VideoScore of ${creator.avgScore}/100.`;

  return {
    title: `${creator.name} — Video Critic on ${platformLabel}`,
    description,
    alternates: { canonical: `${BASE_URL}/video-critics/${params.slug}` },
  };
}

export default function VideoCreatorPage({ params }: { params: { slug: string } }) {
  if (!featureFlags.videoReviews) notFound();

  const creator = getVideoCreatorBySlug(params.slug);
  if (!creator) notFound();

  return <VideoCreatorDetailClient creator={creator} />;
}
