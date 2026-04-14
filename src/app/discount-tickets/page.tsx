import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { getLotteryRush, getLotteryRushLastUpdated } from '@/lib/data-lottery';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { DiscountTicketsTable, type DiscountShowRow } from './DiscountTicketsTable';
import { DiscountTicketsNav } from '@/components/DiscountTicketsNav';

export const metadata: Metadata = {
  title: 'Cheap Broadway Tickets - Lotteries, Rush & Standing Room',
  description: 'Every discount Broadway ticket option in one place. Compare lottery, rush, and standing room prices for all shows. Find the cheapest way to see Broadway.',
  alternates: {
    canonical: `${BASE_URL}/discount-tickets`,
  },
  openGraph: {
    title: 'Cheap Broadway Tickets - All Discount Options',
    description: 'Compare every lottery, rush, and standing room ticket for Broadway shows. Updated weekly.',
    url: `${BASE_URL}/discount-tickets`,
    type: 'article',
  },
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What are the cheapest ways to see Broadway shows?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The three main ways to get cheap Broadway tickets are: (1) Digital lotteries ($10-60, enter online for a chance to win), (2) Rush tickets ($30-50, first-come first-served at the box office or via apps), and (3) Standing room ($35-50, standing-only when shows sell out).',
      },
    },
    {
      '@type': 'Question',
      name: 'How do Broadway lotteries work?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Broadway lotteries are free digital drawings. Enter through apps like TodayTix or the show\'s website. Winners are randomly selected and can buy discounted tickets (usually $10-50 for orchestra seats).',
      },
    },
  ],
};

export default function DiscountTicketsPage() {
  const allShows = getBroadwayShows();
  const lastUpdated = getLotteryRushLastUpdated();

  const rows: DiscountShowRow[] = [];

  for (const show of allShows) {
    if (show.status !== 'open' && show.status !== 'previews') continue;
    const data = getLotteryRush(show.id);
    if (!data) continue;

    const hasAny = data.lottery || data.specialLottery || data.rush || data.digitalRush || data.studentRush || data.standingRoom;
    if (!hasAny) continue;

    // Pick the cheapest lottery option
    let lottery: DiscountShowRow['lottery'] = null;
    const lotteryOptions: DiscountShowRow['lottery'][] = [];
    if (data.lottery) {
      lotteryOptions.push({
        price: data.lottery.price,
        label: 'Digital Lottery',
        platform: data.lottery.platform || null,
        url: data.lottery.url || null,
        time: data.lottery.time || null,
        instructions: data.lottery.instructions || null,
      });
    }
    if (data.specialLottery) {
      lotteryOptions.push({
        price: data.specialLottery.price,
        label: data.specialLottery.name,
        platform: data.specialLottery.platform || null,
        url: data.specialLottery.url || null,
        time: null,
        instructions: data.specialLottery.instructions || null,
      });
    }
    if (lotteryOptions.length > 0) {
      lottery = lotteryOptions.sort((a, b) => a!.price - b!.price)[0];
    }

    // Pick the cheapest rush option
    let rush: DiscountShowRow['rush'] = null;
    const rushOptions: DiscountShowRow['rush'][] = [];
    if (data.rush) {
      rushOptions.push({
        price: data.rush.price,
        label: 'Rush',
        platform: data.rush.platform || null,
        url: data.rush.url || null,
        time: data.rush.time || null,
        location: data.rush.location || null,
        instructions: data.rush.instructions || null,
      });
    }
    if (data.digitalRush) {
      rushOptions.push({
        price: data.digitalRush.price,
        label: 'Digital Rush',
        platform: data.digitalRush.platform || null,
        url: data.digitalRush.url || null,
        time: data.digitalRush.time || null,
        location: null,
        instructions: data.digitalRush.instructions || null,
      });
    }
    if (data.studentRush) {
      rushOptions.push({
        price: data.studentRush.price,
        label: 'Student Rush',
        platform: data.studentRush.platform || null,
        url: data.studentRush.url || null,
        time: data.studentRush.time || null,
        location: data.studentRush.location || null,
        instructions: data.studentRush.instructions || null,
      });
    }
    if (rushOptions.length > 0) {
      rush = rushOptions.sort((a, b) => a!.price - b!.price)[0];
    }

    const sro: DiscountShowRow['sro'] = data.standingRoom ? {
      price: data.standingRoom.price,
      time: data.standingRoom.time || null,
      instructions: data.standingRoom.instructions || null,
    } : null;

    rows.push({ slug: show.slug, title: show.title, score: show.criticScore?.score ?? null, lottery, rush, sro });
  }

  rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Discount Tickets', url: `${BASE_URL}/discount-tickets` },
  ]);

  const lotteryCount = rows.filter(r => r.lottery).length;
  const rushCount = rows.filter(r => r.rush).length;
  const sroCount = rows.filter(r => r.sro).length;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Discount Broadway Tickets</h1>
          <p className="text-gray-400 mt-2">
            Every lottery, rush, and standing room option for Broadway shows in one place.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {rows.length} shows · {lotteryCount} lotteries · {rushCount} rush · {sroCount} standing room · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        <DiscountTicketsNav active="all" />

        {rows.length > 0 ? (
          <DiscountTicketsTable rows={rows} />
        ) : (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No discount ticket information available right now. Check back soon — we refresh lottery, rush, and standing-room data twice a week.</p>
          </div>
        )}

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
