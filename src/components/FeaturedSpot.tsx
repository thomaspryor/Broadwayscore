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
  gold: 'sm:before:bg-score-must-see/15',
  brand: 'sm:before:bg-brand/20',
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

function GoldStatPill({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? 'inline-flex items-center gap-2 px-2.5 py-1 rounded-pill score-must-see text-surface text-xs font-bold leading-none whitespace-nowrap'
          : 'inline-flex items-center gap-3 px-5 py-3 rounded-pill score-must-see text-surface whitespace-nowrap'
      }
    >
      <span className={compact ? 'text-xs font-extrabold' : 'text-2xl sm:text-3xl font-extrabold tracking-tight'}>
        {value}
      </span>
      <span className={compact ? 'h-3 w-px bg-surface/40' : 'h-7 w-px bg-surface/40'} aria-hidden="true" />
      <span
        className={
          compact
            ? 'text-[10px] font-semibold uppercase tracking-wider'
            : 'text-[11px] font-bold uppercase tracking-wider leading-tight max-w-[6.5rem]'
        }
      >
        {label}
      </span>
    </div>
  );
}

function BrandStatPill({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? 'inline-flex items-center gap-2 px-2.5 py-1 rounded-pill bg-brand/15 border border-brand/30 text-brand-light text-xs font-bold leading-none whitespace-nowrap'
          : 'inline-flex items-center gap-3 px-5 py-3 rounded-pill bg-brand/15 border border-brand/30 text-brand-light whitespace-nowrap'
      }
    >
      <span className={compact ? 'text-xs font-extrabold' : 'text-2xl sm:text-3xl font-extrabold tracking-tight'}>
        {value}
      </span>
      <span className={compact ? 'h-3 w-px bg-brand/40' : 'h-7 w-px bg-brand/40'} aria-hidden="true" />
      <span
        className={
          compact
            ? 'text-[10px] font-semibold uppercase tracking-wider'
            : 'text-[11px] font-bold uppercase tracking-wider leading-tight max-w-[6.5rem]'
        }
      >
        {label}
      </span>
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
      <div className="relative overflow-hidden rounded-card bg-surface-raised border border-white/5 shadow-card">
        {/* Top accent edge */}
        <div className={`absolute inset-x-0 top-0 h-px ${ACCENT_TOP_EDGE[accent]}`} aria-hidden="true" />

        <div
          className={`relative grid grid-cols-1 sm:grid-cols-[1.4fr_1fr] ${ACCENT_DIVIDER[accent]} sm:before:content-[''] sm:before:absolute sm:before:top-6 sm:before:bottom-6 sm:before:left-[58.333%] sm:before:w-px`}
        >
          {/* Left / primary content */}
          <div className="p-5 sm:p-8 flex flex-col gap-3 sm:gap-4">
            {/* Mobile: eyebrow + compact stat in one row. Desktop: eyebrow only. */}
            <div className="flex items-center justify-between gap-3 sm:justify-start">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${ACCENT_DOT[accent]}`} aria-hidden="true" />
                <span className="text-[11px] sm:text-xs font-bold uppercase tracking-[0.12em] text-gray-400">
                  {eyebrow}
                </span>
              </div>
              {stat && (
                <div className="sm:hidden">
                  <StatPill value={stat.value} label={stat.label} compact />
                </div>
              )}
            </div>

            <h3 className="text-xl sm:text-3xl lg:text-[2rem] leading-tight font-extrabold text-white tracking-tight">
              {title}
            </h3>

            <p className="hidden sm:block text-gray-400 text-base leading-relaxed max-w-md">
              {description}
            </p>

            <div className="mt-1 sm:mt-2">
              <Link
                href={href}
                prefetch={false}
                className={`inline-flex items-center gap-2 px-5 py-3 rounded-pill font-bold text-sm sm:text-base transition-all duration-200 active:scale-[0.98] ${CTA_CLASS[accent]}`}
              >
                <span>{ctaLabel}</span>
                <ArrowIcon />
              </Link>
            </div>
          </div>

          {/* Right / stat panel — desktop only */}
          {stat && (
            <div className="hidden sm:flex flex-col items-center justify-center gap-4 p-8 bg-surface-raised">
              <StatPill value={stat.value} label={stat.label} />
              {secondary && secondary.length > 0 && (
                <div className="flex items-baseline gap-6 mt-1">
                  {secondary.map((s) => (
                    <div key={s.label} className="text-center">
                      <div className="text-lg font-bold text-white leading-tight">{s.value}</div>
                      <div className="text-xs text-gray-500 uppercase tracking-wider">{s.label}</div>
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
