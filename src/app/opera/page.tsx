import { Metadata } from 'next';
import Link from 'next/link';
import { getOperaShows, getOperaTitleSlug } from '@/lib/data-core';
import { serializeShowForClient } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import OperaPageClient from '@/components/OperaPageClient';

const currentYear = new Date().getFullYear();
const operaOgImageUrl = `${BASE_URL}/og/opera.png`;

export const metadata: Metadata = {
  title: `Met Opera Reviews & Ratings (${currentYear}) — OperaScorecard`,
  description:
    'CriticScore ratings for Metropolitan Opera productions. Aggregated from The New York Times, Operawire, Parterre Box, New York Classical Review, Bachtrack, and more — all opera critic voices count equally.',
  alternates: {
    canonical: `${BASE_URL}/opera`,
  },
  openGraph: {
    title: 'OperaScorecard — Met Opera Reviews & Ratings',
    description:
      'Aggregated CriticScore ratings for Metropolitan Opera productions from Operawire, NYT, Parterre Box, NYCR, and more.',
    url: `${BASE_URL}/opera`,
    type: 'article',
    images: [{ url: operaOgImageUrl, width: 1200, height: 630, alt: 'OperaScorecard — Met Opera Reviews & Ratings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OperaScorecard',
    description: 'Aggregated CriticScore ratings for Metropolitan Opera productions from Operawire, NYT, Parterre Box, NYCR, and more.',
    images: [{ url: operaOgImageUrl, width: 1200, height: 630, alt: 'OperaScorecard — Met Opera Reviews & Ratings' }],
  },
};

export default function OperaPage() {
  const allOpera = getOperaShows();
  // Surface currently-open and previews shows first; closed shows fall to the bottom
  const ordered = [...allOpera].sort((a, b) => {
    const aOpen = a.status === 'open' || a.status === 'previews' ? 0 : 1;
    const bOpen = b.status === 'open' || b.status === 'previews' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const aDate = a.openingDate || '';
    const bDate = b.openingDate || '';
    return bDate.localeCompare(aDate); // most recent first
  });

  const serializedShows = ordered.map(show => serializeShowForClient(show, { category: 'off-broadway' }));

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Opera', url: `${BASE_URL}/opera` },
  ]);

  const itemListSchema = generateItemListSchema(
    ordered
      .filter(s => s.status !== 'upcoming')
      .map(show => ({
        name: show.title,
        url: `${BASE_URL}/opera/${getOperaTitleSlug(show.slug)}`,
        image: show.images?.hero,
        score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
        reviewCount: show.criticScore?.reviewCount,
        venue: show.venue,
        startDate: show.openingDate,
        endDate: show.closingDate,
        status: show.status,
        category: 'opera',
      })),
    'Opera Productions',
  );

  const totalReviews = ordered.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  const operaOrgSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Opera Scorecard',
    url: 'https://operascorecard.com',
    logo: `${BASE_URL}/og/opera.png`,
    description: 'Aggregated critic ratings for Metropolitan Opera productions',
    inLanguage: 'en',
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema, operaOrgSchema]) }}
      />

      <OperaPageClient
        shows={serializedShows}
        totalShows={ordered.length}
        totalReviews={totalReviews}
      />

      {/* Tiny footer note explaining the flat-tier methodology */}
      <div className="mt-12 mb-8 mx-auto max-w-2xl text-center text-xs text-gray-500 px-4">
        <p>
          Opera reviews count equally — Operawire, Parterre Box, New York Classical Review, Bachtrack,
          Classical Voice America, and Seen-and-Heard International carry the same weight as The New York
          Times for opera scoring. (
          <Link href="/methodology" className="underline hover:text-gray-300">methodology</Link>)
        </p>
      </div>
    </>
  );
}
