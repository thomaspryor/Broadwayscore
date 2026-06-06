import Link from 'next/link';
import type { Metadata } from 'next';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getTonySeasonWindow, type TonyCategory, type SerializedTonyShow } from '@/lib/data-tony-predictions';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import { getOptimizedImageUrl } from '@/lib/images';
import { SHOW_LEVEL_CATEGORIES, PERSON_LEVEL_CATEGORIES } from '@/components/tony-noms/CategorySection';

const season = getTonySeasonWindow();

export const metadata: Metadata = {
  title: `2026 Tony Award Winners — ${season.ceremonyYear} Tony Awards Results`,
  description: `Complete list of 2026 Tony Award winners and top predictions for the 79th Annual Tony Awards ceremony. Ranked by critic score, audience grade, and GoldDerby win odds.`,
  alternates: {
    canonical: `${BASE_URL}/tony-awards/winners-2026`,
  },
  openGraph: {
    title: `2026 Tony Award Winners — Broadway Scorecard`,
    description: `Who won the 2026 Tony Awards? Data-driven predictions ranked by critic score, audience grade, and GoldDerby win odds.`,
    url: `${BASE_URL}/tony-awards/winners-2026`,
    type: 'website',
  },
};

const MAJOR_CATEGORY_ORDER = [
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
];

const ACTING_CATEGORY_ORDER = [
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
];

function formatOdds(odds: number | null | undefined): string | null {
  if (odds == null || odds <= 0) return null;
  return `${Math.round(odds * 100)}%`;
}

function WinnerRow({
  category,
  winner,
  isPrediction,
}: {
  category: TonyCategory;
  winner: SerializedTonyShow;
  isPrediction: boolean;
}) {
  const isPersonLevel = PERSON_LEVEL_CATEGORIES.has(category.title);
  const name = isPersonLevel ? (winner.nomineePersonName ?? winner.title) : winner.title;
  const subtitle = isPersonLevel ? winner.title : null;
  const showUrl = `/show/${winner.slug}`;
  const personUrl = winner.nomineeActorSlug ? `/cast/${winner.nomineeActorSlug}` : null;
  const odds = formatOdds(winner.gdOdds);
  const picksCount = winner.criticPicks?.length ?? 0;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-raised hover:bg-surface-overlay transition-colors">
      {winner.thumbnailPath ? (
        <Link href={showUrl} className="w-10 h-10 rounded-lg overflow-hidden bg-surface flex-shrink-0" tabIndex={-1} aria-hidden="true">
          <img
            src={getOptimizedImageUrl(winner.thumbnailPath, 'thumbnail')}
            alt=""
            className="w-full h-full object-cover"
            width={40}
            height={40}
            loading="lazy"
          />
        </Link>
      ) : (
        <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center flex-shrink-0 text-sm" aria-hidden="true">🎭</div>
      )}

      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-gray-500 mb-0.5 truncate">{category.title}</div>
        <div className="font-semibold text-white text-sm leading-snug truncate">
          {personUrl ? (
            <Link href={personUrl} className="hover:text-brand transition-colors">{name}</Link>
          ) : (
            <Link href={showUrl} className="hover:text-brand transition-colors">{name}</Link>
          )}
        </div>
        {subtitle && (
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            <Link href={showUrl} className="hover:text-gray-300 transition-colors">{subtitle}</Link>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2.5 flex-shrink-0">
        {picksCount > 0 && (
          <div className="text-center">
            <div className="text-xs font-bold text-white leading-none">{picksCount}</div>
            <div className="text-[9px] text-gray-500 uppercase tracking-wide leading-none mt-0.5">picks</div>
          </div>
        )}
        {odds && (
          <div className="text-center min-w-[40px]">
            <div className="text-sm font-bold text-brand leading-none">{odds}</div>
            <div className="text-[9px] text-gray-500 uppercase tracking-wide leading-none mt-0.5">GD odds</div>
          </div>
        )}
        <span className={`text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap ${
          isPrediction
            ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20'
            : 'bg-green-500/15 text-green-400 border border-green-500/20'
        }`}>
          {isPrediction ? 'Predicted' : 'Winner ✓'}
        </span>
      </div>
    </div>
  );
}

function WinnerGroup({
  heading,
  categories,
  isPrediction,
}: {
  heading: string;
  categories: TonyCategory[];
  isPrediction: boolean;
}) {
  const visible = categories.filter(c => c.shows.length > 0);
  if (visible.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-3">{heading}</h2>
      <div className="space-y-2">
        {visible.map(cat => (
          <WinnerRow key={cat.key} category={cat} winner={cat.shows[0]} isPrediction={isPrediction} />
        ))}
      </div>
    </section>
  );
}

export default function TonyWinners2026Page() {
  const categories = getNomineesByCategory(season);
  const catMap = new Map(categories.map(c => [c.title, c]));

  const majorCats = MAJOR_CATEGORY_ORDER.flatMap(t => {
    const c = catMap.get(t);
    return c ? [c] : [];
  });

  const actingCats = ACTING_CATEGORY_ORDER.flatMap(t => {
    const c = catMap.get(t);
    return c ? [c] : [];
  });

  const otherCats = categories.filter(
    c => !SHOW_LEVEL_CATEGORIES.has(c.title) && !PERSON_LEVEL_CATEGORIES.has(c.title),
  );

  const isPrediction = new Date() < new Date('2026-06-09T00:00:00Z');

  const breadcrumb = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Winners 2026', url: `${BASE_URL}/tony-awards/winners-2026` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link
          href="/tony-awards"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Tony Awards
        </Link>

        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-white">
            2026 Tony Award Winners
          </h1>
          <p className="text-gray-400 mt-1 text-sm">
            79th Annual Tony Awards &middot; June 8, 2026 &middot; Radio City Music Hall
          </p>
        </div>

        {isPrediction && (
          <div className="mb-6 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-sm">
            <span className="text-amber-400 font-semibold">Predictions, not results.</span>
            <span className="text-gray-400"> The ceremony airs June 8 at 8 PM ET on CBS. This page will update with winners as they&apos;re announced.</span>
          </div>
        )}

        <WinnerGroup heading="Best Shows" categories={majorCats} isPrediction={isPrediction} />
        <WinnerGroup heading="Best Performances" categories={actingCats} isPrediction={isPrediction} />
        <WinnerGroup heading="Creative &amp; Design" categories={otherCats} isPrediction={isPrediction} />

        <div className="mt-8 pt-6 border-t border-white/8 text-sm flex flex-wrap gap-x-6 gap-y-2 text-gray-400">
          <Link href="/tony-awards/nominees" className="text-brand hover:text-brand-hover transition-colors">
            All 2026 Nominees →
          </Link>
          <Link href="/tony-awards/predictions" className="text-brand hover:text-brand-hover transition-colors">
            Full Predictions →
          </Link>
          <Link href="/tony-awards/press-picks" className="text-brand hover:text-brand-hover transition-colors">
            Critic Picks →
          </Link>
        </div>

        <p className="mt-4 text-xs text-gray-600">
          Win odds from GoldDerby (crowd predictions). Critic picks from 20+ outlets. Updated daily until ceremony night.
        </p>
      </div>
    </>
  );
}
