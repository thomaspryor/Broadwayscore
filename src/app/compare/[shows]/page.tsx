import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug } from '@/lib/data-core';
import { getLotteryRush } from '@/lib/data-lottery';
import { getCriticConsensus } from '@/lib/data-guides';
import { getAllComparisonSlugs, parseComparisonSlug, isValidComparison } from '@/config/comparisons';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge, StatusBadge, FormatPill } from '@/components/show-cards';
import ShowImage from '@/components/ShowImage';
import TicketLink from '@/components/TicketLink';
import { sortTicketLinks } from '@/lib/ticket-utils';
import Breadcrumb from '@/components/Breadcrumb';

export function generateStaticParams() {
  return getAllComparisonSlugs().map((shows) => ({ shows }));
}

export function generateMetadata({ params }: { params: { shows: string } }): Metadata {
  const parsed = parseComparisonSlug(params.shows);
  if (!parsed) return { title: 'Comparison Not Found' };

  const showA = getShowBySlug(parsed.showA);
  const showB = getShowBySlug(parsed.showB);
  if (!showA || !showB) return { title: 'Comparison Not Found' };

  const title = `${showA.title} vs ${showB.title}: Which Broadway Show Is Better?`;
  const description = `Compare ${showA.title} and ${showB.title} on Broadway. See CriticScore ratings, runtime, ticket prices, and which show is right for you.`;

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/compare/${params.shows}` },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/compare/${params.shows}`,
      type: 'article',
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: title }],
    },
  };
}

// Helper to format runtime
function formatRuntime(runtime?: string): string {
  if (!runtime) return 'TBD';
  return runtime;
}

// Helper to get ticket price range
function getTicketPriceRange(show: ReturnType<typeof getShowBySlug>): string {
  if (!show?.ticketLinks?.length) return 'Check show website';
  const prices = show.ticketLinks.filter(l => l.priceFrom).map(l => l.priceFrom!);
  if (!prices.length) return 'Varies';
  const min = Math.min(...prices);
  return `From $${min}`;
}

// Comparison row component
function ComparisonRow({
  label,
  valueA,
  valueB,
  winnerA,
  winnerB,
}: {
  label: string;
  valueA: React.ReactNode;
  valueB: React.ReactNode;
  winnerA?: boolean;
  winnerB?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-4 py-3 border-b border-white/5 last:border-0">
      <div className="text-gray-400 text-sm font-medium">{label}</div>
      <div className={`text-center ${winnerA ? 'text-emerald-400 font-semibold' : 'text-gray-300'}`}>
        {valueA}
      </div>
      <div className={`text-center ${winnerB ? 'text-emerald-400 font-semibold' : 'text-gray-300'}`}>
        {valueB}
      </div>
    </div>
  );
}

