import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getLotteryRush, getLotteryRushLastUpdated, ShowLotteryRush } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { ComputedShow } from '@/lib/engine';
import { RushTable } from '@/components/SortableLotteryRushTables';

export const metadata: Metadata = {
  title: 'Broadway Rush Tickets - Same-Day Discount Tickets',
  description: 'Get same-day Broadway rush tickets for $30-50. First-come, first-served at the box office or through digital rush apps. Updated daily.',
  alternates: {
    canonical: `${BASE_URL}/rush`,
  },
  openGraph: {
    title: 'Broadway Rush Tickets - Same-Day Deals',
    description: 'Same-day rush tickets for Broadway shows. Arrive early at the box office or use digital rush apps for discounted seats.',
    url: `${BASE_URL}/rush`,
    type: 'article',
  },
};

// FAQ Schema for AI optimization
const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What are Broadway rush tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Rush tickets are same-day discounted Broadway tickets sold at the box office when it opens (usually 10 AM) or through digital apps like TodayTix. They\'re first-come, first-served and typically cost $30-50. Unlike lotteries, rush tickets guarantee you get a seat if you arrive early enough.',
      },
    },
    {
      '@type': 'Question',
      name: 'What time do Broadway rush tickets go on sale?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Most Broadway box offices open at 10 AM Monday-Saturday and 12 PM on Sundays. Digital rush through apps like TodayTix typically releases at 9 AM. For popular shows, people line up 1-2 hours before the box office opens.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the difference between rush and lottery tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Rush tickets are first-come, first-served - if you arrive early enough, you\'re guaranteed a ticket. Lottery tickets are randomly drawn from all entries, so winning is based on luck. Rush requires showing up in person (or being fast online), while lotteries let you enter in advance.',
      },
    },
  ],
};

function TicketIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-4 h-4"} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

function LocationIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

interface RushShowCardProps {
  show: ComputedShow;
  rushData: ShowLotteryRush;
  index: number;
}

function RushShowCard({ show, rushData, index }: RushShowCardProps) {
  const score = show.criticScore?.score;
  const rush = rushData.rush;
  const digitalRush = rushData.digitalRush;
  const studentRush = rushData.studentRush;

  // Get the cheapest rush price to display prominently
  const rushOptions = [rush, digitalRush, studentRush].filter(Boolean);
  const cheapestRush = rushOptions.sort((a, b) => (a?.price || 999) - (b?.price || 999))[0];

  return (
    <Link
      href={`/show/${show.slug}`}
      className="group card-interactive flex flex-col sm:flex-row gap-4 p-4 animate-in"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Thumbnail */}
      <div className="flex-shrink-0 w-full sm:w-28 h-40 sm:h-28 rounded-lg overflow-hidden bg-surface-overlay">
        {show.images?.thumbnail ? (
          <img
            src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
            alt={`${show.title} Broadway ${show.type}`}
            loading={index < 6 ? "eager" : "lazy"}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <div className="text-3xl">🎭</div>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors">
          {show.title}
        </h3>

        {/* Rush Badges - Prominent */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {rush && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold text-sm">
              <TicketIcon className="w-4 h-4" />
              ${rush.price} Rush
            </span>
          )}
          {digitalRush && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-300 font-semibold text-sm">
              <TicketIcon className="w-4 h-4" />
              ${digitalRush.price} Digital Rush
            </span>
          )}
          {studentRush && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pink-500/15 border border-pink-500/30 text-pink-300 font-semibold text-sm">
              <TicketIcon className="w-4 h-4" />
              ${studentRush.price} Student Rush
            </span>
          )}
        </div>

        {/* Rush Details */}
        <div className="mt-2 text-sm text-gray-400 space-y-1">
          {rush && (
            <p className="flex items-start gap-1.5">
              <LocationIcon />
              <span className="truncate">{rush.location || 'Box office'} · {rush.time?.split(',')[0]}</span>
            </p>
          )}
          {digitalRush && !rush && (
            <p className="truncate">
              <span className="text-gray-300">{digitalRush.platform}</span>
              <span className="text-gray-500"> · {digitalRush.time}</span>
            </p>
          )}
        </div>

        {/* Additional options */}
        {(rushData.lottery || rushData.standingRoom) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {rushData.lottery && (
              <span className="text-xs px-2 py-0.5 rounded bg-purple-500/10 text-purple-400">
                + Lottery ${rushData.lottery.price}
              </span>
            )}
            {rushData.standingRoom && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-500/10 text-gray-400">
                + SRO ${rushData.standingRoom.price}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Score Badge */}
      <div className="flex-shrink-0 flex items-center justify-center sm:flex-col sm:items-center gap-2 sm:w-20">
        <div className={`w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center text-lg sm:text-xl font-bold ${
          score === undefined || score === null ? 'bg-surface-overlay text-gray-400' :
          score >= 85 ? 'score-must-see' :
          score >= 75 ? 'score-great' :
          score >= 65 ? 'score-good' :
          score >= 55 ? 'score-tepid' :
          'score-skip'
        }`}>
          {score !== undefined && score !== null ? Math.round(score) : '—'}
        </div>
        <span className="text-xs text-gray-500 hidden sm:block">
          {show.criticScore?.reviewCount || 0} reviews
        </span>
      </div>
    </Link>
  );
}

