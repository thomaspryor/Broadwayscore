import Link from 'next/link';
import type { Metadata } from 'next';
import { getWestEndShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getScoreTier } from '@/components/show-cards/ScoreBadge';
import awardsData from '../../../data/awards.json';

// --- SEO ---

export const metadata: Metadata = {
  title: { absolute: 'Olivier Awards — West End Winners, Scores & History' },
  description:
    'The Laurence Olivier Awards are London\u2019s highest theatre honour. Recent winners and their West End Scorecard critic ratings across Best New Musical, Best New Play, and Best Revival.',
  alternates: {
    canonical: `${BASE_URL}/olivier-awards`,
  },
  openGraph: {
    title: 'Olivier Awards — West End Scorecard',
    description: 'Recent Olivier Award winners ranked by critic scores — the UK\u2019s equivalent of the Tony Awards.',
    url: `${BASE_URL}/olivier-awards`,
    type: 'website',
    siteName: 'West End Scorecard',
    images: [{ url: `${BASE_URL}/og/west-end.png`, width: 1200, height: 630, alt: 'Olivier Awards — West End Scorecard' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Olivier Awards — West End Scorecard',
    description: 'Recent Olivier Award winners ranked by critic scores.',
  },
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What are the Olivier Awards?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The Laurence Olivier Awards are presented annually by the Society of London Theatre to recognise excellence in professional theatre in London. They are the West End\u2019s equivalent of Broadway\u2019s Tony Awards and cover musicals, plays, dance, and opera.',
      },
    },
    {
      '@type': 'Question',
      name: 'Who gives out the Olivier Awards?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The Society of London Theatre administers the Oliviers with voting panels drawn from theatre professionals and committed theatregoers. Winners are announced at an annual ceremony, usually in April.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do critic scores compare to Olivier winners?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Most Olivier Best New Musical and Best New Play winners earn strong critic consensus before winning \u2014 though surprises happen, especially in revival categories where nostalgia and casting weigh more than raw reviews.',
      },
    },
  ],
};

// --- Data ---

interface OlivierShowData {
  season?: string;
  nominations?: number;
  nominatedFor?: string[];
  wins?: string[];
}

interface OlivierAwardsJson {
  _meta?: unknown;
  shows: Record<string, { olivier?: OlivierShowData } & Record<string, unknown>>;
}

interface OlivierWinnerRow {
  slug: string;
  title: string;
  season: string;
  category: string;
  wins: string[];
  nominations: number;
  compositeScore: number | null;
  reviewCount: number;
  market: string | undefined;
}

function buildRecentWinners(): OlivierWinnerRow[] {
  // Look up critic scores from computed West End shows (includes OWE).
  const westEndShows = getWestEndShows();
  const byId = new Map(westEndShows.map(s => [s.id, s]));

  const awards = (awardsData as OlivierAwardsJson).shows ?? {};
  const rows: OlivierWinnerRow[] = [];

  for (const [id, data] of Object.entries(awards)) {
    const olivier = data.olivier;
    if (!olivier?.wins || olivier.wins.length === 0) continue;
    const computed = byId.get(id);
    if (!computed) continue; // only include shows we have in the WE database

    // Pick the "headline" win to feature — Best New Musical > Best New Play > Best Revival > others
    const preferred =
      olivier.wins.find(w => /Best New Musical/i.test(w)) ||
      olivier.wins.find(w => /Best New Play/i.test(w)) ||
      olivier.wins.find(w => /Musical Revival|New Musical/i.test(w)) ||
      olivier.wins.find(w => /Best Revival|Play Revival/i.test(w)) ||
      olivier.wins[0];

    rows.push({
      slug: computed.slug,
      title: computed.title,
      season: olivier.season ?? '',
      category: preferred,
      wins: olivier.wins,
      nominations: olivier.nominations ?? olivier.wins.length,
      compositeScore: computed.compositeScore ?? null,
      reviewCount: computed.criticScore?.reviewCount ?? 0,
      market: computed.category,
    });
  }

  // Sort by season descending (newest first), then by number of wins
  rows.sort((a, b) => {
    const seasonCmp = b.season.localeCompare(a.season);
    if (seasonCmp !== 0) return seasonCmp;
    return b.wins.length - a.wins.length;
  });

  return rows;
}

