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

  const description = show.metascore
    ? `${show.title} has a Metascore of ${show.metascore}. Critics: ${show.criticScore?.score ?? 'N/A'}, Audience: ${show.audienceScore?.score ?? 'N/A'}, Buzz: ${show.buzzScore?.score ?? 'N/A'}.`
    : `Reviews and scores for ${show.title} on Broadway.`;

  return {
    title: `${show.title} Reviews & Metascore`,
    description,
    openGraph: {
      title: `${show.title} - Broadway Metascore`,
      description,
    },
  };
}

function ScoreBadge({ score, label, size = 'lg' }: { score?: number | null; label: string; size?: 'md' | 'lg' }) {
  const sizeClasses = {
    md: 'w-14 h-14 sm:w-16 sm:h-16 text-xl sm:text-2xl rounded-xl',
    lg: 'w-20 h-20 sm:w-24 sm:h-24 text-3xl sm:text-4xl rounded-2xl',
  };

  const colorClass = score === undefined || score === null
    ? 'bg-surface-overlay text-gray-500 border border-white/10'
    : score >= 70
    ? 'bg-score-high text-white shadow-[0_4px_12px_rgba(16,185,129,0.3)]'
    : score >= 50
    ? 'bg-score-medium text-gray-900 shadow-[0_4px_12px_rgba(245,158,11,0.3)]'
    : 'bg-score-low text-white shadow-[0_4px_12px_rgba(239,68,68,0.3)]';

  return (
    <div className="flex flex-col items-center">
      <div className={`${sizeClasses[size]} ${colorClass} flex items-center justify-center font-bold transition-transform hover:scale-105`}>
        {score ?? '—'}
      </div>
      <div className="mt-2.5 text-xs sm:text-sm text-gray-400 uppercase tracking-wide font-medium">{label}</div>
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
    <span className={`inline-flex items-center px-4 py-1.5 rounded-pill text-sm font-semibold border ${className}`}>
      {label}
    </span>
  );
}

