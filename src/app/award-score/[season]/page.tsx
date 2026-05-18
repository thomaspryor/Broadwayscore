import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { computeSiteAwardScore } from '@/lib/awards-scoring';
import { SortableAwardScoreTable } from '@/components/SortableAwardScoreTable';
import { featureFlags } from '@/config/feature-flags';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';

function slugToFullSeason(slug: string): string {
  // "2025-26" → "2025-2026"
  const m = slug.match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  return `${m[1]}-${m[1].slice(0, 2)}${m[2]}`;
}

function toSlug(fullSeason: string): string {
  const m = fullSeason.match(/^(\d{4})-\d{2}(\d{2})$/);
  if (!m) return fullSeason;
  return `${m[1]}-${m[2]}`;
}

function formatSeason(fullSeason: string): string {
  const m = fullSeason.match(/^(\d{4})-\d{2}(\d{2})$/);
  if (!m) return fullSeason;
  return `${m[1]}–${m[2]}`;
}

function getShowsForSeason(fullSeason: string) {
  return getBroadwayShows()
    .map(show => {
      try {
        const awardScore = computeSiteAwardScore(show.id);
        return {
          show: { slug: show.slug, title: show.title, status: show.status, images: show.images },
          awardScore,
        };
      } catch { return null; }
    })
    .filter((item): item is NonNullable<typeof item> =>
      item !== null &&
      item.awardScore.tonySeason === fullSeason &&
      item.awardScore.displayScore > 0
    )
    .sort((a, b) => b.awardScore.displayScore - a.awardScore.displayScore);
}

export async function generateStaticParams() {
  const allShows = getBroadwayShows();
  const seasons = new Set<string>();
  for (const show of allShows) {
    try {
      const score = computeSiteAwardScore(show.id);
      if (score.tonySeason) seasons.add(score.tonySeason);
    } catch {}
  }
  return Array.from(seasons).map(season => ({ season: toSlug(season) }));
}

export async function generateMetadata({ params }: { params: { season: string } }): Promise<Metadata> {
  const fullSeason = slugToFullSeason(params.season);
  const label = formatSeason(fullSeason) || params.season;
  return {
    title: `${label} Broadway Award Scorecard`,
    description: `Prestige-weighted award scores for the ${label} Broadway season — Tony Awards, Pulitzer Prize, Drama Desk, Outer Critics Circle, Drama League, and NYDCC.`,
    openGraph: {
      title: `${label} Broadway Award Scorecard`,
      description: `Which shows dominated the ${label} Broadway awards season? See scores across seven ceremonies.`,
      url: `${BASE_URL}/award-score/${params.season}`,
      type: 'article',
    },
  };
}

export default function AwardScoreSeasonPage({ params }: { params: { season: string } }) {
  if (!featureFlags.awardScoreV2) notFound();

  const showsWithScore = getShowsForSeason(params.season);
  if (showsWithScore.length === 0) notFound();

  const seasonLabel = formatSeason(params.season);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Award Scorecard', url: `${BASE_URL}/award-score` },
    { name: seasonLabel, url: `${BASE_URL}/award-score/${params.season}` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/award-score" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Seasons
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">{seasonLabel} Broadway Award Scorecard</h1>
          <p className="text-gray-400 mt-2">
            Which shows dominated the {seasonLabel} Broadway awards season? Each score weighs seven ceremonies — Tonys, Pulitzer, Olivier, Drama Desk, OCC, Drama League, and NYDCC — with Tony wins carrying the most weight.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithScore.length} show{showsWithScore.length !== 1 ? 's' : ''} with award activity
          </p>
        </div>

        <section className="mb-12">
          <SortableAwardScoreTable data={showsWithScore} />
        </section>

        <div className="mt-8 pt-6 border-t border-white/5">
          <div className="flex flex-wrap gap-3">
            <Link href="/award-score" className="text-brand hover:text-brand-hover transition-colors text-sm">
              ← All Seasons
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
      </div>
    </>
  );
}
