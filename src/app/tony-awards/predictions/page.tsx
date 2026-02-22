import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import TonyPredictionsTable from '@/components/TonyPredictionsTable';
import {
  getTonySeasonWindow,
  getEligibleShows,
  groupIntoCategories,
} from '@/lib/data-tony-predictions';

const season = getTonySeasonWindow();

export function generateMetadata(): Metadata {
  return {
    title: `Tony Awards Predictions ${season.ceremonyYear} - Data-Driven Broadway Rankings`,
    description: `Which Broadway shows will win Tony Awards in ${season.ceremonyYear}? Data-driven predictions based on aggregated CriticScore ratings for all Tony-eligible shows in the ${season.label} season.`,
    alternates: {
      canonical: `${BASE_URL}/tony-awards/predictions`,
    },
    openGraph: {
      title: `Tony Awards Predictions ${season.ceremonyYear}`,
      description: `Data-driven Tony predictions for every eligible Broadway show in the ${season.label} season.`,
      url: `${BASE_URL}/tony-awards/predictions`,
      type: 'article',
      images: [{ url: `${BASE_URL}/og/tony-predictions.png`, width: 1200, height: 630, alt: `Tony Awards Predictions ${season.ceremonyYear}` }],
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
      name: `When are the ${season.ceremonyYear} Tony Awards?`,
      acceptedAnswer: {
        '@type': 'Answer',
        text: `The Tony Awards ceremony is traditionally held in June. The ${season.label} Tony season covers shows that opened between late April ${season.ceremonyYear - 1} and late April ${season.ceremonyYear}.`,
      },
    },
  ],
};

export default function TonyPredictionsPage() {
  if (!featureFlags.tonyPredictions) notFound();

  const allShows = getBroadwayShows();
  const eligible = getEligibleShows(allShows, season);
  const categories = groupIntoCategories(eligible);

  const totalScored = categories.reduce((sum, cat) => sum + cat.shows.length, 0);
  const totalUpcoming = categories.reduce((sum, cat) => sum + cat.upcoming.length, 0);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Predictions', url: `${BASE_URL}/tony-awards/predictions` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/tony-awards" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Tony Awards
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
            <span className="text-gray-600">&middot;</span>
            <span>{totalScored} reviewed</span>
            <span className="text-gray-600">&middot;</span>
            <span>{totalUpcoming} upcoming</span>
          </div>
        </div>

        {/* How This Works */}
        <div className="mb-10 p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide mb-2">How This Works</h2>
          <p className="text-sm text-gray-400 leading-relaxed">
            Shows are ranked by their aggregated CriticScore — a weighted average of reviews from dozens of outlets including
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
