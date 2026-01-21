import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, ComputedShow } from '@/lib/data';
import { METHODOLOGY_VERSION } from '@/config/scoring';

export function generateStaticParams() {
  return getAllShowSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  const description = show.criticScore
    ? `${show.title} has a Critics Score of ${show.criticScore.score} based on ${show.criticScore.reviewCount} reviews.`
    : `Reviews and scores for ${show.title} on Broadway.`;

  return {
    title: `${show.title} Reviews & Score`,
    description,
    openGraph: {
      title: `${show.title} - Broadway Metascore`,
      description,
    },
  };
}

function ScoreBadge({ score, label, size = 'lg' }: { score?: number | null; label: string; size?: 'md' | 'lg' }) {
  const sizeClasses = {
    md: 'w-14 h-14 sm:w-16 sm:h-16 text-xl sm:text-2xl',
    lg: 'w-20 h-20 sm:w-24 sm:h-24 text-3xl sm:text-4xl',
  };

  const colorClass = score === undefined || score === null
    ? 'bg-gray-700 text-gray-500'
    : score >= 70
    ? 'bg-green-500 text-white'
    : score >= 50
    ? 'bg-yellow-500 text-gray-900'
    : 'bg-red-500 text-white';

  return (
    <div className="flex flex-col items-center">
      <div className={`${sizeClasses[size]} ${colorClass} rounded-xl flex items-center justify-center font-bold`}>
        {score ?? '—'}
      </div>
      <div className="mt-2 text-xs sm:text-sm text-gray-400 uppercase tracking-wide">{label}</div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    open: { label: 'Now Playing', className: 'bg-green-500/20 text-green-300 border-green-500/30' },
    closed: { label: 'Closed', className: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
    previews: { label: 'In Previews', className: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  };

  const { label, className } = config[status] || { label: status, className: 'bg-gray-500/20 text-gray-400 border-gray-500/30' };

  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${className}`}>
      {label}
    </span>
  );
}

function ConfidenceBadge({ level, reasons }: { level: string; reasons: string[] }) {
  const colors: Record<string, string> = {
    high: 'bg-green-500/20 text-green-300 border-green-500/30',
    medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    low: 'bg-red-500/20 text-red-300 border-red-500/30',
  };

  return (
    <div className={`p-3 rounded-lg border ${colors[level] || colors.low}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium capitalize">{level} Confidence</span>
      </div>
      {reasons.length > 0 && (
        <ul className="mt-2 text-sm opacity-80">
          {reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TierBadge({ tier }: { tier: number }) {
  const colors: Record<number, string> = {
    1: 'bg-green-500/20 text-green-400',
    2: 'bg-blue-500/20 text-blue-400',
    3: 'bg-gray-500/20 text-gray-400',
  };

  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${colors[tier] || colors[3]}`}>
      Tier {tier}
    </span>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getScoreColor(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 50) return '#eab308';
  return '#ef4444';
}

// JSON-LD structured data for SEO
function generateStructuredData(show: ComputedShow) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TheaterEvent',
    name: show.title,
    location: {
      '@type': 'PerformingArtsTheater',
      name: show.venue,
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'New York',
        addressRegion: 'NY',
        addressCountry: 'US',
      },
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
  };
}

export default function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const structuredData = generateStructuredData(show);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <Link href="/" className="text-green-400 hover:text-green-300 text-sm mb-4 inline-block">
            ← Back to all shows
          </Link>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <h1 className="text-2xl sm:text-4xl font-bold text-white">{show.title}</h1>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2 text-gray-400 text-sm sm:text-base">
                <span>{show.venue}</span>
                <span className="hidden sm:inline">•</span>
                <span>Opened {formatDate(show.openingDate)}</span>
                {show.runtime && (
                  <>
                    <span className="hidden sm:inline">•</span>
                    <span>{show.runtime}</span>
                  </>
                )}
              </div>
            </div>
            <StatusChip status={show.status} />
          </div>
        </div>

        {/* Score Overview */}
        <div className="bg-gray-800 rounded-xl p-6 sm:p-8 mb-6 sm:mb-8">
          <div className="flex flex-col items-center">
            <ScoreBadge score={show.criticScore?.score} label="Critics Score" size="lg" />

            {show.criticScore && (
              <div className="mt-4 text-sm text-gray-400">
                Based on {show.criticScore.reviewCount} critic reviews
                {show.criticScore.tier1Count > 0 && ` (${show.criticScore.tier1Count} Tier 1)`}
              </div>
            )}

            {show.criticScore?.label && (
              <div className={`mt-2 px-3 py-1 rounded-full text-sm font-medium ${
                show.criticScore.label === 'Rave' ? 'bg-green-500/20 text-green-300' :
                show.criticScore.label === 'Positive' ? 'bg-green-500/20 text-green-300' :
                show.criticScore.label === 'Mixed' ? 'bg-yellow-500/20 text-yellow-300' :
                'bg-red-500/20 text-red-300'
              }`}>
                {show.criticScore.label}
              </div>
            )}
          </div>

          {show.confidence && (
            <div className="mt-6 flex justify-center">
              <ConfidenceBadge level={show.confidence.level} reasons={show.confidence.reasons} />
            </div>
          )}
        </div>

        {/* Critic Reviews */}
        {show.criticScore && (
          <div className="bg-gray-800 rounded-xl p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg sm:text-xl font-bold text-white">Critic Reviews</h2>
              <div className="text-xs sm:text-sm text-gray-400">
                {show.criticScore.reviewCount} reviews
              </div>
            </div>
            <div className="space-y-3 sm:space-y-4">
              {show.criticScore.reviews.map((review, i) => (
                <div key={i} className="border-b border-gray-700 pb-3 sm:pb-4 last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <a
                        href={review.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-white hover:text-green-400 transition text-sm sm:text-base"
                      >
                        {review.outlet}
                      </a>
                      {review.criticName && (
                        <span className="text-gray-400 text-xs sm:text-sm ml-2">by {review.criticName}</span>
                      )}
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <TierBadge tier={review.tier} />
                        <span className="text-xs text-gray-500">
                          {formatDate(review.publishDate)}
                        </span>
                        {review.designation && (
                          <span className="text-xs text-green-500">({review.designation.replace('_', ' ')})</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="font-bold text-lg" style={{ color: getScoreColor(review.reviewMetaScore) }}>
                        {review.reviewMetaScore}
                      </div>
                      {review.assignedScore !== review.reviewMetaScore && (
                        <div className="text-xs text-gray-500">base: {review.assignedScore}</div>
                      )}
                    </div>
                  </div>
                  {review.pullQuote && (
                    <blockquote className="mt-2 text-xs sm:text-sm text-gray-400 italic border-l-2 border-gray-600 pl-3">
                      &ldquo;{review.pullQuote}&rdquo;
                    </blockquote>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!show.criticScore && (
          <div className="bg-gray-800 rounded-xl p-6 text-center text-gray-400">
            No critic reviews yet.
          </div>
        )}

        {/* Footer Metadata */}
        <div className="mt-6 sm:mt-8 text-xs sm:text-sm text-gray-500 border-t border-gray-700 pt-4">
          <div className="flex flex-wrap gap-2 sm:gap-4">
            <span>Methodology v{show.methodologyVersion}</span>
            <span className="hidden sm:inline">•</span>
            <Link href="/methodology" className="text-green-400 hover:underline">
              View methodology
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
