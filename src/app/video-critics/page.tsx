import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAllVideoCreators } from '@/lib/data-video-critics';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import VideoCriticIndexClient from './VideoCriticIndexClient';

export const revalidate = 86400;

export function generateMetadata(): Metadata {
  const creators = getAllVideoCreators();
  const total = creators.reduce((sum, c) => sum + c.reviewCount, 0);
  const title = `${creators.length} Video Theater Critics — TikTok & YouTube Reviewers`;
  const description = `Browse ${creators.length} theater reviewers on TikTok and YouTube, with ${total.toLocaleString()} scored reviews. See average scores and full review histories.`;
  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/video-critics` },
  };
}

export default function VideoCriticsIndexPage() {
  if (!featureFlags.videoReviews) notFound();

  const creators = getAllVideoCreators();
  const totalReviews = creators.reduce((sum, c) => sum + c.reviewCount, 0);

  const summaries = creators.map(({ reviews, ...rest }) => rest);

  return <VideoCriticIndexClient critics={summaries} totalReviews={totalReviews} />;
}
