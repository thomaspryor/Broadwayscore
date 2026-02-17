import Link from 'next/link';
import type { Metadata } from 'next';
import { getAllShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getScoreTier } from '@/components/show-cards/ScoreBadge';
import TonyPredictionsTable from '@/components/TonyPredictionsTable';
import type { SerializedTonyShow } from '@/components/TonyPredictionsTable';
import type { ComputedShow } from '@/lib/engine';
import { featureFlags } from '@/config/feature-flags';

// Import commercial.json directly to avoid pulling in grosses-history.json
import commercialData from '../../../data/commercial.json';
import awardsData from '../../../data/awards.json';

// --- Tony Season Logic ---

interface TonySeasonWindow {
  start: string;
  end: string;
  label: string;
  ceremonyYear: number;
}

function getTonySeasonWindow(): TonySeasonWindow {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // Tony eligibility windows (season starts the day after previous ceremony's cutoff)
  // 2024-25 cutoff: April 27, 2025 → 2025-26 season starts April 28, 2025
  // Jan-Jun: current Tony season started previous April
  // Jul-Dec: current Tony season started this April
  if (month <= 5) {
    return {
      start: `${year - 1}-04-28`,
      end: `${year}-04-27`,
      label: `${year - 1}-${year}`,
      ceremonyYear: year,
    };
  }
  return {
    start: `${year}-04-28`,
    end: `${year + 1}-04-27`,
    label: `${year}-${year + 1}`,
    ceremonyYear: year + 1,
  };
}

// --- Data Preparation ---

interface TonyCategory {
  key: string;
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
}

function serializeShow(show: ComputedShow): SerializedTonyShow {
  return {
    slug: show.slug,
    title: show.title,
    venue: show.venue || '',
    openingDate: show.openingDate || '',
    previewsStartDate: show.previewsStartDate || undefined,
    status: show.status || '',
    compositeScore: show.compositeScore,
    reviewCount: show.criticScore?.reviewCount || 0,
    thumbnailPath: show.images?.thumbnail || null,
  };
}

// Tour stops explicitly ruled Tony-eligible by the Administration Committee
const TONY_ELIGIBLE_TOUR_STOPS = new Set(['mamma-mia']);

function getTourStopSlugs(): Set<string> {
  const slugs = new Set<string>();
  const shows = (commercialData as Record<string, unknown>).shows as Record<string, { designation?: string }> | undefined;
  if (!shows) return slugs;
  for (const [slug, data] of Object.entries(shows)) {
    if (data.designation === 'Tour Stop' && !TONY_ELIGIBLE_TOUR_STOPS.has(slug)) slugs.add(slug);
  }
  return slugs;
}

function getEligibleShows(allShows: ComputedShow[], season: TonySeasonWindow): ComputedShow[] {
  const tourStops = getTourStopSlugs();
  return allShows.filter(show => {
    if (!show.openingDate) return false;
    if (show.openingDate < season.start || show.openingDate > season.end) return false;
    if (tourStops.has(show.slug)) return false;
    return true;
  });
}

function groupIntoCategories(eligible: ComputedShow[]): TonyCategory[] {
  const categories = [
    {
      key: 'best-musical',
      title: 'Best Musical',
      description: 'New musicals eligible for the top musical prize.',
      filter: (s: ComputedShow) => s.type === 'musical' && !s.isRevival,
    },
    {
      key: 'best-play',
      title: 'Best Play',
      description: 'New plays eligible for the top play prize.',
      filter: (s: ComputedShow) => s.type === 'play' && !s.isRevival,
    },
    {
      key: 'best-revival-musical',
      title: 'Best Revival of a Musical',
      description: 'Musical revivals competing for best revival honors.',
      filter: (s: ComputedShow) => s.type === 'musical' && !!s.isRevival,
    },
    {
      key: 'best-revival-play',
      title: 'Best Revival of a Play',
      description: 'Play revivals competing for best revival honors.',
      filter: (s: ComputedShow) => s.type === 'play' && !!s.isRevival,
    },
  ];

  return categories.map(cat => {
    const matching = eligible.filter(cat.filter);

    const scored = matching
      .filter(s => s.status !== 'previews' && (s.criticScore?.reviewCount || 0) >= 5)
      .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))
      .map(serializeShow);

    const upcoming = matching
      .filter(s => s.status === 'previews' || (s.criticScore?.reviewCount || 0) < 5)
      .sort((a, b) => (a.openingDate || '').localeCompare(b.openingDate || ''))
      .map(serializeShow);

    return {
      key: cat.key,
      title: cat.title,
      description: cat.description,
      shows: scored,
      upcoming,
    };
  });
}

