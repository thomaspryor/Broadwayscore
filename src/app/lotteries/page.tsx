import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getLotteryRush, getLotteryRushLastUpdated, ShowLotteryRush } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { ComputedShow } from '@/lib/engine';
import { LotteryTable } from '@/components/SortableLotteryRushTables';

export const metadata: Metadata = {
  title: 'Broadway Lottery Tickets - Win Cheap Broadway Tickets',
  description: 'Enter digital lotteries to win discounted Broadway tickets for $10-60. Hamilton, Wicked, Lion King, and more. Daily lottery entries for cheap Broadway seats.',
  alternates: {
    canonical: `${BASE_URL}/lotteries`,
  },
  openGraph: {
    title: 'Broadway Lottery Tickets - Win Cheap Seats',
    description: 'Enter digital lotteries for discounted Broadway tickets. Hamilton $10, Wicked $55, and many more shows offering lottery programs.',
    url: `${BASE_URL}/lotteries`,
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
      name: 'How do Broadway lotteries work?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Broadway lotteries are digital drawings for discounted tickets. You enter online (usually through apps like TodayTix, Broadway Direct, or the show\'s website) the day before or day of the performance. Winners are randomly selected and have a limited time to purchase their discounted tickets.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the cheapest way to get Broadway tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The cheapest Broadway tickets are through lotteries ($10-60) and rush tickets ($30-50). Hamilton\'s lottery offers $10 tickets, while most other shows range from $40-60. Rush tickets are first-come, first-served at the box office on the day of the show.',
      },
    },
    {
      '@type': 'Question',
      name: 'Which Broadway shows have lotteries?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Most popular Broadway shows offer digital lotteries including Hamilton ($10), Wicked ($55-65), The Lion King ($60), Hadestown ($49), Six ($45), and many more. Lottery tickets are typically for orchestra seats at a fraction of full price.',
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

interface LotteryShowCardProps {
  show: ComputedShow;
  lotteryData: ShowLotteryRush;
  index: number;
}

function LotteryShowCard({ show, lotteryData, index }: LotteryShowCardProps) {
  const score = show.criticScore?.score;
  const lottery = lotteryData.lottery;
  const specialLottery = lotteryData.specialLottery;

  // Get the best lottery price to display
  const lotteryPrice = specialLottery?.price || lottery?.price;
  const lotteryPlatform = specialLottery?.platform || lottery?.platform;

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
            alt=""
            aria-hidden="true"
            loading={index < 6 ? "eager" : "lazy"}
            className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300"
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

        {/* Lottery Badge - Prominent */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {lottery && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 font-semibold text-sm">
              <TicketIcon className="w-4 h-4" />
              ${lottery.price} Lottery
            </span>
          )}
          {specialLottery && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold text-sm">
              <TicketIcon className="w-4 h-4" />
              ${specialLottery.price} {specialLottery.name}
            </span>
          )}
        </div>

        {/* Lottery Details */}
        <div className="mt-2 text-sm text-gray-400">
          <p className="truncate">
            {lotteryPlatform && <span className="text-gray-300">{lotteryPlatform}</span>}
            {lottery?.time && <span className="text-gray-500"> · {lottery.time.split('.')[0]}</span>}
          </p>
        </div>

        {/* Additional options */}
        {(lotteryData.rush || lotteryData.digitalRush || lotteryData.studentRush || lotteryData.standingRoom) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(lotteryData.rush || lotteryData.digitalRush) && (
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                + Rush ${lotteryData.rush?.price || lotteryData.digitalRush?.price}
              </span>
            )}
            {lotteryData.studentRush && (
              <span className="text-xs px-2 py-0.5 rounded bg-pink-500/10 text-pink-400">
                + Student Rush ${lotteryData.studentRush.price}
              </span>
            )}
            {lotteryData.standingRoom && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-500/10 text-gray-400">
                + SRO ${lotteryData.standingRoom.price}
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

export default function LotteriesPage() {
  const allShows = getAllShows();
  const lastUpdated = getLotteryRushLastUpdated();

  // Get shows with lottery data, sorted by lottery price (cheapest first)
  const showsWithLottery = allShows
    .filter(show => show.status === 'open')
    .map(show => ({
      show,
      lotteryData: getLotteryRush(show.id),
    }))
    .filter(item => item.lotteryData?.lottery || item.lotteryData?.specialLottery)
    .sort((a, b) => {
      const priceA = a.lotteryData?.specialLottery?.price || a.lotteryData?.lottery?.price || 999;
      const priceB = b.lotteryData?.specialLottery?.price || b.lotteryData?.lottery?.price || 999;
      return priceA - priceB;
    });

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Lotteries', url: `${BASE_URL}/lotteries` },
  ]);

  // Stats
  const cheapestLottery = showsWithLottery[0];
  const avgPrice = showsWithLottery.reduce((sum, item) => {
    return sum + (item.lotteryData?.lottery?.price || item.lotteryData?.specialLottery?.price || 0);
  }, 0) / showsWithLottery.length;

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
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Lotteries</h1>
          <p className="text-gray-400 mt-2">
            Enter digital lotteries to win discounted Broadway tickets. Most lotteries are free to enter and offer orchestra seats at a fraction of full price.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithLottery.length} shows with lotteries · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-purple-400">
              ${cheapestLottery?.lotteryData?.specialLottery?.price || cheapestLottery?.lotteryData?.lottery?.price}
            </div>
            <div className="text-xs text-gray-500 mt-1">Cheapest Lottery</div>
            <div className="text-xs text-gray-400 truncate">{cheapestLottery?.show.title}</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{showsWithLottery.length}</div>
            <div className="text-xs text-gray-500 mt-1">Shows with Lotteries</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-gray-300">${Math.round(avgPrice)}</div>
            <div className="text-xs text-gray-500 mt-1">Avg Lottery Price</div>
          </div>
        </div>

        {/* How It Works */}
        <div className="card p-5 mb-8 bg-purple-500/5 border-purple-500/20">
          <h2 className="font-bold text-white mb-2">How Broadway Lotteries Work</h2>
          <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside">
            <li>Enter online through the show&apos;s lottery platform (usually free)</li>
            <li>Entries typically close the day before or morning of the show</li>
            <li>Winners are randomly selected and notified by email/app</li>
            <li>Winners have a limited time (30-60 min) to purchase tickets</li>
            <li>Pick up tickets at the box office with valid photo ID</li>
          </ol>
        </div>

        {/* Sortable Table */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">All Lotteries</h2>
          <LotteryTable data={showsWithLottery.map(item => ({ show: item.show, lotteryData: item.lotteryData! }))} />
        </div>

        {/* Detailed Show Cards */}
        <h2 className="text-lg font-bold text-white mb-3">Detailed View</h2>
        <div className="space-y-3">
          {showsWithLottery.map((item, index) => (
            <LotteryShowCard
              key={item.show.slug}
              show={item.show}
              lotteryData={item.lotteryData!}
              index={index}
            />
          ))}
        </div>

        {/* Related Links */}
        <div className="mt-8 pt-6 border-t border-white/5">
          <h2 className="text-lg font-bold text-white mb-3">More Ways to Save</h2>
          <div className="flex flex-wrap gap-3">
            <Link href="/rush" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Rush Tickets →
            </Link>
            <Link href="/browse/broadway-lottery-shows" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Browse Lottery Shows →
            </Link>
            <Link href="/browse/broadway-rush-tickets" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Browse Rush Shows →
            </Link>
          </div>
        </div>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Lottery information sourced from Playbill and official show websites.
            Prices and availability subject to change. Always verify details on the official lottery platform.
          </p>
        </div>
      </div>
    </>
  );
}
