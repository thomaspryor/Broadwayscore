import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getLotteryRush, getLotteryRushLastUpdated, ShowLotteryRush } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { ComputedShow } from '@/lib/engine';

export const metadata: Metadata = {
  title: 'Best Value Broadway Tickets - Cheapest Ways to See Shows',
  description: 'Find the cheapest Broadway tickets. Compare lotteries, rush, student rush, and standing room prices for every show. Sorted by lowest price.',
  alternates: {
    canonical: `${BASE_URL}/best-value`,
  },
  openGraph: {
    title: 'Best Value Broadway Tickets',
    description: 'The cheapest ways to see Broadway shows. Compare all discount options: lotteries from $10, rush from $30, and more.',
    url: `${BASE_URL}/best-value`,
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
      name: 'What is the cheapest way to see Broadway shows?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The cheapest Broadway tickets are through lotteries ($10-60), rush tickets ($30-50), and standing room ($35-50). Hamilton\'s $10 lottery is the best deal, but winning is difficult. Rush tickets are first-come, first-served but guarantee a seat if you arrive early.',
      },
    },
    {
      '@type': 'Question',
      name: 'How can I see Hamilton for cheap?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Hamilton offers a $10 digital lottery through the Hamilton app. Enter weekly for a chance at front row orchestra seats. Standing room ($40) is available when sold out. There are no rush tickets for Hamilton.',
      },
    },
    {
      '@type': 'Question',
      name: 'Are TKTS booths still the cheapest Broadway tickets?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'TKTS offers 20-50% off face value, but lotteries and rush tickets are often cheaper. A $150 ticket at TKTS costs $75-120, while the same show might have a $40 lottery or $45 rush. TKTS is better for last-minute decisions; lotteries require planning ahead.',
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
      label: 'Student Rush',
      color: 'text-pink-300',
      bgColor: 'bg-pink-500/15 border-pink-500/30',
    });
  }

  if (data.rush) {
    options.push({
      type: 'rush',
      price: data.rush.price,
      label: 'Rush',
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

function ValueShowCard({ show, discountData, cheapestPrice, index }: ValueShowCardProps) {
  const score = show.criticScore?.score;
  const options = getDiscountOptions(discountData);
  const cheapest = options[0];

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

        {/* All Discount Options */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {options.map((option, i) => (
            <span
              key={option.type}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-sm font-medium ${option.bgColor} ${option.color} ${i === 0 ? 'ring-1 ring-white/20' : ''}`}
            >
              ${option.price} {option.label}
            </span>
          ))}
        </div>

        {/* Best deal highlight */}
        {cheapest && (
          <p className="text-xs text-gray-500 mt-2">
            Best deal: <span className={cheapest.color}>${cheapest.price} {cheapest.label}</span>
          </p>
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

export default function BestValuePage() {
  const allShows = getAllShows();
  const lastUpdated = getLotteryRushLastUpdated();

  // Get shows with any discount option, sorted by cheapest price
  const showsWithDiscounts = allShows
    .filter(show => show.status === 'open')
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
    { name: 'Best Value', url: `${BASE_URL}/best-value` },
  ]);

  // Stats
  const cheapestShow = showsWithDiscounts[0];
  const avgCheapestPrice = Math.round(
    showsWithDiscounts.reduce((sum, item) => sum + item.cheapestPrice, 0) / showsWithDiscounts.length
  );
  const multiOptionShows = showsWithDiscounts.filter(item => item.optionCount >= 3).length;

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
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Best Value Broadway Tickets</h1>
          <p className="text-gray-400 mt-2">
            Every discount ticket option for every show, sorted by cheapest price. Compare lotteries, rush, student deals, and standing room.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithDiscounts.length} shows with discount tickets · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-emerald-400">${cheapestShow?.cheapestPrice}</div>
            <div className="text-xs text-gray-500 mt-1">Cheapest Ticket</div>
            <div className="text-xs text-gray-400 truncate">{cheapestShow?.show.title}</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">${avgCheapestPrice}</div>
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
              Lottery — Digital entry, random drawing
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 text-emerald-300">
              Rush — First-come, first-served at box office
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-500/15 text-blue-300">
              Digital Rush — Rush via TodayTix/apps
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-pink-500/15 text-pink-300">
              Student Rush — Student ID required
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-500/15 text-gray-300">
              Standing Room — Standing, sold-out shows only
            </span>
          </div>
        </div>

        {/* Show List */}
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

        {/* Related Links */}
        <div className="mt-8 pt-6 border-t border-white/5">
          <h2 className="text-lg font-bold text-white mb-3">Browse by Type</h2>
          <div className="flex flex-wrap gap-3">
            <Link href="/lotteries" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Lottery Tickets →
            </Link>
            <Link href="/rush" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Rush Tickets →
            </Link>
            <Link href="/standing-room" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Standing Room →
            </Link>
          </div>
        </div>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Discount ticket information sourced from Playbill and official show websites.
            Prices and availability change frequently. Always verify with the official source.
          </p>
        </div>
      </div>
    </>
  );
}