// --- Historical Winners ---

interface HistoricalWinner {
  slug: string;
  title: string;
  season: string;
  category: string;
  compositeScore: number | null;
  reviewCount: number;
}

function getHistoricalWinners(allShows: ComputedShow[]): HistoricalWinner[] {
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const winners: HistoricalWinner[] = [];
  const awardsShows = (awardsData as Record<string, unknown>).shows as Record<string, {
    tony?: { season?: string; wins?: string[] };
  }>;

  for (const [showId, data] of Object.entries(awardsShows)) {
    const wins = data.tony?.wins || [];
    const topCategory = wins.find(w =>
      ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'].includes(w)
    );
    if (!topCategory) continue;

    const show = showMap.get(showId);
    if (!show) continue;

    winners.push({
      slug: show.slug,
      title: show.title,
      season: data.tony?.season || '',
      category: topCategory,
      compositeScore: show.compositeScore,
      reviewCount: show.criticScore?.reviewCount || 0,
    });
  }

  return winners
    .sort((a, b) => b.season.localeCompare(a.season))
    .slice(0, 20);
}

// --- SEO ---

const season = getTonySeasonWindow();

export function generateMetadata(): Metadata {
  return {
    title: `Tony Awards Predictions ${season.ceremonyYear} - Data-Driven Broadway Rankings`,
    description: `Which Broadway shows will win Tony Awards in ${season.ceremonyYear}? Data-driven predictions based on aggregated critic scores for all Tony-eligible shows in the ${season.label} season.`,
    alternates: {
      canonical: `${BASE_URL}/tony-awards`,
    },
    openGraph: {
      title: `Tony Awards Predictions ${season.ceremonyYear}`,
      description: `Data-driven Tony predictions for every eligible Broadway show in the ${season.label} season.`,
      url: `${BASE_URL}/tony-awards`,
      type: 'article',
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: 'Broadway Scorecard' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `Tony Awards Predictions ${season.ceremonyYear}`,
      description: `Data-driven Tony predictions for every eligible Broadway show.`,
    },
  };
}

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: `What Broadway shows are likely to win Tony Awards in ${season.ceremonyYear}?`,
      acceptedAnswer: {
        '@type': 'Answer',
        text: `Based on aggregated critic scores from hundreds of reviews, Broadway Scorecard ranks every Tony-eligible show in the ${season.label} season. Historically, shows with critic scores above 80 have a strong track record at the Tony Awards.`,
      },
    },
    {
      '@type': 'Question',
      name: 'How accurate are critic scores at predicting Tony Awards?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Over 12 Tony seasons (2014-2025), the top 2 shows by aggregated critic score won the Tony 95% of the time. Best Musical is the most predictable category at 90% accuracy. Only 2 winners in over a decade ranked below #2: The Outsiders (2024, #4) and Take Me Out (2022, #5).',
      },
    },
    {
      '@type': 'Question',
      name: `When are the ${season.ceremonyYear} Tony Awards?`,
      acceptedAnswer: {
        '@type': 'Answer',
        text: `The Tony Awards ceremony is traditionally held in June. The ${season.label} Tony season covers shows that opened between late April ${season.ceremonyYear - 1} and late April ${season.ceremonyYear}.`,
      },
    },
  ],
};

// --- Page ---

