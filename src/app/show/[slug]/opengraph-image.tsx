import { ImageResponse } from 'next/og';
import { pngToOgJpegResponse } from '@/lib/og-jpeg';
import { fetchImageDataUri } from '@/lib/og-image';
import { interFontOption } from '@/lib/og-fonts';
import { getShowBySlug, getHotShowSlugs } from '@/lib/data-core';
import { isCategoryEnabled } from '@/lib/markets';
import { getScoreTier } from '@/components/show-cards';
import { isShowScoreTBD } from '@/lib/show-score-tbd';

export const alt = 'Broadway Scorecard: show score';
export const size = { width: 1200, height: 630 };
// JPEG, not PNG: the hero is a full-bleed photo and PNG encodes it at ~1.2 MB.
// WhatsApp drops link previews whose image is over ~300 KB, so we re-encode
// (see pngToOgJpegResponse) to ~70-80 KB.
export const contentType = 'image/jpeg';

// Match page.tsx revalidate so score updates between deploys propagate to OG
// scrapers (Facebook/Twitter/iMessage) within a day, not stuck on deploy-time.
export const revalidate = 86400;
// Explicit (Next 14 SSR default is true) — closed/historical shows whose
// slugs aren't in getHotShowSlugs() generate their OG on first scrape via ISR
// and then CDN-cache. See getHotShowSlugs() in data-core.ts for the trade-off.
export const dynamicParams = true;

export function generateStaticParams() {
  // Pre-render OG only for open + previews shows (~80) instead of the full
  // 180-day recent set (~474). Trade-off: closed/historical shows hit a cold
  // ISR generation on first social-media scrape (~500ms + a self-call to
  // /_next/image for WebP→JPEG conversion — see fetch() below), then
  // CDN-cache. This trims ~340 MB of build artifacts and ~50-100s of
  // build-time OG render work, at the cost of slightly slower first-scrape
  // for rarely-shared shows. Open/previews shows (highest social-share
  // volume) stay pre-rendered.
  return getHotShowSlugs().map(slug => ({ slug }));
}

// Tier hex values + tier-colored glow — mirrors src/app/globals.css
// .score-must-see / .score-great / .score-good / .score-tepid / .score-skip.
// The shadow uses the tier bg color (rgba) to match the site's glow.
const TIER_STYLE: Record<string, { bg: string; text: string; glow: string }> = {
  'Critical Gold': { bg: '#FFD700', text: '#1a1a1a', glow: 'rgba(255, 215, 0, 0.4)' },
  'Recommended':   { bg: '#22c55e', text: '#ffffff', glow: 'rgba(34, 197, 94, 0.35)' },
  'Worth Seeing':  { bg: '#14b8a6', text: '#ffffff', glow: 'rgba(20, 184, 166, 0.35)' },
  'Mixed':     { bg: '#d97706', text: '#1a1a1a', glow: 'rgba(217, 119, 6, 0.35)' },
  'Critical Miss': { bg: '#ef4444', text: '#ffffff', glow: 'rgba(239, 68, 68, 0.35)' },
};

export default async function OGImage({ params: pendingParams }: { params: Promise<{ slug: string }> }) {
  const params = await pendingParams;
  const show = getShowBySlug(params.slug);

  // Fall back to homepage OG if no show / no image / flag-gated category
  if (!show || !isCategoryEnabled(show.category)) {
    return fallbackImage();
  }

  const imagePath = show.images?.hero || show.images?.poster;
  if (!imagePath) {
    return fallbackImage();
  }

  // The shared /_next/image helper also converts WebP pass-through responses
  // to JPEG so Satori always receives a format it can decode.
  const imageUrl = await fetchImageDataUri(imagePath, 1200);
  if (!imageUrl) {
    console.error('[og] Image fetch failed for', params.slug);
    return fallbackImage();
  }

  // Compute score + tier (only show badge when the show page shows the score:
  // review threshold, previews/upcoming, coverage floor; BRO-5811)
  const rawScore = show.criticScore?.score;
  const hasScore = !isShowScoreTBD(show);
  const score = hasScore ? Math.round(rawScore!) : null;
  const tier = score != null ? getScoreTier(score, show.category) : null;
  const tierStyle = tier ? TIER_STYLE[tier.label] : null;
  const isGold = tier?.label === 'Critical Gold';

  // Must-See gold gradient matches .score-must-see in globals.css (simplified
  // for ImageResponse — multi-stop with border accent).
  const badgeBackground = isGold
    ? 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)'
    : tierStyle?.bg;

  const fontOption = await interFontOption([700]);
  return pngToOgJpegResponse(new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          fontFamily: 'Inter',
          background: '#0f0f14',
        }}
      >
        {/* Keep poster titles visible; only hero photos fill the card. */}
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img
          src={imageUrl}
          width={1200}
          height={630}
          style={{
            width: '100%',
            height: '100%',
            objectFit: show.images?.hero ? 'cover' : 'contain',
          }}
        />

        {/* Score badge overlay — matches MiniShowCard exactly, scaled up.
            Homepage: w-9 (36px) + rounded-lg (8px) + font-bold (700) + text-sm (14px)
                      + box-shadow: 0 2px 8px rgba(tier,0.3) (from globals.css)
            Ratios preserved here at 4× scale (144px box). */}
        {score != null && tierStyle && (
          <div
            style={{
              position: 'absolute',
              bottom: 36,
              right: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 144,
              height: 144,
              borderRadius: 32,
              background: badgeBackground,
              color: tierStyle.text,
              fontSize: 72,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              border: isGold ? '3px solid #C8960E' : 'none',
              boxShadow: isGold
                ? `0 8px 32px ${tierStyle.glow}, 0 0 24px ${tierStyle.glow}`
                : `0 8px 32px ${tierStyle.glow}`,
            }}
          >
            {score}
          </div>
        )}
      </div>
    ),
    { ...size, ...fontOption }
  ));
}

async function fallbackImage(): Promise<Response> {
  const fontOption = await interFontOption([800]);
  return pngToOgJpegResponse(new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f0f14',
          color: '#ffffff',
          fontFamily: 'Inter',
          fontSize: 72,
          fontWeight: 800,
          letterSpacing: '-0.03em',
        }}
      >
        Broadway Scorecard
      </div>
    ),
    { ...size, ...fontOption }
  ));
}
