'use client';

import Link from 'next/link';

/**
 * <SocialPulseCard> — renders the "SOCIALS SCORECARD" card on show pages.
 *
 * Data source: public/data/shows/{show-id}.social.json (a SIBLING file to
 * the main show JSON, intentionally separate to avoid race conditions with
 * the nightly rebuild).
 *
 * Returns null for:
 *   - missing payload (show never scraped)
 *   - feature flag off (NEXT_PUBLIC_SOCIAL_PULSE !== 'true')
 *   - tier === 'Hidden' (below MIN_MENTIONS_FOR_CARD threshold)
 */

// Compact schema written by fetch-social-pulse.js + compute-social-pulse-ranks.js
export interface SocialPulsePayload {
  _v: number;
  t: 'Buzzing' | 'Rising' | 'Steady' | 'Troubled' | 'BuildingBaseline' | 'Hidden';
  v: number;              // v3: TRUE weekly mention total (uncapped counters); v2: capped-sample count
  ev?: number;            // effective volume — Pulse Index ranking strength (schema v3, 2026-07)
  p: number;              // positive %, 0-100
  os?: number;            // opinion-bearing sample size behind `p` (schema v3)
  wow: number | null;     // week-over-week %
  bm?: number | null;     // baseline multiple (legacy, may be null)
  pl: {
    x: number;            // classified-sample counts per platform (posts we read),
    tt: number;           //   NOT true volume — see `c` for counters
    ig: number;
    r?: number;           // Reddit sample count (schema v2+)
    bs?: number;          // Bluesky sample count (schema v3)
  };
  /**
   * Weekly COUNTERS — true uncapped volume per signal (schema v3).
   * null/missing = signal absent that week. Different units from `pl`
   * (which counts sampled posts) — the v2 `xv` precedent, generalized.
   */
  c?: {
    r: number | null;     // Reddit posts this week
    bs: number | null;    // Bluesky mentions this week (hitsTotal, 7-day window)
    x: number | null;     // X tweets this week (free counts API, at-risk)
    wv: number | null;    // Wikipedia article views this week (index input, not displayed)
  };
  xv?: number;            // legacy v2: true X volume (superseded by c.x)
  q: Array<{ t: string; p: string; a: string | null; u: string | null }>;
  u: string;              // updated ISO date
  r?: string;             // rank string like "3/42 Broadway" (top-level, NOT to be confused with pl.r)
}

interface SocialPulseCardProps {
  sp: SocialPulsePayload | null | undefined;
}

// ---------- Tier display config ----------

interface TierDisplay {
  label: string;
  emoji: string;
  /** Hex for the tier color (used for inline styles where dynamic values matter) */
  color: string;
  textColor: string;
  /** Tailwind classes for static elements */
  bgClass: string;
  borderClass: string;
  textClass: string;
  /** Subtitle line under the tier label */
  subtitle: string;
}

const TIER_DISPLAY: Record<SocialPulsePayload['t'], TierDisplay | null> = {
  Buzzing: {
    label: 'BUZZING',
    emoji: '🔥',
    color: '#f97316',
    textColor: '#ffffff',
    bgClass: 'bg-orange-500/10',
    borderClass: 'border-orange-500/40',
    textClass: 'text-orange-400',
    subtitle: 'Trending hot right now',
  },
  Rising: {
    label: 'RISING',
    emoji: '📈',
    color: '#10b981',
    textColor: '#ffffff',
    bgClass: 'bg-emerald-500/10',
    borderClass: 'border-emerald-500/40',
    textClass: 'text-emerald-400',
    subtitle: 'Picking up momentum',
  },
  Steady: {
    label: 'STEADY',
    emoji: '⚪',
    color: '#3b82f6',
    textColor: '#ffffff',
    bgClass: 'bg-blue-500/10',
    borderClass: 'border-blue-500/40',
    textClass: 'text-blue-400',
    subtitle: 'Consistent buzz',
  },
  Troubled: {
    label: 'TROUBLED',
    emoji: '💔',
    color: '#ef4444',
    textColor: '#ffffff',
    bgClass: 'bg-red-500/10',
    borderClass: 'border-red-500/40',
    textClass: 'text-red-400',
    subtitle: 'Negative chatter outweighs positive',
  },
  BuildingBaseline: {
    // Legacy state — old data files may still have this. Now treated as Steady.
    label: 'STEADY',
    emoji: '⚪',
    color: '#3b82f6',
    textColor: '#ffffff',
    bgClass: 'bg-blue-500/10',
    borderClass: 'border-blue-500/40',
    textClass: 'text-blue-400',
    subtitle: 'Consistent buzz',
  },
  Hidden: null, // never rendered
};

