import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, ComputedShow } from '@/lib/data';

export function generateStaticParams() {
  return getAllShowSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  const description = show.synopsis
    || (show.criticScore
      ? `${show.title} has a score of ${show.criticScore.score} based on ${show.criticScore.reviewCount} critic reviews.`
      : `Reviews and scores for ${show.title} on Broadway.`);

  return {
    title: `${show.title} - Broadway Metascore`,
    description,
    openGraph: {
      title: `${show.title} - Broadway Metascore`,
      description,
      images: show.images?.hero ? [{ url: show.images.hero }] : undefined,
    },
  };
}

function getScoreColor(score: number): string {
  if (score >= 70) return 'bg-green-500';
  if (score >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

function getScoreTextColor(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 50) return '#eab308';
  return '#ef4444';
}

function TierBadge({ tier }: { tier: number }) {
  const colors: Record<number, string> = {
    1: 'bg-green-500/20 text-green-400',
    2: 'bg-blue-500/20 text-blue-400',
    3: 'bg-gray-500/20 text-gray-400',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${colors[tier] || colors[3]}`}>
      T{tier}
    </span>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// JSON-LD structured data for SEO
function generateStructuredData(show: ComputedShow) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TheaterEvent',
    name: show.title,
    description: show.synopsis,
    image: show.images?.hero,
    location: {
      '@type': 'PerformingArtsTheater',
      name: show.venue,
      address: show.theaterAddress ? {
        '@type': 'PostalAddress',
        streetAddress: show.theaterAddress,
        addressLocality: 'New York',
        addressRegion: 'NY',
        addressCountry: 'US',
      } : undefined,
    },
    startDate: show.openingDate,
    ...(show.closingDate && { endDate: show.closingDate }),
    aggregateRating: show.criticScore ? {
      '@type': 'AggregateRating',
      ratingValue: show.criticScore.score,
      bestRating: 100,
      worstRating: 0,
      ratingCount: show.criticScore.reviewCount,
    } : undefined,
    offers: show.ticketLinks?.[0] ? {
      '@type': 'Offer',
      url: show.ticketLinks[0].url,
      priceCurrency: 'USD',
      ...(show.ticketLinks[0].priceFrom && { price: show.ticketLinks[0].priceFrom }),
    } : undefined,
  };
}

export default function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const structuredData = generateStructuredData(show);
  const score = show.criticScore?.score;
  const lowestPrice = show.ticketLinks?.reduce((min, link) =>
    link.priceFrom && (!min || link.priceFrom < min) ? link.priceFrom : min,
    null as number | null
  );

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="min-h-screen">
        {/* Hero Section */}
        {show.images?.hero && (
          <div className="relative h-64 sm:h-80 md:h-96 w-full">
            <Image
              src={show.images.hero}
              alt={show.title}
              fill
              className="object-cover"
              priority
            />
            <div className="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/60 to-transparent" />
          </div>
        )}

        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          {/* Back link */}
          <Link href="/" className="text-green-400 hover:text-green-300 text-sm mb-6 inline-block">
            ← All Shows
          </Link>

          {/* Title, Score, and Buy Tickets */}
          <div className="flex flex-col sm:flex-row sm:items-start gap-6 mb-6">
            {/* Score Badge */}
            {score !== undefined && score !== null && (
              <div className={`${getScoreColor(score)} w-24 h-24 sm:w-28 sm:h-28 rounded-lg flex flex-col items-center justify-center flex-shrink-0`}>
                <div className="text-4xl sm:text-5xl font-bold text-white">{score}</div>
              </div>
            )}

            {/* Show Info */}
            <div className="flex-1">
              <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">{show.title}</h1>

              {/* Tags */}
              {show.tags && show.tags.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {show.tags.map((tag, i) => (
                    <span key={i} className="text-xs px-2 py-1 bg-gray-700 text-gray-300 rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="text-gray-400 text-sm sm:text-base space-y-1">
                <div>{show.venue}</div>
                <div>
                  {show.runtime}
                  {show.intermissions !== undefined && ` • ${show.intermissions === 0 ? 'No intermission' : show.intermissions === 1 ? '1 intermission' : `${show.intermissions} intermissions`}`}
                </div>
                {show.ageRecommendation && (
                  <div className="text-gray-500">{show.ageRecommendation}</div>
                )}
                {show.criticScore && (
                  <div className="text-gray-500">
                    Based on {show.criticScore.reviewCount} critic reviews
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Buy Tickets Section */}
          {(show.ticketLinks && show.ticketLinks.length > 0) && (
            <div className="bg-gray-800 rounded-lg p-4 mb-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <div className="text-white font-semibold">Get Tickets</div>
                  {lowestPrice && (
                    <div className="text-gray-400 text-sm">From ${lowestPrice}</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {show.ticketLinks.map((link, i) => (
                    <a
                      key={i}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center px-4 py-2 bg-green-500 hover:bg-green-600 text-white font-medium rounded-lg transition"
                    >
                      {link.platform}
                      {link.priceFrom && <span className="ml-1 text-green-200 text-sm">from ${link.priceFrom}</span>}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Synopsis */}
          {show.synopsis && (
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white mb-2">About</h2>
              <p className="text-gray-300 leading-relaxed">{show.synopsis}</p>
            </div>
          )}

          {/* Cast & Creative */}
          {(show.cast || show.creativeTeam) && (
            <div className="grid sm:grid-cols-2 gap-6 mb-6">
              {/* Cast */}
              {show.cast && show.cast.length > 0 && (
                <div>
                  <h2 className="text-lg font-semibold text-white mb-3">Cast</h2>
                  <div className="space-y-2">
                    {show.cast.map((member, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-white">{member.name}</span>
                        <span className="text-gray-500">{member.role}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Creative Team */}
              {show.creativeTeam && show.creativeTeam.length > 0 && (
                <div>
                  <h2 className="text-lg font-semibold text-white mb-3">Creative Team</h2>
                  <div className="space-y-2">
                    {show.creativeTeam.map((member, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-white">{member.name}</span>
                        <span className="text-gray-500">{member.role}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Trailer */}
          {show.trailerUrl && (
            <div className="mb-6">
              <a
                href={show.trailerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-green-400 hover:text-green-300"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                </svg>
                Watch Trailer
              </a>
            </div>
          )}

          {/* Critic Reviews */}
          {show.criticScore && show.criticScore.reviews.length > 0 && (
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white mb-4 border-b border-gray-700 pb-2">
                Critic Reviews
              </h2>
              <div className="space-y-1">
                {show.criticScore.reviews.map((review, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-4 py-3 border-b border-gray-800 last:border-0 hover:bg-gray-800/50 -mx-2 px-2 rounded"
                  >
                    {/* Score */}
                    <div
                      className="w-12 h-12 rounded flex items-center justify-center font-bold text-lg flex-shrink-0"
                      style={{
                        backgroundColor: `${getScoreTextColor(review.reviewMetaScore)}20`,
                        color: getScoreTextColor(review.reviewMetaScore)
                      }}
                    >
                      {review.reviewMetaScore}
                    </div>

                    {/* Review Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <a
                          href={review.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-white hover:text-green-400 transition"
                        >
                          {review.outlet}
                        </a>
                        <TierBadge tier={review.tier} />
                        {review.designation && (
                          <span className="text-xs text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">
                            {review.designation.replace('_', ' ')}
                          </span>
                        )}
                      </div>
                      {review.criticName && (
                        <div className="text-sm text-gray-500">{review.criticName}</div>
                      )}
                      {review.pullQuote && (
                        <div className="text-sm text-gray-400 mt-1 line-clamp-2">
                          &ldquo;{review.pullQuote}&rdquo;
                        </div>
                      )}
                    </div>

                    {/* Original Rating */}
                    {review.originalRating && (
                      <div className="text-sm text-gray-500 flex-shrink-0">
                        {review.originalRating}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!show.criticScore && (
            <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400 mb-6">
              No critic reviews yet.
            </div>
          )}

          {/* Theater Info */}
          {show.theaterAddress && (
            <div className="bg-gray-800/50 rounded-lg p-4 mb-6">
              <h2 className="text-sm font-semibold text-white mb-1">Theater</h2>
              <div className="text-gray-400 text-sm">{show.venue}</div>
              <div className="text-gray-500 text-sm">{show.theaterAddress}</div>
            </div>
          )}

          {/* Links */}
          <div className="flex flex-wrap gap-4 text-sm">
            {show.officialUrl && (
              <a
                href={show.officialUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-400 hover:text-green-300"
              >
                Official Website →
              </a>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