export default function OlivierAwardsHubPage() {
  const allWinners = buildRecentWinners();
  const recent = allWinners.slice(0, 40);

  const totalWinners = allWinners.length;
  const totalWinTitles = allWinners.reduce((sum, r) => sum + r.wins.length, 0);
  const bestNewMusicalWinners = allWinners.filter(r => r.wins.some(w => /Best New Musical/i.test(w))).length;
  const bestNewPlayWinners = allWinners.filter(r => r.wins.some(w => /Best New Play/i.test(w))).length;

  // Breadcrumb schema: /olivier-awards is a top-level route (not under /west-end/),
  // so the structured-data breadcrumb should be Home > Olivier Awards — not
  // Home > West End > Olivier Awards. The visual back-link still goes to /west-end
  // for navigation UX, but Google's breadcrumb must match the URL hierarchy.
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Olivier Awards', url: `${BASE_URL}/olivier-awards` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/west-end" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All West End Shows
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Olivier Awards</h1>
          <p className="text-gray-400 mt-2 max-w-2xl">
            The Laurence Olivier Awards are London&apos;s highest theatre honour — the West End&apos;s equivalent of Broadway&apos;s Tonys. Recent winners, their critic scores, and how reviews line up with the prize.
          </p>
        </div>

        {/* Quick Stats — scoped to the WE shows we can actually score */}
        <div className="grid grid-cols-3 gap-4 mb-10">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{totalWinners}</div>
            <div className="text-xs text-gray-500 mt-1">Recent winning shows</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-brand">{totalWinTitles.toLocaleString('en-GB')}</div>
            <div className="text-xs text-gray-500 mt-1">Oliviers won by those shows</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-amber-300">{bestNewMusicalWinners + bestNewPlayWinners}</div>
            <div className="text-xs text-gray-500 mt-1">Best Musical / Play winners</div>
          </div>
        </div>

        {/* Recent Winners Table */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-2">Recent Olivier Winners &amp; Their Scores</h2>
          <p className="text-sm text-gray-400 mb-4">
            The most recent {recent.length} Olivier-winning productions in our database, with critic scores where available.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/5">
                  <th className="pb-3 pr-4">Season</th>
                  <th className="pb-3 pr-4">Show</th>
                  <th className="pb-3 pr-4">Headline Win</th>
                  <th className="pb-3 pr-4 text-right">Wins</th>
                  <th className="pb-3 text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((w, i) => {
                  const tier = getScoreTier(w.compositeScore);
                  return (
                    <tr key={`${w.slug}-${i}`} className="border-b border-white/5">
                      <td className="py-2.5 pr-4 text-sm text-gray-400">{w.season}</td>
                      <td className="py-2.5 pr-4">
                        <Link href={`/show/${w.slug}`} className="text-sm font-medium text-white hover:text-brand transition-colors">
                          {w.title}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-sm text-gray-400">{w.category.replace(/^Best /, '')}</td>
                      <td className="py-2.5 pr-4 text-right text-sm text-gray-300">{w.wins.length}</td>
                      <td className="py-2.5 text-right">
                        {w.compositeScore !== null ? (
                          <span className="text-sm font-semibold" style={{ color: tier?.color || '#9ca3af' }}>
                            {Math.round(w.compositeScore)}
                          </span>
                        ) : (
                          <span className="text-sm text-gray-500">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* About */}
        <section className="mb-10 card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-3">About the Olivier Awards</h2>
          <p className="text-gray-300 mb-3">
            The Laurence Olivier Awards are presented annually by the Society of London Theatre (SOLT) to recognise excellence in professional theatre in London. Named after the British actor Laurence Olivier, they cover musicals, plays, dance, opera, and affiliate theatre.
          </p>
          <p className="text-gray-300 mb-3">
            Major categories include Best New Musical, Best New Play, Best Musical Revival, Best Revival (Play), Best Actor, and Best Actress. Winners are typically announced at a ceremony in April held at the Royal Albert Hall.
          </p>
          <p className="text-gray-300">
            Oliviers are the UK counterpart to Broadway&apos;s Tony Awards. Shows that triumph at one often transfer across the Atlantic — winning at both is a rare distinction reserved for the decade&apos;s defining productions.
          </p>
        </section>

        {/* Footer links */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <div className="flex flex-wrap gap-4">
            <Link href="/west-end/methodology" className="text-brand hover:text-brand-hover transition-colors">
              Scoring methodology →
            </Link>
            <Link href="/tony-awards" className="text-brand hover:text-brand-hover transition-colors">
              Tony Awards (Broadway) →
            </Link>
            <Link href="/west-end" className="text-brand hover:text-brand-hover transition-colors">
              All West End shows →
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
