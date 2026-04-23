import { ImageResponse } from 'next/og';
import { getShowBySlug, getAllShowSlugs } from '@/lib/data-core';
import { getScoreTier } from '@/components/show-cards';
import { hasEnoughReviews } from '@/config/score-buckets';
import { BASE_URL, toAbsoluteUrl } from '@/lib/seo';
import type { ComputedShow } from '@/lib/data-types';

export const alt = 'Broadway Scorecard — show score';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export function generateStaticParams() {
  const allSlugs = getAllShowSlugs();
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
  const allShows = allSlugs
    .map(slug => getShowBySlug(slug))
    .filter(Boolean) as ComputedShow[];
  return allShows
    .filter(s =>
      s.status === 'open' || s.status === 'previews' ||
      (s.closingDate != null && new Date(s.closingDate) > sixMonthsAgo)
    )
    .map(s => ({ slug: s.slug }));
}

// Tier hex values + tier-colored glow — mirrors src/app/globals.css
// .score-must-see / .score-great / .score-good / .score-tepid / .score-skip.
// The shadow uses the tier bg color (rgba) to match the site's glow.
const TIER_STYLE: Record<string, { bg: string; text: string; glow: string }> = {
  'Critical Gold': { bg: '#FFD700', text: '#1a1a1a', glow: 'rgba(255, 215, 0, 0.4)' },
  'Recommended':   { bg: '#22c55e', text: '#ffffff', glow: 'rgba(34, 197, 94, 0.35)' },
  'Worth Seeing':  { bg: '#14b8a6', text: '#ffffff', glow: 'rgba(20, 184, 166, 0.35)' },
  'Skippable':     { bg: '#d97706', text: '#1a1a1a', glow: 'rgba(217, 119, 6, 0.35)' },
  'Critical Miss': { bg: '#ef4444', text: '#ffffff', glow: 'rgba(239, 68, 68, 0.35)' },
};

export default async function OGImage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  // Fall back to homepage OG if no show / no image
  if (!show) {
    return fallbackImage();
  }

  const imagePath = show.images?.hero || show.images?.poster;
  if (!imagePath) {
    return fallbackImage();
  }

  // Satori/@vercel/og can't decode WebP. Route through Next.js's /_next/image
  // optimizer (returns JPEG to non-webp clients), then fetch as a buffer and
  // embed as a base64 data URI so Satori gets a format it understands.
  // w=1200 at q=75 keeps base64 payload under ~500KB (Satori chokes on larger).
  const optimizedUrl = `${BASE_URL}/_next/image?url=${encodeURIComponent(imagePath)}&w=1200&q=75`;

  let imageUrl: string;
  try {
    const res = await fetch(optimizedUrl, { headers: { Accept: 'image/jpeg,image/png,*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Only JPEG/PNG are reliable in Satori. Anything else → fallback.
    const contentType = res.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png)$/.test(contentType)) {
      throw new Error(`unsupported content-type: ${contentType}`);
    }
    imageUrl = `data:${contentType};base64,${buf.toString('base64')}`;
  } catch (err) {
    console.error('[og] Image fetch failed for', params.slug, err instanceof Error ? err.message : err);
    return fallbackImage();
  }

  // Compute score + tier (only show badge if enough reviews)
  const rawScore = show.criticScore?.score;
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  const hasScore = rawScore != null && hasEnoughReviews(reviewCount, show.category, t1t2);
  const score = hasScore ? Math.round(rawScore!) : null;
  const tier = score != null ? getScoreTier(score, show.category) : null;
  const tierStyle = tier ? TIER_STYLE[tier.label] : null;
  const isGold = tier?.label === 'Critical Gold';

  // Must-See gold gradient matches .score-must-see in globals.css (simplified
  // for ImageResponse — multi-stop with border accent).
  const badgeBackground = isGold
    ? 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)'
    : tierStyle?.bg;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          background: '#0f0f14',
        }}
      >
        {/* Full-bleed show image */}
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img
          src={imageUrl}
          width={1200}
          height={630}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
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
    size
  );
}

function fallbackImage() {
  return new ImageResponse(
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
          fontSize: 72,
          fontWeight: 800,
          letterSpacing: '-0.03em',
        }}
      >
        Broadway Scorecard
      </div>
    ),
    size
  );
}
