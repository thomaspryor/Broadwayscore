import Link from 'next/link';
import { Metadata } from 'next';
import { getWestEndShows } from '@/lib/data-core';
import { getLotteryRush, getLotteryRushLastUpdated } from '@/lib/data-lottery';
import type { ShowLotteryRush } from '@/lib/data-types';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { getMarketLabel } from '@/lib/venue-classification';
import { ComputedShow } from '@/lib/engine';
import { ScoreBadge } from '@/components/show-cards';
import { DiscountTicketsNav } from '@/components/DiscountTicketsNav';
import { BestValueTable, type BestValueRow } from '../../best-value/BestValueTable';
import { formatTicketPrice } from '@/lib/formatting';

export const metadata: Metadata = {
  title: { absolute: 'Best Value West End Tickets — Cheapest Ways to See London Shows' },
  description:
    'Find the cheapest West End tickets. Compare lotteries, day seats, rush, student standby, and standing room prices for every London show. Sorted by lowest price.',
  alternates: {
    canonical: `${BASE_URL}/west-end/best-value`,
  },
  openGraph: {
    title: 'Best Value West End Tickets',
    description:
      'Compare every discount option for West End shows, sorted by cheapest price.',
    url: `${BASE_URL}/west-end/best-value`,
    type: 'article',
    siteName: 'West End Scorecard',
    images: [{ url: `${BASE_URL}/og/west-end.png`, width: 1200, height: 630 }],
  },
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the cheapest way to see a West End show?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The cheapest West End tickets come from lotteries (\u00a315\u2013\u00a330), day seats at the box office (\u00a320\u2013\u00a340), and standing room (\u00a310\u2013\u00a320 for sold-out shows). Prices vary by show and availability changes daily.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where can I compare West End discount ticket prices?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'This page lists every discount ticket option \u2014 lottery, rush, day seats, student standby, and standing room \u2014 for every West End show in our database, sorted by cheapest price.',
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

interface DiscountOption {
  type: 'lottery' | 'special-lottery' | 'rush' | 'digital-rush' | 'student-rush' | 'sro';
  price: number;
  label: string;
  color: string;
  bgColor: string;
}

function getDiscountOptions(data: ShowLotteryRush): DiscountOption[] {
  const options: DiscountOption[] = [];

  if (data.specialLottery) {
    options.push({
      type: 'special-lottery',
      price: data.specialLottery.price,
      label: data.specialLottery.name,
      color: 'text-amber-300',
      bgColor: 'bg-amber-500/15 border-amber-500/30',
    });
  }
  if (data.lottery) {
    options.push({
      type: 'lottery',
      price: data.lottery.price,
      label: 'Lottery',
      color: 'text-purple-300',
      bgColor: 'bg-purple-500/15 border-purple-500/30',
    });
  }
  if (data.studentRush) {
    options.push({
      type: 'student-rush',
      price: data.studentRush.price,
      label: 'Student Standby',
      color: 'text-pink-300',
      bgColor: 'bg-pink-500/15 border-pink-500/30',
    });
  }
  if (data.rush) {
    options.push({
      type: 'rush',
      price: data.rush.price,
      label: 'Day Seat',
      color: 'text-emerald-300',
      bgColor: 'bg-emerald-500/15 border-emerald-500/30',
    });
  }
  if (data.digitalRush) {
    options.push({
      type: 'digital-rush',
      price: data.digitalRush.price,
      label: 'Digital Rush',
      color: 'text-blue-300',
      bgColor: 'bg-blue-500/15 border-blue-500/30',
    });
  }
  if (data.standingRoom) {
    options.push({
      type: 'sro',
      price: data.standingRoom.price,
      label: 'Standing Room',
      color: 'text-gray-300',
      bgColor: 'bg-gray-500/15 border-gray-500/30',
    });
  }

  return options.sort((a, b) => a.price - b.price);
}

interface ValueShowCardProps {
  show: ComputedShow;
  discountData: ShowLotteryRush;
  cheapestPrice: number;
  index: number;
}

function ValueShowCard({ show, discountData, index }: ValueShowCardProps) {
  const score = show.criticScore?.score;
  const options = getDiscountOptions(discountData);
  const cheapest = options[0];

  return (
    <Link
      href={`/show/${show.slug}`}
      className="group card-interactive flex flex-col sm:flex-row gap-4 p-4 animate-in"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <div className="flex-shrink-0 w-full sm:w-28 h-40 sm:h-28 rounded-lg overflow-hidden bg-surface-overlay">
        {show.images?.thumbnail ? (
          <img
            src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
            alt={`${show.title} ${getMarketLabel(show.category)} ${show.type}`}
            loading={index < 6 ? 'eager' : 'lazy'}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <div className="text-3xl">🎭</div>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors">
          {show.title}
        </h3>

        <div className="flex flex-wrap items-center gap-2 mt-2">
          {options.map((option, i) => (
            <span
              key={option.type}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-sm font-medium ${option.bgColor} ${option.color} ${i === 0 ? 'ring-1 ring-white/20' : ''}`}
            >
              {formatTicketPrice(option.price, 'west-end')} {option.label}
            </span>
          ))}
        </div>

        {cheapest && (
          <p className="text-xs text-gray-500 mt-2">
            Best deal: <span className={cheapest.color}>{formatTicketPrice(cheapest.price, 'west-end')} {cheapest.label}</span>
          </p>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center justify-center sm:flex-col sm:items-center gap-2 sm:w-20">
        <ScoreBadge score={score} size="md" showCrown />
        <span className="text-xs text-gray-500 hidden sm:block">
          {show.criticScore?.reviewCount || 0} reviews
        </span>
      </div>
    </Link>
  );
}

export default function WestEndBestValuePage() {
  const allShows = getWestEndShows();
  const lastUpdated = getLotteryRushLastUpdated();

  const showsWithDiscounts = allShows
    .filter(show => show.status === 'open' || show.status === 'previews')
    .map(show => {
      const discountData = getLotteryRush(show.id);
      if (!discountData) return null;

      const options = getDiscountOptions(discountData);
      if (options.length === 0) return null;

      const cheapestPrice = options[0].price;

      return {
        show,
        discountData,
        cheapestPrice,
        optionCount: options.length,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.cheapestPrice - b.cheapestPrice);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
    { name: 'Best Value', url: `${BASE_URL}/west-end/best-value` },
  ]);

  const cheapestShow = showsWithDiscounts[0];
  const avgCheapestPrice = showsWithDiscounts.length > 0
    ? Math.round(showsWithDiscounts.reduce((sum, item) => sum + item.cheapestPrice, 0) / showsWithDiscounts.length)
    : 0;
  const multiOptionShows = showsWithDiscounts.filter(item => item.optionCount >= 3).length;

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
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Best Value West End Tickets</h1>
          <p className="text-gray-400 mt-2">
            Every discount ticket option for every show, sorted by cheapest price. Compare lotteries, day seats, rush, student standby, and standing room.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithDiscounts.length} shows with discount tickets · Updated {new Date(lastUpdated).toLocaleDateString('en-GB', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        <DiscountTicketsNav active="best-value" market="west-end" />

        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-emerald-400">{formatTicketPrice(cheapestShow?.cheapestPrice, 'west-end')}</div>
            <div className="text-xs text-gray-500 mt-1">Cheapest Ticket</div>
            <div className="text-xs text-gray-400 truncate">{cheapestShow?.show.title ?? '—'}</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{formatTicketPrice(avgCheapestPrice, 'west-end')}</div>
            <div className="text-xs text-gray-500 mt-1">Avg Cheapest Price</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-purple-400">{multiOptionShows}</div>
            <div className="text-xs text-gray-500 mt-1">Shows with 3+ Options</div>
          </div>
        </div>

        {/* Legend */}
        <div className="card p-4 mb-8">
          <h2 className="font-bold text-white mb-3 text-sm">Discount Types</h2>
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-purple-500/15 text-purple-300">
              Lottery — Digital entry, random draw
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 text-emerald-300">
              Day Seat — First-come at the box office
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-500/15 text-blue-300">
              Digital Rush — Rush via TodayTix/apps
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-pink-500/15 text-pink-300">
              Student Standby — Student ID required
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-500/15 text-gray-300">
              Standing Room — Sold-out shows only
            </span>
          </div>
        </div>

        {/* Sortable Table */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">All Shows by Price</h2>
          {showsWithDiscounts.length > 0 ? (
            <BestValueTable
              rows={showsWithDiscounts.map(item => {
                const options = getDiscountOptions(item.discountData);
                const best = options[0];
                return {
                  slug: item.show.slug,
                  title: item.show.title,
                  score: item.show.criticScore?.score ?? null,
                  bestPrice: item.cheapestPrice,
                  bestType: best?.label ?? '',
                  bestColor: best?.color ?? 'text-gray-300',
                  bestBgColor: best?.bgColor ?? 'bg-gray-500/15 border-gray-500/30',
                  optionCount: item.optionCount,
                  allOptions: options.map(o => ({ price: o.price, label: o.label, color: o.color, bgColor: o.bgColor })),
                } satisfies BestValueRow;
              })}
              market="west-end"
            />
          ) : (
            <p className="text-sm text-gray-500">No discount information in our database right now.</p>
          )}
        </div>

        {/* Detailed View */}
        {showsWithDiscounts.length > 0 && (
          <>
            <h2 className="text-lg font-bold text-white mb-3">Detailed View</h2>
            <div className="space-y-3">
              {showsWithDiscounts.map((item, index) => (
                <ValueShowCard
                  key={item.show.slug}
                  show={item.show}
                  discountData={item.discountData}
                  cheapestPrice={item.cheapestPrice}
                  index={index}
                />
              ))}
            </div>
          </>
        )}

        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Discount ticket information is sourced from TodayTix and official show websites.
            Prices and availability change frequently. Always verify with the official source.
          </p>
        </div>
      </div>
    </>
  );
}
