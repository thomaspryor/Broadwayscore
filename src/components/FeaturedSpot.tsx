import Link from 'next/link';

type Accent = 'gold' | 'brand';

interface FeaturedSpotStat {
  value: string;
  label: string;
}

interface FeaturedSpotSecondary {
  value: string;
  label: string;
}

interface FeaturedSpotProps {
  eyebrow: string;
  title: string;
  description: string;
  ctaLabel: string;
  href: string;
  accent?: Accent;
  stat?: FeaturedSpotStat;
  secondary?: FeaturedSpotSecondary[];
}

const ACCENT_DOT: Record<Accent, string> = {
  gold: 'bg-score-must-see shadow-[0_0_8px_rgba(255,215,0,0.6)]',
  brand: 'bg-brand shadow-[0_0_8px_rgba(212,165,116,0.5)]',
};

const ACCENT_TOP_EDGE: Record<Accent, string> = {
  gold: 'bg-gradient-to-r from-transparent via-score-must-see/70 to-transparent',
  brand: 'bg-gradient-to-r from-transparent via-brand/70 to-transparent',
};

const ACCENT_DIVIDER: Record<Accent, string> = {
  gold: 'lg:before:bg-score-must-see/15',
  brand: 'lg:before:bg-brand/20',
};

const CTA_CLASS: Record<Accent, string> = {
  gold: 'bg-accent-warm text-surface hover:bg-brand hover:shadow-glow-sm',
  brand: 'bg-brand text-surface hover:bg-brand-hover hover:shadow-glow-sm',
};

const ArrowIcon = () => (
  <svg
    className="w-4 h-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7 17L17 7M9 7h8v8" />
  </svg>
);

function GoldStatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-pill score-must-see text-surface max-w-full">
      <span className="text-2xl font-extrabold tracking-tight leading-none flex-shrink-0">{value}</span>
      <span className="h-7 w-px bg-surface/40 flex-shrink-0" aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-wider leading-tight min-w-0">{label}</span>
    </div>
  );
}

function BrandStatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-pill bg-brand/15 border border-brand/30 text-brand-light max-w-full">
      <span className="text-2xl font-extrabold tracking-tight leading-none flex-shrink-0">{value}</span>
      <span className="h-7 w-px bg-brand/40 flex-shrink-0" aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-wider leading-tight min-w-0">{label}</span>
    </div>
  );
}

export default function FeaturedSpot({
  eyebrow,
  title,
  description,
  ctaLabel,
  href,
  accent = 'gold',
  stat,
  secondary,
}: FeaturedSpotProps) {
  const StatPill = accent === 'gold' ? GoldStatPill : BrandStatPill;

  return (
    <section aria-label={`Featured: ${title}`} className="my-6 sm:my-8">
      <div className="group relative overflow-hidden rounded-card bg-surface-raised border border-white/5 shadow-card transition-all duration-200 hover:border-white/10 hover:shadow-card-hover">
        {/* Stretched link — makes the whole card clickable, single accessible anchor */}
        <Link
          href={href}
          prefetch={false}
          aria-label={`${title} — ${ctaLabel}`}
          className="absolute inset-0 z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-card"
        >
          <span className="sr-only">{ctaLabel}</span>
        </Link>

        {/* Top accent edge */}
        <div className={`absolute inset-x-0 top-0 h-px ${ACCENT_TOP_EDGE[accent]}`} aria-hidden="true" />

        <div
          className={`relative grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] ${ACCENT_DIVIDER[accent]} lg:before:content-[''] lg:before:absolute lg:before:top-6 lg:before:bottom-6 lg:before:left-[58.333%] lg:before:w-px`}
        >
          {/* Left / primary content */}
          <div className="p-5 sm:p-6 flex flex-col gap-2.5 sm:gap-3">
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${ACCENT_DOT[accent]}`} aria-hidden="true" />
              <span className="text-[11px] sm:text-xs font-bold uppercase tracking-[0.12em] text-gray-400">
                {eyebrow}
              </span>
            </div>

            <h3 className="text-xl sm:text-2xl lg:text-[1.625rem] leading-tight font-extrabold text-white tracking-tight">
              {title}
            </h3>

            <p className="text-gray-400 text-sm sm:text-[15px] leading-snug max-w-md">
              {description}
            </p>

            <div className="mt-1">
              <span
                aria-hidden="true"
                className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-pill font-bold text-sm sm:text-base transition-all duration-200 group-hover:shadow-glow-sm ${CTA_CLASS[accent]}`}
              >
                <span>{ctaLabel}</span>
                <ArrowIcon />
              </span>
            </div>
          </div>

          {/* Right / stat panel — desktop only */}
          {stat && (
            <div className="hidden lg:flex min-w-0 flex-col items-center justify-center gap-3 p-5 lg:p-6 bg-surface-raised">
              <StatPill value={stat.value} label={stat.label} />
              {secondary && secondary.length > 0 && (
                <div className="flex items-baseline gap-5 mt-1">
                  {secondary.map((s) => (
                    <div key={s.label} className="text-center">
                      <div className="text-base lg:text-lg font-bold text-white leading-tight">{s.value}</div>
                      <div className="text-[10px] lg:text-xs text-gray-500 uppercase tracking-wider">{s.label}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
