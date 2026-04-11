'use client';

/**
 * <SocialPulseCard> — renders the "Social Buzz" card on show pages.
 *
 * Data source: public/data/shows/{show-id}.social.json (a SIBLING file to
 * the main show JSON, intentionally separate to avoid race conditions with
 * the nightly rebuild — see generate-mobile-show-details.js comment).
 *
 * The parent show page fetches both files at build time and passes the
 * social-pulse payload (or null) as a prop. The card returns null for:
 *   - missing payload (show never scraped)
 *   - feature flag off (NEXT_PUBLIC_SOCIAL_PULSE !== 'true')
 *   - tier === 'Hidden' (below MIN_MENTIONS_FOR_CARD threshold)
 */

// Compact schema written by fetch-social-pulse.js. Short keys keep the
// per-show payload tiny (<1KB typical).
export interface SocialPulsePayload {
  _v: number;
  t: 'Buzzing' | 'Rising' | 'Steady' | 'Troubled' | 'BuildingBaseline' | 'Hidden';
  v: number;              // volume (relevant mention count)
  p: number;              // positive %, 0-100
  wow: number | null;     // week-over-week %
  bm: number | null;      // baseline multiple (e.g., 2.8)
  pl: {                   // platform breakdown
    x: number;
    tt: number;
    ig: number;
  };
  q: Array<{              // top quotes (0-2 items)
    t: string;            // quote text
    p: string;            // platform
    a: string | null;     // author handle
    u: string | null;     // post URL
  }>;
  u: string;              // updated ISO date
  r?: string;             // rank string like "3/33 Broadway"
}

interface SocialPulseCardProps {
  sp: SocialPulsePayload | null | undefined;
}

// ---------- Tier display config ----------

interface TierDisplay {
  label: string;
  emoji: string;
  /** Tailwind classes for the tier badge color scheme */
  bgClass: string;
  borderClass: string;
  textClass: string;
  /** Sentiment bar color */
  barClass: string;
}

const TIER_DISPLAY: Record<SocialPulsePayload['t'], TierDisplay | null> = {
  Buzzing: {
    label: 'BUZZING',
    emoji: '🔥',
    bgClass: 'bg-orange-500/10',
    borderClass: 'border-orange-500/30',
    textClass: 'text-orange-400',
    barClass: 'bg-orange-500',
  },
  Rising: {
    label: 'RISING',
    emoji: '📈',
    bgClass: 'bg-emerald-500/10',
    borderClass: 'border-emerald-500/30',
    textClass: 'text-emerald-400',
    barClass: 'bg-emerald-500',
  },
  Steady: {
    label: 'STEADY',
    emoji: '😐',
    bgClass: 'bg-blue-500/10',
    borderClass: 'border-blue-500/30',
    textClass: 'text-blue-400',
    barClass: 'bg-blue-500',
  },
  Troubled: {
    label: 'TROUBLED',
    emoji: '💔',
    bgClass: 'bg-red-500/10',
    borderClass: 'border-red-500/30',
    textClass: 'text-red-400',
    barClass: 'bg-red-500',
  },
  BuildingBaseline: {
    label: 'BUILDING BASELINE',
    emoji: '⏳',
    bgClass: 'bg-gray-500/10',
    borderClass: 'border-gray-500/30',
    textClass: 'text-gray-400',
    barClass: 'bg-gray-500',
  },
  Hidden: null, // never rendered
};

// ---------- Platform icons ----------

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.1z" />
    </svg>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
    </svg>
  );
}

