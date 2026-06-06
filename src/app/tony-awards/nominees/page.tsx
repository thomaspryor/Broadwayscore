import Link from 'next/link';
import type { Metadata } from 'next';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getTonySeasonWindow } from '@/lib/data-tony-predictions';
import { tonySeasonForCeremonyYear } from '@/lib/tony-cutoffs';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import { CeremonyCountdown } from '@/components/tony/CeremonyCountdown';
import { featureFlags } from '@/config/feature-flags';
import { CategorySection, SHOW_LEVEL_CATEGORIES } from '@/components/tony-noms/CategorySection';

const SHOW_OUR_PICK = featureFlags.tonyPredictionsOurPick;

const season = getTonySeasonWindow();
const seasonRecord = tonySeasonForCeremonyYear(season.ceremonyYear);
const ceremonyDate = seasonRecord?.ceremonyDate ?? null;

// --- SEO ---

export const metadata: Metadata = {
  title: `${season.ceremonyYear} Tony Nominations Center — Critic, Audience & Odds`,
  description: `Every ${season.label} Tony-nominated show and nominee ranked by critic score, audience grade, and win odds from GoldDerby, Polymarket, and Kalshi. All 26 categories.`,
  alternates: {
    canonical: `${BASE_URL}/tony-awards/nominees`,
  },
  openGraph: {
    title: `${season.ceremonyYear} Tony Nominations Center — Broadway Scorecard`,
    description: `All ${season.label} Tony nominees with critic scores, audience grades, and crowd-sourced win odds from GoldDerby, Polymarket, and Kalshi.`,
    url: `${BASE_URL}/tony-awards/nominees`,
    type: 'website',
  },
};

// --- Helpers ---

function formatCeremonyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// All row/category components moved to @/components/tony-noms/CategorySection (shared with predictions page).


// --- Page ---

export default function TonyNomineesPage() {
  const categories = getNomineesByCategory(season);
  const totalCategories = categories.filter(c => c.shows.length > 0).length;

  // Softmax win probabilities per major category (T=7, matches predictions [season] page).
  // Only computed for the 4 top categories — performer/craft don't have a model output.
  const T = 7;
  const categoryWinProbs = new Map<string, Map<string, number>>();
  for (const cat of categories) {
    if (!SHOW_LEVEL_CATEGORIES.has(cat.title)) continue;
    const scored = cat.shows.filter(s => s.blendedScore != null);
    if (scored.length === 0) continue;
    const exps = scored.map(s => Math.exp(s.blendedScore! / T));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = new Map<string, number>();
    scored.forEach((show, i) => probs.set(show.slug, exps[i] / sum));
    categoryWinProbs.set(cat.key, probs);
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Nominees', url: `${BASE_URL}/tony-awards/nominees` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Back link */}
        <Link
          href="/tony-awards"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Tony Awards
        </Link>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-white">
              {season.ceremonyYear} Tony Nominations Center
            </h1>
            {ceremonyDate && (
              <span className="hidden sm:inline-flex text-xs font-medium px-3 py-1.5 rounded-full bg-brand/10 text-brand border border-brand/20 flex-shrink-0 whitespace-nowrap self-start mt-1">
                Ceremony {formatCeremonyDate(ceremonyDate)}
              </span>
            )}
          </div>
          <p className="text-gray-400 mt-1 text-sm">
            {totalCategories} categories &middot; critic scores, audience grades, and win odds. Updated daily.
          </p>
          {ceremonyDate && (
            <div className="mt-2 flex items-center gap-2">
              <span className="sm:hidden text-xs font-medium px-2.5 py-1 rounded-full bg-brand/10 text-brand border border-brand/20 whitespace-nowrap">
                Ceremony {formatCeremonyDate(ceremonyDate)}
              </span>
              <CeremonyCountdown ceremonyDate={ceremonyDate} />
            </div>
          )}
        </div>

        {/* Announcement banner — hidden once Our Pick is live (flag-gated) or after May 24 */}
        {!SHOW_OUR_PICK && new Date() < new Date('2026-05-25T00:00:00Z') && (
          <div className="mb-6 px-4 py-3 rounded-xl border border-white/8 bg-surface-raised text-sm">
            <span className="text-brand font-semibold">Win predictions coming Saturday, May 24.</span>
            {' '}Our model ranks each nominee&apos;s win probability based on all this data.
          </div>
        )}

        {/* After predictions launch: persistent link to predictions page */}
        {!SHOW_OUR_PICK && new Date() >= new Date('2026-05-23T00:00:00Z') && (
          <div className="mb-6 px-4 py-3 rounded-xl border border-white/8 bg-surface-raised text-sm flex items-center justify-between gap-3">
            <span className="text-gray-300">Our critic, audience &amp; awards model has ranked nominees by win probability.</span>
            <Link href="/tony-awards/predictions" className="text-brand font-semibold whitespace-nowrap hover:text-brand-hover transition-colors">
              See predictions →
            </Link>
          </div>
        )}

        {/* Link to winners page — visible near ceremony */}
        {new Date() >= new Date('2026-05-23T00:00:00Z') && (
          <div className="mb-6 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-sm flex items-center justify-between gap-3">
            <span className="text-gray-300">See who we think wins each of the 26 categories.</span>
            <Link href="/tony-awards/winners-2026" className="text-amber-400 font-semibold whitespace-nowrap hover:text-amber-300 transition-colors">
              Predicted winners →
            </Link>
          </div>
        )}

        {/* Category sections */}
        {categories.map(cat => (
          <CategorySection key={cat.key} category={cat} winProbs={categoryWinProbs.get(cat.key)} ceremonyDate={ceremonyDate} />
        ))}

        {/* Legend */}
        <div className="mt-8 text-xs text-gray-600 text-center space-y-1.5">
          <p>Win odds: GoldDerby (crowd predictions, 26 categories) · Kalshi (real-money market, 25 categories) · Polymarket (real-money market, 3 categories)</p>
          <p>Odds may sum to more or less than 100% — prediction markets include a house spread.</p>
          <p>Award Score: composite of Drama League, Outer Critics Circle, and Drama Desk wins in this category (0–100). Press Picks: predicted winners from NYT (Helen Shaw) and Variety (Clayton Davis).</p>
        </div>
      </div>
    </>
  );
}