// ---------- Brand-colored platform icons ----------
//
// Real brand colors. X is white-on-black, TikTok uses cyan + magenta accent,
// Instagram uses the warm gradient. These render at 18px so the icons feel
// like the right visual weight next to the count text.

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-label="X">
      <rect width="24" height="24" rx="4" fill="#000000" />
      <path
        fill="#ffffff"
        d="M17.95 5.5h2.213l-4.835 5.527 5.687 7.516h-4.453l-3.488-4.561-3.992 4.561H6.864l5.171-5.913L6.55 5.5h4.567l3.154 4.17zm-.776 11.731h1.226L9.875 6.708H8.559z"
      />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-label="TikTok">
      <rect width="24" height="24" rx="4" fill="#000000" />
      {/* Magenta back-shadow */}
      <path
        fill="#ff0050"
        d="M17.5 8.4c-1.13 0-2.13-.6-2.7-1.5v6.7c0 2.65-2.15 4.8-4.8 4.8a4.8 4.8 0 1 1 0-9.6c.18 0 .35.02.5.04v2.4a2.4 2.4 0 1 0 1.9 2.36V4h2.4a3.6 3.6 0 0 0 2.7 3.5z"
      />
      {/* Cyan front-shadow, offset */}
      <path
        fill="#00f2ea"
        d="M18.1 7.8c-1.13 0-2.13-.6-2.7-1.5V13c0 2.65-2.15 4.8-4.8 4.8a4.8 4.8 0 1 1 0-9.6c.18 0 .35.02.5.04v2.4a2.4 2.4 0 1 0 1.9 2.36V3.4h2.4a3.6 3.6 0 0 0 2.7 3.5z"
      />
      {/* White foreground (the actual recognizable note) */}
      <path
        fill="#ffffff"
        d="M17.8 8.1c-1.13 0-2.13-.6-2.7-1.5v6.7c0 2.65-2.15 4.8-4.8 4.8a4.8 4.8 0 1 1 0-9.6c.18 0 .35.02.5.04v2.4a2.4 2.4 0 1 0 1.9 2.36V3.7h2.4a3.6 3.6 0 0 0 2.7 3.5z"
      />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-label="Instagram">
      <defs>
        <linearGradient id="ig-grad" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#feda75" />
          <stop offset="25%" stopColor="#fa7e1e" />
          <stop offset="50%" stopColor="#d62976" />
          <stop offset="75%" stopColor="#962fbf" />
          <stop offset="100%" stopColor="#4f5bd5" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#ig-grad)" />
      <rect x="5" y="5" width="14" height="14" rx="4" fill="none" stroke="#ffffff" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.4" fill="none" stroke="#ffffff" strokeWidth="1.6" />
      <circle cx="16.4" cy="7.6" r="0.9" fill="#ffffff" />
    </svg>
  );
}

/**
 * Reddit — orange roundrect with white snoo (the Reddit mascot/alien).
 * Matches Reddit's real brand color (#ff4500) and reads distinctly at
 * 18px alongside the other platform icons.
 */
function RedditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-label="Reddit">
      <rect width="24" height="24" rx="4" fill="#ff4500" />
      {/* Snoo body */}
      <circle cx="12" cy="13" r="6" fill="#ffffff" />
      {/* Antenna */}
      <circle cx="16.2" cy="5.6" r="1.3" fill="#ffffff" />
      <line x1="12" y1="7" x2="15.3" y2="6.5" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
      {/* Eyes */}
      <circle cx="9.5" cy="12.2" r="1.1" fill="#ff4500" />
      <circle cx="14.5" cy="12.2" r="1.1" fill="#ff4500" />
      {/* Smile */}
      <path d="M9 15 Q12 17 15 15" stroke="#ff4500" strokeWidth="1.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/**
 * Bluesky — the butterfly on brand blue (#0085ff). Reads distinctly at
 * 18px alongside the other platform icons.
 */
function BlueskyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-label="Bluesky">
      <rect width="24" height="24" rx="4" fill="#0085ff" />
      <path
        fill="#ffffff"
        d="M7.2 5.9c1.7 1.3 3.6 3.9 4.8 5.6 1.2-1.7 3.1-4.3 4.8-5.6 1.2-.9 3.2-1.6 3.2.7 0 .4-.3 3.7-.4 4.2-.5 1.8-2.3 2.3-3.9 2 2.8.5 3.5 2.1 2 3.7-2.9 3-4.2-.8-5.6-3.2-.1-.2-.1-.2-.2 0-1.4 2.4-2.7 6.2-5.6 3.2-1.5-1.6-.8-3.2 2-3.7-1.6.3-3.4-.2-3.9-2-.1-.5-.4-3.8-.4-4.2 0-2.3 2-1.6 3.2-.7z"
      />
    </svg>
  );
}

const PLATFORM_META: Record<string, { Icon: () => JSX.Element; label: string }> = {
  x: { Icon: XIcon, label: 'X' },
  twitter: { Icon: XIcon, label: 'X' },
  tiktok: { Icon: TikTokIcon, label: 'TikTok' },
  instagram: { Icon: InstagramIcon, label: 'Instagram' },
  reddit: { Icon: RedditIcon, label: 'Reddit' },
  bluesky: { Icon: BlueskyIcon, label: 'Bluesky' },
};

/** Min opinion-bearing posts behind the % for the sentiment bar to render. */
const MIN_OPINION_SAMPLE = 10;

// ---------- Helpers ----------

function formatVolume(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString();
}

function formatUpdatedDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * Splits a rank string like "3/42 Broadway" into ["3", "42", "Broadway"].
 * Returns null if the rank doesn't match the expected shape.
 */
function parseRank(r: string | undefined): { position: string; total: string; market: string } | null {
  if (!r) return null;
  const m = /^(\d+)\/(\d+)\s+(.+)$/.exec(r);
  if (!m) return null;
  return { position: m[1], total: m[2], market: m[3] };
}

/**
 * Calculates a relative "rank tier" from position/total — used to color the
 * rank badge. Top 20% = gold-ish, top 40% = orange, then desaturating.
 */
function rankBadgeColor(position: number, total: number): { bg: string; text: string } {
  if (total === 0) return { bg: '#374151', text: '#9ca3af' };
  const percentile = position / total;
  if (percentile <= 0.1) return { bg: '#f59e0b', text: '#1f2937' }; // top 10% — gold
  if (percentile <= 0.2) return { bg: '#f97316', text: '#ffffff' }; // top 20% — orange
  if (percentile <= 0.4) return { bg: '#10b981', text: '#ffffff' }; // top 40% — emerald
  if (percentile <= 0.6) return { bg: '#3b82f6', text: '#ffffff' }; // middle — blue
  return { bg: '#475569', text: '#cbd5e1' };                       // lower — slate
}

// ---------- Main component ----------