const PLATFORM_META: Record<string, { Icon: (props: { className?: string }) => JSX.Element; label: string }> = {
  x: { Icon: XIcon, label: 'X' },
  twitter: { Icon: XIcon, label: 'X' },
  tiktok: { Icon: TikTokIcon, label: 'TikTok' },
  instagram: { Icon: InstagramIcon, label: 'Instagram' },
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
 * Builds the tier subtitle — short status line under the tier label.
 * Different per tier to communicate the right thing:
 *   - Buzzing/Rising/Troubled: baseline comparison (e.g., "▲ 2.8× 8-week average")
 *   - Steady: "Running at typical volume"
 *   - BuildingBaseline: "Not enough history yet"
 */
function buildTierSubtitle(sp: SocialPulsePayload): string {
  if (sp.t === 'Steady') return 'Running at typical volume';
  if (sp.t === 'BuildingBaseline') return 'Not enough history yet';
  if (sp.bm != null) {
    const arrow = sp.bm >= 1 ? '▲' : '▼';
    return `${arrow} ${sp.bm.toFixed(1)}× 8-week average`;
  }
  if (sp.wow != null) {
    const arrow = sp.wow >= 0 ? '▲' : '▼';
    return `${arrow} ${Math.abs(sp.wow)}% vs last week`;
  }
  return '';
}

// ---------- Main component ----------

export default function SocialPulseCard({ sp }: SocialPulseCardProps) {
  // Feature flag gate. The env var is statically inlined at build time by
  // Next.js because it's NEXT_PUBLIC_*, so this check is essentially free.
  if (process.env.NEXT_PUBLIC_SOCIAL_PULSE !== 'true') return null;

  // No data — show never scraped, or still BuildingBaseline and we chose
  // to hide until mature. Here we render BuildingBaseline as a muted card.
  if (!sp) return null;
  if (sp.t === 'Hidden') return null;

  const display = TIER_DISPLAY[sp.t];
  if (!display) return null;

  const posBarWidth = Math.max(0, Math.min(100, sp.p));
  const subtitle = buildTierSubtitle(sp);

  const platformEntries: Array<{ key: string; count: number }> = [
    { key: 'x', count: sp.pl.x || 0 },
    { key: 'tiktok', count: sp.pl.tt || 0 },
    { key: 'instagram', count: sp.pl.ig || 0 },
  ].filter((p) => p.count > 0);

  return (
    <div className="card p-5 sm:p-6 mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          Social Buzz
        </h2>
        <span className="text-xs text-gray-500">last 7 days</span>
      </div>

      {/* Tier badge */}
      <div className={`rounded-xl p-4 border mb-4 ${display.bgClass} ${display.borderClass}`}>
        <div className="flex items-center gap-3">
          <div className="text-3xl leading-none" aria-hidden="true">
            {display.emoji}
          </div>
          <div className="min-w-0">
            <div className={`text-lg font-bold ${display.textClass}`}>{display.label}</div>
            {subtitle && <div className="text-sm text-gray-400">{subtitle}</div>}
          </div>
        </div>
      </div>

      {/* Stats row: volume + positive % + rank */}
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div>
          <span className="text-2xl font-bold text-white">{formatVolume(sp.v)}</span>{' '}
          <span className="text-sm text-gray-400">mentions</span>
          <span className="text-sm text-gray-500 mx-1">·</span>
          <span className="text-sm text-gray-300">{sp.p}% positive</span>
        </div>
        {sp.r && <div className="text-xs text-gray-500 shrink-0">#{sp.r}</div>}
      </div>

      {/* Sentiment bar */}
      <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden mb-4">
        <div
          className={`h-full rounded-full transition-all ${display.barClass}`}
          style={{ width: `${posBarWidth}%` }}
        />
      </div>

      {/* Platform breakdown */}
      {platformEntries.length > 0 && (
        <div className="flex items-center gap-3 sm:gap-4 text-xs text-gray-400 mb-4 flex-wrap">
          {platformEntries.map(({ key, count }) => {
            const meta = PLATFORM_META[key];
            if (!meta) return null;
            const { Icon } = meta;
            return (
              <div key={key} className="flex items-center gap-1.5">
                <Icon className="text-gray-500" />
                <span>{formatVolume(count)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Top quotes */}
      {sp.q && sp.q.length > 0 && (
        <div className="space-y-2 mb-3">
          {sp.q.map((quote, i) => {
            const meta = PLATFORM_META[quote.p];
            return (
              <div key={i} className="text-sm text-gray-300 leading-relaxed">
                <span className="text-gray-500">&ldquo;</span>
                {quote.t}
                <span className="text-gray-500">&rdquo;</span>{' '}
                <span className="text-xs text-gray-500 inline-flex items-center gap-1">
                  —{' '}
                  {meta && <meta.Icon className="text-gray-600 inline" />}
                  {quote.a || meta?.label || quote.p}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-gray-500 pt-2 border-t border-white/5">
        Updated {formatUpdatedDate(sp.u)} · weekly
      </div>
    </div>
  );
}
