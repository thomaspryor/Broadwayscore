import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getTheaterBySlug, slugify } from '@/lib/data-core';
import { getLotteryRush } from '@/lib/data-lottery';
import { getCriticConsensus } from '@/lib/data-guides';
import { getAudienceBuzz } from '@/lib/data-audience';
import { getAudienceGrade, getAudienceGradeClasses } from '@/lib/audience-grade-utils';
import { getShowAwards } from '@/lib/data-awards';
import { getShowGrosses } from '@/lib/data-grosses';
import { getAllComparisonSlugs, parseComparisonSlug } from '@/config/comparisons';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { isLondonMarket } from '@/lib/market-utils';
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

// Section label component
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 pt-4 pb-2 border-t border-white/[0.06] first:border-t-white/10">
      {children}
    </div>
  );
}

// Comparison row with consistent 3-column grid
function Row({
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
    <div className="grid grid-cols-[80px_1fr_1fr] sm:grid-cols-[100px_1fr_1fr] gap-2 py-2.5 border-b border-white/[0.04] last:border-0 items-center">
      <div className="text-[13px] text-gray-400 font-medium">{label}</div>
      <div className={`text-center text-sm ${winnerA ? 'text-emerald-400 font-semibold' : 'text-gray-300'}`}>
        {valueA}
      </div>
      <div className={`text-center text-sm ${winnerB ? 'text-emerald-400 font-semibold' : 'text-gray-300'}`}>
        {valueB}
      </div>
    </div>
  );
}