export default function RushPage() {
  const allShows = getAllShows();
  const lastUpdated = getLotteryRushLastUpdated();

  // Get shows with rush data, sorted by rush price (cheapest first)
  const showsWithRush = allShows
    .filter(show => show.status === 'open')
    .map(show => ({
      show,
      rushData: getLotteryRush(show.id),
    }))
    .filter(item => item.rushData?.rush || item.rushData?.digitalRush || item.rushData?.studentRush)
    .sort((a, b) => {
      const priceA = Math.min(
        a.rushData?.rush?.price || 999,
        a.rushData?.digitalRush?.price || 999,
        a.rushData?.studentRush?.price || 999
      );
      const priceB = Math.min(
        b.rushData?.rush?.price || 999,
        b.rushData?.digitalRush?.price || 999,
        b.rushData?.studentRush?.price || 999
      );
      return priceA - priceB;
    });

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Rush Tickets', url: `${BASE_URL}/rush` },
  ]);

  // Stats
  const cheapestRush = showsWithRush[0];
  const cheapestPrice = Math.min(
    cheapestRush?.rushData?.rush?.price || 999,
    cheapestRush?.rushData?.digitalRush?.price || 999,
    cheapestRush?.rushData?.studentRush?.price || 999
  );

  const boxOfficeRushCount = showsWithRush.filter(item => item.rushData?.rush?.type === 'general').length;
  const digitalRushCount = showsWithRush.filter(item => item.rushData?.digitalRush || item.rushData?.rush?.type === 'digital').length;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Rush Tickets</h1>
          <p className="text-gray-400 mt-2">
            Same-day discounted tickets available at the box office or through digital apps. First-come, first-served means if you arrive early, you&apos;re guaranteed a seat.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithRush.length} shows with rush tickets · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-emerald-400">${cheapestPrice}</div>
            <div className="text-xs text-gray-500 mt-1">Cheapest Rush</div>
            <div className="text-xs text-gray-400 truncate">{cheapestRush?.show.title}</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{boxOfficeRushCount}</div>
            <div className="text-xs text-gray-500 mt-1">Box Office Rush</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-blue-400">{digitalRushCount}</div>
            <div className="text-xs text-gray-500 mt-1">Digital Rush</div>
          </div>
        </div>

        {/* How It Works */}
        <div className="card p-5 mb-8 bg-emerald-500/5 border-emerald-500/20">
          <h2 className="font-bold text-white mb-2">How Broadway Rush Tickets Work</h2>
          <div className="grid sm:grid-cols-2 gap-4 text-sm text-gray-400">
            <div>
              <h3 className="font-semibold text-emerald-300 mb-1">Box Office Rush</h3>
              <ul className="space-y-1 list-disc list-inside">
                <li>Arrive at box office when it opens (10 AM or 12 PM)</li>
                <li>First-come, first-served - line up early!</li>
                <li>Usually limited to 2 tickets per person</li>
                <li>Cash or credit card accepted</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-blue-300 mb-1">Digital Rush</h3>
              <ul className="space-y-1 list-disc list-inside">
                <li>Opens at 9 AM on apps like TodayTix</li>
                <li>Be ready to purchase immediately when tickets drop</li>
                <li>Tickets sell out quickly for popular shows</li>
                <li>E-tickets sent directly to your phone</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Sortable Table */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">All Rush Tickets</h2>
          <RushTable data={showsWithRush.map(item => ({ show: item.show, rushData: item.rushData! }))} />
        </div>

        {/* Detailed Show Cards */}
        <h2 className="text-lg font-bold text-white mb-3">Detailed View</h2>
        <div className="space-y-3">
          {showsWithRush.map((item, index) => (
            <RushShowCard
              key={item.show.slug}
              show={item.show}
              rushData={item.rushData!}
              index={index}
            />
          ))}
        </div>

        {/* Related Links */}
        <div className="mt-8 pt-6 border-t border-white/5">
          <h2 className="text-lg font-bold text-white mb-3">More Ways to Save</h2>
          <div className="flex flex-wrap gap-3">
            <Link href="/lotteries" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Lottery Tickets →
            </Link>
            <Link href="/browse/broadway-rush-tickets" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Browse Rush Shows →
            </Link>
            <Link href="/browse/broadway-lottery-shows" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Browse Lottery Shows →
            </Link>
          </div>
        </div>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Rush ticket information sourced from Playbill and official show websites.
            Prices and availability subject to change. Verify details at the box office or official platform.
          </p>
        </div>
      </div>
    </>
  );
}
