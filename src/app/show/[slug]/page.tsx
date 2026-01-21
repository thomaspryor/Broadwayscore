import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, ComputedShow } from '@/lib/data';
import { generateShowSchema, generateBreadcrumbSchema } from '@/lib/seo';
import StickyScoreHeader from '@/components/StickyScoreHeader';
import AnimatedScoreDistribution from '@/components/AnimatedScoreDistribution';
import ReviewsList from '@/components/ReviewsList';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwaymetascore.com';

export function generateStaticParams() {
  return getAllShowSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  const score = show.criticScore?.score;
  const roundedScore = score ? Math.round(score) : null;
  const reviewCount = show.criticScore?.reviewCount || 0;

  // Enhanced title with score for better CTR
  const title = roundedScore
    ? `${show.title} Reviews | ${roundedScore}/100 Critic Score`
    : `${show.title} - Broadway Reviews & Ratings`;

  // Enhanced description with call-to-action
  const description = roundedScore
    ? `${show.title} has a ${roundedScore}/100 critic score based on ${reviewCount} reviews. See what critics are saying about this Broadway ${show.type}.`
    : `Read critic reviews and ratings for ${show.title} on Broadway at ${show.venue}.`;

  const canonicalUrl = `${BASE_URL}/show/${params.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${show.title} - BroadwayMetaScores`,
      description,
      url: canonicalUrl,
      type: 'article',
      images: show.images?.hero ? [{ url: show.images.hero, width: 1200, height: 630, alt: `${show.title} Broadway show` }] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: roundedScore ? `${show.title} - ${roundedScore}/100` : show.title,
      description,
      images: show.images?.hero ? [show.images.hero] : undefined,
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

  // Round to whole number for cleaner display
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

function MapPinIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
    </svg>
  );
}

function TypeTag({ type }: { type: string }) {
  const config: Record<string, { label: string; className: string }> = {
    musical: { label: 'Musical', className: 'bg-purple-500/20 text-purple-400 border-purple-500/20' },
    play: { label: 'Play', className: 'bg-blue-500/20 text-blue-400 border-blue-500/20' },
    revival: { label: 'Revival', className: 'bg-amber-500/20 text-amber-400 border-amber-500/20' },
  };

  const { label, className } = config[type] || { label: type, className: 'bg-gray-500/20 text-gray-400 border-gray-500/20' };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide border ${className}`}>
      {label}
    </span>
  );
}

function NewBadge() {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded bg-brand/20 text-brand text-xs font-bold uppercase tracking-wide">
      New
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

function isNewShow(openingDate: string): boolean {
  const opening = new Date(openingDate);
  const now = new Date();
  const daysSinceOpening = (now.getTime() - opening.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceOpening <= 60 && daysSinceOpening >= 0;
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}


// Generate all structured data for the page (TheaterEvent + BreadcrumbList)
function generateAllStructuredData(show: ComputedShow) {
  const showSchema = generateShowSchema(show);
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Shows', url: `${BASE_URL}/#shows` },
    { name: show.title, url: `${BASE_URL}/show/${show.slug}` },
  ]);

  return [showSchema, breadcrumbSchema];
}

export default function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const structuredData = generateAllStructuredData(show);
  const score = show.criticScore?.score;

  return (
    <>
      {/* Enhanced JSON-LD: TheaterEvent with Reviews + BreadcrumbList */}
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
        <div className="flex gap-4 sm:gap-6 mb-8">
          {/* Poster Card */}
          <div className="flex-shrink-0">
            <div className="relative w-28 sm:w-36 lg:w-44 aspect-[2/3] rounded-xl overflow-hidden shadow-2xl border border-white/10 bg-surface-raised">
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
            {/* Score badge below poster */}
            {score !== undefined && score !== null && (
              <div className="mt-3 flex flex-col items-center">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Metascore</span>
                <ScoreBadge score={score} size="md" />
              </div>
            )}
          </div>

          {/* Title & Meta */}
          <div className="flex-1 min-w-0 pt-2 sm:pt-4">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <TypeTag type={show.type} />
              {isNewShow(show.openingDate) && <NewBadge />}
              <StatusChip status={show.status} />
            </div>
            <h1 className="text-xl sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight leading-tight">
              {show.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-gray-400 text-sm">
              <span className="text-gray-300">{show.venue}</span>
              <span className="text-gray-600 hidden sm:inline">•</span>
              <span className="hidden sm:inline">{show.runtime}</span>
            </div>

            {/* Score Label and Reviews - desktop */}
            {score && (
              <div className="hidden sm:flex items-center gap-3 mt-4">
                <ScoreLabel score={score} />
                {show.criticScore && (
                  <span className="text-sm text-gray-500">
                    Based on {show.criticScore.reviewCount} reviews
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Score Label - mobile only */}
        {score && (
          <div className="flex items-center gap-3 mb-6 sm:hidden">
            <ScoreLabel score={score} />
            {show.criticScore && (
              <span className="text-sm text-gray-500">
                {show.criticScore.reviewCount} reviews
              </span>
            )}
          </div>
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
          <div className="card p-5 sm:p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">Critic Reviews</h2>
              <span className="text-sm text-gray-500">{show.criticScore.reviewCount} reviews</span>
            </div>

            <AnimatedScoreDistribution reviews={show.criticScore.reviews} />

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
