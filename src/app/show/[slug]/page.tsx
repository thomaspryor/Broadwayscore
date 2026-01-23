import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, ComputedShow } from '@/lib/data';
import StickyScoreHeader from '@/components/StickyScoreHeader';
import ReviewsList from '@/components/ReviewsList';

export function generateStaticParams() {
  return getAllShowSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  const score = show.criticScore?.score;
  const description = score
    ? `${show.title} has a critic score of ${score}. Read ${show.criticScore?.reviewCount} reviews.`
    : `Reviews and scores for ${show.title} on Broadway.`;

  return {
    title: `${show.title} - Critic Score & Reviews`,
    description,
    openGraph: {
      title: `${show.title} - BroadwayMetaScores`,
      description,
      images: show.images?.hero ? [{ url: show.images.hero }] : undefined,
    },
  };
}

function ScoreBadge({ score, size = 'lg' }: { score?: number | null; size?: 'md' | 'lg' | 'xl' }) {
  const sizeClasses = {
    md: 'w-14 h-14 text-2xl rounded-xl',
    lg: 'w-20 h-20 text-4xl rounded-2xl',
    xl: 'w-24 h-24 text-5xl rounded-2xl',
  };

  if (score === undefined || score === null) {
    return (
      <div className={`${sizeClasses[size]} bg-surface-overlay text-gray-500 border border-white/10 flex items-center justify-center font-extrabold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  const colorClass = roundedScore >= 70
    ? 'bg-score-high text-white shadow-[0_4px_16px_rgba(16,185,129,0.4)]'
    : roundedScore >= 50
    ? 'bg-score-medium text-gray-900 shadow-[0_4px_16px_rgba(245,158,11,0.4)]'
    : 'bg-score-low text-white shadow-[0_4px_16px_rgba(239,68,68,0.4)]';

  return (
    <div className={`${sizeClasses[size]} ${colorClass} flex items-center justify-center font-extrabold`}>
      {roundedScore}
    </div>
  );
}

// Status pill - subtle background with accent color
function StatusBadge({ status }: { status: string }) {
  const label = {
    open: 'NOW PLAYING',
    closed: 'CLOSED',
    previews: 'IN PREVIEWS',
  }[status] || status.toUpperCase();

  const colorClass = {
    open: 'bg-emerald-500/15 text-emerald-400',
    closed: 'bg-gray-500/15 text-gray-400',
    previews: 'bg-purple-500/15 text-purple-400',
  }[status] || 'bg-gray-500/15 text-gray-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
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

// Use UTC-based formatting to avoid timezone-related hydration mismatch
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function BackArrow() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
    </svg>
  );
}

// Format pill - outline style
function FormatPill({ type }: { type: string }) {
  const isMusical = type === 'musical' || type === 'revival';
  const label = isMusical ? 'MUSICAL' : 'PLAY';
  const colorClass = isMusical
    ? 'border-purple-500/50 text-purple-400'
    : 'border-blue-500/50 text-blue-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${colorClass}`}>
      {label}
    </span>
  );
}

// Production pill - solid muted fill
function ProductionPill({ isRevival }: { isRevival: boolean }) {
  const label = isRevival ? 'REVIVAL' : 'ORIGINAL';
  const colorClass = isRevival
    ? 'bg-amber-500/20 text-amber-400'
    : 'bg-gray-500/20 text-gray-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}


function ScoreLabel({ score }: { score: number }) {
  const roundedScore = Math.round(score);
  let label: string;
  let bgClass: string;
  let textClass: string;

  if (roundedScore >= 85) {
    label = 'Must See!';
    bgClass = 'bg-score-high/20';
    textClass = 'text-score-high';
  } else if (roundedScore >= 75) {
    label = 'Excellent';
    bgClass = 'bg-score-high/20';
    textClass = 'text-score-high';
  } else if (roundedScore >= 65) {
    label = 'Great';
    bgClass = 'bg-score-high/20';
    textClass = 'text-score-high';
  } else if (roundedScore >= 55) {
    label = 'Good';
    bgClass = 'bg-score-medium/20';
    textClass = 'text-score-medium';
  } else if (roundedScore >= 45) {
    label = 'Mixed';
    bgClass = 'bg-score-medium/20';
    textClass = 'text-score-medium';
  } else {
    label = 'Poor';
    bgClass = 'bg-score-low/20';
    textClass = 'text-score-low';
  }

  return (
    <span className={`inline-block px-3 py-1 rounded-full text-sm font-bold uppercase tracking-wide ${bgClass} ${textClass}`}>
      {label}
    </span>
  );
}

function getSentimentLabel(score: number): { label: string; colorClass: string } {
  const roundedScore = Math.round(score);
  if (roundedScore >= 81) return { label: 'Universal Acclaim', colorClass: 'text-score-high' };
  if (roundedScore >= 61) return { label: 'Generally Favorable Reviews', colorClass: 'text-score-high' };
  if (roundedScore >= 40) return { label: 'Mixed or Average Reviews', colorClass: 'text-score-medium' };
  if (roundedScore >= 20) return { label: 'Generally Unfavorable Reviews', colorClass: 'text-score-low' };
  return { label: 'Overwhelming Dislike', colorClass: 'text-score-low' };
}

interface ReviewForBreakdown {
  reviewMetaScore: number;
}

function ScoreBreakdownBar({ reviews }: { reviews: ReviewForBreakdown[] }) {
  const positive = reviews.filter(r => r.reviewMetaScore >= 70).length;
  const mixed = reviews.filter(r => r.reviewMetaScore >= 50 && r.reviewMetaScore < 70).length;
  const negative = reviews.filter(r => r.reviewMetaScore < 50).length;
  const total = reviews.length;

  if (total === 0) return null;

  const positivePct = Math.round((positive / total) * 100);
  const mixedPct = Math.round((mixed / total) * 100);
  const negativePct = Math.round((negative / total) * 100);

  return (
    <div className="space-y-2" role="img" aria-label={`Review breakdown: ${positive} positive, ${mixed} mixed, ${negative} negative out of ${total} total reviews`}>
      {/* Bar */}
      <div className="h-3 rounded-full overflow-hidden flex bg-surface-overlay" aria-hidden="true">
        {positivePct > 0 && (
          <div
            className="bg-score-high h-full"
            style={{ width: `${positivePct}%` }}
          />
        )}
        {mixedPct > 0 && (
          <div
            className="bg-score-medium h-full"
            style={{ width: `${mixedPct}%` }}
          />
        )}
        {negativePct > 0 && (
          <div
            className="bg-score-low h-full"
            style={{ width: `${negativePct}%` }}
          />
        )}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 text-xs">
        {positive > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-score-high" aria-hidden="true" />
            <span className="text-gray-400">{positive} Positive</span>
          </div>
        )}
        {mixed > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-score-medium" aria-hidden="true" />
            <span className="text-gray-400">{mixed} Mixed</span>
          </div>
        )}
        {negative > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-score-low" aria-hidden="true" />
            <span className="text-gray-400">{negative} Negative</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MetascoreSection({ score, reviewCount, reviews }: { score: number; reviewCount: number; reviews: ReviewForBreakdown[] }) {
  const roundedScore = Math.round(score);
  const { label: sentimentLabel, colorClass } = getSentimentLabel(score);

  const scoreColorClass = roundedScore >= 70
    ? 'bg-score-high text-white'
    : roundedScore >= 50
    ? 'bg-score-medium text-gray-900'
    : 'bg-score-low text-white';

  return (
    <section className="card p-5 sm:p-6 mb-6" aria-labelledby="metascore-heading">
      <div className="flex items-start gap-4 sm:gap-6 mb-4">
        {/* Large Score Badge */}
        <div
          className={`w-20 h-20 sm:w-24 sm:h-24 rounded-lg flex items-center justify-center flex-shrink-0 ${scoreColorClass}`}
          role="meter"
          aria-valuenow={roundedScore}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Metascore: ${roundedScore} out of 100 - ${sentimentLabel}`}
        >
          <span className="text-4xl sm:text-5xl font-extrabold" aria-hidden="true">{roundedScore}</span>
        </div>

        {/* Metascore Label and Sentiment */}
        <div className="flex-1 pt-1">
          <h2 id="metascore-heading" className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Metascore</h2>
          <div className={`text-lg sm:text-xl font-bold ${colorClass}`}>{sentimentLabel}</div>
          <a
            href="#critic-reviews"
            className="text-sm text-gray-500 hover:text-brand transition-colors mt-1 inline-block"
          >
            Based on {reviewCount} Critic Review{reviewCount !== 1 ? 's' : ''}
          </a>
        </div>
      </div>

      {/* Score Breakdown Bar */}
      <ScoreBreakdownBar reviews={reviews} />
    </section>
  );
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
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
      address: show.theaterAddress || 'New York, NY',
    },
    startDate: show.openingDate,
    ...(show.closingDate && { endDate: show.closingDate }),
    ...(show.images?.hero && { image: show.images.hero }),
    aggregateRating: show.criticScore?.score ? {
      '@type': 'AggregateRating',
      ratingValue: show.criticScore.score,
      bestRating: 100,
      worstRating: 0,
      reviewCount: show.criticScore.reviewCount,
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

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      {/* Sticky Score Header */}
      <StickyScoreHeader title={show.title} score={score} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <BackArrow />
          All Shows
        </Link>

        {/* Header with Poster Card */}
        <div className="flex gap-4 sm:gap-6 mb-6">
          {/* Poster Card */}
          <div className="flex-shrink-0 w-28 sm:w-36 lg:w-44">
            <div className="aspect-[2/3] rounded-xl overflow-hidden shadow-2xl border border-white/10 bg-surface-raised">
              {show.images?.poster ? (
                <img
                  src={show.images.poster}
                  alt={show.title}
                  className="w-full h-full object-cover"
                />
              ) : show.images?.thumbnail ? (
                <img
                  src={show.images.thumbnail}
                  alt={show.title}
                  className="w-full h-full object-cover"
                />
              ) : show.images?.hero ? (
                <img
                  src={show.images.hero}
                  alt={show.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                  <span className="text-4xl text-gray-600">🎭</span>
                </div>
              )}
            </div>
          </div>

          {/* Title & Meta */}
          <div className="flex-1 min-w-0 pt-2 sm:pt-4">
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <FormatPill type={show.type} />
              <ProductionPill isRevival={show.type === 'revival'} />
              <StatusBadge status={show.status} />
            </div>
            <h1 className="text-xl sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight leading-tight">
              {show.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-gray-400 text-sm">
              <span className="text-gray-300">{show.venue}</span>
              <span className="text-gray-600">•</span>
              <span>Opened {formatDate(show.openingDate)}</span>
              <span className="text-gray-600 hidden sm:inline">•</span>
              <span className="hidden sm:inline">{show.runtime}</span>
            </div>
          </div>
        </div>

        {/* Metascore Section */}
        {score && show.criticScore && (
          <MetascoreSection
            score={score}
            reviewCount={show.criticScore.reviewCount}
            reviews={show.criticScore.reviews}
          />
        )}

        {/* Action Buttons */}
        {(show.ticketLinks?.length || show.officialUrl || show.trailerUrl) && (
          <div className="flex flex-wrap gap-3 mb-8">
            {/* Ticket Links */}
            {show.ticketLinks?.map((link, i) => (
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

            {/* Official Website */}
            {show.officialUrl && (
              <a
                href={show.officialUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-sm font-medium transition-colors border border-white/10"
              >
                <GlobeIcon />
                Official Site
              </a>
            )}

            {/* Trailer */}
            {show.trailerUrl && (
              <a
                href={show.trailerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-sm font-medium transition-colors border border-white/10"
              >
                <PlayIcon />
                Trailer
              </a>
            )}
          </div>
        )}

        {/* Synopsis */}
        {show.synopsis && (
          <div className="mb-8">
            <p className="text-gray-300 leading-relaxed">{show.synopsis}</p>
          </div>
        )}

        {/* Critic Reviews */}
        {show.criticScore && show.criticScore.reviews.length > 0 && (
          <div id="critic-reviews" className="card p-5 sm:p-6 mb-8 scroll-mt-20">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">Critic Reviews</h2>
              <span className="text-sm text-gray-500">{show.criticScore.reviewCount} reviews</span>
            </div>

            <ReviewsList reviews={show.criticScore.reviews} initialCount={5} />
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
            <div className="col-span-2">
              <dt className="text-gray-500">Theater</dt>
              <dd className="text-white mt-0.5">
                {show.theaterAddress ? (
                  <a
                    href={getGoogleMapsUrl(show.theaterAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 hover:text-brand transition-colors"
                  >
                    <MapPinIcon />
                    {show.venue} — {show.theaterAddress}
                  </a>
                ) : (
                  show.venue
                )}
              </dd>
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
