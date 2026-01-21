import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, ComputedShow } from '@/lib/data';

export function generateStaticParams() {
  return getAllShowSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  const score = show.criticScore?.score;
  const scoreText = score ? ` (Score: ${score}/100)` : '';
  const reviewText = show.criticScore?.reviewCount ? ` Based on ${show.criticScore.reviewCount} critic reviews.` : '';

  const description = show.synopsis
    ? `${show.synopsis.slice(0, 150)}...${scoreText}`
    : `${show.title} at ${show.venue}.${scoreText}${reviewText}`;

  const title = score
    ? `${show.title} - Score: ${score} | Broadway Reviews`
    : `${show.title} - Broadway Reviews & Tickets`;

  return {
    title,
    description,
    keywords: [show.title, show.venue, 'Broadway', 'tickets', 'reviews', ...(show.tags || [])],
    openGraph: {
      type: 'website',
      title: `${show.title}${scoreText} - BroadwayScore`,
      description,
      images: show.images?.hero ? [{
        url: show.images.hero,
        width: 1920,
        height: 1080,
        alt: show.title,
      }] : undefined,
      siteName: 'BroadwayScore',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${show.title}${scoreText}`,
      description: description.slice(0, 200),
      images: show.images?.hero ? [show.images.hero] : undefined,
    },
    alternates: {
      canonical: `${BASE_URL}/show/${show.slug}`,
    },
  };
}

function ScoreBadge({ score, size = 'lg' }: { score?: number | null; size?: 'md' | 'lg' | 'xl' }) {
  const sizeClasses = {
    md: 'w-14 h-14 text-xl rounded-xl',
    lg: 'w-20 h-20 text-3xl rounded-2xl',
    xl: 'w-24 h-24 text-4xl rounded-2xl',
  };

  const colorClass = score === undefined || score === null
    ? 'bg-surface-overlay text-gray-500 border border-white/10'
    : score >= 70
    ? 'bg-score-high text-white shadow-[0_4px_16px_rgba(16,185,129,0.4)]'
    : score >= 50
    ? 'bg-score-medium text-gray-900 shadow-[0_4px_16px_rgba(245,158,11,0.4)]'
    : 'bg-score-low text-white shadow-[0_4px_16px_rgba(239,68,68,0.4)]';

  return (
    <div className={`${sizeClasses[size]} ${colorClass} flex items-center justify-center font-bold`}>
      {score ?? '—'}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    open: { label: 'Now Playing', className: 'bg-status-open-bg text-status-open border-status-open/20' },
    closed: { label: 'Closed', className: 'bg-status-closed-bg text-status-closed border-status-closed/20' },
    previews: { label: 'In Previews', className: 'bg-status-previews-bg text-status-previews border-status-previews/20' },
  };

  const { label, className } = config[status] || { label: status, className: 'bg-status-closed-bg text-status-closed border-status-closed/20' };

  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-pill text-xs font-semibold uppercase tracking-wide border ${className}`}>
      {label}
    </span>
  );
}

