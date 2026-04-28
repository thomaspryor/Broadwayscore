import { NextResponse } from 'next/server';
import { getShowBySlug, getAllShowSlugs } from '@/lib/data-core';
import { getScoreTier } from '@/components/show-cards';
import { hasEnoughReviews, isCriticalGold } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';
import type { ComputedShow } from '@/lib/data-types';

// Pre-render one SVG per show at build time; CDN-cached until next deploy.
// Since BWSC deploys multiple times a day, badges stay within ~24h of current.
export const dynamic = 'force-static';

export function generateStaticParams() {
  const allSlugs = getAllShowSlugs();
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
  const shows = allSlugs.map(slug => getShowBySlug(slug)).filter(Boolean) as ComputedShow[];
  return shows
    .filter(s =>
      s.status === 'open' || s.status === 'previews' ||
      (s.closingDate != null && new Date(s.closingDate) > sixMonthsAgo)
    )
    .map(s => ({ slug: s.slug }));
}

// Tier hex values mirror globals.css + opengraph-image.tsx.
const TIER_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  'Critical Gold': { bg: '#FFD700', text: '#1a1a1a', label: 'Critical Gold' },
  'Recommended':   { bg: '#22c55e', text: '#ffffff', label: 'Recommended' },
  'Worth Seeing':  { bg: '#14b8a6', text: '#ffffff', label: 'Worth Seeing' },
  'Skippable':     { bg: '#d97706', text: '#1a1a1a', label: 'Skippable' },
  'Critical Miss': { bg: '#ef4444', text: '#ffffff', label: 'Critical Miss' },
};

const CARD_BG = '#0f0f14';
const CARD_BORDER = '#ffffff1a';
const MUTED_TEXT = '#9ca3af';
const BRAND_GOLD = '#d4a574';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSvg(opts: {
  score: number | null;
  tierLabel: string;
  tierBg: string;
  tierText: string;
  tierStroke: string | null; // gold border
  reviewCount: number;
  isGold: boolean;
  isTbd: boolean;
}): string {
  const { score, tierLabel, tierBg, tierText, tierStroke, reviewCount, isGold, isTbd } = opts;
  const scoreText = isTbd ? 'TBD' : String(score);
  const scoreFontSize = isTbd ? 28 : 44;
  const metaText = isTbd ? 'Not enough reviews yet' : `${reviewCount} critic${reviewCount === 1 ? '' : 's'}`;

  // Gold gradient for Critical Gold badge (matches .score-must-see in globals.css).
  const goldDefs = isGold ? `
    <defs>
      <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#DAA520"/>
        <stop offset="30%" stop-color="#FFD700"/>
        <stop offset="50%" stop-color="#FFF0A0"/>
        <stop offset="70%" stop-color="#FFD700"/>
        <stop offset="100%" stop-color="#DAA520"/>
      </linearGradient>
    </defs>` : '';

  const badgeFill = isGold ? 'url(#gold)' : tierBg;
  const badgeStroke = tierStroke ? `stroke="${tierStroke}" stroke-width="2"` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 100" width="280" height="100" role="img" aria-label="${escapeXml(tierLabel)} — ${escapeXml(scoreText)} out of 100 CriticScore">
${goldDefs}
  <rect x="0.5" y="0.5" width="279" height="99" rx="12" fill="${CARD_BG}" stroke="${CARD_BORDER}"/>
  <rect x="10" y="10" width="80" height="80" rx="12" fill="${badgeFill}" ${badgeStroke}/>
  <text x="50" y="${isTbd ? 60 : 66}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-weight="700" font-size="${scoreFontSize}" fill="${tierText}" letter-spacing="-0.03em">${scoreText}</text>
  <text x="105" y="36" font-family="Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-weight="700" font-size="16" fill="${tierBg === '#FFD700' ? '#FFD700' : tierBg}">${escapeXml(tierLabel)}</text>
  <text x="105" y="56" font-family="Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-weight="400" font-size="12" fill="${MUTED_TEXT}">${escapeXml(metaText)}</text>
  <text x="105" y="82" font-family="Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-weight="600" font-size="9" fill="${BRAND_GOLD}" letter-spacing="0.5">CRITICSCORE™ BY BROADWAY SCORECARD</text>
</svg>`;
}

const CACHE_HEADERS = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  // CDN: public cache for 1 hour, stale-while-revalidate for 24h.
  // Badges always refresh on each deploy via force-static rebuild.
  'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
  // Allow any origin to embed as <img>.
  'Access-Control-Allow-Origin': '*',
};

function notFoundSvg(): Response {
  const svg = buildSvg({
    score: null,
    tierLabel: 'Not Found',
    tierBg: '#2a2a38',
    tierText: MUTED_TEXT,
    tierStroke: null,
    reviewCount: 0,
    isGold: false,
    isTbd: true,
  });
  return new Response(svg, {
    status: 404,
    headers: { ...CACHE_HEADERS, 'Cache-Control': 'public, max-age=60' },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: { slug: string } }
): Promise<Response> {
  // Accept both `/api/badge/proof-2026` and `/api/badge/proof-2026.svg`.
  const slug = params.slug.replace(/\.svg$/i, '');

  const show = getShowBySlug(slug);
  if (!show) return notFoundSvg();

  const rawScore = show.criticScore?.score;
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  const enoughReviews = hasEnoughReviews(reviewCount, show.category, t1t2, CURATED_HISTORICAL_SHOWS.has(show.id));
  const isPreviewsOrUpcoming = show.status === 'previews' || show.status === 'upcoming';
  const isTbd = !enoughReviews || isPreviewsOrUpcoming || rawScore == null;

  let tierBg = '#2a2a38';
  let tierText = MUTED_TEXT;
  let tierLabel = 'TBD';
  let isGold = false;

  if (!isTbd && rawScore != null) {
    const rounded = Math.round(rawScore);
    const tier = getScoreTier(rounded, show.category);
    if (tier) {
      const style = TIER_STYLE[tier.label];
      if (style) {
        tierBg = style.bg;
        tierText = style.text;
        tierLabel = style.label;
      }
      isGold = isCriticalGold(rounded, show.category);
    }
  }

  const score = isTbd ? null : Math.round(rawScore!);
  const tierStroke = isGold ? '#C8960E' : null;

  const svg = buildSvg({
    score,
    tierLabel,
    tierBg,
    tierText,
    tierStroke,
    reviewCount,
    isGold,
    isTbd,
  });

  return new Response(svg, { status: 200, headers: CACHE_HEADERS });
}
