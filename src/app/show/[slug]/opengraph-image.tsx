import { ImageResponse } from 'next/og';
import { getShowBySlug, getAllShowSlugs } from '@/lib/data-core';
import { getScoreTier } from '@/components/show-cards';
import { isLondonMarket } from '@/lib/venue-classification';
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

// Tier hex values (filled badge variants from globals.css) — kept in sync with
// .score-must-see / .score-great / etc. When scripts/lib/brand-colors.js lands
// from the parallel brand-kit session, swap these for imports.
const TIER_FILL: Record<string, { bg: string; text: string; ring: string }> = {
  'Critical Gold': { bg: '#FFD700', text: '#1a1a1a', ring: '#C8960E' },
  'Recommended':    { bg: '#22c55e', text: '#ffffff', ring: 'rgba(34,197,94,0.4)' },
  'Worth Seeing':   { bg: '#14b8a6', text: '#ffffff', ring: 'rgba(20,184,166,0.4)' },
  'Skippable':      { bg: '#d97706', text: '#1a1a1a', ring: 'rgba(217,119,6,0.4)' },
  'Stay Away':      { bg: '#ef4444', text: '#ffffff', ring: 'rgba(239,68,68,0.4)' },
};

const MARKET_ACCENT: Record<string, string> = {
  'broadway':     '#d4a574', // Gold
  'off-broadway': '#d4a574', // Gold (same family)
  'west-end':     '#f472b6', // Pink
  'off-west-end': '#f472b6', // Pink
};

export default async function OGImage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
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
            fontSize: 48,
            fontWeight: 800,
          }}
        >
          Broadway Scorecard
        </div>
      ),
      size
    );
  }

  const score = show.criticScore?.score;
  const roundedScore = score ? Math.round(score) : null;
  const reviewCount = show.criticScore?.reviewCount || 0;
  const tier = roundedScore ? getScoreTier(roundedScore, show.category) : null;
  const tierName = tier?.label || 'Pending';
  const tierStyle = TIER_FILL[tierName] || { bg: '#6b7280', text: '#ffffff', ring: 'rgba(107,114,128,0.4)' };
  const marketAccent = MARKET_ACCENT[show.category || 'broadway'] || '#d4a574';

  const isLondon = isLondonMarket(show.category);
  const marketLabel =
    show.category === 'off-west-end' ? 'Off-West End' :
    isLondon ? 'West End' :
    show.category === 'off-broadway' ? 'Off-Broadway' :
    'Broadway';

  // Metallic gold effect for Critical Gold (approximation — ImageResponse
  // doesn't render multi-stop gradients perfectly, but a 2-stop diagonal works).
  const isGold = tierName === 'Critical Gold';
  const badgeBackground = isGold
    ? 'linear-gradient(135deg, #DAA520 0%, #FFD700 50%, #DAA520 100%)'
    : tierStyle.bg;

  const title = show.title.length > 45 ? show.title.slice(0, 42) + '…' : show.title;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#0f0f14',
          padding: 64,
          fontFamily: '"Inter", system-ui, sans-serif',
          position: 'relative',
        }}
      >
        {/* Top-left accent bar (market color) */}
        <div
          style={{
            display: 'flex',
            position: 'absolute',
            top: 0,
            left: 0,
            width: 8,
            height: '100%',
            background: marketAccent,
          }}
        />

        {/* Header: BWSC wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 40 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 28,
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '-0.01em',
            }}
          >
            {marketLabel}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 28,
              fontWeight: 700,
              marginLeft: 10,
              background: `linear-gradient(135deg, ${marketAccent} 0%, #b8956a 100%)`,
              backgroundClip: 'text',
              color: 'transparent',
              letterSpacing: '-0.01em',
            }}
          >
            Scorecard
          </div>
        </div>

        {/* Main row: score badge + show info */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            gap: 56,
          }}
        >
          {/* Score badge */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 280,
                height: 280,
                borderRadius: 40,
                background: badgeBackground,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 140,
                fontWeight: 800,
                color: tierStyle.text,
                border: isGold ? `4px solid ${tierStyle.ring}` : 'none',
                boxShadow: isGold
                  ? `0 0 60px rgba(255, 215, 0, 0.4), 0 0 30px rgba(218, 165, 32, 0.3)`
                  : `0 20px 40px rgba(0,0,0,0.4), 0 0 40px ${tierStyle.ring}`,
                letterSpacing: '-0.04em',
              }}
            >
              {roundedScore ?? 'TBD'}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 22,
                fontWeight: 700,
                color: tierStyle.bg,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              {tierName}
            </div>
          </div>

          {/* Show info */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              gap: 24,
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: title.length > 25 ? 72 : 88,
                fontWeight: 800,
                color: '#ffffff',
                lineHeight: 1.05,
                letterSpacing: '-0.03em',
              }}
            >
              {title}
            </div>
            {reviewCount > 0 && (
              <div
                style={{
                  display: 'flex',
                  fontSize: 28,
                  fontWeight: 500,
                  color: '#9ca3af',
                }}
              >
                {reviewCount} {reviewCount === 1 ? 'critic' : 'critics'} weighed in
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 32,
            paddingTop: 24,
            borderTop: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <div style={{ display: 'flex', fontSize: 22, color: '#9ca3af', fontWeight: 500 }}>
            broadwayscorecard.com
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              color: marketAccent,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Critic Score
          </div>
        </div>
      </div>
    ),
    size
  );
}
