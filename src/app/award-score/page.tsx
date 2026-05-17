import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { computeSiteAwardScore } from '@/lib/awards-scoring';
import type { TierBadge } from '@/lib/awards-scoring';
import { AWARD_TIER_LABEL } from '@/components/show-cards/AwardScoreBadge';
import { SortableAwardScoreTable } from '@/components/SortableAwardScoreTable';
import { featureFlags } from '@/config/feature-flags';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Broadway Award Scorecard - Prestige Scores for Every Show',
  description: 'Prestige-weighted award scores for Broadway shows. See which shows dominated the Tony Awards, Pulitzer Prize, Drama Desk, and more.',
  openGraph: {
    title: 'Broadway Award Scorecard',
    description: 'Prestige-weighted award scores across Tony, Pulitzer, Olivier, Drama Desk, Outer Critics Circle, Drama League, and NY Drama Critics.',
    url: `${BASE_URL}/award-score`,
    type: 'article',
  },
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the Broadway Award Score?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The Award Score is a 0–100 prestige-weighted composite across seven major award ceremonies: Tony Awards, Pulitzer Prize, Olivier Awards, Drama Desk, Outer Critics Circle, Drama League, and NY Drama Critics\' Circle. Tony wins carry the most weight.',
      },
    },
    {
      '@type': 'Question',
      name: 'What do the award tiers mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Sweeper (85+): dominated the awards season. Decorated (70–84): won multiple major awards. Honored (41–69): won at least one major award. Nominated (1–40): received nominations. Eligible (0): no award activity yet.',
      },
    },
  ],
};

// Legend chip colors match the medal palette in AwardScoreBadge (2026-05-17 v2):
// gold / silver / bronze for top 3 ("won something") tiers; subdued white for
// the unwon tier. Keep in sync with TIER_STYLES in AwardScoreBadge.tsx.
const tierConfig: { badge: TierBadge; chipClass: string; description: string }[] = [
  { badge: 'sweeper',   chipClass: 'bg-amber-400/20 text-amber-300 border border-amber-400/30',   description: '85+ · Dominated the awards season' },
  { badge: 'decorated', chipClass: 'bg-zinc-400/20 text-zinc-200 border border-zinc-300/30',     description: '70–84 · Won multiple major awards' },
  { badge: 'honored',   chipClass: 'bg-orange-700/20 text-orange-300 border border-orange-500/30', description: '41–69 · Won at least one major award' },
  { badge: 'nominated', chipClass: 'bg-white/5 text-gray-300 border border-white/20',             description: '1–40 · Received nominations' },
];

export default function AwardScorePage() {
  if (!featureFlags.awardScoreV2) notFound();

  const allShows = getBroadwayShows().filter(s => s.status === 'open');

  const showsWithScore = allShows
    .map(show => {
      try {
        return { show, awardScore: computeSiteAwardScore(show.id) };
      } catch {
        return null;
      }
    })
    .filter((item): item is NonNullable<typeof item> =>
      item !== null && item.awardScore.displayScore > 0
    )
    .sort((a, b) => b.awardScore.displayScore - a.awardScore.displayScore);

  const byTier = tierConfig.reduce((acc, { badge }) => {
    acc[badge] = showsWithScore.filter(item => item.awardScore.badge === badge);
    return acc;
  }, {} as Record<TierBadge, typeof showsWithScore>);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Award Scorecard', url: `${BASE_URL}/award-score` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Award Scorecard</h1>
          <p className="text-gray-400 mt-2">
            Which shows are winning Broadway&apos;s awards season? Each score weighs seven ceremonies — Tonys, Pulitzer, Olivier, Drama Desk, OCC, Drama League, and NYDCC — with Tony wins carrying the most weight.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithScore.length} shows with award activity · Currently open Broadway shows
          </p>
        </div>

        {/* How Award Score Works */}
        <div className="card p-5 mb-8 bg-gradient-to-r from-amber-500/5 to-emerald-500/5 border-white/10">
          <h2 className="font-bold text-white mb-3">How Award Score Works</h2>
          <p className="text-sm text-gray-400 mb-4">
            Each ceremony is weighted by prestige. Tony wins carry the most points; Drama Desk nominations the least. The raw points total is mapped to a 0–100 log scale. Shows with no nominations are Eligible but not listed below.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {tierConfig.map(({ badge, chipClass, description }) => (
              <div key={badge} className="flex items-start gap-2">
                <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-bold shrink-0 mt-0.5 ${chipClass}`}>
                  {AWARD_TIER_LABEL[badge]}
                </span>
                <span className="text-xs text-gray-500">{description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Main Table */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">All Shows by Award Score</h2>
          <p className="text-gray-400 text-sm mb-4">
            Click column headers to sort. ★ In Progress means Tony nominations are confirmed but the ceremony hasn&apos;t happened yet.
          </p>
          {showsWithScore.length > 0 ? (
            <SortableAwardScoreTable data={showsWithScore} />
          ) : (
            <p className="text-gray-500 text-sm">No shows with award activity found.</p>
          )}
        </section>

        {/* By Tier Breakdown */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">Shows by Tier</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {tierConfig.map(({ badge, chipClass }) => {
              const shows = byTier[badge] ?? [];
              if (shows.length === 0) return null;
              return (
                <div key={badge} className="card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-bold ${chipClass}`}>
                      {AWARD_TIER_LABEL[badge]}
                    </span>
                    <span className="text-gray-500 text-sm">{shows.length} show{shows.length !== 1 ? 's' : ''}</span>
                  </div>
                  <ul className="space-y-1">
                    {shows.slice(0, 8).map(item => (
                      <li key={item.show.slug} className="text-sm flex items-center gap-1.5">
                        <Link href={`/show/${item.show.slug}`} className="text-gray-300 hover:text-white transition-colors truncate">
                          {item.show.title}
                        </Link>
                        {item.awardScore.inProgress && (
                          <span className="text-amber-400 text-xs shrink-0">★</span>
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

        {/* Related Links */}
        <div className="mt-8 pt-6 border-t border-white/5">
          <h2 className="text-lg font-bold text-white mb-3">Related</h2>
          <div className="flex flex-wrap gap-3">
            <Link href="/audience-buzz" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Audience Scorecard →
            </Link>
            {featureFlags.tonyPredictions && (
              <Link href="/tony-awards/predictions" className="text-brand hover:text-brand-hover transition-colors text-sm">
                Tony Predictions →
              </Link>
            )}
            <Link href="/methodology#award-score" className="text-brand hover:text-brand-hover transition-colors text-sm">
              How Scoring Works →
            </Link>
          </div>
        </div>

        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Award data from Tony Awards, Pulitzer Prize, Olivier Awards, Drama Desk Awards, Outer Critics Circle, Drama League, and NY Drama Critics&apos; Circle. Scores use prestige-weighted point tables; Tony wins carry the highest weight.
          </p>
        </div>
      </div>
    </>
  );
}