export default function TonyAwardsPage() {
  const allShows = getAllShows();
  const eligible = getEligibleShows(allShows, season);
  const categories = groupIntoCategories(eligible);
  const historicalWinners = getHistoricalWinners(allShows);

  const totalScored = categories.reduce((sum, cat) => sum + cat.shows.length, 0);
  const totalUpcoming = categories.reduce((sum, cat) => sum + cat.upcoming.length, 0);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards Predictions', url: `${BASE_URL}/tony-awards` },
  ]);

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

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            Tony Awards Predictions: {season.label} Season
          </h1>
          <p className="text-gray-400 mt-2 max-w-2xl">
            Data-driven predictions powered by aggregated critic scores. Every Tony-eligible show ranked by review consensus.
          </p>
          <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500">
            <span>{eligible.length} eligible shows</span>
            <span className="text-gray-600">·</span>
            <span>{totalScored} reviewed</span>
            <span className="text-gray-600">·</span>
            <span>{totalUpcoming} upcoming</span>
          </div>
        </div>

        {/* How This Works */}
        <div className="mb-10 p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide mb-2">How This Works</h2>
          <p className="text-sm text-gray-400 leading-relaxed">
            Shows are ranked by their aggregated critic score — a weighted average of reviews from dozens of outlets including
            The New York Times, Vulture, Variety, and more. Historically, the Best Musical Tony winner has
            been among the top-scored eligible shows in almost every recent season.
            These aren&apos;t editorial picks — they&apos;re what the collective critical consensus says.
          </p>
          <Link href="/methodology" className="text-sm text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
            Learn about our scoring methodology →
          </Link>
        </div>

        {/* Category Sections */}
        {categories.reduce<{ elements: React.ReactNode[]; runningIndex: number }>(
          (acc, cat) => {
            acc.elements.push(
              <TonyPredictionsTable
                key={cat.key}
                title={cat.title}
                description={cat.description}
                shows={cat.shows}
                upcoming={cat.upcoming}
                startIndex={acc.runningIndex}
              />
            );
            acc.runningIndex += cat.shows.length + cat.upcoming.length;
            return acc;
          },
          { elements: [], runningIndex: 0 }
        ).elements}

        {/* Historical Winners */}
        {historicalWinners.length > 0 && (
          <section className="mb-10 mt-4">
            <h2 className="text-xl font-bold text-white mb-2">Recent Tony Winning Shows &amp; Their Scores</h2>
            <p className="text-sm text-gray-400 mb-4">
              How recent Tony winners scored with critics — showing the relationship between reviews and awards.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/5">
                    <th className="pb-3 pr-4">Season</th>
                    <th className="pb-3 pr-4">Show</th>
                    <th className="pb-3 pr-4">Category</th>
                    <th className="pb-3 pr-4 text-right">Score</th>
                    <th className="pb-3 text-right">Reviews</th>
                  </tr>
                </thead>
                <tbody>
                  {historicalWinners.map((winner, i) => {
                    const tier = getScoreTier(winner.compositeScore);
                    return (
                      <tr key={`${winner.slug}-${i}`} className="border-b border-white/5">
                        <td className="py-2.5 pr-4 text-sm text-gray-400">{winner.season}</td>
                        <td className="py-2.5 pr-4">
                          <Link href={`/show/${winner.slug}`} className="text-sm font-medium text-white hover:text-brand transition-colors">
                            {winner.title}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-4 text-sm text-gray-400">{winner.category.replace('Best ', '')}</td>
                        <td className="py-2.5 pr-4 text-right">
                          {winner.compositeScore !== null ? (
                            <span className="text-sm font-semibold" style={{ color: tier?.color || '#9ca3af' }}>
                              {winner.compositeScore}
                            </span>
                          ) : (
                            <span className="text-sm text-gray-500">—</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right text-sm text-gray-500">{winner.reviewCount || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* How Accurate Are Critic Scores? */}
        <section className="mb-10 mt-4">
          <h2 className="text-xl font-bold text-white mb-2">How Accurate Are Critic Scores?</h2>
          <p className="text-sm text-gray-400 mb-5">
            We analyzed 12 Tony seasons (2014&ndash;2025) across all four main categories to test how well aggregated critic scores predict winners.
          </p>

          {/* Hero stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { stat: '69%', label: '#1 score wins' },
              { stat: '95%', label: 'Top 2 wins' },
              { stat: '90%', label: 'Best Musical accuracy' },
              { stat: '1.44', label: 'Avg winner rank' },
            ].map(({ stat, label }) => (
              <div key={label} className="rounded-xl border border-white/5 bg-surface-overlay p-3 sm:p-4 text-center">
                <div className="text-2xl sm:text-3xl font-bold text-brand">{stat}</div>
                <div className="text-xs text-gray-400 mt-1">{label}</div>
              </div>
            ))}
          </div>

          {/* Field size insight */}
          <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5 mb-5">
            <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">Field Size Changes Everything</h3>
            <div className="space-y-2.5">
              {[
                { nominees: '3\u20134 nominees', pct: 92, note: 'Standard Tony field' },
                { nominees: '5\u20136 nominees', pct: 67, note: '' },
                { nominees: '2 nominees', pct: 50, note: 'Coin flip' },
                { nominees: '7+ nominees', pct: 40, note: 'Chaos' },
              ].map(({ nominees, pct, note }) => (
                <div key={nominees} className="flex items-center gap-3">
                  <span className="text-sm text-gray-300 w-28 sm:w-32 flex-shrink-0">{nominees}</span>
                  <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand/70"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-white w-10 text-right">{pct}%</span>
                  {note && <span className="text-xs text-gray-500 hidden sm:inline w-24">{note}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Category breakdown + New vs Revival */}
          <div className="grid sm:grid-cols-2 gap-3 mb-5">
            <div className="rounded-xl border border-white/5 bg-surface-overlay p-4">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Category</h3>
              <div className="space-y-2">
                {[
                  { cat: 'Best Musical', pct: '90%', color: 'text-emerald-400' },
                  { cat: 'Best Play', pct: '70%', color: 'text-blue-400' },
                  { cat: 'Revival Play', pct: '60%', color: 'text-gray-300' },
                  { cat: 'Revival Musical', pct: '56%', color: 'text-gray-400' },
                ].map(({ cat, pct, color }) => (
                  <div key={cat} className="flex items-center justify-between">
                    <span className="text-sm text-gray-300">{cat}</span>
                    <span className={`text-sm font-bold ${color}`}>{pct}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-surface-overlay p-4">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">New Works vs. Revivals</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">New works</span>
                  <span className="text-sm font-bold text-emerald-400">80%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">Revivals</span>
                  <span className="text-sm font-bold text-gray-400">58%</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Revivals carry nostalgia, star power, and cultural-moment factors that critic scores don&apos;t fully capture.
              </p>
            </div>
          </div>

          {/* The only 2 real upsets */}
          <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-1">The Only Times It Failed</h3>
            <p className="text-xs text-gray-500 mb-3">
              In 39 category-seasons, only 2 winners ranked below #2 by critic score.
            </p>
            <div className="space-y-2">
              <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                <div>
                  <span className="text-sm text-white font-medium">The Outsiders</span>
                  <span className="text-xs text-gray-500 ml-2">Best Musical 2024</span>
                </div>
                <span className="text-sm text-amber-400 font-semibold">Ranked #4</span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <div>
                  <span className="text-sm text-white font-medium">Take Me Out</span>
                  <span className="text-xs text-gray-500 ml-2">Revival Play 2022</span>
                </div>
                <span className="text-sm text-amber-400 font-semibold">Ranked #5</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Every other &ldquo;upset&rdquo; was the #2 critic score edging out #1 &mdash; average gap just 2.7 points.
            </p>
          </div>
        </section>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <p>
            Rankings are derived from aggregated critic reviews collected from {eligible.length > 0 ? 'dozens of' : ''} outlets.
            Shows appear automatically as they open and get reviewed — no editorial intervention.
            Tony eligibility based on opening dates within the {season.label} season.
            Includes currently announced shows only. Category classifications (new vs. revival) are subject to official Tony Awards Administration Committee rulings.
          </p>
          <div className="flex flex-wrap gap-4 mt-3">
            <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
              Scoring methodology →
            </Link>
            {featureFlags.boxOffice && (
              <Link href="/box-office" className="text-brand hover:text-brand-hover transition-colors">
                Box office data →
              </Link>
            )}
            {featureFlags.criticPages && (
              <Link href="/critics" className="text-brand hover:text-brand-hover transition-colors">
                Critic profiles →
              </Link>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
