'use client';

import Link from 'next/link';
import { trackPromoClick } from '@/lib/promo-tracking';

type Accent = 'gold' | 'brand' | 'btc';

interface FeaturedSpotStat {
  value: string;
  label: string;
  /** Short label used in the compact mobile/tablet pill. Falls back to `label`. */
  compactLabel?: string;
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
  /** Identifier for analytics (placement + campaign). Required to track clicks. */
  trackingId?: string;
}


const ACCENT_DOT: Record<Accent, string> = {
  gold: 'bg-score-must-see shadow-[0_0_8px_rgba(255,215,0,0.6)]',
  brand: 'bg-brand shadow-[0_0_8px_rgba(212,165,116,0.5)]',
  btc: 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.55)]',
};

const ACCENT_TOP_EDGE: Record<Accent, string> = {
  gold: 'bg-gradient-to-r from-transparent via-score-must-see/70 to-transparent',
  brand: 'bg-gradient-to-r from-transparent via-brand/70 to-transparent',
  btc: 'bg-gradient-to-r from-transparent via-rose-500/70 to-transparent',
};

const ACCENT_DIVIDER: Record<Accent, string> = {
  gold: 'lg:before:bg-score-must-see/15',
  brand: 'lg:before:bg-brand/20',
  btc: 'lg:before:bg-rose-500/20',
};

const CTA_CLASS: Record<Accent, string> = {
  gold: 'bg-accent-warm text-surface hover:bg-brand hover:shadow-glow-sm',
  brand: 'bg-brand text-surface hover:bg-brand-hover hover:shadow-glow-sm',
  btc: 'bg-rose-500 text-white hover:bg-rose-400 hover:shadow-glow-sm',
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

function GoldCompactPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill score-must-see text-surface whitespace-nowrap shadow-[0_0_10px_rgba(255,215,0,0.25)]">
      <span className="text-[11px] font-extrabold leading-none">{value}</span>
      <span className="h-2.5 w-px bg-surface/40" aria-hidden="true" />
      <span className="text-[9px] font-bold uppercase tracking-wider leading-none">{label}</span>
    </div>
  );
}

function BrandCompactPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill bg-brand/15 border border-brand/40 text-brand-light whitespace-nowrap">
      <span className="text-[11px] font-extrabold leading-none">{value}</span>
      <span className="h-2.5 w-px bg-brand/40" aria-hidden="true" />
      <span className="text-[9px] font-bold uppercase tracking-wider leading-none">{label}</span>
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

function BtcCompactPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill score-must-see text-surface whitespace-nowrap shadow-[0_0_10px_rgba(255,215,0,0.25)]">
      <span className="text-[11px] font-extrabold leading-none">{value}</span>
      <span className="h-2.5 w-px bg-surface/40" aria-hidden="true" />
      <span className="text-[9px] font-bold uppercase tracking-wider leading-none">{label}</span>
    </div>
  );
}

function BtcStatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-pill score-must-see text-surface max-w-full shadow-[0_0_24px_rgba(255,215,0,0.25)]">
      <span className="text-2xl font-extrabold tracking-tight leading-none flex-shrink-0">{value}</span>
      <span className="h-7 w-px bg-surface/40 flex-shrink-0" aria-hidden="true" />
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
  trackingId,
}: FeaturedSpotProps) {
  const StatPill = accent === 'gold' ? GoldStatPill : accent === 'btc' ? BtcStatPill : BrandStatPill;
  const CompactPill = accent === 'gold' ? GoldCompactPill : accent === 'btc' ? BtcCompactPill : BrandCompactPill;
  const compactLabel = stat?.compactLabel ?? stat?.label;

  const handleClick = () => {
    if (!trackingId) return;
    trackPromoClick(trackingId, { variant: 'featured_spot', href, accent });
  };

  return (
    <section aria-label={`Featured: ${title}`} className="my-6 sm:my-8">
      <div className="group relative overflow-hidden rounded-card bg-surface-raised border border-white/5 shadow-card transition-all duration-200 hover:border-white/10 hover:shadow-card-hover">
        {/* Stretched link — makes the whole card clickable, single accessible anchor */}
        <Link
          href={href}
          prefetch={false}
          onClick={handleClick}
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
            <div className="flex items-center justify-between gap-3 lg:justify-start">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ACCENT_DOT[accent]}`} aria-hidden="true" />
                <span className="text-[11px] sm:text-xs font-bold uppercase tracking-[0.12em] text-gray-400 truncate">
                  {eyebrow}
                </span>
              </div>
              {stat && compactLabel && (
                <div className="lg:hidden flex-shrink-0">
                  <CompactPill value={stat.value} label={compactLabel} />
                </div>
              )}
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
