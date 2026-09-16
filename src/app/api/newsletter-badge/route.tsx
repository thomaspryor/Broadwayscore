import { ImageResponse } from '@vercel/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

// Renders the newsletter's score badges (BRO-1392) as flat PNGs instead of
// styled <div>s. Gmail iOS dark mode force-inverts the newsletter's dark
// design to a light background; badge backgrounds resist inversion but badge
// TEXT color still flips, breaking contrast per badge. No CSS hardening can
// stop this — Gmail repaints AFTER any of our color-scheme/[data-ogsc] rules
// apply (see scripts/newsletter/generate.mjs). A raster image is immune:
// Gmail can't recolor pixels baked into a PNG.
//
// Public + unauthenticated, so colors come from a fixed `tier` ID rather than
// raw CSS strings — mirrors src/app/api/og/route.tsx's SCORE_COLORS
// precedent. Values must stay in sync with scoreTier() in
// scripts/newsletter/generate.mjs (that Node function is canonical; this is
// the edge-runtime render target it points at).
const TIER_COLORS: Record<string, { bg: string; text: string; border?: string }> = {
  gold: { bg: 'linear-gradient(135deg,#DAA520 0%,#FFD700 30%,#FFF0A0 50%,#FFD700 70%,#DAA520 100%)', text: '#1a1a1a', border: '#C8960E' },
  rec: { bg: '#22c55e', text: '#ffffff' },
  worth: { bg: '#14b8a6', text: '#ffffff' },
  skip: { bg: '#d97706', text: '#1a1a1a' },
  miss: { bg: '#ef4444', text: '#ffffff' },
};
const TBD_COLORS: { bg: string; text: string; border?: string } = { bg: '#2a2a38', text: '#9ca3af' };

// BRO-3555 — same bug class as BRO-1392 (Gmail iOS dark mode inverts CSS
// text color against a bg it can't invert), for the two other badge shapes
// in the newsletter that used a colored <div> + separately-styled text:
// Social Buzz rank boxes (rankBadgeColor()) and Awards Score Movers rings
// (awardBadgeBox()/awardTierColor()) in scripts/newsletter/generate.mjs.
// Fixed tables here mirror TIER_COLORS above — a `tierId` selects a row,
// never raw colors, on this public unauthenticated endpoint.
const RANK_COLORS: Record<string, { bg: string; text: string }> = {
  top10: { bg: '#f59e0b', text: '#1f2937' },
  top20: { bg: '#f97316', text: '#ffffff' },
  top40: { bg: '#10b981', text: '#ffffff' },
  top60: { bg: '#3b82f6', text: '#ffffff' },
  rest: { bg: '#475569', text: '#cbd5e1' },
  none: { bg: '#374151', text: '#9ca3af' },
};

// Award ring badge keeps a fixed translucent fill + white text (matches the
// original awardBadgeBox() div); only the ring color varies by tier.
const AWARD_RING_COLORS: Record<string, string> = {
  sweeper: '#D4AF37',
  decorated: '#B8B8B8',
  honored: '#C2773A',
  'in-the-hunt': '#9ca3af',
  nominated: '#6b7280',
  eligible: '#4b5563',
};
const AWARD_FILL = 'rgba(255,255,255,0.03)';
const AWARD_TEXT = '#ffffff';

