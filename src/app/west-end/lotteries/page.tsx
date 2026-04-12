import Link from 'next/link';
import { Metadata } from 'next';
import { getWestEndShows } from '@/lib/data-core';
import { getLotteryRush, getLotteryRushLastUpdated } from '@/lib/data-lottery';
import type { ShowLotteryRush } from '@/lib/data-types';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { getMarketLabel } from '@/lib/venue-classification';
import { ComputedShow } from '@/lib/engine';
import { LotteryTable } from '@/components/SortableLotteryRushTables';
import { ScoreBadge } from '@/components/show-cards';
import { DiscountTicketsNav } from '@/components/DiscountTicketsNav';
import { formatTicketPrice } from '@/lib/formatting';

export const metadata: Metadata = {
  title: { absolute: 'West End Lottery Tickets — Win Cheap London Theatre Tickets' },
  description:
    'Enter digital lotteries to win discounted West End tickets. Check lottery prices, platforms, and entry times for every London show that runs one. Updated regularly.',
  alternates: {
    canonical: `${BASE_URL}/west-end/lotteries`,
  },
  openGraph: {
    title: 'West End Lottery Tickets — Win Cheap London Theatre Seats',
    description:
      'Enter digital lotteries for discounted West End tickets across the biggest London musicals and plays.',
    url: `${BASE_URL}/west-end/lotteries`,
    type: 'article',
    siteName: 'West End Scorecard',
    images: [{ url: `${BASE_URL}/og/west-end.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'West End Lottery Tickets',
    description:
      'Enter digital lotteries for discounted West End tickets across the biggest London musicals and plays.',
    images: [`${BASE_URL}/og/west-end.png`],
  },
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'How do West End lotteries work?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'West End lotteries are digital drawings for discounted tickets. You enter online through apps like TodayTix, Lottoland, or the show\u2019s website \u2014 usually the day before or the morning of the performance. Winners are picked at random and have a limited time to pay for their discounted seats.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the cheapest way to get West End tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The cheapest West End tickets are typically lottery and rush tickets. Lottery prices usually sit between \u00a315\u2013\u00a330, while rush tickets are \u00a320\u2013\u00a340. Day seats at the box office are another option for sold-out shows.',
      },
    },
    {
      '@type': 'Question',
      name: 'Which West End shows have lotteries?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Many popular West End shows offer lotteries, often via TodayTix. Availability changes week to week \u2014 check our list for the current running shows and their lottery details.',
      },
    },
  ],
};

function TicketIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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

  const lotteryPrice = specialLottery?.price || lottery?.price;
  const lotteryPlatform = specialLottery?.platform || lottery?.platform;

  return (
    <Link
      href={`/show/${show.slug}`}
      className="group card-interactive flex flex-row gap-4 p-4 animate-in"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <div className="relative flex-shrink-0 w-24 sm:w-28 aspect-[2/3] sm:aspect-square sm:h-28 rounded-lg overflow-hidden bg-surface-overlay">
        {(show.images?.poster || show.images?.thumbnail) ? (
          <img
            src={getOptimizedImageUrl((show.images.poster || show.images.thumbnail)!, 'thumbnail')}
            alt={`${show.title} ${getMarketLabel(show.category)} ${show.type}`}
            loading={index < 6 ? 'eager' : 'lazy'}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <div className="text-3xl">🎭</div>
          </div>
        )}
        <div className="absolute bottom-1.5 right-1.5 sm:hidden">
          <ScoreBadge score={score} size="sm" showCrown />
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors">
          {show.title}
        </h3>

        <div className="flex flex-wrap items-center gap-2 mt-2">
          {lottery && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 font-semibold text-sm">
              <TicketIcon className="w-4 h-4" />
              {formatTicketPrice(lottery.price, 'west-end')} Lottery
            </span>
          )}
          {specialLottery && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold text-sm">
              <TicketIcon className="w-4 h-4" />
              {formatTicketPrice(specialLottery.price, 'west-end')} {specialLottery.name}
            </span>
          )}
        </div>

        <div className="mt-2 text-sm text-gray-400">
          <p className="truncate">
            {lotteryPlatform && <span className="text-gray-300">{lotteryPlatform}</span>}
            {lottery?.time && <span className="text-gray-500"> · {lottery.time.split('.')[0]}</span>}
          </p>
        </div>

        {(lotteryData.rush || lotteryData.digitalRush || lotteryData.studentRush || lotteryData.standingRoom) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(lotteryData.rush || lotteryData.digitalRush) && (
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                + Rush {formatTicketPrice(lotteryData.rush?.price ?? lotteryData.digitalRush?.price, 'west-end')}
              </span>
            )}
            {lotteryData.studentRush && (
              <span className="text-xs px-2 py-0.5 rounded bg-pink-500/10 text-pink-400">
                + Student Rush {formatTicketPrice(lotteryData.studentRush.price, 'west-end')}
              </span>
            )}
            {lotteryData.standingRoom && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-500/10 text-gray-400">
                + SRO {formatTicketPrice(lotteryData.standingRoom.price, 'west-end')}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 hidden sm:flex flex-col items-center justify-center gap-2 w-20">
        <ScoreBadge score={score} size="md" showCrown />
        <span className="text-xs text-gray-500">
          {show.criticScore?.reviewCount || 0} reviews
        </span>
      </div>
    </Link>
  );
}

export default function WestEndLotteriesPage() {
  const allShows = getWestEndShows();
  const lastUpdated = getLotteryRushLastUpdated();

  const showsWithLottery = allShows
    .filter(show => show.status === 'open' || show.status === 'previews')
    .map(show => ({
      show,
      lotteryData: getLotteryRush(show.id),
    }))
    .filter(item => item.lotteryData?.lottery || item.lotteryData?.specialLottery)
    .sort((a, b) => {
      const priceA = a.lotteryData?.specialLottery?.price ?? a.lotteryData?.lottery?.price ?? 999;
      const priceB = b.lotteryData?.specialLottery?.price ?? b.lotteryData?.lottery?.price ?? 999;
      return priceA - priceB;
    });

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
    { name: 'Lotteries', url: `${BASE_URL}/west-end/lotteries` },
  ]);

  const cheapestLottery = showsWithLottery.length > 0 ? showsWithLottery[0] : null;
  const avgPrice = showsWithLottery.length > 0
    ? showsWithLottery.reduce((sum, item) => {
        return sum + (item.lotteryData?.specialLottery?.price ?? item.lotteryData?.lottery?.price ?? 0);
      }, 0) / showsWithLottery.length
    : null;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/west-end" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All West End Shows
        </Link>

        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">West End Lotteries</h1>
          <p className="text-gray-400 mt-2">
            Enter digital lotteries to win discounted West End tickets. Most lotteries are free to enter and offer seats for a fraction of full price.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithLottery.length} shows with lotteries · Updated {new Date(lastUpdated).toLocaleDateString('en-GB', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        <DiscountTicketsNav active="lotteries" market="west-end" />

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-purple-400">
              {cheapestLottery
                ? formatTicketPrice(
                    cheapestLottery.lotteryData?.specialLottery?.price ??
                      cheapestLottery.lotteryData?.lottery?.price,
                    'west-end'
                  )
                : '—'}
            </div>
            <div className="text-xs text-gray-500 mt-1">Cheapest Lottery</div>
            <div className="text-xs text-gray-400 truncate">{cheapestLottery?.show.title ?? '—'}</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{showsWithLottery.length}</div>
            <div className="text-xs text-gray-500 mt-1">Shows with Lotteries</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-gray-300">
              {avgPrice !== null ? formatTicketPrice(Math.round(avgPrice), 'west-end') : '—'}
            </div>
            <div className="text-xs text-gray-500 mt-1">Avg Lottery Price</div>
          </div>
        </div>

        {/* How It Works */}
        <div className="card p-5 mb-8 bg-purple-500/5 border-purple-500/20">
          <h2 className="font-bold text-white mb-2">How West End Lotteries Work</h2>
          <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside">
            <li>Enter online through the show&apos;s lottery platform (usually free)</li>
            <li>Entries typically close the day before or morning of the show</li>
            <li>Winners are randomly selected and notified by email or app push</li>
            <li>Winners have a limited time (30–60 min) to pay for their tickets</li>
            <li>Collect tickets at the box office with a valid photo ID</li>
          </ol>
        </div>

        {/* Sortable Table */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">All Lotteries</h2>
          {showsWithLottery.length > 0 ? (
            <LotteryTable
              data={showsWithLottery.map(item => ({ show: item.show, lotteryData: item.lotteryData! }))}
              market="west-end"
            />
          ) : (
            <p className="text-sm text-gray-500">No lotteries running right now. Check back during the week — new lotteries open and close frequently.</p>
          )}
        </div>

        {/* Detailed Show Cards */}
        {showsWithLottery.length > 0 && (
          <>
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
          </>
        )}

        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Lottery information sourced from TodayTix and official show websites.
            Prices and availability subject to change. Always verify details on the official lottery platform.
          </p>
        </div>
      </div>
    </>
  );
}
