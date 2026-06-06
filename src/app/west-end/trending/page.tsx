import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows } from '@/lib/data-core';
import { getTopTrendingShows, getTrendingLastUpdated } from '@/lib/data-social-pulse';
import type { ComputedShow } from '@/lib/engine';
import { generateBreadcrumbSchema, marketAlternates, BASE_URL } from '@/lib/seo';
import TrendingList from '@/components/trending/TrendingList';

/**
 * /west-end/trending — Every West End show ranked by social buzz.
 *
 * London-specific page. Broadway has its own at /trending.
 */

const PAGE_TITLE = 'Trending West End Shows';
const PAGE_DESCRIPTION =
  'Every West End show ranked by social media buzz — volume and audience sentiment across Reddit, X, TikTok, and Instagram. Updated weekly.';

export const metadata: Metadata = {
  title: {
    absolute: `${PAGE_TITLE} | West End Scorecard`,
  },
  description: PAGE_DESCRIPTION,
  alternates: marketAlternates('westEnd', '/trending'),
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    url: `${BASE_URL}/west-end/trending`,
    type: 'article',
  },
  twitter: {
    card: 'summary_large_image',
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

function buildShowLookup(): Map<string, ComputedShow> {
  const map = new Map<string, ComputedShow>();
  for (const s of getAllShows()) map.set(s.id, s);
  return map;
}

export default function WestEndTrendingPage() {
  const showLookup = buildShowLookup();
  // Restrict to currently-running shows: "trending" means current buzz, and a
  // closed show's social-pulse file is frozen (the fetcher stops refreshing it).
  // Composes with getTopTrendingShows' staleness filter to keep recently-closed
  // shows (still inside the 14-day freshness window) off the leaderboard.
  const knownShowIds: ReadonlySet<string> = new Set(
    Array.from(showLookup.values()).filter((s) => s.status === 'open' || s.status === 'previews').map((s) => s.id),
  );
  const picks = getTopTrendingShows('West End', knownShowIds, 1000);
  const lastUpdated = getTrendingLastUpdated();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
    { name: 'Trending', url: `${BASE_URL}/west-end/trending` },
  ]);

  const itemListSchema = picks.length > 0
    ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Trending West End Shows',
        description: 'West End shows in London ranked by social media buzz',
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        numberOfItems: picks.length,
        itemListElement: picks.map((p, i) => {
          const show = showLookup.get(p.showId)!;
          return {
            '@type': 'ListItem',
            position: i + 1,
            url: `${BASE_URL}/show/${show.slug}`,
            name: show.title,
          };
        }),
      }
    : null;

  const updatedLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema].filter(Boolean)) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link
          href="/west-end"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          West End Shows
        </Link>

        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            Trending West End Shows
          </h1>
          <p className="text-gray-400 mt-2">
            Every West End show ranked by social media buzz — volume and audience
            sentiment across Reddit, X, TikTok, and Instagram.
          </p>
          {updatedLabel && (
            <p className="text-sm text-gray-500 mt-1">
              Updated {updatedLabel} · refreshed weekly
            </p>
          )}
        </div>

        {/* Top N badge + list */}
        <div className="mb-8">
          {picks.length > 0 && (
            <div className="flex items-baseline gap-3 mb-4 pb-3 border-b border-white/10">
              <h2 className="text-xl sm:text-2xl font-bold text-white">West End</h2>
              <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
                {picks.length} shows
              </span>
            </div>
          )}
          <TrendingList
            picks={picks}
            showLookup={showLookup}
            emptyMessage="No trending West End shows yet — check back after the next weekly refresh."
          />
        </div>

        {/* How it works — below the list */}
        <details className="card p-4 sm:p-5 mb-8 group">
          <summary className="text-sm font-bold text-white uppercase tracking-wide cursor-pointer list-none flex items-center justify-between">
            How the Socials Scorecard works
            <svg className="w-4 h-4 text-gray-500 group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <p className="text-sm text-gray-400 mt-3">
            Every week we scan Reddit, X, TikTok, and Instagram for mentions of every show, classify each
            post&rsquo;s sentiment, and rank shows by{' '}
            <span className="text-gray-300 font-semibold">volume × positive %</span>. More people
            talking <em>and</em> saying nice things wins. Tiers:{' '}
            <span className="text-orange-400 font-semibold">Buzzing</span>,{' '}
            <span className="text-emerald-400 font-semibold">Rising</span>,{' '}
            <span className="text-blue-400 font-semibold">Steady</span>,{' '}
            <span className="text-red-400 font-semibold">Troubled</span>.
          </p>
        </details>

        {/* Cross-market link */}
        <div className="card p-4 sm:p-5 mb-8 flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-white">Broadway Trending</div>
            <div className="text-xs text-gray-500 mt-0.5">See the buzziest New York shows</div>
          </div>
          <Link
            href="/trending"
            className="text-brand hover:text-brand-hover transition-colors text-sm font-medium"
          >
            View Broadway →
          </Link>
        </div>

        {/* Related links */}
        <div className="pt-6 border-t border-white/5">
          <h2 className="text-lg font-bold text-white mb-3">Related</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <Link href="/west-end/audience-buzz" className="text-brand hover:text-brand-hover transition-colors text-sm">
              West End AudienceGrade →
            </Link>
            <Link href="/west-end/methodology" className="text-brand hover:text-brand-hover transition-colors text-sm">
              How Scoring Works →
            </Link>
            <Link href="/west-end" className="text-brand hover:text-brand-hover transition-colors text-sm">
              All West End Shows →
            </Link>
          </div>
        </div>

        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Social data aggregated from Reddit, X, TikTok, and Instagram.
            Sentiment classified by LLM. Updated weekly.
          </p>
        </div>
      </div>
    </>
  );
}