// Server-side render scale for retina sharpness — the <img> tag pins
// width/height to the nominal CSS `size`, so this only affects pixel density.
const RENDER_SCALE = 2;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw == null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const kind = sp.get('kind');

  if (kind === 'rank') {
    const rawId = sp.get('tier');
    const tierId = rawId && Object.prototype.hasOwnProperty.call(RANK_COLORS, rawId) ? rawId : 'none';
    const colors = RANK_COLORS[tierId];
    const position = clampInt(sp.get('pos'), NaN, 1, 999);
    const label = Number.isFinite(position) ? `#${position}` : '#?';
    const size = clampInt(sp.get('size'), 36, 8, 200);
    const fontSize = clampInt(sp.get('fontSize'), Math.round(size * 0.4), 4, 120);
    const radius = clampInt(sp.get('radius'), 8, 0, 100);
    const px = size * RENDER_SCALE;
    return new ImageResponse(
      (
        <div
          style={{
            width: px,
            height: px,
            borderRadius: radius * RENDER_SCALE,
            background: colors.bg,
            color: colors.text,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: fontSize * RENDER_SCALE,
            fontWeight: 800,
          }}
        >
          {label}
        </div>
      ),
      { width: px, height: px }
    );
  }

  if (kind === 'award') {
    const rawId = sp.get('tier');
    const tierId = rawId && Object.prototype.hasOwnProperty.call(AWARD_RING_COLORS, rawId) ? rawId : 'eligible';
    const ring = AWARD_RING_COLORS[tierId];
    const scoreRaw = clampInt(sp.get('score'), NaN, 0, 999);
    const label = Number.isFinite(scoreRaw) && scoreRaw > 0 ? String(scoreRaw) : '—';
    const size = clampInt(sp.get('size'), 40, 8, 200);
    const fontSize = clampInt(sp.get('fontSize'), Math.round(size * 0.36), 4, 120);
    const px = size * RENDER_SCALE;
    return new ImageResponse(
      (
        <div
          style={{
            width: px,
            height: px,
            borderRadius: px,
            background: AWARD_FILL,
            color: AWARD_TEXT,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: fontSize * RENDER_SCALE,
            fontWeight: 700,
            border: `${2 * RENDER_SCALE}px solid ${ring}`,
          }}
        >
          {label}
        </div>
      ),
      { width: px, height: px }
    );
  }

  const tierId = sp.get('tier');
  // hasOwnProperty guard, not a bare `TIER_COLORS[tierId]` truthy check —
  // `?tier=__proto__`/`constructor`/`toString` etc. otherwise resolves to an
  // inherited Object.prototype value (truthy, but with no bg/text of its
  // own), defeating the "malformed input -> safe TBD fallback" contract on
  // this public, unauthenticated endpoint (ship-check catch).
  const tier = tierId && Object.prototype.hasOwnProperty.call(TIER_COLORS, tierId) ? TIER_COLORS[tierId] : null;
  const scoreRaw = clampInt(sp.get('score'), NaN, 0, 999);
  const hasScore = tier != null && Number.isFinite(scoreRaw);
  const label = hasScore ? String(scoreRaw) : 'TBD';

  const size = clampInt(sp.get('size'), 64, 8, 200);
  const fontSize = clampInt(sp.get('fontSize'), Math.round(size * 0.42), 4, 120);
  const radius = clampInt(sp.get('radius'), 12, 0, 100);

  // Colors track hasScore, not just tier — `?tier=gold` with no/garbage
  // `score` used to render a gold-colored box that read "TBD", a confusing
  // hybrid state (ship-check catch). Any malformed request now falls all the
  // way back to the plain gray TBD styling.
  const colors = hasScore && tier ? tier : TBD_COLORS;
  const px = size * RENDER_SCALE;

  return new ImageResponse(
    (
      <div
        style={{
          width: px,
          height: px,
          borderRadius: radius * RENDER_SCALE,
          background: colors.bg,
          color: colors.text,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: fontSize * RENDER_SCALE,
          fontWeight: 800,
          // satori calls .trim() on `border` unconditionally while resolving
          // styles, so an explicit `undefined` here (as opposed to omitting
          // the key) throws "Cannot read properties of undefined (reading
          // 'trim')" and crashes the render — only ever surfaced on non-gold
          // tiers, since gold is the only one that sets a real border string.
          border: colors.border ? `${2 * RENDER_SCALE}px solid ${colors.border}` : '0px solid transparent',
        }}
      >
        {label}
      </div>
    ),
    { width: px, height: px }
  );
}