function TierBadge({ tier }: { tier: number }) {
  const colors: Record<number, string> = {
    1: 'bg-accent-gold/20 text-accent-gold',
    2: 'bg-gray-500/20 text-gray-400',
    3: 'bg-surface-overlay text-gray-500',
  };

  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${colors[tier] || colors[3]}`}>
      Tier {tier}
    </span>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getScoreColor(score: number): string {
  if (score >= 70) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

function BackArrow() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscore.com';

// JSON-LD structured data for SEO - generates rich results in Google
function generateStructuredData(show: ComputedShow) {
  // Main event schema
  const eventData: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TheaterEvent',
    name: show.title,
    description: show.synopsis,
    url: `${BASE_URL}/show/${show.slug}`,
    location: {
      '@type': 'PerformingArtsTheater',
      name: show.venue,
      address: {
        '@type': 'PostalAddress',
        streetAddress: show.theaterAddress?.split(',')[0] || show.venue,
        addressLocality: 'New York',
        addressRegion: 'NY',
        addressCountry: 'US',
      },
    },
    startDate: show.openingDate,
    eventStatus: show.status === 'open' ? 'https://schema.org/EventScheduled' : 'https://schema.org/EventCancelled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  };

  if (show.closingDate) {
    eventData.endDate = show.closingDate;
  }

  if (show.images?.hero) {
    eventData.image = [show.images.hero, show.images.poster, show.images.thumbnail].filter(Boolean);
  }

  // Add aggregate rating if we have reviews
  if (show.criticScore?.score) {
    eventData.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: show.criticScore.score,
      bestRating: 100,
      worstRating: 0,
      reviewCount: show.criticScore.reviewCount,
      ratingCount: show.criticScore.reviewCount,
    };
  }

  // Add ticket offers for rich results
  if (show.ticketLinks && show.ticketLinks.length > 0) {
    eventData.offers = show.ticketLinks.map((link) => ({
      '@type': 'Offer',
      url: link.url,
      price: link.priceFrom || 0,
      priceCurrency: 'USD',
      availability: show.status === 'open' ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut',
      validFrom: show.openingDate,
      seller: {
        '@type': 'Organization',
        name: link.platform,
      },
    }));
  }

  // Add performers (cast)
  if (show.cast && show.cast.length > 0) {
    eventData.performer = show.cast.map((member) => ({
      '@type': 'Person',
      name: member.name,
    }));
  }

  // Add organizer (creative team / production)
  if (show.creativeTeam && show.creativeTeam.length > 0) {
    const director = show.creativeTeam.find((m) => m.role.toLowerCase().includes('director'));
    if (director) {
      eventData.director = {
        '@type': 'Person',
        name: director.name,
      };
    }
  }

  return eventData;
}

export default function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const structuredData = generateStructuredData(show);
  const score = show.criticScore?.score;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <BackArrow />
          All Shows
        </Link>

        {/* Main Header - Poster Layout */}
        <div className="flex flex-col md:flex-row gap-6 md:gap-8 mb-8">
          {/* Poster Image */}
          <div className="flex-shrink-0 relative">
            {show.images?.poster ? (
              <div className="relative">
                <img
                  src={show.images.poster}
                  alt={show.title}
                  className="w-48 md:w-56 rounded-lg shadow-2xl object-cover aspect-[2/3]"
                />
                {/* Score Badge Overlay */}
                <div className="absolute -bottom-3 -right-3">
                  <ScoreBadge score={score} size="lg" />
                </div>
              </div>
            ) : (
              <div className="w-48 md:w-56 aspect-[2/3] bg-surface-card rounded-lg flex items-center justify-center">
                <span className="text-4xl">🎭</span>
              </div>
            )}
            {show.criticScore && (
              <p className="text-center text-xs text-gray-500 mt-4">
                {show.criticScore.reviewCount} reviews
              </p>
            )}
          </div>

          {/* Show Info */}
          <div className="flex-1">
            {/* Tags */}
            <div className="flex flex-wrap gap-2 mb-3">
              {show.type && (
                <span className="px-3 py-1 bg-surface-overlay text-gray-300 text-xs font-medium rounded-full uppercase">
                  {show.type}
                </span>
              )}
              <StatusChip status={show.status} />
            </div>

            {/* Title */}
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight mb-3">
              {show.title}
            </h1>

            {/* Meta */}
            <div className="flex flex-wrap items-center gap-2 text-gray-400 text-sm mb-4">
              <span className="text-gray-300">{show.venue}</span>
              <span className="text-gray-600">•</span>
              <span>{show.runtime}</span>
            </div>

            {/* Score Label */}
            {score !== undefined && score !== null && (
              <div className="flex items-center gap-2 mb-4">
                <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                  score >= 70 ? 'bg-score-high/20 text-score-high' :
                  score >= 50 ? 'bg-score-medium/20 text-score-medium' :
                  'bg-score-low/20 text-score-low'
                }`}>
                  {score >= 70 ? 'GREAT' : score >= 50 ? 'MIXED' : 'POOR'}
                </span>
                <span className="text-gray-400 text-sm">Based on {show.criticScore?.reviewCount} reviews</span>
              </div>
            )}

            {/* Ticket Links */}
            {show.ticketLinks && show.ticketLinks.length > 0 && (
              <div className="flex flex-wrap gap-3 mb-4">
                {show.ticketLinks.map((link, i) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary flex items-center gap-2"
                  >
                    {link.platform}
                    {link.priceFrom && <span className="opacity-80">from ${link.priceFrom}</span>}
                    <ExternalLinkIcon />
                  </a>
                ))}
                {show.officialUrl && (
                  <a
                    href={show.officialUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary flex items-center gap-2"
                  >
                    <span>🌐</span> Official Site
                  </a>
                )}
                {show.trailerUrl && (
                  <a
                    href={show.trailerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary flex items-center gap-2"
                  >
                    <span>▶</span> Trailer
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Synopsis */}
        {show.synopsis && (
          <div className="mb-8">
            <p className="text-gray-300 leading-relaxed">{show.synopsis}</p>
          </div>
        )}

        {/* Cast & Creative */}
        {(show.cast || show.creativeTeam) && (
          <div className="grid sm:grid-cols-2 gap-6 mb-8">
            {show.cast && show.cast.length > 0 && (
              <div className="card p-5">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Cast</h2>
                <ul className="space-y-2">
                  {show.cast.map((member, i) => (
                    <li key={i} className="flex justify-between text-sm">
                      <span className="text-white font-medium">{member.name}</span>
                      <span className="text-gray-500">{member.role}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {show.creativeTeam && show.creativeTeam.length > 0 && (
              <div className="card p-5">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Creative Team</h2>
                <ul className="space-y-2">
                  {show.creativeTeam.map((member, i) => (
                    <li key={i} className="flex justify-between text-sm">
                      <span className="text-white font-medium">{member.name}</span>
                      <span className="text-gray-500">{member.role}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Critic Reviews */}
        {show.criticScore && show.criticScore.reviews.length > 0 && (
          <div className="card p-5 sm:p-6 mb-8">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-white">Critic Reviews</h2>
              <span className="text-sm text-gray-500">{show.criticScore.reviewCount} reviews</span>
            </div>

            <div className="space-y-4">
              {show.criticScore.reviews.map((review, i) => (
                <div key={i} className="border-b border-white/5 pb-4 last:border-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <a
                        href={review.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-white hover:text-brand transition-colors"
                      >
                        {review.outlet}
                      </a>
                      {review.criticName && (
                        <span className="text-gray-500 text-sm ml-2">by {review.criticName}</span>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <TierBadge tier={review.tier} />
                        <span className="text-xs text-gray-500">{formatDate(review.publishDate)}</span>
                        {review.designation && (
                          <span className="text-xs text-score-high font-medium">
                            {review.designation.replace('_', ' ')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex-shrink-0 text-xl font-bold" style={{ color: getScoreColor(review.reviewMetaScore) }}>
                      {review.reviewMetaScore}
                    </div>
                  </div>
                  {review.pullQuote && (
                    <blockquote className="mt-3 text-sm text-gray-400 italic border-l-2 border-brand/30 pl-3">
                      &ldquo;{review.pullQuote}&rdquo;
                    </blockquote>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Show Details */}
        <div className="card p-5 mb-8">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Details</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">Opened</dt>
              <dd className="text-white mt-0.5">{formatDate(show.openingDate)}</dd>
            </div>
            {show.closingDate && (
              <div>
                <dt className="text-gray-500">Closes</dt>
                <dd className="text-white mt-0.5">{formatDate(show.closingDate)}</dd>
              </div>
            )}
            <div>
              <dt className="text-gray-500">Runtime</dt>
              <dd className="text-white mt-0.5">{show.runtime}</dd>
            </div>
            {show.intermissions !== undefined && (
              <div>
                <dt className="text-gray-500">Intermissions</dt>
                <dd className="text-white mt-0.5">{show.intermissions}</dd>
              </div>
            )}
            {show.ageRecommendation && (
              <div>
                <dt className="text-gray-500">Age</dt>
                <dd className="text-white mt-0.5">{show.ageRecommendation}</dd>
              </div>
            )}
            <div>
              <dt className="text-gray-500">Theater</dt>
              <dd className="text-white mt-0.5">{show.venue}</dd>
            </div>
          </dl>
        </div>

        {/* Footer */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
            How are scores calculated? →
          </Link>
        </div>
      </div>
    </>
  );
}
