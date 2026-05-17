import Link from 'next/link';
import type { Metadata } from 'next';
import { getOptimizedImageUrl } from '@/lib/images';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { BlendedTrioDisplay, ScoreBadge, AudienceChip } from '@/components/show-cards';
import { getTonySeasonWindow } from '@/lib/data-tony-predictions';
import { tonySeasonForCeremonyYear } from '@/lib/tony-cutoffs';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import type { TonyCategory } from '@/lib/data-tony-predictions';

// --- Constants ---

const SHOW_LEVEL_CATEGORIES = new Set([
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
]);

const season = getTonySeasonWindow();
const seasonRecord = tonySeasonForCeremonyYear(season.ceremonyYear);
const ceremonyDate = seasonRecord?.ceremonyDate ?? null;

// --- SEO ---

export const metadata: Metadata = {
  title: `${season.ceremonyYear} Tony Awards Nominees — Critic, Audience & Odds`,
  description: `Every ${season.label} Tony-nominated show and nominee ranked by critic score, audience grade, and win odds from GoldDerby. All 26 categories.`,
  alternates: {
    canonical: `${BASE_URL}/tony-awards/nominees`,
  },
  openGraph: {
    title: `${season.ceremonyYear} Tony Nominees — Broadway Scorecard`,
    description: `All ${season.label} Tony nominees with critic scores, audience grades, and crowd-sourced win odds.`,
    url: `${BASE_URL}/tony-awards/nominees`,
    type: 'website',
  },
};

// --- Helpers ---

function formatCeremonyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function OddsTag({ label, value }: { label: string; value: number | null | undefined }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 text-xs font-semibold">
      <span className="text-gray-400">{label}</span>
      <span className="text-white">{pct}%</span>
    </span>
  );
}

// --- Major category row (show-level, with BlendedTrioDisplay) ---

function MajorNomineeRow({ show }: { show: TonyCategory['shows'][number] }) {
  return (
    <Link
      href={`/show/${show.slug}`}
      className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl hover:bg-white/[0.03] transition-colors group"
    >
      {/* Thumbnail */}
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
        {show.thumbnailPath ? (
          <img
            src={getOptimizedImageUrl(show.thumbnailPath, 'thumbnail')}
            alt={show.title}
            className="w-full h-full object-cover"
            width={80}
            height={80}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-2xl">🎭</div>
        )}
      </div>

      {/* Title + odds */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm sm:text-base font-bold text-white truncate group-hover:text-brand transition-colors">
          {show.title}
        </h3>
        <p className="text-xs text-gray-500 truncate mt-0.5">{show.venue}</p>
        {(show.gdOdds != null || show.polymarketOdds != null) && (
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            <OddsTag label="GD" value={show.gdOdds} />
            <OddsTag label="PM" value={show.polymarketOdds} />
          </div>
        )}
      </div>

      {/* Scores */}
      <BlendedTrioDisplay
        blendedScore={show.blendedScore}
        compositeScore={show.compositeScore}
        reviewCount={show.reviewCount}
        status={show.status}
        audienceGrade={show.audienceGrade}
        awardsScore={show.awardsScore}
        awardsWeighted={show.tonyCategoryKey === 'best-play'}
        size="sm"
      />
    </Link>
  );
}

// --- Compact row (person-level or show-level non-major) ---

function CompactNomineeRow({ show }: { show: TonyCategory['shows'][number] }) {
  const displayName = show.nomineePersonName
    ? `${show.nomineePersonName} in ${show.title}`
    : show.title;

  return (
    <Link
      href={`/show/${show.slug}`}
      className="flex items-center gap-3 p-2.5 sm:p-3 rounded-lg hover:bg-white/[0.03] transition-colors group"
    >
      {/* Small thumbnail */}
      <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-md overflow-hidden bg-surface-raised flex-shrink-0">
        {show.thumbnailPath ? (
          <img
            src={getOptimizedImageUrl(show.thumbnailPath, 'thumbnail')}
            alt={show.title}
            className="w-full h-full object-cover"
            width={40}
            height={40}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm">🎭</div>
        )}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate group-hover:text-brand transition-colors">
          {displayName}
        </p>
      </div>

      {/* Score indicators */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Audience grade chip */}
        {show.audienceGrade && (
          <AudienceChip grade={show.audienceGrade} />
        )}

        {/* Critic score badge */}
        <div className="w-11 h-11 flex-shrink-0">
          <ScoreBadge
            score={show.compositeScore}
            size="sm"
            reviewCount={show.reviewCount}
            status={show.status}
          />
        </div>

        {/* Odds pills */}
        <div className="hidden sm:flex gap-1.5">
          <OddsTag label="GD" value={show.gdOdds} />
          <OddsTag label="PM" value={show.polymarketOdds} />
        </div>
      </div>
    </Link>
  );
}

// --- Category section ---

function CategorySection({ category }: { category: TonyCategory }) {
  const isMajor = SHOW_LEVEL_CATEGORIES.has(category.title);
  const nominees = category.shows;

  if (nominees.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
        {category.title}
      </h2>
      <div className="bg-surface-raised rounded-xl border border-white/5 divide-y divide-white/5">
        {nominees.map(show => (
          <div key={show.nomineePersonName ? `${show.slug}-${show.nomineePersonName}` : show.slug}>
            {isMajor ? (
              <MajorNomineeRow show={show} />
            ) : (
              <CompactNomineeRow show={show} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// --- Page ---

export default function TonyNomineesPage() {
  const categories = getNomineesByCategory(season);
  const totalCategories = categories.filter(c => c.shows.length > 0).length;

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
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">
              {season.ceremonyYear} Tony Nominees
            </h1>
            <p className="text-gray-400 mt-1 text-sm">
              {totalCategories} categories &middot; critic scores, audience grades, and win odds
            </p>
          </div>
          {ceremonyDate && (
            <span className="flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded-full bg-brand/10 text-brand border border-brand/20">
              Ceremony {formatCeremonyDate(ceremonyDate)}
            </span>
          )}
        </div>

        {/* Column key (compact rows) */}
        <div className="flex items-center justify-end gap-3 mb-4 text-xs text-gray-500">
          <span>audience</span>
          <span>critic</span>
          <span className="hidden sm:block">GD% · PM%</span>
        </div>

        {/* Category sections */}
        {categories.map(cat => (
          <CategorySection key={cat.key} category={cat} />
        ))}

        {/* Legend */}
        <p className="mt-8 text-xs text-gray-600 text-center">
          GD = GoldDerby crowd odds &middot; PM = Polymarket prediction market
        </p>
      </div>
    </>
  );
}
