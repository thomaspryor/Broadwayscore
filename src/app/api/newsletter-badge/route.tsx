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
const TBD_COLORS = { bg: '#2a2a38', text: '#9ca3af' };

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
  const tierId = sp.get('tier');
  const tier = tierId && TIER_COLORS[tierId] ? TIER_COLORS[tierId] : null;
  const scoreRaw = clampInt(sp.get('score'), NaN, 0, 999);
  const label = tier && Number.isFinite(scoreRaw) ? String(scoreRaw) : 'TBD';

  const size = clampInt(sp.get('size'), 64, 8, 200);
  const fontSize = clampInt(sp.get('fontSize'), Math.round(size * 0.42), 4, 120);
  const radius = clampInt(sp.get('radius'), 12, 0, 100);

  const colors = tier || TBD_COLORS;
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
          border: tier?.border ? `${2 * RENDER_SCALE}px solid ${tier.border}` : '0px solid transparent',
        }}
      >
        {label}
      </div>
    ),
    { width: px, height: px }
  );
}
