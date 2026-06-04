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
              Who <span className="text-gray-200 font-semibold">{SOURCES.length} outlets</span> predict will win, category by category.
              Bars show how many critics agree on each nominee.
            </p>

            {/* Outlet legend */}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
              {SOURCES.map(s => (
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
              const maxCount = Math.max(1, ...nominees.map(n => n.criticPicks?.length ?? 0));

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
                      const isLeader = count > 0 && count === maxCount;
                      const name = nom.nomineePersonName ?? nom.title;
                      const sub = nom.nomineePersonName ? nom.title : null;
                      return (
                        <div
                          key={nom.slug + (nom.nomineePersonName ?? '')}
                          className={`flex items-center gap-3 ${count === 0 ? 'opacity-45' : ''}`}
                        >
                          {/* Name */}
                          <div className="w-32 sm:w-44 flex-shrink-0 min-w-0">
                            <div className={`text-sm truncate ${isLeader ? 'text-white font-semibold' : 'text-gray-300'}`}>
                              {name}
                            </div>
                            {sub && <div className="text-[10px] text-gray-500 truncate">{sub}</div>}
                          </div>

                          {/* Bar */}
                          <div className="flex-1 min-w-0 h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                            <div
                              className={`h-full rounded-full ${isLeader ? 'bg-amber-400' : 'bg-amber-400/30'}`}
                              style={{ width: `${(count / Math.max(1, coveringOutlets)) * 100}%` }}
                            />
                          </div>

                          {/* Count */}
                          <div className={`w-5 flex-shrink-0 text-right text-sm tabular-nums ${count === 0 ? 'text-gray-600' : isLeader ? 'text-amber-300 font-bold' : 'text-gray-400'}`}>
                            {count}
                          </div>

                          {/* Logos */}
                          <div className="w-[112px] flex-shrink-0 flex flex-wrap items-center gap-0.5">
                            {(nom.criticPicks ?? []).map(id => (
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
