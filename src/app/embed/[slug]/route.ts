import { getShowBySlug } from '@/lib/data-core';
import { getScoreTier } from '@/components/show-cards';
import { hasEnoughReviews, isCriticalGold } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';
import { BASE_URL } from '@/lib/seo';

// Server-render each request so ?theme= query params actually vary the output.
// Edge-cached for 1 hour via Cache-Control below — effectively static after the
// first hit per (slug, theme) combination.
export const dynamic = 'force-dynamic';

const TIER_STYLE: Record<string, { bg: string; text: string; glow: string }> = {
  'Critical Gold': { bg: '#FFD700', text: '#1a1a1a', glow: 'rgba(255, 215, 0, 0.4)' },
  'Recommended':   { bg: '#22c55e', text: '#ffffff', glow: 'rgba(34, 197, 94, 0.35)' },
  'Worth Seeing':  { bg: '#14b8a6', text: '#ffffff', glow: 'rgba(20, 184, 166, 0.35)' },
  'Skippable':     { bg: '#d97706', text: '#1a1a1a', glow: 'rgba(217, 119, 6, 0.35)' },
  'Critical Miss': { bg: '#ef4444', text: '#ffffff', glow: 'rgba(239, 68, 68, 0.35)' },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtml(opts: {
  title: string;
  score: number | null;
  tierLabel: string;
  reviewCount: number;
  showUrl: string;
  isTbd: boolean;
  isGold: boolean;
  tierStyle: { bg: string; text: string; glow: string };
  variant: 'auto' | 'light' | 'dark';
}): string {
  const { title, score, tierLabel, reviewCount, showUrl, isTbd, isGold, tierStyle, variant } = opts;
  const badgeBg = isGold
    ? 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)'
    : tierStyle.bg;
  const badgeBorder = isGold ? '2px solid #C8960E' : 'none';
  const badgeShadow = isGold
    ? `0 0 20px ${tierStyle.glow}, 0 0 10px rgba(255, 215, 0, 0.3)`
    : `0 4px 14px ${tierStyle.glow}`;
  const scoreText = isTbd ? 'TBD' : String(score);
  const scoreFontSize = isTbd ? 22 : 34;
  const metaLine = isTbd
    ? 'Not enough reviews yet'
    : `${escapeHtml(tierLabel)} · ${reviewCount} critic${reviewCount === 1 ? '' : 's'}`;

  // Light / dark / auto mode.
  const cardBg = variant === 'light' ? '#ffffff' : '#0f0f14';
  const cardBorder = variant === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.1)';
  const titleColor = variant === 'light' ? '#0f0f14' : '#ffffff';
  const mutedColor = variant === 'light' ? '#6b7280' : '#9ca3af';
  const hoverBg = variant === 'light' ? 'rgba(0, 0, 0, 0.03)' : 'rgba(255, 255, 255, 0.04)';

  const autoStyles = variant === 'auto' ? `
    @media (prefers-color-scheme: light) {
      .embed-card { background: #ffffff; border-color: rgba(0,0,0,0.08); }
      .embed-title { color: #0f0f14; }
      .embed-meta { color: #6b7280; }
      .embed-card:hover { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.16); }
    }
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — CriticScore</title>
<style>
  :root { color-scheme: ${variant === 'light' ? 'light' : variant === 'dark' ? 'dark' : 'light dark'}; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .embed-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px;
    background: ${cardBg};
    border: 1px solid ${cardBorder};
    border-radius: 12px;
    text-decoration: none;
    color: ${titleColor};
    max-width: 360px;
    transition: background 150ms ease, border-color 150ms ease;
  }
  .embed-card:hover {
    background: ${hoverBg};
    border-color: ${variant === 'light' ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.2)'};
  }
  .embed-card:focus-visible {
    outline: 2px solid #d4a574;
    outline-offset: 2px;
  }
  .embed-badge {
    flex-shrink: 0;
    width: 64px;
    height: 64px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: ${scoreFontSize}px;
    letter-spacing: -0.03em;
    background: ${badgeBg};
    color: ${tierStyle.text};
    border: ${badgeBorder};
    box-shadow: ${badgeShadow};
  }
  .embed-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .embed-title {
    font-size: 15px;
    font-weight: 700;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${titleColor};
  }
  .embed-meta { font-size: 12px; color: ${mutedColor}; line-height: 1.3; }
  .embed-attribution {
    font-size: 9px;
    font-weight: 600;
    color: #d4a574;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    margin-top: 2px;
  }
  ${autoStyles}
</style>
</head>
<body>
<a class="embed-card" href="${escapeHtml(showUrl)}" target="_top" rel="noopener">
  <div class="embed-badge" aria-label="Score: ${escapeHtml(scoreText)} out of 100, ${escapeHtml(tierLabel)}">${escapeHtml(scoreText)}</div>
  <div class="embed-body">
    <div class="embed-title">${escapeHtml(title)}</div>
    <div class="embed-meta">${metaLine}</div>
    <div class="embed-attribution">CriticScore™ by Broadway Scorecard</div>
  </div>
</a>
</body>
</html>`;
}

const HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
  // Allow embedding from any origin.
  'Content-Security-Policy': "frame-ancestors *",
};

function notFoundHtml(): Response {
  const html = buildHtml({
    title: 'Show not found',
    score: null,
    tierLabel: 'Not Found',
    reviewCount: 0,
    showUrl: BASE_URL,
    isTbd: true,
    isGold: false,
    tierStyle: { bg: '#2a2a38', text: '#9ca3af', glow: 'rgba(0,0,0,0)' },
    variant: 'auto',
  });
  return new Response(html, {
    status: 404,
    headers: { ...HEADERS, 'Cache-Control': 'public, max-age=60' },
  });
}

export async function GET(
  request: Request,
  { params }: { params: { slug: string } }
): Promise<Response> {
  const url = new URL(request.url);
  const theme = url.searchParams.get('theme');
  const variant: 'auto' | 'light' | 'dark' =
    theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'auto';

  const utmSource = url.searchParams.get('utm_source') || 'embed';
  const utmMedium = url.searchParams.get('utm_medium') || 'badge';
  const utmCampaign = url.searchParams.get('utm_campaign') || 'partner';

  const show = getShowBySlug(params.slug);
  if (!show) return notFoundHtml();

  const rawScore = show.criticScore?.score;
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  const enoughReviews = hasEnoughReviews(reviewCount, show.category, t1t2, CURATED_HISTORICAL_SHOWS.has(show.id));
  const isPreviewsOrUpcoming = show.status === 'previews' || show.status === 'upcoming';
  const isTbd = !enoughReviews || isPreviewsOrUpcoming || rawScore == null;

  let tierStyle = { bg: '#2a2a38', text: '#9ca3af', glow: 'rgba(0,0,0,0)' };
  let tierLabel = 'TBD';
  let isGold = false;

  if (!isTbd && rawScore != null) {
    const rounded = Math.round(rawScore);
    const tier = getScoreTier(rounded, show.category);
    if (tier) {
      tierStyle = TIER_STYLE[tier.label] ?? tierStyle;
      tierLabel = tier.label;
      isGold = isCriticalGold(rounded, show.category);
    }
  }

  const score = isTbd ? null : Math.round(rawScore!);
  const showUrl = `${BASE_URL}/show/${show.slug}?utm_source=${encodeURIComponent(utmSource)}&utm_medium=${encodeURIComponent(utmMedium)}&utm_campaign=${encodeURIComponent(utmCampaign)}`;

  const html = buildHtml({
    title: show.title,
    score,
    tierLabel,
    reviewCount,
    showUrl,
    isTbd,
    isGold,
    tierStyle,
    variant,
  });

  return new Response(html, { status: 200, headers: HEADERS });
}
