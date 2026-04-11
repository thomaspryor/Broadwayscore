'use client';

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
  v: number;              // volume (relevant mention count)
  p: number;              // positive %, 0-100
  wow: number | null;     // week-over-week %
  bm: number | null;      // baseline multiple (legacy, may be null)
  pl: {
    x: number;            // X/Twitter count
    tt: number;           // TikTok count
    ig: number;           // Instagram count
    r?: number;           // Reddit count (schema v2, 2026-04-11 — optional for back-compat with v1 files)
  };
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

const PLATFORM_META: Record<string, { Icon: () => JSX.Element; label: string }> = {
  x: { Icon: XIcon, label: 'X' },
  twitter: { Icon: XIcon, label: 'X' },
  tiktok: { Icon: TikTokIcon, label: 'TikTok' },
  instagram: { Icon: InstagramIcon, label: 'Instagram' },
  reddit: { Icon: RedditIcon, label: 'Reddit' },
};

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
  const posBarWidth = Math.max(0, Math.min(100, sp.p));

  // Sentiment bar gradient: red (negative) → yellow (mixed) → green (positive)
  // The bar fill width represents the positive %.
  const sentimentBarStyle = {
    width: `${posBarWidth}%`,
    background: 'linear-gradient(90deg, #ef4444 0%, #f59e0b 50%, #10b981 100%)',
    backgroundSize: `${(100 / Math.max(posBarWidth, 1)) * 100}% 100%`,
  };

  // Platform breakdown row. Order: Reddit first (primary uncapped signal
  // as of 2026-04-11), then X, TikTok, Instagram. `sp.pl.r` is optional
  // for back-compat with legacy v1 files that predate Reddit.
  const platformEntries: Array<{ key: string; count: number }> = [
    { key: 'reddit', count: sp.pl.r || 0 },
    { key: 'x', count: sp.pl.x || 0 },
    { key: 'tiktok', count: sp.pl.tt || 0 },
    { key: 'instagram', count: sp.pl.ig || 0 },
  ].filter((p) => p.count > 0);

  return (
    <div className="card p-5 sm:p-6 mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          Socials Scorecard
        </h2>
        <span className="text-xs text-gray-500">last 7 days</span>
      </div>

      {/* Hero block: rank badge (LEFT, AudienceGrade-style) + tier label (RIGHT) */}
      <div className={`rounded-xl p-4 sm:p-5 border mb-4 ${display.bgClass} ${display.borderClass}`}>
        <div className="flex items-stretch gap-4">
          {/* Rank badge — the AudienceGrade-style scorecard square */}
          {rank && rankColors ? (
            <div
              className="shrink-0 flex flex-col items-center justify-center rounded-lg px-3 py-2 min-w-[72px] shadow-sm"
              style={{
                backgroundColor: rankColors.bg,
                color: rankColors.text,
                boxShadow: `0 2px 12px ${rankColors.bg}40`,
              }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider opacity-80">Rank</div>
              <div className="text-3xl font-extrabold leading-none mt-0.5">#{rank.position}</div>
              <div className="text-[11px] font-medium opacity-90 mt-0.5">of {rank.total}</div>
            </div>
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

        {/* Sentiment bar — full-width, colorful, prominent */}
        <div className="mt-4">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-sm font-semibold text-gray-200">{sp.p}% positive</span>
            <span className="text-xs text-gray-500">{formatVolume(sp.v)} mentions</span>
          </div>
          <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={sentimentBarStyle} />
          </div>
        </div>
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

      {/* Footer */}
      <div className="text-xs text-gray-500 pt-2 border-t border-white/5">
        Updated {formatUpdatedDate(sp.u)} · refreshed weekly
      </div>
    </div>
  );
}
