import type { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL, generateBreadcrumbSchema } from '@/lib/seo';
import { getTonySeasonWindow } from '@/lib/data-tony-predictions';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import { OutletPickLogo } from '@/components/tony/OutletPickLogo';
import criticPicksData from '../../../../data/tony-critic-picks.json';

const season = getTonySeasonWindow();

interface PickSource { id: string; outlet: string; critic: string; shortName: string }
const SOURCES = (criticPicksData as { sources: PickSource[] }).sources;
const PICK_CATEGORIES = new Set(Object.keys((criticPicksData as { picks: Record<string, unknown> }).picks));

// Display order only — NOT a credibility ranking. Every outlet counts as one
// equal vote in the consensus bars. Trades + theater specialists are listed
// first, general/lifestyle outlets last, purely so the legend reads sensibly.
const OUTLET_ORDER = ['nyt', 'nytpaulson', 'variety', 'thr', 'thewrap', 'timeout', 'slant', 'bg', 'chitrib', 'nytg', 'theatermania', 'nysun', 'ew', 'deadline', 'culturesauce', 'cityguide', 'vf', 'elle'];
const orderIdx = (id: string) => {
  const i = OUTLET_ORDER.indexOf(id);
  return i === -1 ? 999 : i;
};
const ORDERED_SOURCES = [...SOURCES].sort((a, b) => orderIdx(a.id) - orderIdx(b.id));

export const metadata: Metadata = {
  title: `${season.ceremonyYear} Tony Awards — Critic Press Picks`,
  description: `Who ${SOURCES.length} critics predict will win at the ${season.ceremonyYear} Tony Awards, category by category. See where the press agrees and where it splits.`,
  alternates: { canonical: `${BASE_URL}/tony-awards/press-picks` },
  openGraph: {
    title: `${season.ceremonyYear} Tony Awards — Critic Press Picks`,
    description: `Every ${season.ceremonyYear} Tony category with the predicted winner from ${SOURCES.length} outlets. See where critics agree and where they split.`,
    url: `${BASE_URL}/tony-awards/press-picks`,
    type: 'website',
  },
};

export default function TonyPressPicksPage() {
  const categories = getNomineesByCategory(season).filter(
    c => PICK_CATEGORIES.has(c.title) && c.shows.length > 0,
  );

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Press Picks', url: `${BASE_URL}/tony-awards/press-picks` },
  ]);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <main className="min-h-screen bg-surface">
        <div className="max-w-3xl mx-auto px-4 py-8 sm:py-10">
          {/* Header */}
          <header className="mb-7">
            <Link href="/tony-awards/nominees" className="text-xs text-gray-500 hover:text-brand transition-colors">
              ← Tony Nominations Center
            </Link>
            <h1 className="mt-2 text-2xl sm:text-3xl font-bold text-white">
              {season.ceremonyYear} Tony Awards — Critic Press Picks
            </h1>
            <p className="mt-1.5 text-sm text-gray-400">
              Who <span className="text-gray-200 font-semibold">{SOURCES.length} outlets</span> predict <span className="text-gray-200 font-semibold">will win</span> — not who <span className="italic">should</span> win.
              Bars show how many outlets agree on each nominee.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              When an outlet separated its prediction from a personal favorite, we use its &ldquo;will win&rdquo; call. Some outlets cover fewer categories, so each block notes how many weighed in.
            </p>

            {/* Outlet legend */}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
              {ORDERED_SOURCES.map(s => (
                <div key={s.id} className="flex items-center gap-1.5">
                  <OutletPickLogo outletId={s.id} />
                  <span className="text-[11px] text-gray-400 leading-none">
                    <span className="text-gray-200 font-medium">{s.outlet}</span>
                    <span className="text-gray-500"> · {s.critic}</span>
                  </span>
                </div>
              ))}
            </div>
          </header>

          {/* Category blocks */}
          <div className="space-y-5">
            {categories.map(cat => {
              const nominees = [...cat.shows].sort(
                (a, b) => (b.criticPicks?.length ?? 0) - (a.criticPicks?.length ?? 0)
                  || a.title.localeCompare(b.title),
              );
              const coveringOutlets = new Set(cat.shows.flatMap(s => s.criticPicks ?? [])).size;

              return (
                <section key={cat.key} className="bg-surface-raised rounded-xl p-4 sm:p-5">
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <h2 className="text-sm font-bold uppercase tracking-wide text-gray-300">{cat.title}</h2>
                    <span className="text-[11px] text-gray-500 flex-shrink-0">
                      {coveringOutlets} of {SOURCES.length} weighed in
                    </span>
                  </div>

                  <div className="space-y-2">
                    {nominees.map(nom => {
                      const count = nom.criticPicks?.length ?? 0;
                      const name = nom.nomineePersonName ?? nom.title;
                      const sub = nom.nomineePersonName ? nom.title : null;
                      return (
                        <div
                          key={nom.slug + (nom.nomineePersonName ?? '')}
                          className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3"
                        >
                          {/* Name */}
                          <div className="sm:w-44 sm:flex-shrink-0 min-w-0">
                            <div className="text-sm truncate text-gray-200">
                              {name}
                            </div>
                            {sub && <div className="text-[10px] text-gray-500 truncate">{sub}</div>}
                          </div>

                          {/* Bar + count (own full-width row on mobile so the bar never collapses) */}
                          <div className="flex items-center gap-2 sm:flex-1 min-w-0">
                            <div className="flex-1 min-w-0 h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                              <div
                                className="h-full rounded-full bg-amber-400"
                                style={{ width: `${(count / Math.max(1, coveringOutlets)) * 100}%` }}
                              />
                            </div>
                            <div className="w-5 flex-shrink-0 text-right text-sm tabular-nums text-gray-300">
                              {count}
                            </div>
                          </div>

                          {/* Logos */}
                          <div className="flex flex-wrap items-center gap-0.5 sm:w-[112px] sm:flex-shrink-0">
                            {(nom.criticPicks ?? []).slice().sort((a, b) => orderIdx(a) - orderIdx(b)).map(id => (
                              <OutletPickLogo key={id} outletId={id} />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <footer className="mt-8 text-center text-[11px] text-gray-600">
            Broadway Scorecard · broadwayscorecard.com/tony-awards/press-picks
          </footer>
        </div>
      </main>
    </>
  );
}
