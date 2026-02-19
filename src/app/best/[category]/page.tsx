import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBestOfList, getAllBestOfCategories } from '@/lib/data-core';
import type { BestOfCategory } from '@/lib/data-types';
import { generateBreadcrumbSchema, generateItemListSchema, generateBrowseFAQSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import Breadcrumb from '@/components/Breadcrumb';
import { ScoreBadge, getScoreTier, FormatPill, ProductionPill } from '@/components/show-cards';

export function generateStaticParams() {
  return getAllBestOfCategories().map((category) => ({ category }));
}

export function generateMetadata({ params }: { params: { category: string } }): Metadata {
  const list = getBestOfList(params.category as BestOfCategory);
  if (!list) return { title: 'List Not Found' };

  const canonicalUrl = `${BASE_URL}/best/${params.category}`;

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
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: list.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: list.title,
      description: list.description,
    },
  };
}

function getBroadwayDuration(openingDate: string | null): string | null {
  if (!openingDate) return null;
  const open = new Date(openingDate);
  const now = new Date();
  const months = (now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth());
  if (months < 1) return 'Just opened';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} on Broadway`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (remainingMonths === 0) return `${years} year${years === 1 ? '' : 's'} on Broadway`;
  return `${years}+ year${years === 1 ? '' : 's'} on Broadway`;
}

function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
      isTop3 ? 'bg-accent-gold text-gray-900' : 'bg-surface-overlay text-gray-400 border border-white/10'
    }`}>
      {rank}
    </div>
  );
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

  // Only show format pills when the list has mixed types (e.g. "Best New Shows" has musicals + plays)
  const isMixedType = new Set(list.shows.map(s => s.type)).size > 1;
  // Only show status when the list has mixed statuses (e.g. don't show "Now Playing" on every card if they're all open)
  const statuses = new Set(list.shows.map(s => s.status === 'open' || s.status === 'previews' ? 'open' : 'closed'));
  const isMixedStatus = statuses.size > 1;

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
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">{list.title}</h1>
          <p className="text-gray-400 text-lg">{list.description}</p>
          <p className="text-gray-500 text-sm mt-2">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {/* Show List */}
        {list.shows.length > 0 ? (
          <div className="space-y-3">
            {list.shows.map((show, index) => {
              const tier = getScoreTier(show.criticScore?.score);
              const isOpen = show.status === 'open' || show.status === 'previews';
              const duration = isOpen ? getBroadwayDuration(show.openingDate) : null;
              return (
              <div key={show.id} className="flex items-center gap-3">
                {/* Rank outside the card */}
                <RankBadge rank={index + 1} />

                <Link
                  href={`/show/${show.slug}`}
                  className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group flex-1 min-w-0"
                >
                  {/* Thumbnail */}
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                    {show.images?.thumbnail ? (
                      <img
                        src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
                        alt={`${show.title} Broadway ${show.type}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="text-2xl">🎭</span>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h2 className="font-bold text-lg text-white group-hover:text-brand transition-colors truncate">
                        {show.title}
                      </h2>
                      {isMixedType && <FormatPill type={show.type} />}
                      {show.isRevival && <ProductionPill isRevival={true} />}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-gray-500">
                      {duration && <span>{duration}</span>}
                      {isOpen && show.closingDate && (
                        <span className="text-amber-400">
                          {duration && '·'} Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                      {isMixedStatus && !isOpen && (
                        <span className="text-orange-400">
                          Closed{show.closingDate ? ` ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Score — tier label above badge, fixed width for alignment */}
                  <div className="flex-shrink-0 flex flex-col items-center gap-1.5 w-20 sm:w-24">
                    {tier ? (
                      <span
                        className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                        style={{ color: tier.color }}
                      >
                        {tier.label}
                      </span>
                    ) : null}
                    <ScoreBadge score={show.criticScore?.score} size="md" />
                  </div>
                </Link>
              </div>
              );
            })}
          </div>
        ) : (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No shows found in this category.</p>
          </div>
        )}

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
