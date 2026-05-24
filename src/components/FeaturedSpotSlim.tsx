import Link from 'next/link';

type Accent = 'gold' | 'btc';

interface FeaturedSpotSlimStat {
  value?: string;
  label: string;
  icon?: string;
}

interface FeaturedSpotSlimProps {
  eyebrow: string;
  title: string;
  ctaLabel: string;
  href: string;
  accent?: Accent;
  stat: FeaturedSpotSlimStat;
}

const ACCENT_DOT: Record<Accent, string> = {
  gold: 'bg-score-must-see shadow-[0_0_8px_rgba(255,215,0,0.6)]',
  btc: 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.55)]',
};

const ACCENT_TOP_EDGE: Record<Accent, string> = {
  gold: 'bg-gradient-to-r from-transparent via-score-must-see/60 to-transparent',
  btc: 'bg-gradient-to-r from-transparent via-rose-500/60 to-transparent',
};

const CTA_CLASS: Record<Accent, string> = {
  gold: 'bg-accent-warm text-surface group-hover:shadow-glow-sm',
  btc: 'bg-rose-500 text-white group-hover:bg-rose-400',
};

const ArrowIcon = () => (
  <svg
    className="w-3.5 h-3.5"
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

function StatPill({ accent, stat }: { accent: Accent; stat: FeaturedSpotSlimStat }) {
  if (accent === 'gold') {
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill score-must-see text-surface whitespace-nowrap shadow-[0_0_10px_rgba(255,215,0,0.25)]">
        {stat.value && (
          <>
            <span className="text-[11px] font-extrabold leading-none">{stat.value}</span>
            <span className="h-2.5 w-px bg-surface/40" aria-hidden="true" />
          </>
        )}
        <span className="text-[9px] font-bold uppercase tracking-wider leading-none">{stat.label}</span>
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-rose-500/10 border border-rose-500/40 text-rose-300 whitespace-nowrap">
      {stat.icon && <span className="text-[11px] leading-none">{stat.icon}</span>}
      <span className="text-[10px] font-bold uppercase tracking-wider leading-none">{stat.label}</span>
    </div>
  );
}

export default function FeaturedSpotSlim({
  eyebrow,
  title,
  ctaLabel,
  href,
  accent = 'gold',
  stat,
}: FeaturedSpotSlimProps) {
  return (
    <section aria-label={`Featured: ${title}`} className="mb-4 sm:mb-6">
      <div className="group relative overflow-hidden rounded-card bg-surface-raised border border-white/5 shadow-card transition-all duration-200 hover:border-white/10 hover:shadow-card-hover">
        <Link
          href={href}
          prefetch={false}
          aria-label={`${title} — ${ctaLabel}`}
          className="absolute inset-0 z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-card"
        >
          <span className="sr-only">{ctaLabel}</span>
        </Link>

        <div className={`absolute inset-x-0 top-0 h-px ${ACCENT_TOP_EDGE[accent]}`} aria-hidden="true" />

        <div className="relative flex items-center gap-3 sm:gap-4 px-4 py-3 sm:px-5 sm:py-3.5">
          {/* Left: eyebrow + title */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5 sm:mb-1">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ACCENT_DOT[accent]}`} aria-hidden="true" />
              <span className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">
                {eyebrow}
              </span>
            </div>
            <h3 className="text-sm sm:text-lg font-extrabold text-white tracking-tight leading-tight truncate">
              {title}
            </h3>
          </div>

          {/* Right: pill + CTA */}
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            <div className="hidden sm:block">
              <StatPill accent={accent} stat={stat} />
            </div>
            <span
              aria-hidden="true"
              className={`inline-flex items-center gap-1.5 px-3 py-2 sm:px-4 sm:py-2.5 rounded-pill font-bold text-xs sm:text-sm transition-all duration-200 whitespace-nowrap ${CTA_CLASS[accent]}`}
            >
              <span className="hidden sm:inline">{ctaLabel}</span>
              <span className="sm:hidden">{ctaLabel.split(' ').slice(0, 2).join(' ')}</span>
              <ArrowIcon />
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