export default function ComparisonPage({ params }: { params: { shows: string } }) {
  const parsed = parseComparisonSlug(params.shows);
  if (!parsed) notFound();

  const showA = getShowBySlug(parsed.showA);
  const showB = getShowBySlug(parsed.showB);
  if (!showA || !showB) notFound();

  // Check if this is a valid curated comparison
  if (!isValidComparison(parsed.showA, parsed.showB)) notFound();

  const lotteryRushA = getLotteryRush(showA.id);
  const lotteryRushB = getLotteryRush(showB.id);
  const consensusA = getCriticConsensus(showA.id);
  const consensusB = getCriticConsensus(showB.id);

  const scoreA = showA.criticScore?.score ?? null;
  const scoreB = showB.criticScore?.score ?? null;

  // Determine winners for various categories
  const scoreWinnerA = scoreA !== null && scoreB !== null && scoreA > scoreB;
  const scoreWinnerB = scoreA !== null && scoreB !== null && scoreB > scoreA;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Compare', url: `${BASE_URL}/compare` },
    { name: `${showA.title} vs ${showB.title}`, url: `${BASE_URL}/compare/${params.shows}` },
  ]);

  // Comparison schema for SEO
  const comparisonSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `${showA.title} vs ${showB.title}: Broadway Show Comparison`,
    description: `Compare ${showA.title} and ${showB.title} side by side. CriticScore ratings, runtime, ticket prices, and recommendations.`,
    image: `${BASE_URL}/og/home.png`,
    datePublished: new Date().toISOString().split('T')[0],
    dateModified: new Date().toISOString().split('T')[0],
    author: {
      '@type': 'Organization',
      name: 'Broadway Scorecard',
      url: BASE_URL,
    },
    about: [
      { '@type': 'Thing', name: showA.title },
      { '@type': 'Thing', name: showB.title },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, comparisonSchema]) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Compare', href: '/compare' },
          { label: `${showA.title} vs ${showB.title}` },
        ]} />

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-3">
            {showA.title} vs {showB.title}
          </h1>
          <p className="text-gray-400 text-base sm:text-lg">
            Which Broadway show should you see? Compare CriticScore ratings, runtime, prices, and more.
          </p>
        </div>

        {/* Side-by-side show cards */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          {/* Show A */}
          <div className="card p-4 text-center">
            <Link href={`/show/${showA.slug}`} className="block">
              <div className="w-24 h-24 sm:w-32 sm:h-32 mx-auto rounded-lg overflow-hidden bg-surface-overlay mb-3">
                <ShowImage
                  sources={[
                    showA.images?.thumbnail ? getOptimizedImageUrl(showA.images.thumbnail, 'thumbnail') : null,
                    showA.images?.poster ? getOptimizedImageUrl(showA.images.poster, 'thumbnail') : null,
                  ]}
                  alt={showA.title}
                  className="w-full h-full object-cover"
                  fallback={
                    <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                      <span className="text-3xl text-gray-500">🎭</span>
                    </div>
                  }
                />
              </div>
              <h2 className="font-bold text-white text-base sm:text-lg hover:text-brand transition-colors mb-2">
                {showA.title}
              </h2>
            </Link>
            <div className="flex justify-center gap-1.5 mb-3">
              <StatusBadge status={showA.status} />
              <FormatPill type={showA.type} />
            </div>
            <div className="flex justify-center">
              <ScoreBadge
                score={scoreA}
                size="lg"
                showCrown
                reviewCount={showA.criticScore?.reviewCount}
                status={showA.status}
              />
            </div>
            {showA.status !== 'closed' && showA.ticketLinks?.length ? (() => {
              const sorted = sortTicketLinks(showA.ticketLinks);
              return (
                <div className="mt-3">
                  <TicketLink
                    showName={showA.title}
                    showId={showA.id}
                    showSlug={showA.slug}
                    showStatus={showA.status}
                    platform={sorted[0].platform}
                    url={sorted[0].url}
                    pageType="comparison"
                    linkPosition={0}
                    totalLinks={sorted.length}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                    </svg>
                    Get Tickets
                  </TicketLink>
                </div>
              );
            })() : null}
          </div>

          {/* Show B */}
          <div className="card p-4 text-center">
            <Link href={`/show/${showB.slug}`} className="block">
              <div className="w-24 h-24 sm:w-32 sm:h-32 mx-auto rounded-lg overflow-hidden bg-surface-overlay mb-3">
                <ShowImage
                  sources={[
                    showB.images?.thumbnail ? getOptimizedImageUrl(showB.images.thumbnail, 'thumbnail') : null,
                    showB.images?.poster ? getOptimizedImageUrl(showB.images.poster, 'thumbnail') : null,
                  ]}
                  alt={showB.title}
                  className="w-full h-full object-cover"
                  fallback={
                    <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                      <span className="text-3xl text-gray-500">🎭</span>
                    </div>
                  }
                />
              </div>
              <h2 className="font-bold text-white text-base sm:text-lg hover:text-brand transition-colors mb-2">
                {showB.title}
              </h2>
            </Link>
            <div className="flex justify-center gap-1.5 mb-3">
              <StatusBadge status={showB.status} />
              <FormatPill type={showB.type} />
            </div>
            <div className="flex justify-center">
              <ScoreBadge
                score={scoreB}
                size="lg"
                showCrown
                reviewCount={showB.criticScore?.reviewCount}
                status={showB.status}
              />
            </div>
            {showB.status !== 'closed' && showB.ticketLinks?.length ? (() => {
              const sorted = sortTicketLinks(showB.ticketLinks);
              return (
                <div className="mt-3">
                  <TicketLink
                    showName={showB.title}
                    showId={showB.id}
                    showSlug={showB.slug}
                    showStatus={showB.status}
                    platform={sorted[0].platform}
                    url={sorted[0].url}
                    pageType="comparison"
                    linkPosition={0}
                    totalLinks={sorted.length}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                    </svg>
                    Get Tickets
                  </TicketLink>
                </div>
              );
            })() : null}
          </div>
        </div>

        {/* Comparison Table */}
        <div className="card p-4 sm:p-6 mb-8">
          <h2 className="font-bold text-white text-lg mb-4">Side-by-Side Comparison</h2>

          {/* Header row */}
          <div className="grid grid-cols-3 gap-4 pb-3 border-b border-white/10 mb-2">
            <div className="text-gray-500 text-sm font-medium"></div>
            <div className="text-center font-semibold text-white text-sm truncate">{showA.title}</div>
            <div className="text-center font-semibold text-white text-sm truncate">{showB.title}</div>
          </div>

          <ComparisonRow
            label="CriticScore"
            valueA={scoreA !== null ? Math.round(scoreA) : 'TBD'}
            valueB={scoreB !== null ? Math.round(scoreB) : 'TBD'}
            winnerA={scoreWinnerA}
            winnerB={scoreWinnerB}
          />
          <ComparisonRow
            label="Review Count"
            valueA={showA.criticScore?.reviewCount ?? 'N/A'}
            valueB={showB.criticScore?.reviewCount ?? 'N/A'}
          />
          <ComparisonRow
            label="Type"
            valueA={showA.type === 'musical' ? 'Musical' : 'Play'}
            valueB={showB.type === 'musical' ? 'Musical' : 'Play'}
          />
          <ComparisonRow
            label="Runtime"
            valueA={formatRuntime(showA.runtime)}
            valueB={formatRuntime(showB.runtime)}
          />
          <ComparisonRow
            label="Intermissions"
            valueA={showA.intermissions !== undefined ? showA.intermissions : 'TBD'}
            valueB={showB.intermissions !== undefined ? showB.intermissions : 'TBD'}
          />
          <ComparisonRow
            label="Theater"
            valueA={showA.venue || 'TBD'}
            valueB={showB.venue || 'TBD'}
          />
          <ComparisonRow
            label="Ticket Prices"
            valueA={getTicketPriceRange(showA)}
            valueB={getTicketPriceRange(showB)}
          />
          <ComparisonRow
            label="Has Lottery"
            valueA={lotteryRushA?.lottery ? '✓ Yes' : '✗ No'}
            valueB={lotteryRushB?.lottery ? '✓ Yes' : '✗ No'}
            winnerA={!!lotteryRushA?.lottery && !lotteryRushB?.lottery}
            winnerB={!!lotteryRushB?.lottery && !lotteryRushA?.lottery}
          />
          <ComparisonRow
            label="Has Rush"
            valueA={lotteryRushA?.rush ? '✓ Yes' : '✗ No'}
            valueB={lotteryRushB?.rush ? '✓ Yes' : '✗ No'}
            winnerA={!!lotteryRushA?.rush && !lotteryRushB?.rush}
            winnerB={!!lotteryRushB?.rush && !lotteryRushA?.rush}
          />
          <ComparisonRow
            label="Age Recommendation"
            valueA={showA.ageRecommendation || 'Not specified'}
            valueB={showB.ageRecommendation || 'Not specified'}
          />
        </div>

        {/* Critic Consensus */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          <div className="card p-4">
            <h3 className="font-bold text-white text-sm mb-2">Critics on {showA.title}</h3>
            <p className="text-gray-400 text-sm leading-relaxed">
              {consensusA || showA.synopsis || 'No critic consensus available.'}
            </p>
          </div>
          <div className="card p-4">
            <h3 className="font-bold text-white text-sm mb-2">Critics on {showB.title}</h3>
            <p className="text-gray-400 text-sm leading-relaxed">
              {consensusB || showB.synopsis || 'No critic consensus available.'}
            </p>
          </div>
        </div>

        {/* Recommendation */}
        <div className="card p-4 sm:p-6 bg-surface-raised mb-8">
          <h2 className="font-bold text-white text-lg mb-3">Which Show Should You See?</h2>
          <div className="text-gray-300 text-sm space-y-3">
            {scoreA !== null && scoreB !== null && Math.abs(scoreA - scoreB) > 5 && (
              <p>
                <strong className="text-white">Based on CriticScore:</strong>{' '}
                {scoreA > scoreB ? showA.title : showB.title} has a higher critic rating
                ({Math.round(scoreA > scoreB ? scoreA : scoreB)} vs {Math.round(scoreA > scoreB ? scoreB : scoreA)}).
              </p>
            )}
            {showA.type !== showB.type && (
              <p>
                <strong className="text-white">Different formats:</strong>{' '}
                {showA.title} is a {showA.type}, while {showB.title} is a {showB.type}.
                Choose based on whether you prefer musical numbers or dramatic performances.
              </p>
            )}
            {showA.runtime && showB.runtime && showA.runtime !== showB.runtime && (
              <p>
                <strong className="text-white">Short on time?</strong>{' '}
                {showA.title} runs {showA.runtime} while {showB.title} runs {showB.runtime}.
              </p>
            )}
            {showA.ageRecommendation && showB.ageRecommendation && showA.ageRecommendation !== showB.ageRecommendation && (
              <p>
                <strong className="text-white">Bringing kids?</strong>{' '}
                {showA.title} is recommended for {showA.ageRecommendation}, while {showB.title} is {showB.ageRecommendation}.
              </p>
            )}
            {(lotteryRushA?.lottery || lotteryRushB?.lottery) && (
              <p>
                <strong className="text-white">Budget-friendly option:</strong>{' '}
                {lotteryRushA?.lottery && lotteryRushB?.lottery
                  ? 'Both shows offer lottery tickets — enter both for better chances!'
                  : lotteryRushA?.lottery
                    ? `${showA.title} has a lottery for discounted tickets.`
                    : `${showB.title} has a lottery for discounted tickets.`}
              </p>
            )}
            <p className="pt-2 border-t border-white/10">
              <Link href={`/show/${scoreA !== null && scoreB !== null && scoreA >= scoreB ? showA.slug : showB.slug}`} className="text-brand hover:text-brand-hover font-medium">
                Learn more about {scoreA !== null && scoreB !== null && scoreA >= scoreB ? showA.title : showB.title} →
              </Link>
            </p>
          </div>
        </div>

        {/* Related Comparisons */}
        <div className="mt-8 pt-6 border-t border-white/10">
          <h3 className="font-bold text-white text-base mb-3">More Comparisons</h3>
          <div className="flex flex-wrap gap-2">
            <Link href="/guides/best-broadway-shows" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Best Broadway Shows
            </Link>
            <Link href="/guides/best-broadway-musicals" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Best Musicals
            </Link>
            <Link href="/guides/cheap-broadway-tickets" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Cheap Tickets Guide
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