function ConfidenceBadge({ level, reasons }: { level: string; reasons: string[] }) {
  const colors: Record<string, string> = {
    high: 'bg-score-high-bg text-score-high border-score-high/20',
    medium: 'bg-score-medium-bg text-score-medium border-score-medium/20',
    low: 'bg-score-low-bg text-score-low border-score-low/20',
  };

  return (
    <div className={`p-4 rounded-card border ${colors[level] || colors.low}`}>
      <div className="flex items-center gap-2">
        <span className="font-semibold capitalize">{level} Confidence</span>
      </div>
      {reasons.length > 0 && (
        <ul className="mt-2 text-sm opacity-80 space-y-0.5">
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
    month: 'long',
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
    aggregateRating: show.metascore ? {
      '@type': 'AggregateRating',
      ratingValue: show.metascore,
      bestRating: 100,
      worstRating: 0,
      ratingCount: (show.criticScore?.reviewCount ?? 0) + (show.audienceScore?.totalReviewCount ?? 0),
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

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8 sm:mb-10">
          <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
            <BackArrow />
            All Shows
          </Link>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-white tracking-tight">{show.title}</h1>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-3 text-gray-400 text-sm sm:text-base">
                <span className="font-medium text-gray-300">{show.venue}</span>
                <span className="text-gray-600">•</span>
                <span>Opened {formatDate(show.openingDate)}</span>
                {show.runtime && (
                  <>
                    <span className="text-gray-600 hidden sm:inline">•</span>
                    <span className="hidden sm:inline">{show.runtime}</span>
                  </>
                )}
              </div>
            </div>
            <StatusChip status={show.status} />
          </div>
        </div>

        {/* Score Overview */}
        <div className="card p-6 sm:p-8 mb-8">
          <div className="grid grid-cols-4 gap-3 sm:gap-8 justify-items-center">
            <ScoreBadge score={show.metascore} label="Overall" size="lg" />
            <ScoreBadge score={show.criticScore?.score} label="Critics" size="md" />
            <ScoreBadge score={show.audienceScore?.score} label="Audience" size="md" />
            <ScoreBadge score={show.buzzScore?.score} label="Buzz" size="md" />
          </div>

          {show.metascore !== null && (
            <div className="mt-6 sm:mt-8 pt-6 border-t border-white/5 text-xs sm:text-sm text-gray-500 text-center">
              <span className="text-gray-400">Weights:</span> Critics 50% • Audience 35% • Buzz 15%
            </div>
          )}

          {show.confidence && (
            <div className="mt-6 flex justify-center">
              <ConfidenceBadge level={show.confidence.level} reasons={show.confidence.reasons} />
            </div>
          )}
        </div>

        {/* Score Details Grid */}
        <div className="grid lg:grid-cols-2 gap-6 sm:gap-8">
          {/* Critic Reviews */}
          {show.criticScore && (
            <div className="card p-5 sm:p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg sm:text-xl font-bold text-white">Critic Reviews</h2>
                <div className="text-sm text-gray-500 font-medium">
                  {show.criticScore.reviewCount} reviews
                </div>
              </div>
              <div className="space-y-4 max-h-[450px] sm:max-h-[550px] overflow-y-auto pr-2 -mr-2">
                {show.criticScore.reviews.map((review, i) => (
                  <div key={i} className="border-b border-white/5 pb-4 last:border-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <a
                          href={review.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-white hover:text-brand transition-colors text-sm sm:text-base"
                        >
                          {review.outlet}
                        </a>
                        {review.criticName && (
                          <span className="text-gray-500 text-xs sm:text-sm ml-2">by {review.criticName}</span>
                        )}
                        <div className="flex flex-wrap items-center gap-2 mt-1.5">
                          <TierBadge tier={review.tier} />
                          <span className="text-xs text-gray-500">
                            {formatDate(review.publishDate)}
                          </span>
                          {review.designation && (
                            <span className="text-xs text-score-high font-medium">
                              {review.designation.replace('_', ' ')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-bold text-lg" style={{ color: getScoreColor(review.reviewMetaScore) }}>
                          {review.reviewMetaScore}
                        </div>
                        <div className="text-[10px] text-gray-600">base: {review.assignedScore}</div>
                      </div>
                    </div>
                    {review.pullQuote && (
                      <blockquote className="mt-3 text-xs sm:text-sm text-gray-400 italic border-l-2 border-brand/30 pl-3">
                        &ldquo;{review.pullQuote}&rdquo;
                      </blockquote>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Audience Scores */}
          {show.audienceScore && (
            <div className="card p-5 sm:p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg sm:text-xl font-bold text-white">Audience Scores</h2>
                <div className="text-sm text-gray-500 font-medium">
                  {show.audienceScore.totalReviewCount.toLocaleString()} reviews
                </div>
              </div>

              {show.audienceScore.divergenceWarning && (
                <div className="mb-5 p-4 rounded-card bg-score-medium-bg border border-score-medium/20 text-score-medium text-sm">
                  {show.audienceScore.divergenceWarning}
                </div>
              )}

              <div className="space-y-4">
                {show.audienceScore.platforms.map((platform, i) => (
                  <div key={i} className="bg-surface-overlay/50 rounded-card p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-white">{platform.platformName}</div>
                        <div className="text-sm text-gray-500 mt-0.5">
                          {platform.averageRating} / {platform.maxRating}
                          {platform.reviewCount && ` • ${platform.reviewCount.toLocaleString()} reviews`}
                        </div>
                      </div>
                      <div className="text-2xl font-bold" style={{ color: getScoreColor(platform.mappedScore) }}>
                        {platform.mappedScore}
                      </div>
                    </div>
                    {platform.url && (
                      <a
                        href={platform.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-brand hover:text-brand-hover font-medium mt-3 inline-flex items-center gap-1 transition-colors"
                      >
                        View on {platform.platformName}
                        <span>→</span>
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Buzz Section */}
        {show.buzzScore && (
          <div className="card p-5 sm:p-6 mt-6 sm:mt-8">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg sm:text-xl font-bold text-white">Community Buzz</h2>
              <div className="text-sm font-medium" style={{ color: getScoreColor(show.buzzScore.score) }}>
                {show.buzzScore.score}/100
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mb-6">
              <div className="bg-surface-overlay/50 rounded-card p-4">
                <div className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Volume</div>
                <div className="text-2xl font-bold text-white">{show.buzzScore.volumeScore}<span className="text-gray-500 text-lg">/50</span></div>
                <div className="text-sm text-gray-500 mt-1">{show.buzzScore.volumeNote}</div>
              </div>
              <div className="bg-surface-overlay/50 rounded-card p-4">
                <div className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Sentiment</div>
                <div className="text-2xl font-bold text-white">{show.buzzScore.sentimentScore}<span className="text-gray-500 text-lg">/50</span></div>
                <div className="text-sm text-gray-500 mt-1">{show.buzzScore.sentimentNote}</div>
              </div>
            </div>

            {show.buzzScore.stalenessPenalty && (
              <div className="mb-5 p-4 rounded-card bg-score-medium-bg border border-score-medium/20 text-score-medium text-sm">
                -{show.buzzScore.stalenessPenalty} point staleness penalty applied (older discussions)
              </div>
            )}

            <h3 className="text-base font-semibold text-white mb-4">Recent Discussions</h3>
            <div className="space-y-3">
              {show.buzzScore.threads.slice(0, 5).map((thread, i) => (
                <a
                  key={i}
                  href={thread.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-surface-overlay/30 hover:bg-surface-overlay/60 rounded-card p-4 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-white font-medium text-sm sm:text-base line-clamp-2">{thread.title}</div>
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2 text-xs sm:text-sm text-gray-500">
                        <span className="text-gray-400 font-medium">{thread.subreddit || thread.platform}</span>
                        <span className="text-gray-600">•</span>
                        <span>{formatDate(thread.date)}</span>
                        <span className="text-gray-600">•</span>
                        <span className={
                          thread.sentiment === 'positive' ? 'text-score-high font-medium' :
                          thread.sentiment === 'negative' ? 'text-score-low font-medium' :
                          'text-score-medium font-medium'
                        }>
                          {thread.sentiment}
                        </span>
                      </div>
                    </div>
                    <div className="text-right text-xs sm:text-sm text-gray-500 whitespace-nowrap flex-shrink-0">
                      <div className="text-gray-400">↑ {thread.upvotes}</div>
                      <div>{thread.commentCount} comments</div>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Footer Metadata */}
        <div className="mt-8 sm:mt-10 text-sm text-gray-500 border-t border-white/5 pt-6">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <span>Methodology v{show.methodologyVersion}</span>
            <span className="text-gray-700">•</span>
            <Link href="/methodology" className="text-brand hover:text-brand-hover font-medium transition-colors">
              View methodology
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