// Helper: format large numbers
function formatMoney(n: number, currency: string): string {
  if (n >= 1_000_000_000) return `${currency}${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${currency}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${currency}${(n / 1_000).toFixed(0)}K`;
  return `${currency}${n}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n.toLocaleString();
}

// Helper: how long has it been running
function getRunningDuration(openingDate: string): string {
  const open = new Date(openingDate);
  const now = new Date();
  const years = Math.floor((now.getTime() - open.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  if (years < 1) {
    const months = Math.floor((now.getTime() - open.getTime()) / (30.44 * 24 * 60 * 60 * 1000));
    return months <= 1 ? '< 1 month' : `${months} months`;
  }
  return years === 1 ? '1 year' : `${years} years`;
}

// Helper: format opening date
function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Helper: get the cheapest ticket price
function getMinPrice(show: ReturnType<typeof getShowBySlug>): number | null {
  if (!show?.ticketLinks?.length) return null;
  const prices = show.ticketLinks.filter(l => l.priceFrom).map(l => l.priceFrom!);
  return prices.length ? Math.min(...prices) : null;
}

// Helper: % change string
function pctChange(current: number | null, previous: number | null): string | null {
  if (current == null || previous == null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// Ticket icon SVG
function TicketIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

// Genre tags that map to browse pages
const TAG_BROWSE_MAP: Record<string, string> = {
  'comedy': '/browse/best-broadway-comedies',
  'drama': '/browse/best-broadway-dramas',
  'family': '/browse/broadway-shows-for-kids',
  'revival': '/browse/best-broadway-revivals',
  'jukebox': '/browse/jukebox-musicals-on-broadway',
};

export default function ComparisonPage({ params }: { params: { shows: string } }) {
  const parsed = parseComparisonSlug(params.shows);
  if (!parsed) notFound();

  const showA = getShowBySlug(parsed.showA);
  const showB = getShowBySlug(parsed.showB);
  if (!showA || !showB) notFound();

  // Data fetching
  const lotteryRushA = getLotteryRush(showA.id);
  const lotteryRushB = getLotteryRush(showB.id);
  const consensusA = getCriticConsensus(showA.id);
  const consensusB = getCriticConsensus(showB.id);
  const buzzA = getAudienceBuzz(showA.id);
  const buzzB = getAudienceBuzz(showB.id);
  const awardsA = getShowAwards(showA.id);
  const awardsB = getShowAwards(showB.id);
  const grossesA = getShowGrosses(showA.slug);
  const grossesB = getShowGrosses(showB.slug);
  const isLondon = isLondonMarket(showA.category);
  const currency = isLondon ? '£' : '$';

  // Theater data (Broadway only — WE theaters don't have pages)
  const theaterA = !isLondon && showA.venue ? getTheaterBySlug(slugify(showA.venue)) : undefined;
  const theaterB = !isLondon && showB.venue ? getTheaterBySlug(slugify(showB.venue)) : undefined;

  const scoreA = showA.criticScore?.score ?? null;
  const scoreB = showB.criticScore?.score ?? null;
  const scoreWinnerA = scoreA !== null && scoreB !== null && scoreA > scoreB;
  const scoreWinnerB = scoreA !== null && scoreB !== null && scoreB > scoreA;

  // Audience grades
  const gradeA = buzzA ? getAudienceGrade(buzzA.combinedScore) : null;
  const gradeB = buzzB ? getAudienceGrade(buzzB.combinedScore) : null;
  const gradeClassesA = buzzA ? getAudienceGradeClasses(buzzA.combinedScore) : null;
  const gradeClassesB = buzzB ? getAudienceGradeClasses(buzzB.combinedScore) : null;

  // Ticket prices
  const minPriceA = getMinPrice(showA);
  const minPriceB = getMinPrice(showB);
  const sortedLinksA = showA.ticketLinks?.length ? sortTicketLinks(showA.ticketLinks) : [];
  const sortedLinksB = showB.ticketLinks?.length ? sortTicketLinks(showB.ticketLinks) : [];

  // Creative team helpers
  const getCreative = (show: typeof showA, roles: string[]) =>
    show.creativeTeam?.find(m => roles.includes(m.role));
  const directorA = getCreative(showA, ['Director']);
  const directorB = getCreative(showB, ['Director']);
  const bookA = getCreative(showA, ['Book', 'Playwright', 'Written By', 'Writer']);
  const bookB = getCreative(showB, ['Book', 'Playwright', 'Written By', 'Writer']);
  const musicA = getCreative(showA, ['Music', 'Composer', 'Music & Lyrics', 'Music and Lyrics']);
  const musicB = getCreative(showB, ['Music', 'Composer', 'Music & Lyrics', 'Music and Lyrics']);

  // Genre tags (filter out structural tags)
  const STRUCTURAL_TAGS = new Set(['musical', 'play', 'new', 'revival', 'limited-run', 'limited run']);
  const genreTagsA = showA.tags?.filter(t => !STRUCTURAL_TAGS.has(t.toLowerCase())) ?? [];
  const genreTagsB = showB.tags?.filter(t => !STRUCTURAL_TAGS.has(t.toLowerCase())) ?? [];

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Compare', url: `${BASE_URL}/compare` },
    { name: `${showA.title} vs ${showB.title}`, url: `${BASE_URL}/compare/${params.shows}` },
  ]);

  const comparisonSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `${showA.title} vs ${showB.title}: Broadway Show Comparison`,
    description: `Compare ${showA.title} and ${showB.title} side by side. CriticScore ratings, runtime, ticket prices, and recommendations.`,
    image: `${BASE_URL}/og/home.png`,
    datePublished: new Date().toISOString().split('T')[0],
    dateModified: new Date().toISOString().split('T')[0],
    author: { '@type': 'Organization', name: 'Broadway Scorecard', url: BASE_URL },
    about: [{ '@type': 'Thing', name: showA.title }, { '@type': 'Thing', name: showB.title }],
  };

  // Render helpers for audience badge
  function AudienceBadge({ grade, classes, showSlug }: {
    grade: NonNullable<typeof gradeA>;
    classes: NonNullable<typeof gradeClassesA>;
    showSlug: string;
  }) {
    return (
      <Link href={`/show/${showSlug}#audience`} className="flex flex-col items-center gap-1 group">
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold text-lg shadow-sm ${grade.grade === 'A+' ? 'audience-top-grade' : ''}`}
          style={grade.grade === 'A+' ? {} : { backgroundColor: grade.color, color: grade.textColor }}
          title={grade.tooltip}
        >
          {grade.grade}
        </div>
        <span className="text-[11px] text-gray-400 group-hover:text-white transition-colors">{grade.label}</span>
      </Link>
    );
  }

  // Lottery pill matching existing site style
  function LotteryPill({ data, showSlug }: { data: NonNullable<typeof lotteryRushA>; showSlug: string }) {
    const lottery = data.lottery || data.specialLottery;
    if (!lottery) return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-white/[0.04] text-gray-500 text-xs">&#10007; None</span>;
    return (
      <Link
        href={`/show/${showSlug}#discount-tickets`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 font-semibold text-xs hover:bg-purple-500/25 transition-colors"
      >
        <TicketIcon />
        {currency}{lottery.price} Lottery
      </Link>
    );
  }

  function RushPill({ data, showSlug }: { data: NonNullable<typeof lotteryRushA>; showSlug: string }) {
    const rush = data.rush || data.digitalRush || data.studentRush;
    if (!rush) return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-white/[0.04] text-gray-500 text-xs">&#10007; None</span>;
    return (
      <Link
        href={`/show/${showSlug}#discount-tickets`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold text-xs hover:bg-sky-500/25 transition-colors"
      >
        <TicketIcon />
        {currency}{rush.price} Rush
      </Link>
    );
  }

  // Creative team link
  function CreativeLink({ member, roleSlug }: { member: { name: string; role: string } | undefined; roleSlug: string }) {
    if (!member) return <span className="text-gray-500">—</span>;
    return (
      <Link href={`/${roleSlug}/${slugify(member.name)}`} className="text-gray-300 hover:text-brand transition-colors border-b border-dashed border-white/20 hover:border-brand">
        {member.name}
      </Link>
    );
  }

  // Tag rendering
  function GenreTags({ tags }: { tags: string[] }) {
    if (!tags.length) return <span className="text-gray-500">—</span>;
    return (
      <div className="flex flex-wrap justify-center gap-1">
        {tags.slice(0, 4).map(tag => {
          const browseUrl = TAG_BROWSE_MAP[tag.toLowerCase()];
          const pill = (
            <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.06] text-gray-400">
              {tag}
            </span>
          );
          return browseUrl ? <Link key={tag} href={browseUrl}>{pill}</Link> : pill;
        })}
      </div>
    );
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, comparisonSchema]) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Compare', href: '/compare' },
          { label: `${showA.title} vs ${showB.title}` },
        ]} />

        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-3">
            {showA.title} vs {showB.title}
          </h1>
          <p className="text-gray-400 text-base sm:text-lg">
            Which Broadway show should you see? Compare CriticScore ratings, runtime, prices, and more.
          </p>
        </div>

        {/* Main comparison card */}
        <div className="card p-4 sm:p-6 mb-6">
          {/* Show headers — same 3-column grid as rows */}
          <div className="grid grid-cols-[80px_1fr_1fr] sm:grid-cols-[100px_1fr_1fr] gap-2 mb-6">
            <div />
            {[showA, showB].map((show, i) => {
              const score = i === 0 ? scoreA : scoreB;
              const sorted = show.ticketLinks?.length ? sortTicketLinks(show.ticketLinks) : [];
              const minPrice = i === 0 ? minPriceA : minPriceB;
              return (
                <div key={show.id} className="text-center">
                  <Link href={`/show/${show.slug}`} className="block">
                    <div className="w-20 h-20 sm:w-24 sm:h-24 mx-auto rounded-lg overflow-hidden bg-surface-overlay mb-2">
                      <ShowImage
                        sources={[
                          show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
                          show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'thumbnail') : null,
                        ]}
                        alt={show.title}
                        className="w-full h-full object-cover"
                        fallback={<div className="w-full h-full flex items-center justify-center bg-surface-overlay"><span className="text-2xl text-gray-500">🎭</span></div>}
                      />
                    </div>
                    <h2 className="font-bold text-white text-sm sm:text-base hover:text-brand transition-colors mb-1.5">
                      {show.title}
                    </h2>
                  </Link>
                  <div className="flex flex-col items-center gap-1 mb-2">
                    <StatusBadge status={show.status} />
                    <FormatPill type={show.type} />
                  </div>
                  <div className="flex justify-center mb-2">
                    <ScoreBadge score={score} size="lg" showCrown reviewCount={show.criticScore?.reviewCount} status={show.status} />
                  </div>
                  {show.status !== 'closed' && sorted.length > 0 && (
                    <TicketLink
                      showName={show.title}
                      showId={show.id}
                      showSlug={show.slug}
                      showStatus={show.status}
                      platform={sorted[0].platform}
                      url={sorted[0].url}
                      pageType="comparison"
                      linkPosition={0}
                      totalLinks={sorted.length}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10"
                    >
                      <TicketIcon />
                      Get Tickets{minPrice ? <span className="text-white font-semibold">from {currency}{minPrice}</span> : null}
                    </TicketLink>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── SCORES ── */}
          <SectionLabel>Scores</SectionLabel>
          <Row
            label="Audience"
            valueA={gradeA && gradeClassesA ? <AudienceBadge grade={gradeA} classes={gradeClassesA} showSlug={showA.slug} /> : '—'}
            valueB={gradeB && gradeClassesB ? <AudienceBadge grade={gradeB} classes={gradeClassesB} showSlug={showB.slug} /> : '—'}
          />
          <Row
            label="Reviews"
            valueA={<Link href={`/show/${showA.slug}`} className="text-gray-300 hover:text-brand transition-colors">{showA.criticScore?.reviewCount ?? 'N/A'} reviews</Link>}
            valueB={<Link href={`/show/${showB.slug}`} className="text-gray-300 hover:text-brand transition-colors">{showB.criticScore?.reviewCount ?? 'N/A'} reviews</Link>}
          />

          {/* ── SHOW DETAILS ── */}
          <SectionLabel>Show Details</SectionLabel>
          <Row
            label="Type"
            valueA={<Link href={showA.type === 'musical' ? '/browse/best-broadway-musicals' : '/browse/best-broadway-dramas'} className="text-gray-300 hover:text-brand transition-colors">{showA.type === 'musical' ? 'Musical' : 'Play'}</Link>}
            valueB={<Link href={showB.type === 'musical' ? '/browse/best-broadway-musicals' : '/browse/best-broadway-dramas'} className="text-gray-300 hover:text-brand transition-colors">{showB.type === 'musical' ? 'Musical' : 'Play'}</Link>}
          />
          <Row
            label="Production"
            valueA={showA.isRevival
              ? <Link href="/browse/best-broadway-revivals"><span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 font-semibold">Revival</span></Link>
              : <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-semibold">Original</span>
            }
            valueB={showB.isRevival
              ? <Link href="/browse/best-broadway-revivals"><span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 font-semibold">Revival</span></Link>
              : <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-semibold">Original</span>
            }
          />
          <Row
            label="Genre"
            valueA={<GenreTags tags={genreTagsA} />}
            valueB={<GenreTags tags={genreTagsB} />}
          />
          <Row
            label="Ages"
            valueA={showA.ageRecommendation ? <Link href="/browse/broadway-age-guide" className="text-gray-300 hover:text-brand transition-colors">{showA.ageRecommendation}</Link> : '—'}
            valueB={showB.ageRecommendation ? <Link href="/browse/broadway-age-guide" className="text-gray-300 hover:text-brand transition-colors">{showB.ageRecommendation}</Link> : '—'}
          />
          <Row
            label="Opened"
            valueA={showA.openingDate ? formatDate(showA.openingDate) : 'TBD'}
            valueB={showB.openingDate ? formatDate(showB.openingDate) : 'TBD'}
          />
          <Row
            label="Running"
            valueA={showA.openingDate && showA.status !== 'closed' ? <Link href="/browse/longest-running-broadway-shows" className="text-gray-300 hover:text-brand transition-colors">{getRunningDuration(showA.openingDate)}</Link> : showA.status === 'closed' ? 'Closed' : 'TBD'}
            valueB={showB.openingDate && showB.status !== 'closed' ? <Link href="/browse/longest-running-broadway-shows" className="text-gray-300 hover:text-brand transition-colors">{getRunningDuration(showB.openingDate)}</Link> : showB.status === 'closed' ? 'Closed' : 'TBD'}
          />

          {/* ── AWARDS ── */}
          {(awardsA?.tony || awardsB?.tony) && (
            <>
              <SectionLabel>Awards</SectionLabel>
              <Row
                label="Tonys"
                valueA={awardsA?.tony ? (
                  <Link href={`/show/${showA.slug}#awards`} className="group">
                    <span className="text-amber-400 font-bold group-hover:text-amber-300">🏆 {awardsA.tony.wins?.length ?? 0} wins</span>
                    <span className="block text-[11px] text-gray-500">{awardsA.tony.nominations ?? 0} nominations</span>
                  </Link>
                ) : <span className="text-gray-500">—</span>}
                valueB={awardsB?.tony ? (
                  <Link href={`/show/${showB.slug}#awards`} className="group">
                    <span className="text-amber-400 font-bold group-hover:text-amber-300">🏆 {awardsB.tony.wins?.length ?? 0} wins</span>
                    <span className="block text-[11px] text-gray-500">{awardsB.tony.nominations ?? 0} nominations</span>
                  </Link>
                ) : <span className="text-gray-500">—</span>}
                winnerA={!!awardsA?.tony?.wins?.length && (awardsA.tony.wins.length > (awardsB?.tony?.wins?.length ?? 0))}
                winnerB={!!awardsB?.tony?.wins?.length && (awardsB.tony.wins.length > (awardsA?.tony?.wins?.length ?? 0))}
              />
            </>
          )}

          {/* ── LOGISTICS ── */}
          <SectionLabel>Logistics</SectionLabel>
          <Row
            label="Runtime"
            valueA={<Link href="/browse/broadway-show-runtimes" className="text-gray-300 hover:text-brand transition-colors">{showA.runtime || 'TBD'}</Link>}
            valueB={<Link href="/browse/broadway-show-runtimes" className="text-gray-300 hover:text-brand transition-colors">{showB.runtime || 'TBD'}</Link>}
          />
          <Row
            label="Intermissions"
            valueA={showA.intermissions !== undefined ? showA.intermissions : 'TBD'}
            valueB={showB.intermissions !== undefined ? showB.intermissions : 'TBD'}
          />
          <Row
            label="Theater"
            valueA={showA.venue ? (theaterA ? <Link href={`/theater/${theaterA.slug}`} className="text-gray-300 hover:text-brand transition-colors border-b border-dashed border-white/20 hover:border-brand">{showA.venue}</Link> : showA.venue) : 'TBD'}
            valueB={showB.venue ? (theaterB ? <Link href={`/theater/${theaterB.slug}`} className="text-gray-300 hover:text-brand transition-colors border-b border-dashed border-white/20 hover:border-brand">{showB.venue}</Link> : showB.venue) : 'TBD'}
          />
          {(theaterA?.venueScores?.overall || theaterB?.venueScores?.overall) && (
            <Row
              label="Venue Score"
              valueA={theaterA?.venueScores?.overall ? <Link href={`/theater/${theaterA.slug}`} className="text-gray-300 hover:text-brand transition-colors">{theaterA.venueScores.overall} / 10</Link> : '—'}
              valueB={theaterB?.venueScores?.overall ? <Link href={`/theater/${theaterB.slug}`} className="text-gray-300 hover:text-brand transition-colors">{theaterB.venueScores.overall} / 10</Link> : '—'}
              winnerA={!!theaterA?.venueScores?.overall && !!theaterB?.venueScores?.overall && theaterA.venueScores.overall > theaterB.venueScores.overall}
              winnerB={!!theaterB?.venueScores?.overall && !!theaterA?.venueScores?.overall && theaterB.venueScores.overall > theaterA.venueScores.overall}
            />
          )}
          {(theaterA?.capacity || theaterB?.capacity) && (
            <Row
              label="Capacity"
              valueA={theaterA?.capacity ? <Link href={`/theater/${theaterA.slug}`} className="text-gray-300 hover:text-brand transition-colors">{theaterA.capacity.toLocaleString()} seats</Link> : '—'}
              valueB={theaterB?.capacity ? <Link href={`/theater/${theaterB.slug}`} className="text-gray-300 hover:text-brand transition-colors">{theaterB.capacity.toLocaleString()} seats</Link> : '—'}
            />
          )}

          {/* ── PRICING & DEALS ── */}
          <SectionLabel>Pricing & Deals</SectionLabel>
          <Row
            label="Tickets"
            valueA={sortedLinksA.length > 0 ? (
              <TicketLink showName={showA.title} showId={showA.id} showSlug={showA.slug} showStatus={showA.status} platform={sortedLinksA[0].platform} url={sortedLinksA[0].url} pageType="comparison" linkPosition={0} totalLinks={sortedLinksA.length} className="text-white font-semibold hover:text-brand transition-colors">
                <span className="text-gray-400 font-normal text-xs">{sortedLinksA[0].platform} from </span>{currencyA}{sortedLinksA[0].priceFrom ?? '—'}
              </TicketLink>
            ) : '—'}
            valueB={sortedLinksB.length > 0 ? (
              <TicketLink showName={showB.title} showId={showB.id} showSlug={showB.slug} showStatus={showB.status} platform={sortedLinksB[0].platform} url={sortedLinksB[0].url} pageType="comparison" linkPosition={0} totalLinks={sortedLinksB.length} className="text-white font-semibold hover:text-brand transition-colors">
                <span className="text-gray-400 font-normal text-xs">{sortedLinksB[0].platform} from </span>{currencyB}{sortedLinksB[0].priceFrom ?? '—'}
              </TicketLink>
            ) : '—'}
          />
          {(sortedLinksA.length > 1 || sortedLinksB.length > 1) && (
            <Row
              label="Buy From"
              valueA={
                <div className="flex flex-wrap justify-center gap-1">
                  {sortedLinksA.map((link, i) => (
                    <TicketLink key={i} showName={showA.title} showId={showA.id} showSlug={showA.slug} showStatus={showA.status} platform={link.platform} url={link.url} pageType="comparison" linkPosition={i} totalLinks={sortedLinksA.length} className="text-[11px] px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.08] text-gray-300 hover:text-white hover:bg-white/10 transition-colors">
                      {link.platform}
                    </TicketLink>
                  ))}
                </div>
              }
              valueB={
                <div className="flex flex-wrap justify-center gap-1">
                  {sortedLinksB.map((link, i) => (
                    <TicketLink key={i} showName={showB.title} showId={showB.id} showSlug={showB.slug} showStatus={showB.status} platform={link.platform} url={link.url} pageType="comparison" linkPosition={i} totalLinks={sortedLinksB.length} className="text-[11px] px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.08] text-gray-300 hover:text-white hover:bg-white/10 transition-colors">
                      {link.platform}
                    </TicketLink>
                  ))}
                </div>
              }
            />
          )}
          <Row
            label="Lottery"
            valueA={lotteryRushA ? <LotteryPill data={lotteryRushA} showSlug={showA.slug} /> : <span className="text-gray-500 text-xs">—</span>}
            valueB={lotteryRushB ? <LotteryPill data={lotteryRushB} showSlug={showB.slug} /> : <span className="text-gray-500 text-xs">—</span>}
          />
          <Row
            label="Rush"
            valueA={lotteryRushA ? <RushPill data={lotteryRushA} showSlug={showA.slug} /> : <span className="text-gray-500 text-xs">—</span>}
            valueB={lotteryRushB ? <RushPill data={lotteryRushB} showSlug={showB.slug} /> : <span className="text-gray-500 text-xs">—</span>}
          />

          {/* ── BOX OFFICE — THIS WEEK ── */}
          {(grossesA?.thisWeek || grossesB?.thisWeek) && (
            <>
              <SectionLabel>Box Office — This Week</SectionLabel>
              <Row
                label="Gross"
                valueA={grossesA?.thisWeek?.gross != null ? (
                  <Link href={`/show/${showA.slug}#box-office`} className="group">
                    <span className="text-white font-semibold group-hover:text-brand">{formatMoney(grossesA.thisWeek.gross, currency)}</span>
                    {grossesA.thisWeek.grossPrevWeek != null && (
                      <span className="block text-[11px] text-gray-500">{pctChange(grossesA.thisWeek.gross, grossesA.thisWeek.grossPrevWeek)} vs last week</span>
                    )}
                  </Link>
                ) : '—'}
                valueB={grossesB?.thisWeek?.gross != null ? (
                  <Link href={`/show/${showB.slug}#box-office`} className="group">
                    <span className="text-white font-semibold group-hover:text-brand">{formatMoney(grossesB.thisWeek.gross, currency)}</span>
                    {grossesB.thisWeek.grossPrevWeek != null && (
                      <span className="block text-[11px] text-gray-500">{pctChange(grossesB.thisWeek.gross, grossesB.thisWeek.grossPrevWeek)} vs last week</span>
                    )}
                  </Link>
                ) : '—'}
              />
              <Row
                label="Capacity"
                valueA={grossesA?.thisWeek?.capacity != null ? <Link href={`/show/${showA.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{grossesA.thisWeek.capacity.toFixed(1)}%</Link> : '—'}
                valueB={grossesB?.thisWeek?.capacity != null ? <Link href={`/show/${showB.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{grossesB.thisWeek.capacity.toFixed(1)}%</Link> : '—'}
                winnerA={grossesA?.thisWeek?.capacity != null && grossesB?.thisWeek?.capacity != null && grossesA.thisWeek.capacity > grossesB.thisWeek.capacity}
                winnerB={grossesB?.thisWeek?.capacity != null && grossesA?.thisWeek?.capacity != null && grossesB.thisWeek.capacity > grossesA.thisWeek.capacity}
              />
              <Row
                label="Avg Ticket"
                valueA={grossesA?.thisWeek?.atp != null ? <Link href={`/show/${showA.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{currency}{Math.round(grossesA.thisWeek.atp)}</Link> : '—'}
                valueB={grossesB?.thisWeek?.atp != null ? <Link href={`/show/${showB.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{currency}{Math.round(grossesB.thisWeek.atp)}</Link> : '—'}
              />
            </>
          )}

          {/* ── BOX OFFICE — ALL-TIME ── */}
          {(grossesA?.allTime || grossesB?.allTime) && (
            <>
              <SectionLabel>Box Office — All-Time</SectionLabel>
              <Row
                label="Total Gross"
                valueA={grossesA?.allTime?.gross != null ? (
                  <Link href={`/show/${showA.slug}#box-office`} className="text-white font-semibold hover:text-brand transition-colors">{formatMoney(grossesA.allTime.gross, currency)}</Link>
                ) : '—'}
                valueB={grossesB?.allTime?.gross != null ? (
                  <Link href={`/show/${showB.slug}#box-office`} className="text-white font-semibold hover:text-brand transition-colors">{formatMoney(grossesB.allTime.gross, currency)}</Link>
                ) : '—'}
              />
              <Row
                label="Performances"
                valueA={grossesA?.allTime?.performances != null ? <Link href={`/show/${showA.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{grossesA.allTime.performances.toLocaleString()}</Link> : '—'}
                valueB={grossesB?.allTime?.performances != null ? <Link href={`/show/${showB.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{grossesB.allTime.performances.toLocaleString()}</Link> : '—'}
              />
              {(grossesA?.allTime?.attendance != null || grossesB?.allTime?.attendance != null) && (
                <Row
                  label="Tickets Sold"
                  valueA={grossesA?.allTime?.attendance != null ? <Link href={`/show/${showA.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{formatNumber(grossesA.allTime.attendance)}</Link> : '—'}
                  valueB={grossesB?.allTime?.attendance != null ? <Link href={`/show/${showB.slug}#box-office`} className="text-gray-300 hover:text-brand transition-colors">{formatNumber(grossesB.allTime.attendance)}</Link> : '—'}
                />
              )}
            </>
          )}

          {/* ── CREATIVE TEAM ── */}
          {(directorA || directorB || bookA || bookB || musicA || musicB) && (
            <>
              <SectionLabel>Creative Team</SectionLabel>
              {(bookA || bookB) && (
                <Row
                  label={bookA?.role === 'Playwright' || bookB?.role === 'Playwright' ? 'Playwright' : 'Book'}
                  valueA={<CreativeLink member={bookA} roleSlug="playwrights" />}
                  valueB={<CreativeLink member={bookB} roleSlug="playwrights" />}
                />
              )}
              {(showA.type === 'musical' || showB.type === 'musical') && (musicA || musicB) && (
                <Row
                  label="Music"
                  valueA={<CreativeLink member={musicA} roleSlug="composers" />}
                  valueB={<CreativeLink member={musicB} roleSlug="composers" />}
                />
              )}
              {(directorA || directorB) && (
                <Row
                  label="Director"
                  valueA={<CreativeLink member={directorA} roleSlug="directors" />}
                  valueB={<CreativeLink member={directorB} roleSlug="directors" />}
                />
              )}
            </>
          )}
        </div>

        {/* Critics consensus — same 3-column grid */}
        <div className="card p-4 sm:p-6 mb-6">
          <div className="grid grid-cols-[80px_1fr_1fr] sm:grid-cols-[100px_1fr_1fr] gap-2">
            <div className="text-[13px] text-gray-400 font-medium pt-0.5">Critics Say</div>
            <div>
              <Link href={`/show/${showA.slug}`} className="font-bold text-white text-sm hover:text-brand transition-colors">{showA.title}</Link>
              <p className="text-gray-400 text-[13px] leading-relaxed mt-1">
                {consensusA || showA.synopsis || 'No critic consensus available.'}
              </p>
            </div>
            <div>
              <Link href={`/show/${showB.slug}`} className="font-bold text-white text-sm hover:text-brand transition-colors">{showB.title}</Link>
              <p className="text-gray-400 text-[13px] leading-relaxed mt-1">
                {consensusB || showB.synopsis || 'No critic consensus available.'}
              </p>
            </div>
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
            {gradeA && gradeB && gradeA.grade !== gradeB.grade && (
              <p>
                <strong className="text-white">Audiences say:</strong>{' '}
                {showA.title} earns {gradeA.grade === 'A+' || gradeA.grade === 'A' || gradeA.grade === 'A-' ? 'an' : 'a'} {gradeA.grade} ({gradeA.label}), while {showB.title} gets {gradeB.grade === 'A+' || gradeB.grade === 'A' || gradeB.grade === 'A-' ? 'an' : 'a'} {gradeB.grade} ({gradeB.label}).
              </p>
            )}
            {showA.type !== showB.type && (
              <p>
                <strong className="text-white">Different formats:</strong>{' '}
                {showA.title} is a {showA.type}, while {showB.title} is a {showB.type}.
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
                  ? `Both shows offer ${currency}${lotteryRushA.lottery.price} lottery tickets — enter both for better chances!`
                  : lotteryRushA?.lottery
                    ? `${showA.title} has a ${currency}${lotteryRushA.lottery.price} lottery for discounted tickets.`
                    : `${showB.title} has a ${currency}${lotteryRushB!.lottery!.price} lottery for discounted tickets.`}
              </p>
            )}
            <p className="pt-2 border-t border-white/10">
              <Link href={`/show/${scoreWinnerB ? showB.slug : showA.slug}`} className="text-brand hover:text-brand-hover font-medium">
                Learn more about {scoreWinnerB ? showB.title : showA.title} →
              </Link>
            </p>
          </div>
        </div>

        {/* Related Comparisons */}
        <div className="mt-8 pt-6 border-t border-white/10">
          <h3 className="font-bold text-white text-base mb-3">More Comparisons</h3>
          <div className="flex flex-wrap gap-2">
            <Link href="/browse/best-recent-shows" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Best Broadway Shows
            </Link>
            <Link href="/browse/best-broadway-musicals" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Best Musicals
            </Link>
            <Link href="/lotteries" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Lottery Tickets
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
