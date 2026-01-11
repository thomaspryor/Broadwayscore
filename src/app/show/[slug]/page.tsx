import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getShowBySlug, shows } from '@/data/shows';
import { ShowStatus, ConfidenceLevel, OutletTier } from '@/types/show';

export function generateStaticParams() {
  return shows.map((show) => ({
    slug: show.metadata.slug,
  }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  return {
    title: `${show.metadata.title} - Broadway Metascore`,
    description: show.summary?.oneLiner || `Reviews and scores for ${show.metadata.title}`,
  };
}

function ScoreBadge({ score, label, size = 'lg' }: { score?: number; label: string; size?: 'md' | 'lg' }) {
  const sizeClasses = {
    md: 'w-16 h-16 text-2xl',
    lg: 'w-24 h-24 text-4xl',
  };

  const colorClass = score === undefined
    ? 'bg-gray-700'
    : score >= 70
    ? 'bg-green-500'
    : score >= 50
    ? 'bg-yellow-500'
    : 'bg-red-500';

  return (
    <div className="flex flex-col items-center">
      <div className={`${sizeClasses[size]} ${colorClass} rounded-xl flex items-center justify-center font-bold text-white`}>
        {score ?? '—'}
      </div>
      <div className="mt-2 text-sm text-gray-400 uppercase tracking-wide">{label}</div>
    </div>
  );
}

function StatusChip({ status }: { status: ShowStatus }) {
  const labels: Record<ShowStatus, string> = {
    previews: 'In Previews',
    opened: 'Now Playing',
    closing: 'Closing Soon',
    closed: 'Closed',
  };

  const colors: Record<ShowStatus, string> = {
    previews: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    opened: 'bg-green-500/20 text-green-300 border-green-500/30',
    closing: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    closed: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  };

  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${colors[status]}`}>
      {labels[status]}
    </span>
  );
}

function ConfidenceBadge({ level, reasons }: { level: ConfidenceLevel; reasons: string[] }) {
  const colors: Record<ConfidenceLevel, string> = {
    high: 'bg-green-500/20 text-green-300 border-green-500/30',
    medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    low: 'bg-red-500/20 text-red-300 border-red-500/30',
  };

  return (
    <div className={`p-3 rounded-lg border ${colors[level]}`}>
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

function TierBadge({ tier }: { tier: OutletTier }) {
  const labels: Record<OutletTier, string> = {
    1: 'Tier 1',
    2: 'Tier 2',
    3: 'Tier 3',
  };

  const colors: Record<OutletTier, string> = {
    1: 'bg-green-500/20 text-green-400',
    2: 'bg-blue-500/20 text-blue-400',
    3: 'bg-gray-500/20 text-gray-400',
  };

  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${colors[tier]}`}>
      {labels[tier]}
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

export default function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const { metadata, criticScore, audienceScore, buzzScore, metascore, summary, confidence } = show;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <Link href="/" className="text-green-400 hover:text-green-300 text-sm mb-4 inline-block">
          ← Back to all shows
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold text-white">{metadata.title}</h1>
            <div className="flex flex-wrap items-center gap-3 mt-2 text-gray-400">
              <span>{metadata.venue}</span>
              <span>•</span>
              <span>Opened {formatDate(metadata.openingDate)}</span>
              {metadata.runtime && (
                <>
                  <span>•</span>
                  <span>{metadata.runtime}</span>
                </>
              )}
            </div>
          </div>
          <StatusChip status={metadata.status} />
        </div>
      </div>

      {/* Score Overview */}
      <div className="bg-gray-800 rounded-xl p-6 mb-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 justify-items-center">
          <ScoreBadge score={metascore?.score} label="Overall" size="lg" />
          <ScoreBadge score={criticScore?.score} label="Critics" size="md" />
          <ScoreBadge score={audienceScore?.score} label="Audience" size="md" />
          <ScoreBadge score={buzzScore?.score} label="Buzz" size="md" />
        </div>

        {metascore && (
          <div className="mt-6 pt-6 border-t border-gray-700 text-sm text-gray-400 text-center">
            Overall score weights: Critics {Math.round(metascore.weights.critic * 100)}% • Audience {Math.round(metascore.weights.audience * 100)}% • Buzz {Math.round(metascore.weights.buzz * 100)}%
          </div>
        )}

        {confidence && (
          <div className="mt-4 flex justify-center">
            <ConfidenceBadge level={confidence.level} reasons={confidence.reasons} />
          </div>
        )}
      </div>

      {/* Summary */}
      {summary && (
        <div className="bg-gray-800 rounded-xl p-6 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">What People Are Saying</h2>
          <ul className="space-y-3">
            {summary.bullets.map((bullet, i) => (
              <li key={i} className="flex gap-3 text-gray-300">
                <span className="text-green-400 mt-1">•</span>
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-8">
        {/* Critic Reviews */}
        {criticScore && (
          <div className="bg-gray-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">Critic Reviews</h2>
              <div className="text-sm text-gray-400">
                {criticScore.reviewCount} reviews • Score: {criticScore.score}
              </div>
            </div>
            <div className="space-y-4 max-h-[500px] overflow-y-auto">
              {criticScore.reviews
                .sort((a, b) => b.tier - a.tier || b.mappedScore - a.mappedScore)
                .map((review, i) => (
                  <div key={i} className="border-b border-gray-700 pb-4 last:border-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <a
                          href={review.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-white hover:text-green-400 transition"
                        >
                          {review.outlet}
                        </a>
                        {review.criticName && (
                          <span className="text-gray-400 text-sm ml-2">by {review.criticName}</span>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <TierBadge tier={review.tier} />
                          <span className="text-xs text-gray-500">
                            {formatDate(review.publishDate)}
                          </span>
                          {review.isInferred && (
                            <span className="text-xs text-yellow-500">(inferred)</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-lg" style={{
                          color: review.mappedScore >= 70 ? '#22c55e' : review.mappedScore >= 50 ? '#eab308' : '#ef4444'
                        }}>
                          {review.mappedScore}
                        </div>
                        <div className="text-xs text-gray-500">{review.originalRating}</div>
                      </div>
                    </div>
                    {review.pullQuote && (
                      <blockquote className="mt-2 text-sm text-gray-400 italic border-l-2 border-gray-600 pl-3">
                        &ldquo;{review.pullQuote}&rdquo;
                      </blockquote>
                    )}
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Audience Scores */}
        {audienceScore && (
          <div className="bg-gray-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">Audience Scores</h2>
              <div className="text-sm text-gray-400">
                {audienceScore.totalReviewCount?.toLocaleString()} reviews • Score: {audienceScore.score}
              </div>
            </div>

            {audienceScore.divergenceWarning && (
              <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 text-sm">
                {audienceScore.divergenceWarning}
              </div>
            )}

            <div className="space-y-4">
              {audienceScore.platforms.map((platform, i) => (
                <div key={i} className="bg-gray-700/50 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-white">{platform.platformName}</div>
                      <div className="text-sm text-gray-400">
                        {platform.averageRating} / {platform.maxRating}
                        {platform.reviewCount && ` • ${platform.reviewCount.toLocaleString()} reviews`}
                      </div>
                    </div>
                    <div className="text-2xl font-bold" style={{
                      color: platform.mappedScore >= 70 ? '#22c55e' : platform.mappedScore >= 50 ? '#eab308' : '#ef4444'
                    }}>
                      {platform.mappedScore}
                    </div>
                  </div>
                  {platform.url && (
                    <a
                      href={platform.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-green-400 hover:underline mt-2 inline-block"
                    >
                      View on {platform.platformName} →
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Buzz Section */}
      {buzzScore && (
        <div className="bg-gray-800 rounded-xl p-6 mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">Community Buzz</h2>
            <div className="text-sm text-gray-400">
              Score: {buzzScore.score}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4 mb-6">
            <div className="bg-gray-700/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 uppercase tracking-wide mb-1">Volume</div>
              <div className="text-2xl font-bold text-white">{buzzScore.volumeScore}/50</div>
              <div className="text-sm text-gray-400 mt-1">{buzzScore.volumeNote}</div>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 uppercase tracking-wide mb-1">Sentiment</div>
              <div className="text-2xl font-bold text-white">{buzzScore.sentimentScore}/50</div>
              <div className="text-sm text-gray-400 mt-1">{buzzScore.sentimentNote}</div>
            </div>
          </div>

          {buzzScore.stalenessPenalty && (
            <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 text-sm">
              -{buzzScore.stalenessPenalty} point staleness penalty applied (older discussions)
            </div>
          )}

          <h3 className="text-lg font-medium text-white mb-3">Recent Discussions</h3>
          <div className="space-y-3">
            {buzzScore.threads.map((thread, i) => (
              <a
                key={i}
                href={thread.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-gray-700/30 hover:bg-gray-700/50 rounded-lg p-4 transition"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-white font-medium">{thread.title}</div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
                      <span>{thread.subreddit || thread.platform}</span>
                      <span>•</span>
                      <span>{formatDate(thread.date)}</span>
                      <span>•</span>
                      <span className={
                        thread.sentiment === 'positive' ? 'text-green-400' :
                        thread.sentiment === 'negative' ? 'text-red-400' :
                        'text-yellow-400'
                      }>
                        {thread.sentiment}
                      </span>
                    </div>
                    {thread.summary && (
                      <div className="text-sm text-gray-500 mt-2">{thread.summary}</div>
                    )}
                  </div>
                  <div className="text-right text-sm text-gray-400 whitespace-nowrap">
                    <div>↑ {thread.upvotes}</div>
                    <div>{thread.commentCount} comments</div>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="mt-8 text-sm text-gray-500 border-t border-gray-700 pt-4">
        <div className="flex flex-wrap gap-4">
          <span>Last updated: {formatDate(show.lastUpdated)}</span>
          <span>•</span>
          <Link href="/methodology" className="text-green-400 hover:underline">
            View methodology
          </Link>
          <span>•</span>
          <Link href={`/data/${metadata.slug}`} className="text-green-400 hover:underline">
            View raw data
          </Link>
        </div>
      </div>
    </div>
  );
}
