import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getShowCommercial, getCommercialLastUpdated, CommercialDesignation } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { RecoupTable, CapitalizationTable } from '@/components/SortableBizBuzzTables';

export const metadata: Metadata = {
  title: 'Commercial Scorecard - Which Broadway Shows Make Money?',
  description: 'The business side of Broadway: see which shows have recouped their investment, weeks to profitability, capitalization costs, and commercial designations from Miracle to Flop.',
  alternates: {
    canonical: `${BASE_URL}/biz-buzz`,
  },
  openGraph: {
    title: 'Commercial Scorecard - Broadway Show Profitability',
    description: 'Which Broadway shows are profitable? Recoupment data, capitalization costs, and commercial performance ratings.',
    url: `${BASE_URL}/biz-buzz`,
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
      name: 'How much does it cost to produce a Broadway show?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Broadway musicals typically cost $10-25 million to produce, while plays generally range from $3-8 million. Mega-productions like Spider-Man: Turn Off The Dark have exceeded $75 million. These costs cover sets, costumes, rehearsals, marketing, and the initial run before opening.',
      },
    },
    {
      '@type': 'Question',
      name: 'What percentage of Broadway shows make money?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Only about 20-25% of Broadway shows recoup their investment and become profitable. The majority lose money, which is why Broadway investors expect occasional big hits to offset multiple losses.',
      },
    },
    {
      '@type': 'Question',
      name: 'What does it mean when a Broadway show recoups?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'When a Broadway show "recoups," it means the production has earned back its initial investment (capitalization) through ticket sales, merchandise, and other revenue. After recoupment, profits are split between investors and the creative team.',
      },
    },
    {
      '@type': 'Question',
      name: 'Which Broadway show recouped the fastest?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Hamilton famously recouped its $12.5 million investment in just 10 months (about 26 weeks of performances), making it one of the fastest recoupments in Broadway history. The Book of Mormon also recouped quickly, in about 9 months.',
      },
    },
  ],
};

const designationConfig: Record<CommercialDesignation, { emoji: string; color: string; description: string }> = {
  'Miracle': { emoji: '🌟', color: 'text-yellow-400', description: 'Profit > 3x investment (mega-hits)' },
  'Windfall': { emoji: '💰', color: 'text-emerald-400', description: 'Profit > 1.5x investment (solid hits)' },
  'Trickle': { emoji: '💧', color: 'text-blue-400', description: 'Broke even or modest profit' },
  'Easy Winner': { emoji: '✓', color: 'text-teal-400', description: 'Limited run that made money' },
  'Fizzle': { emoji: '📉', color: 'text-orange-400', description: 'Lost money but not all' },
  'Flop': { emoji: '💥', color: 'text-red-400', description: 'Lost most/all investment' },
  'Nonprofit': { emoji: '🎭', color: 'text-purple-400', description: 'Produced by nonprofit theater' },
  'TBD': { emoji: '⏳', color: 'text-gray-400', description: 'Too early to determine' },
};

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  return `$${(amount / 1000).toFixed(0)}K`;
}

export default function BizBuzzPage() {
  const allShows = getAllShows();
  const lastUpdated = getCommercialLastUpdated();

  // Get all shows with commercial data
  const showsWithCommercial = allShows
    .map(show => ({
      show,
      commercial: getShowCommercial(show.slug),
    }))
    .filter(item => item.commercial);

  // Group by designation
  const byDesignation = showsWithCommercial.reduce((acc, item) => {
    const designation = item.commercial!.designation;
    if (!acc[designation]) acc[designation] = [];
    acc[designation].push(item);
    return acc;
  }, {} as Record<CommercialDesignation, typeof showsWithCommercial>);

  // Shows that recouped, sorted by weeks to recoup (fastest first)
  const recoupedShows = showsWithCommercial
    .filter(item => item.commercial?.recouped && item.commercial?.recoupedWeeks)
    .sort((a, b) => (a.commercial!.recoupedWeeks || 999) - (b.commercial!.recoupedWeeks || 999));

  // All shows sorted by capitalization (highest to lowest)
  const byCapitalization = showsWithCommercial
    .filter(item => item.commercial?.capitalization)
    .sort((a, b) => (b.commercial!.capitalization || 0) - (a.commercial!.capitalization || 0));

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Commercial Scorecard', url: `${BASE_URL}/biz-buzz` },
  ]);

  // Order designations for display (TBD last)
  const designationOrder: CommercialDesignation[] = ['Miracle', 'Windfall', 'Trickle', 'Easy Winner', 'Nonprofit', 'Fizzle', 'Flop', 'TBD'];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Commercial Scorecard</h1>
          <p className="text-gray-400 mt-2">
            The business side of Broadway: which shows make money, how fast they recoup, and what it costs to produce a hit.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            Data from SEC filings, trade press, and industry sources · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
          <p className="text-xs text-gray-600 mt-2">
            Note: This is not an exhaustive list. Commercial data is only available for shows where capitalization, recoupment, or financial outcomes have been publicly reported.
          </p>
        </div>

        {/* Designation Legend */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">Commercial Designations</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {designationOrder.map(designation => (
              <div key={designation} className="card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">{designationConfig[designation].emoji}</span>
                  <span className={`font-semibold ${designationConfig[designation].color}`}>{designation}</span>
                </div>
                <p className="text-xs text-gray-500">{designationConfig[designation].description}</p>
                <p className="text-xs text-gray-400 mt-1">{byDesignation[designation]?.length || 0} shows</p>
              </div>
            ))}
          </div>
        </section>

        {/* Fastest to Recoup */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">Fastest to Recoup</h2>
          <p className="text-gray-400 text-sm mb-4">
            Shows that earned back their investment fastest. Click column headers to sort.
          </p>
          <RecoupTable data={recoupedShows} />
        </section>

        {/* Highest Capitalization */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">Most Expensive Productions</h2>
          <p className="text-gray-400 text-sm mb-4">
            Broadway&apos;s biggest investments. Higher capitalization means more risk—and potentially higher reward.
          </p>
          <CapitalizationTable data={byCapitalization} />
        </section>

        {/* By Designation Breakdown */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">Shows by Designation</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {designationOrder.map(designation => {
              const shows = byDesignation[designation] || [];
              if (shows.length === 0) return null;
              return (
                <div key={designation} className="card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xl">{designationConfig[designation].emoji}</span>
                    <h3 className={`font-bold ${designationConfig[designation].color}`}>{designation}</h3>
                    <span className="text-gray-500 text-sm">({shows.length})</span>
                  </div>
                  <ul className="space-y-1">
                    {shows.slice(0, 8).map(item => (
                      <li key={item.show.slug} className="text-sm">
                        <Link href={`/show/${item.show.slug}`} className="text-gray-300 hover:text-white transition-colors">
                          {item.show.title}
                        </Link>
                        {item.commercial?.recoupedWeeks && (
                          <span className="text-gray-500 ml-2">({item.commercial.recoupedWeeks} wks)</span>
                        )}
                      </li>
                    ))}
                    {shows.length > 8 && (
                      <li className="text-gray-500 text-xs">+{shows.length - 8} more</li>
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <p>
            Commercial data compiled from SEC filings, trade press (Broadway Journal, Broadway News, Deadline, Variety),
            and industry sources. Recoupment times and capitalization figures are estimates based on available public information.
          </p>
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
            Learn more about our methodology →
          </Link>
        </div>
      </div>
    </>
  );
}
