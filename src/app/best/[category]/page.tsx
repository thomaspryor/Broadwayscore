import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBestOfList, getAllBestOfCategories } from '@/lib/data-core';
import type { BestOfCategory } from '@/lib/data-types';
import { serializeShowForClient } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, generateBrowseFAQSchema, BASE_URL, toAbsoluteUrl } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';
import BrowseListClient from '@/components/BrowseListClient';
import HowThisWorks from '@/components/HowThisWorks';
import type { BrowseShow } from '@/components/BrowseListClient';

export function generateStaticParams() {
  return getAllBestOfCategories().map((category) => ({ category }));
}

export function generateMetadata({ params }: { params: { category: string } }): Metadata {
  const list = getBestOfList(params.category as BestOfCategory);
  if (!list) return { title: 'List Not Found' };

  const canonicalUrl = `${BASE_URL}/best/${params.category}`;
  const topImage = list.shows[0]?.images?.hero || list.shows[0]?.images?.poster;
  const ogImageUrl = topImage ? toAbsoluteUrl(topImage) : `${BASE_URL}/og/home.png`;

  return {
    title: `${list.title} ${new Date().getFullYear()}`,
    description: list.description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: list.title,
      description: list.description,
      url: canonicalUrl,
      type: 'article',
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: list.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: list.title,
      description: list.description,
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: list.title }],
    },
  };
}

export default function BestOfPage({ params }: { params: { category: string } }) {
  const list = getBestOfList(params.category as BestOfCategory);

  if (!list) {
    notFound();
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Best Of', url: `${BASE_URL}/best` },
    { name: list.title, url: `${BASE_URL}/best/${params.category}` },
  ]);

  const itemListSchema = generateItemListSchema(
    list.shows.map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
      reviewCount: show.criticScore?.reviewCount,
      venue: show.venue,
      theaterAddress: show.theaterAddress,
      startDate: show.openingDate,
      endDate: show.closingDate,
      description: show.synopsis,
      status: show.status,
      ticketLinks: show.ticketLinks,
    })),
    list.title
  );

  const faqSchema = generateBrowseFAQSchema(
    list.title,
    list.shows.map(show => ({
      title: show.title,
      slug: show.slug,
      venue: show.venue,
      criticScore: show.criticScore ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount } : null,
      status: show.status,
      closingDate: show.closingDate,
      type: show.type,
    })),
  );

  const schemas = [breadcrumbSchema, itemListSchema, faqSchema].filter(Boolean);

  // Display flags
  const isMixedType = new Set(list.shows.map(s => s.type)).size > 1;
  const statuses = new Set(list.shows.map(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming' ? 'open' : 'closed'));
  const isMixedStatus = statuses.size > 1;

  // Serialize shows with audience data
  const serializedShows: BrowseShow[] = list.shows.map(show => serializeShowForClient(show));

  // Best-of: no sort/filter (curated), but audience toggle makes sense
  // Exception: critic-specific lists shouldn't have audience toggle
  const isCriticSpecific = params.category.includes('critic');

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Breadcrumb items={[
          { label: 'Home', href: '/' },
          { label: list.title },
        ]} />

        {/* Header */}
        <div className="mb-4">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">{list.title}</h1>
          <p className="text-gray-400 text-lg">{list.description}</p>
        </div>

        {/* Interactive Show List (curated: no sort/filter, just audience toggle) */}
        <BrowseListClient
          shows={serializedShows}
          showRanks={true}
          isMixedType={isMixedType}
          isMixedStatus={isMixedStatus}
          defaultSort="score"
          hasPerformanceData={false}
          availableSorts={['score']}
          showTypeFilter={false}
          showScoreToggle={!isCriticSpecific}
          subtitle={`Last updated: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`}
        />

        {/* How This Works */}
        <HowThisWorks className="mt-8">
          <p>
            Shows are ranked by CriticScore, a weighted average of reviews from dozens of outlets.
            Top-tier publications (NYT, Vulture, Variety) carry more weight than smaller outlets.
            Toggle to Audience mode to see letter grades based on audience sentiment from multiple sources.
          </p>
        </HowThisWorks>

        {/* Other Lists */}
        <div className="mt-12 pt-8 border-t border-white/10">
          <h3 className="text-lg font-bold text-white mb-4">Explore More Lists</h3>
          <div className="flex flex-wrap gap-2">
            {getAllBestOfCategories()
              .filter(cat => cat !== params.category)
              .map(cat => {
                const otherList = getBestOfList(cat);
                return otherList ? (
                  <Link
                    key={cat}
                    href={`/best/${cat}`}
                    className="px-4 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 flex items-center rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors"
                  >
                    {otherList.title.replace('Best ', '').replace('Top 10 ', '')}
                  </Link>
                ) : null;
              })}
          </div>
        </div>
      </div>
    </>
  );
}
