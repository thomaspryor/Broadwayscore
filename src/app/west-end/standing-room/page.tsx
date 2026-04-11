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
import { StandingRoomTable } from '@/components/SortableLotteryRushTables';
import { DiscountTicketsNav } from '@/components/DiscountTicketsNav';
import { formatTicketPrice } from '@/lib/formatting';

export const metadata: Metadata = {
  title: { absolute: 'West End Standing Room Tickets — Sold-Out London Show Seats' },
  description:
    'Standing room tickets for sold-out West End shows. When a show sells out completely, standing places at the back of the stalls are the last resort.',
  alternates: {
    canonical: `${BASE_URL}/west-end/standing-room`,
  },
  openGraph: {
    title: 'West End Standing Room Only Tickets',
    description: 'The cheapest way to see a sold-out West End show — if a show sells out, standing places are the last resort.',
    url: `${BASE_URL}/west-end/standing-room`,
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
      name: 'What are West End standing room tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Standing room tickets (also called \u201Cstanding places\u201D) are heavily discounted West End tickets for sold-out shows. You stand at the back of the stalls or circle for the entire performance. Prices are typically \u00a310\u2013\u00a320.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do I buy West End standing room?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Go to the box office on the day of the performance (or occasionally in advance) and ask for a standing place. SRO is only released when a show is completely sold out. Limited quantity \u2014 arrive early for popular shows.',
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

interface SROShowCardProps {
  show: ComputedShow;
  sroData: ShowLotteryRush;
  index: number;
}

function SROShowCard({ show, sroData, index }: SROShowCardProps) {
  const score = show.criticScore?.score;
  const sro = sroData.standingRoom;
  if (!sro) return null;

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
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-500/15 border border-gray-500/30 text-gray-300 font-semibold text-sm">
            <TicketIcon className="w-4 h-4" />
            {formatTicketPrice(sro.price, 'west-end')} Standing Room
          </span>
        </div>

        <div className="mt-2 text-sm text-gray-400">
          {sro.time && <p>{sro.time}</p>}
          {sro.instructions && <p className="text-gray-500 mt-1">{sro.instructions}</p>}
        </div>

        {(sroData.lottery || sroData.rush) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {sroData.lottery && (
              <span className="text-xs px-2 py-0.5 rounded bg-purple-500/10 text-purple-400">
                + Lottery {formatTicketPrice(sroData.lottery.price, 'west-end')}
              </span>
            )}
            {sroData.rush && (
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                + Rush {formatTicketPrice(sroData.rush.price, 'west-end')}
              </span>
            )}
          </div>
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

export default function WestEndStandingRoomPage() {
  const allShows = getWestEndShows();
  const lastUpdated = getLotteryRushLastUpdated();

  const showsWithSRO = allShows
    .filter(show => show.status === 'open' || show.status === 'previews')
    .map(show => ({
      show,
      sroData: getLotteryRush(show.id),
    }))
    .filter(item => item.sroData?.standingRoom)
    .sort((a, b) => (a.sroData?.standingRoom?.price ?? 999) - (b.sroData?.standingRoom?.price ?? 999));

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
    { name: 'Standing Room', url: `${BASE_URL}/west-end/standing-room` },
  ]);

  const cheapestSRO = showsWithSRO.length > 0 ? showsWithSRO[0] : null;
  const avgPrice = showsWithSRO.length > 0
    ? Math.round(showsWithSRO.reduce((sum, item) => sum + (item.sroData?.standingRoom?.price ?? 0), 0) / showsWithSRO.length)
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
          <h1 className="text-3xl sm:text-4xl font-bold text-white">West End Standing Room Tickets</h1>
          <p className="text-gray-400 mt-2">
            When a West End show sells out, standing places let you see it from the back of the stalls or circle. The last resort for sold-out hits.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithSRO.length} shows with standing room · Updated {new Date(lastUpdated).toLocaleDateString('en-GB', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        <DiscountTicketsNav active="standing-room" market="west-end" />

        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-gray-300">{cheapestSRO ? formatTicketPrice(cheapestSRO.sroData?.standingRoom?.price, 'west-end') : '—'}</div>
            <div className="text-xs text-gray-500 mt-1">Cheapest SRO</div>
            <div className="text-xs text-gray-400 truncate">{cheapestSRO?.show.title ?? '—'}</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{showsWithSRO.length}</div>
            <div className="text-xs text-gray-500 mt-1">Shows with SRO</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-gray-400">{avgPrice !== null ? formatTicketPrice(avgPrice, 'west-end') : '—'}</div>
            <div className="text-xs text-gray-500 mt-1">Average Price</div>
          </div>
        </div>

        <div className="card p-5 mb-8 bg-gray-500/5 border-gray-500/20">
          <h2 className="font-bold text-white mb-2">How West End Standing Room Works</h2>
          <ul className="text-sm text-gray-400 space-y-2">
            <li className="flex gap-2">
              <span className="text-gray-500">1.</span>
              <span><strong className="text-gray-300">Only when sold out</strong> — Standing places are only released when every seat has been sold. No SRO if there are empty seats.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gray-500">2.</span>
              <span><strong className="text-gray-300">Day of the performance</strong> — Go to the box office when it opens (usually 10 AM) and ask if standing places are available.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gray-500">3.</span>
              <span><strong className="text-gray-300">Back of stalls or circle</strong> — You&apos;ll stand at a rail behind the last row. No sitting for the entire show.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gray-500">4.</span>
              <span><strong className="text-gray-300">Limited quantity</strong> — Usually 10–20 standing places per show. Arrive early for popular shows.</span>
            </li>
          </ul>
        </div>

        <div className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">All Standing Room</h2>
          {showsWithSRO.length > 0 ? (
            <StandingRoomTable
              data={showsWithSRO.map(item => ({ show: item.show, sroData: item.sroData! }))}
              market="west-end"
            />
          ) : (
            <p className="text-sm text-gray-500">No standing-room information in our database right now. Check with the venue directly if the show you want is sold out.</p>
          )}
        </div>

        {showsWithSRO.length > 0 && (
          <>
            <h2 className="text-lg font-bold text-white mb-3">Detailed View</h2>
            <div className="space-y-3">
              {showsWithSRO.map((item, index) => (
                <SROShowCard
                  key={item.show.slug}
                  show={item.show}
                  sroData={item.sroData!}
                  index={index}
                />
              ))}
            </div>
          </>
        )}

        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Standing room information is collected from official show websites and TodayTix.
            SRO availability depends on a show selling out completely. Always ring the box office to confirm before you travel.
          </p>
        </div>
      </div>
    </>
  );
}
