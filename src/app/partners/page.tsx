import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import PartnersPageClient from './PartnersPageClient';
import { getAllShows } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-types';

export const metadata: Metadata = {
  title: 'Partner Embeds — Broadway Scorecard',
  description: 'Embed CriticScore badges on your site. Copy-paste snippets for iframes and SVG images. Free to use with attribution.',
  alternates: { canonical: `${BASE_URL}/partners` },
  openGraph: {
    title: 'Partner Embeds — Broadway Scorecard',
    description: 'Embed CriticScore badges on your site. Free to use with attribution.',
    url: `${BASE_URL}/partners`,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
  robots: { index: true, follow: true },
};

export interface PartnerShowOption {
  id: string;
  title: string;
  slug: string;
  status: string;
  category?: string;
  score: number | null;
  reviewCount: number;
  hasEnoughReviews: boolean;
}

export default function PartnersPage() {
  // Only show currently embeddable shows (open/previews + recently closed).
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
  const shows = (getAllShows() as ComputedShow[])
    .filter(s =>
      s.status === 'open' || s.status === 'previews' ||
      (s.closingDate != null && new Date(s.closingDate) > sixMonthsAgo)
    )
    .map<PartnerShowOption>(s => ({
      id: s.id,
      title: s.title,
      slug: s.slug,
      status: s.status,
      category: s.category,
      score: s.criticScore?.score != null ? Math.round(s.criticScore.score) : null,
      reviewCount: s.criticScore?.reviewCount ?? 0,
      hasEnoughReviews: (s.criticScore?.reviewCount ?? 0) >= 5,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  return <PartnersPageClient shows={shows} baseUrl={BASE_URL} />;
}
