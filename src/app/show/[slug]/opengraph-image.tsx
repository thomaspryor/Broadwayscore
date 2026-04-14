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

// Tier hex values — mirror src/app/globals.css .score-must-see / .score-great / etc.
// Used for the homepage-shelf-style score badge overlay.
const TIER_STYLE: Record<string, { bg: string; text: string }> = {
  'Critical Gold': { bg: '#FFD700', text: '#1a1a1a' },
  'Recommended':   { bg: '#22c55e', text: '#ffffff' },
  'Worth Seeing':  { bg: '#14b8a6', text: '#ffffff' },
  'Skippable':     { bg: '#d97706', text: '#1a1a1a' },
  'Stay Away':     { bg: '#ef4444', text: '#ffffff' },
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

        {/* Score badge overlay — bottom-right, styled like MiniShowCard */}
        {score != null && tierStyle && (
          <div
            style={{
              position: 'absolute',
              bottom: 32,
              right: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 140,
              height: 140,
              borderRadius: 20,
              background: badgeBackground,
              color: tierStyle.text,
              fontSize: 80,
              fontWeight: 800,
              letterSpacing: '-0.04em',
              border: isGold ? '4px solid #C8960E' : 'none',
              boxShadow: isGold
                ? '0 0 40px rgba(255, 215, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.4)'
                : '0 8px 24px rgba(0, 0, 0, 0.5)',
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
