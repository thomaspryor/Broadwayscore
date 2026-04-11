import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows } from '@/lib/data-core';
import {
  getTopTrendingShows,
  getTrendingLastUpdated,
  type TrendingPick,
} from '@/lib/data-social-pulse';
import type { ComputedShow } from '@/lib/engine';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import TrendingShowCard from '@/components/trending/TrendingShowCard';

/**
 * /trending — Top 10 buzziest shows on Broadway + West End, side-by-side.
 *
 * Data source: data/social-pulse/{show-id}.json (raw files written by
 * scripts/fetch-social-pulse.js + compute-social-pulse-ranks.js). Ranked by
 * `compositeScore` = volume × positivePct, recomputed at build time via
 * `getTopTrendingShows()`.
 *
 * New entry point + SEO landing page for the Socials Scorecard product. No
 * feature flag — this page is public-by-default since the underlying data
 * pipeline has been shipping to show pages for weeks.
 */

// NOTE: the root layout defines `title.template = '%s | Broadway Scorecard'`,
// so we pass the raw title here and let the template append the suffix.
// (Double-suffix bug observed 2026-04-11 when this was set to the full string.)
const PAGE_TITLE = 'Trending Broadway & West End Shows';
const PAGE_DESCRIPTION =
  'The 10 buzziest shows on Broadway and the West End right now — ranked by social media volume and audience sentiment across X, TikTok, and Instagram. Updated weekly.';

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/trending` },
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    url: `${BASE_URL}/trending`,
    type: 'article',
  },
  twitter: {
    card: 'summary_large_image',
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

// Build a fast lookup map from showId → ComputedShow. One pass over the
// full show list; avoids O(n²) when we join trending picks with metadata.
function buildShowLookup(): Map<string, ComputedShow> {
  const map = new Map<string, ComputedShow>();
  for (const s of getAllShows()) map.set(s.id, s);
  return map;
}

interface TrendingColumnProps {
  heading: string;
  subheading: string;
  picks: TrendingPick[];
  showLookup: Map<string, ComputedShow>;
  emptyMessage: string;
  accentColor: string;
}

function TrendingColumn({
  heading,
  subheading,
  picks,
  showLookup,
  emptyMessage,
  accentColor,
}: TrendingColumnProps) {
  return (
    <section>
      <div className="mb-4 pb-3 border-b border-white/10">
        <div className="flex items-baseline gap-3">
          <h2 className="text-2xl sm:text-3xl font-bold text-white">{heading}</h2>
          {picks.length > 0 && (
            <span
              className="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded"
              style={{ color: accentColor, backgroundColor: `${accentColor}22` }}
            >
              Top {picks.length}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-400 mt-1">{subheading}</p>
      </div>

      {picks.length === 0 ? (
        <p className="text-sm text-gray-500 italic">{emptyMessage}</p>
      ) : (
        // `role="list"` is explicit: Tailwind's `list-none` strips default list
        // semantics in Safari VoiceOver, which drops AT list navigation. Forcing
        // the role back keeps the ordered-list structure for screen readers.
        <ol role="list" className="space-y-2.5 list-none p-0">
          {picks.map((pulse, idx) => (
            <li key={pulse.showId}>
              <TrendingShowCard
                rank={idx + 1}
                pulse={pulse}
                show={showLookup.get(pulse.showId)}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function buildItemListSchema(
  name: string,
  description: string,
  picks: TrendingPick[],
  showLookup: Map<string, ComputedShow>,
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    description,
    itemListOrder: 'https://schema.org/ItemListOrderDescending',
    numberOfItems: picks.length,
    itemListElement: picks.map((p, i) => {
      // `knownShowIds` filter in getTopTrendingShows guarantees every pick
      // has a slug in showLookup, so the `!` here is intentional — if it
      // ever fires as undefined, it means the orphan filter regressed and
      // we want to catch it in dev/SSR rather than silently 404 in schema.
      const show = showLookup.get(p.showId)!;
      return {
        '@type': 'ListItem',
        position: i + 1,
        url: `${BASE_URL}/show/${show.slug}`,
        name: show.title,
      };
    }),
  };
}

export default function TrendingPage() {
  const showLookup = buildShowLookup();
  const knownShowIds: ReadonlySet<string> = new Set(showLookup.keys());
  const broadwayPicks = getTopTrendingShows('Broadway', knownShowIds, 10);
  const westEndPicks = getTopTrendingShows('West End', knownShowIds, 10);
  const lastUpdated = getTrendingLastUpdated();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Trending', url: `${BASE_URL}/trending` },
  ]);

  // ItemList schemas — only emit when the list has entries. An empty
  // itemListElement array is a common Search Console warning.
  const itemListSchemas = [
    broadwayPicks.length > 0
      ? buildItemListSchema(
          'Trending Broadway Shows',
          'Top 10 buzziest Broadway shows right now',
          broadwayPicks,
          showLookup,
        )
      : null,
    westEndPicks.length > 0
      ? buildItemListSchema(
          'Trending West End Shows',
          'Top 10 buzziest West End shows right now',
          westEndPicks,
          showLookup,
        )
      : null,
  ].filter(Boolean);

  const updatedLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, ...itemListSchemas]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            Trending Shows
          </h1>
          <p className="text-gray-400 mt-2 max-w-2xl">
            The 10 buzziest shows on Broadway and the West End — ranked by social media
            volume and audience sentiment across X, TikTok, and Instagram.
          </p>
          {updatedLabel && (
            <p className="text-sm text-gray-500 mt-1">
              Updated {updatedLabel} · refreshed weekly
            </p>
          )}
        </div>

        {/* How it works — compact explainer */}
        <div className="card p-4 sm:p-5 mb-8 bg-gradient-to-r from-orange-500/5 to-blue-500/5 border-white/10">
          <h2 className="text-sm font-bold text-white uppercase tracking-wide mb-2">
            How the Socials Scorecard works
          </h2>
          <p className="text-sm text-gray-400">
            Every week we scan X, TikTok, and Instagram for mentions of every show, classify each
            post&rsquo;s sentiment, and rank shows by{' '}
            <span className="text-gray-300 font-semibold">volume × positive %</span>. More people
            talking <em>and</em> saying nice things wins. Tiers:{' '}
            <span className="text-orange-400 font-semibold">Buzzing</span>,{' '}
            <span className="text-emerald-400 font-semibold">Rising</span>,{' '}
            <span className="text-blue-400 font-semibold">Steady</span>,{' '}
            <span className="text-red-400 font-semibold">Troubled</span>.
          </p>
        </div>

        {/* Two columns — Broadway + West End. Counts are picks-driven rather
            than hardcoded so the subheading stays honest if the market grows
            or if the orphan filter drops a pick. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-10">
          <TrendingColumn
            heading="Broadway"
            subheading={`New York · ${broadwayPicks.length} shows ranked`}
            picks={broadwayPicks}
            showLookup={showLookup}
            emptyMessage="No trending Broadway shows yet — check back after the next weekly refresh."
            accentColor="#f97316"
          />
          <TrendingColumn
            heading="West End"
            subheading={`London · ${westEndPicks.length} shows ranked`}
            picks={westEndPicks}
            showLookup={showLookup}
            emptyMessage="No trending West End shows yet — check back after the next weekly refresh."
            accentColor="#3b82f6"
          />
        </div>

        {/* Related links */}
        <div className="mt-12 pt-6 border-t border-white/5">
          <h2 className="text-lg font-bold text-white mb-3">Related</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <Link
              href="/audience-buzz"
              className="text-brand hover:text-brand-hover transition-colors text-sm"
            >
              Broadway AudienceGrade →
            </Link>
            <Link
              href="/west-end/audience-buzz"
              className="text-brand hover:text-brand-hover transition-colors text-sm"
            >
              West End AudienceGrade →
            </Link>
            <Link
              href="/rankings"
              className="text-brand hover:text-brand-hover transition-colors text-sm"
            >
              Critic Rankings →
            </Link>
            <Link
              href="/methodology"
              className="text-brand hover:text-brand-hover transition-colors text-sm"
            >
              How Scoring Works →
            </Link>
          </div>
        </div>

        {/* Data source note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Social data aggregated from X, TikTok, and Instagram via the Apify ecosystem.
            Sentiment classified by LLM. Updated weekly.
          </p>
        </div>
      </div>
    </>
  );
}