export default function SocialPulseCard({ sp }: SocialPulseCardProps) {
  // Feature flag gate. The env var is statically inlined at build time by
  // Next.js because it's NEXT_PUBLIC_*, so this check is essentially free.
  if (process.env.NEXT_PUBLIC_SOCIAL_PULSE !== 'true') return null;

  if (!sp) return null;
  if (sp.t === 'Hidden') return null;

  const display = TIER_DISPLAY[sp.t];
  if (!display) return null;

  const rank = parseRank(sp.r);
  const rankColors = rank
    ? rankBadgeColor(parseInt(rank.position, 10), parseInt(rank.total, 10))
    : null;

  // Market-aware trending link: /trending for Broadway, /west-end/trending for London
  const trendingHref = rank?.market === 'West End' ? '/west-end/trending' : '/trending';
  const posBarWidth = Math.max(0, Math.min(100, sp.p));

  // Sentiment bar: colorblind-safe blue→brand gradient. The fill WIDTH
  // is the primary signal (wider = more positive). Color reinforces but
  // does not carry the signal alone — safe for deuteranopia/protanopia.
  const sentimentBarStyle = {
    width: `${posBarWidth}%`,
    background: 'linear-gradient(90deg, #6366f1 0%, #3b82f6 50%, #10b981 100%)',
    backgroundSize: `${(100 / Math.max(posBarWidth, 1)) * 100}% 100%`,
  };

  // Platform breakdown row.
  // Schema v3: `c` holds TRUE weekly counters per platform — show those.
  // (Wikipedia views feed the ranking index but aren't mentions, so they
  // don't get a row.) Legacy v2 files fall back to the old sample-count
  // behavior until the first v3 run overwrites them.
  const isV3 = !!sp.c;
  const platformEntries: Array<{ key: string; count: number }> = (
    isV3
      ? [
          { key: 'reddit', count: sp.c?.r || 0 },
          { key: 'bluesky', count: sp.c?.bs || 0 },
          { key: 'x', count: sp.c?.x || 0 },
        ]
      : [
          { key: 'reddit', count: sp.pl.r || 0 },
          { key: 'x', count: sp.xv || sp.pl.x || 0 },
          { key: 'tiktok', count: sp.pl.tt || 0 },
          { key: 'instagram', count: sp.pl.ig || 0 },
        ]
  ).filter((p) => p.count > 0);

  // Sentiment bar renders only with a meaningful opinion sample behind the
  // percentage (v3 samples are smaller than the old capped X sample; a
  // 3-post "67% positive" must not ship). v2 files lack `os` — keep showing.
  const showSentiment = sp.os === undefined || sp.os >= MIN_OPINION_SAMPLE;

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby="socials-scorecard-heading">
      {/* Unified scorecard chrome */}
      <header className="flex items-center justify-between gap-3 mb-4">
        <h2 id="socials-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
          Socials Scorecard
        </h2>
        <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">
          last 7 days
        </span>
      </header>

      {/* Hero block: rank badge (LEFT) + tier label (RIGHT). Outer colored
          frame dropped — the rank-badge tile and the tier-colored label
          supply the color, matching the audience-card hero treatment. */}
      <div className="mb-4">
        <div className="flex items-stretch gap-4">
          {/* Rank badge — the AudienceGrade-style scorecard square. Linked to
              the full /trending leaderboard so the badge itself becomes a
              second entry point (beyond the footer link) for the discovery
              loop. `no-underline` prevents the global `a { text-decoration }`
              from leaking onto the big white rank number. */}
          {rank && rankColors ? (
            <Link
              href={trendingHref}
              title="Rank blends mention volume across the platforms shown (relevance-weighted) with positive sentiment — not raw mention count alone."
              aria-label={`Ranked ${rank.position} of ${rank.total} in ${rank.market} social buzz — see all trending shows`}
              className="shrink-0 flex flex-col items-center justify-center rounded-lg px-3 py-2 min-w-[72px] shadow-sm no-underline transition-transform hover:-translate-y-0.5"
              style={{
                backgroundColor: rankColors.bg,
                color: rankColors.text,
                boxShadow: `0 2px 12px ${rankColors.bg}40`,
              }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider opacity-80">Rank</div>
              <div className="text-3xl font-extrabold leading-none mt-0.5">#{rank.position}</div>
              <div className="text-[11px] font-medium opacity-90 mt-0.5">of {rank.total}</div>
            </Link>
          ) : (
            // Fallback when rank is suppressed (small market) — show emoji badge
            <div
              className="shrink-0 flex items-center justify-center rounded-lg w-[72px] h-[72px] text-4xl"
              style={{ backgroundColor: display.color + '22' }}
              aria-hidden="true"
            >
              {display.emoji}
            </div>
          )}

          {/* Right side: tier label + market context + supporting stats */}
          <div className="flex-1 min-w-0 flex flex-col justify-center">
            <div className="flex items-center gap-2">
              <span className={`text-xl sm:text-2xl font-bold ${display.textClass}`}>
                {display.label}
              </span>
              <span className="text-xl" aria-hidden="true">{display.emoji}</span>
            </div>
            <div className="text-sm text-gray-400 mt-1">
              {rank ? (
                <>
                  in <span className="font-semibold text-gray-300">{rank.market}</span>{' '}
                  social buzz
                </>
              ) : (
                display.subtitle
              )}
            </div>
          </div>
        </div>

        {/* Sentiment bar — full-width, colorful, prominent. Hidden when the
            opinion sample behind the % is too thin to be meaningful. */}
        {showSentiment ? (
          <div className="mt-4">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-sm font-semibold text-gray-200" title="Percentage of opinion-bearing posts that are positive. Neutral/informational posts are excluded.">{sp.p}% positive</span>
              <span className="text-xs text-gray-500">{formatVolume(sp.v)} mentions this week</span>
            </div>
            <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={sentimentBarStyle} />
            </div>
          </div>
        ) : (
          <div className="mt-4 flex items-baseline justify-end">
            <span className="text-xs text-gray-500">{formatVolume(sp.v)} mentions this week</span>
          </div>
        )}
      </div>

      {/* Platform breakdown with brand-colored logos */}
      {platformEntries.length > 0 && (
        <div className="flex items-center gap-4 sm:gap-5 mb-4 flex-wrap">
          {platformEntries.map(({ key, count }) => {
            const meta = PLATFORM_META[key];
            if (!meta) return null;
            const { Icon } = meta;
            return (
              <div key={key} className="flex items-center gap-2">
                <Icon />
                <span className="text-sm font-semibold text-gray-200">{formatVolume(count)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Top quotes */}
      {sp.q && sp.q.length > 0 && (
        <div className="space-y-2.5 mb-3">
          {sp.q.map((quote, i) => {
            const meta = PLATFORM_META[quote.p];
            return (
              <div key={i} className="text-sm text-gray-300 leading-relaxed">
                <span className="text-gray-500">&ldquo;</span>
                {quote.t}
                <span className="text-gray-500">&rdquo;</span>{' '}
                <span className="text-xs text-gray-500 inline-flex items-center gap-1.5 ml-1">
                  —{' '}
                  {meta && (
                    <span className="inline-block scale-75 -my-1">
                      <meta.Icon />
                    </span>
                  )}
                  {quote.a || meta?.label || quote.p}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer: discovery link to the full leaderboard + refresh metadata.
          Anatomy matches the audience/critic/awards/boxoffice/commercial
          family — gold link with arrow, separator, lowercase faint meta. */}
      <div className="mt-1.5 -mb-1 sm:-mb-2 flex items-center justify-between gap-4 flex-wrap">
        <Link
          href={trendingHref}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover transition-colors group"
        >
          <span>See all trending shows</span>
          <span className="inline-block transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
        </Link>
        <span
          className="text-[11px] text-gray-500 lowercase"
          title={isV3 ? 'Mentions are real weekly counts across Reddit, Bluesky and X. Rank and tier blend those counts (relevance-weighted) with sentiment. Methodology updated July 2026.' : undefined}
        >
          updated {formatUpdatedDate(sp.u)} · refreshed weekly
        </span>
      </div>
    </section>
  );
}
