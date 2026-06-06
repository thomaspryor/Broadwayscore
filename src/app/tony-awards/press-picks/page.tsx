import type { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL, generateBreadcrumbSchema } from '@/lib/seo';
import { getTonySeasonWindow } from '@/lib/data-tony-predictions';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import { PressPicksBoard, type BoardCategory, type BoardSource } from './PressPicksBoard';
import criticPicksData from '../../../../data/tony-critic-picks.json';

const season = getTonySeasonWindow();

interface PickSource { id: string; outlet: string; critic: string; shortName: string }
const SOURCES = (criticPicksData as { sources: PickSource[] }).sources;
const PICK_CATEGORIES = new Set(Object.keys((criticPicksData as { picks: Record<string, unknown> }).picks));

export const metadata: Metadata = {
  title: `${season.ceremonyYear} Tony Awards — Critic Press Picks`,
  description: `Who ${SOURCES.length} critics predict will win at the ${season.ceremonyYear} Tony Awards, category by category — plus a "should win" view. See where the press agrees and where it splits.`,
  alternates: { canonical: `${BASE_URL}/tony-awards/press-picks` },
  openGraph: {
    title: `${season.ceremonyYear} Tony Awards — Critic Press Picks`,
    description: `Every ${season.ceremonyYear} Tony category with the predicted winner from ${SOURCES.length} outlets. Toggle to "should win" to see critics' personal favorites.`,
    url: `${BASE_URL}/tony-awards/press-picks`,
    type: 'website',
  },
};

export default function TonyPressPicksPage() {
  const cats = getNomineesByCategory(season).filter(
    c => PICK_CATEGORIES.has(c.title) && c.shows.length > 0,
  );

  // Build a serializable board prop: per nominee, the outlet IDs for will + should.
  const categories: BoardCategory[] = cats.map(cat => ({
    key: cat.key,
    title: cat.title,
    nominees: cat.shows.map(s => ({
      key: s.slug + (s.nomineePersonName ?? ''),
      name: s.nomineePersonName ?? s.title,
      sub: s.nomineePersonName ? s.title : null,
      will: s.criticPicks ?? [],
      should: s.shouldPicks ?? [],
    })),
  }));

  const sources: BoardSource[] = SOURCES.map(s => ({ id: s.id, outlet: s.outlet, critic: s.critic }));

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
          <header>
            <Link href="/tony-awards/nominees" className="text-xs text-gray-500 hover:text-brand transition-colors">
              ← Tony Nominations Center
            </Link>
            <h1 className="mt-2 text-2xl sm:text-3xl font-bold text-white">
              {season.ceremonyYear} Tony Awards — Critic Press Picks
            </h1>
            <PressPicksBoard categories={categories} sources={sources} />
          </header>

          <footer className="mt-8 text-center text-[11px] text-gray-600">
            Broadway Scorecard · broadwayscorecard.com/tony-awards/press-picks
          </footer>
        </div>
      </main>
    </>
  );
}
