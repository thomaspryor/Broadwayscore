'use client';

import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import { SCORE_TIERS } from '@/components/show-cards';

interface HomepageExplainerShelfProps {
  totalShows: number;
  totalReviews: number;
  totalCritics: number;
  totalOutlets: number;
}

// Round a count down to the nearest 50 for "X+" display, so the copy
// degrades gracefully as reviews are added.
function roundedFloor(n: number, step: number): number {
  return Math.max(step, Math.floor(n / step) * step);
}

export default function HomepageExplainerShelf({ totalShows, totalReviews, totalCritics, totalOutlets }: HomepageExplainerShelfProps) {
  if (!featureFlags.homepageExplainer) return null;

  const tiers = [
    { ...SCORE_TIERS.mustSee, sample: 92 },
    { ...SCORE_TIERS.recommended, sample: 78 },
    { ...SCORE_TIERS.worthSeeing, sample: 70 },
    { ...SCORE_TIERS.skippable, sample: 60 },
    { ...SCORE_TIERS.stayAway, sample: 45 },
  ];

  return (
    <section
      aria-labelledby="explainer-shelf-heading"
      className="mt-12 mb-8 rounded-card overflow-hidden border border-white/10 shadow-card"
    >
      {/* Hero band — gradient with floating sample badges */}
      <div className="relative px-6 sm:px-10 py-10 sm:py-14 bg-gradient-to-br from-brand/30 via-surface-raised to-surface-overlay overflow-hidden">
        {/* Floating sample score badges (decorative) */}
        <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
          <div className="absolute top-6 right-6 sm:top-10 sm:right-16 text-5xl sm:text-6xl font-extrabold text-white/10 select-none">93</div>
          <div className="absolute top-20 right-32 sm:top-24 sm:right-40 text-3xl sm:text-4xl font-extrabold text-white/[0.07] select-none hidden sm:block">88</div>
          <div className="absolute bottom-6 right-10 sm:bottom-10 sm:right-24 text-4xl sm:text-5xl font-extrabold text-white/[0.08] select-none">76</div>
          <div className="absolute bottom-16 left-6 sm:bottom-20 sm:left-12 text-3xl sm:text-4xl font-extrabold text-white/[0.06] select-none hidden sm:block">62</div>
        </div>

        <div className="relative max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-pill bg-white/10 backdrop-blur-sm text-xs font-semibold uppercase tracking-wider text-white mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-brand" />
            What is Broadway Scorecard?
          </div>
          <h2 id="explainer-shelf-heading" className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-white tracking-tight leading-tight">
            One score for every<br />
            <span className="text-gradient">Broadway show</span>
          </h2>
          <p className="mt-4 text-base sm:text-lg text-gray-300 max-w-xl">
            We aggregate every major critic review into a single, weighted score — so you can find the best Broadway shows without reading 20 reviews.
          </p>
        </div>
      </div>

      {/* Breakdown band — score tier visualization + bullets */}
      <div className="px-6 sm:px-10 py-8 sm:py-10 bg-surface-raised">
        <h3 className="text-xl sm:text-2xl font-bold text-white mb-1">The Scorecard Breakdown</h3>
        <p className="text-sm text-gray-400 mb-5">How we turn hundreds of opinions into one number.</p>

        {/* Tier bar — gold on left, red on right (matches show-page ordering) */}
        <div className="flex h-3 rounded-pill overflow-hidden mb-3" role="img" aria-label="Score tier color spectrum from Critical Gold to Critical Miss">
          {tiers.map((t) => (
            <div key={t.label} className="flex-1" style={{ backgroundColor: t.color }} />
          ))}
        </div>
        <div className="flex justify-between text-[10px] sm:text-xs text-gray-500 mb-6 font-medium uppercase tracking-wide">
          <span>83+ Critical Gold</span>
          <span>0 — Critical Miss</span>
        </div>

        {/* Bullets + tier samples */}
        <div className="grid sm:grid-cols-2 gap-6 sm:gap-8">
          <ul className="space-y-3 text-sm sm:text-base text-gray-300">
            <li className="flex gap-3">
              <span className="flex-shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-brand" />
              <span>We collect reviews from <strong className="text-white">{roundedFloor(totalCritics, 50)}+ critics</strong> across <strong className="text-white">{roundedFloor(totalOutlets, 50)}+ outlets</strong> — The New York Times, Vulture, Variety, and every publication that covers Broadway.</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-brand" />
              <span>Each review is normalized to a <strong className="text-white">0–100 score</strong>, then weighted by outlet influence and critic track record.</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-brand" />
              <span>The weighted average becomes one <strong className="text-white">CriticScore</strong> — the same formula for every show, updated daily.</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-brand" />
              <span>{totalShows.toLocaleString('en-US')} shows. {totalReviews.toLocaleString('en-US')} reviews. Free, independent, and not for sale.</span>
            </li>
          </ul>

          {/* Score tier legend with sample badges */}
          <div className="space-y-2">
            {tiers.map((t) => (
              <div key={t.label} className="flex items-center gap-3 px-3 py-2 rounded-badge bg-surface-overlay/50 hover:bg-surface-overlay transition-colors">
                <div
                  className="flex-shrink-0 w-10 h-10 rounded-badge flex items-center justify-center font-extrabold text-base tabular-nums"
                  style={{
                    backgroundColor: `${t.color}33`,
                    color: t.color,
                    boxShadow: t.glow ? `0 0 12px ${t.color}40` : undefined,
                  }}
                >
                  {t.sample}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white truncate">{t.label}</div>
                  <div className="text-xs text-gray-400 truncate">{t.range}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="mt-7 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between pt-6 border-t border-white/5">
          <p className="text-xs sm:text-sm text-gray-400 max-w-md">
            Want the full picture? See exactly which outlets we track, how we weight them, and how we handle stars vs. letters vs. prose.
          </p>
          <Link
            href="/methodology"
            prefetch={false}
            className="inline-flex items-center gap-1 text-sm font-semibold text-brand hover:text-brand-light transition-colors whitespace-nowrap"
          >
            Read the full methodology
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  );
}
