import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
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
  title: 'Broadway Standing Room Only (SRO) Tickets',
  description: 'Standing room tickets for sold-out Broadway shows. When a show is sold out, SRO tickets let you see it from the back of the orchestra for $35-50.',
  alternates: {
    canonical: `${BASE_URL}/standing-room`,
  },
  openGraph: {
    title: 'Broadway Standing Room Only Tickets',
    description: 'Can\'t get seats? Standing room tickets are available when Broadway shows sell out. Usually $35-50 at the back of the orchestra.',
    url: `${BASE_URL}/standing-room`,
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
      name: 'What are Broadway standing room only tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Standing room only (SRO) tickets are sold when a Broadway show is completely sold out. You stand at the back of the orchestra section for the entire show. They\'re typically $35-50 and available at the box office on the day of the performance.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do I get Broadway standing room tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'SRO tickets are only sold when a show is sold out. Go to the box office when it opens (usually 10 AM) and ask if standing room is available. If the show isn\'t sold out, SRO tickets won\'t be offered.',
      },
    },
    {
      '@type': 'Question',
      name: 'Are standing room tickets worth it?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'For sold-out hit shows like Hamilton or Wicked, standing room is often the only affordable option. At $35-50 for a 2-3 hour show, it\'s a good deal if you\'re comfortable standing. Not recommended for long shows or those with mobility issues.',
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
      className="group card-interactive flex flex-col sm:flex-row gap-4 p-4 animate-in"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Thumbnail */}
      <div className="flex-shrink-0 w-full sm:w-28 h-40 sm:h-28 rounded-lg overflow-hidden bg-surface-overlay">
        {show.images?.thumbnail ? (
          <img
            src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
            alt={`${show.title} ${getMarketLabel(show.category)} ${show.type}`}
            loading={index < 6 ? "eager" : "lazy"}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <div className="text-3xl">🎭</div>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors">
          {show.title}
        </h3>

        {/* SRO Badge */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-500/15 border border-gray-500/30 text-gray-300 font-semibold text-sm">
            <TicketIcon className="w-4 h-4" />
            {formatTicketPrice(sro.price, 'broadway')} Standing Room
          </span>
        </div>

        {/* SRO Details */}
        <div className="mt-2 text-sm text-gray-400">
          <p>{sro.time}</p>
          <p className="text-gray-500 mt-1">{sro.instructions}</p>
        </div>

        {/* Other options */}
        {(sroData.lottery || sroData.rush) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {sroData.lottery && (
              <span className="text-xs px-2 py-0.5 rounded bg-purple-500/10 text-purple-400">
                + Lottery {formatTicketPrice(sroData.lottery.price, 'broadway')}
              </span>
            )}
            {sroData.rush && (
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                + Rush {formatTicketPrice(sroData.rush.price, 'broadway')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Score Badge */}
      <div className="flex-shrink-0 flex items-center justify-center sm:flex-col sm:items-center gap-2 sm:w-20">
        <ScoreBadge score={score} size="md" showCrown />
        <span className="text-xs text-gray-500 hidden sm:block">
          {show.criticScore?.reviewCount || 0} reviews
        </span>
      </div>
    </Link>
  );
}

export default function StandingRoomPage() {
  const allShows = getBroadwayShows();
  const lastUpdated = getLotteryRushLastUpdated();

  // Get shows with SRO data, sorted by price (cheapest first)
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
    { name: 'Standing Room', url: `${BASE_URL}/standing-room` },
  ]);

  // Stats
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
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Standing Room Only Tickets</h1>
          <p className="text-gray-400 mt-2">
            When a Broadway show sells out, standing room tickets let you see it from the back of the orchestra. The last resort for sold-out hits.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithSRO.length} shows with SRO · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        <DiscountTicketsNav active="standing-room" />

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-gray-300">{cheapestSRO ? formatTicketPrice(cheapestSRO.sroData?.standingRoom?.price, 'broadway') : '—'}</div>
            <div className="text-xs text-gray-500 mt-1">Cheapest SRO</div>
            <div className="text-xs text-gray-400 truncate">{cheapestSRO?.show.title ?? '—'}</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{showsWithSRO.length}</div>
            <div className="text-xs text-gray-500 mt-1">Shows with SRO</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-gray-400">{avgPrice !== null ? formatTicketPrice(avgPrice, 'broadway') : '—'}</div>
            <div className="text-xs text-gray-500 mt-1">Average Price</div>
          </div>
        </div>

        {/* How It Works */}
        <div className="card p-5 mb-8 bg-gray-500/5 border-gray-500/20">
          <h2 className="font-bold text-white mb-2">How Standing Room Works</h2>
          <ul className="text-sm text-gray-400 space-y-2">
            <li className="flex gap-2">
              <span className="text-gray-500">1.</span>
              <span><strong className="text-gray-300">Only when sold out</strong> — SRO tickets are only available when all seats are sold. If there are empty seats, no standing room.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gray-500">2.</span>
              <span><strong className="text-gray-300">Day of show</strong> — Go to the box office when it opens (usually 10 AM) and ask if SRO is available.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gray-500">3.</span>
              <span><strong className="text-gray-300">Back of orchestra</strong> — You&apos;ll stand at a rail behind the last row. No sitting for the entire show.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-gray-500">4.</span>
              <span><strong className="text-gray-300">Limited quantity</strong> — Only 10-20 SRO spots per show. Arrive early for popular shows.</span>
            </li>
          </ul>
        </div>

        {/* Sortable Table */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">All Standing Room</h2>
          <StandingRoomTable data={showsWithSRO.map(item => ({ show: item.show, sroData: item.sroData! }))} />
        </div>

        {/* Detailed View */}
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

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Standing room information sourced from Playbill and official show websites.
            SRO availability depends on show selling out. Always call the box office to confirm.
          </p>
        </div>
      </div>
    </>
  );
}
