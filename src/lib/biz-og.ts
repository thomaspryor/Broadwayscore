/**
 * Link-preview images for the Profitability Scorecard (BRO-6149). The PNGs in
 * public/og/biz/ are rendered by scripts/generate-biz-og-images.js from
 * public/og/biz.html; every card is evergreen (no figures).
 */
import { existsSync } from 'fs';
import path from 'path';
import { BASE_URL } from '@/lib/seo';

const OG_DIR = path.join(process.cwd(), 'public', 'og', 'biz');

function card(slug: string, alt: string) {
  return { url: `${BASE_URL}/og/biz/${slug}.png`, width: 1200, height: 630, alt };
}

/** The /biz card, or one of the topic pages' (slug = the route segment). */
export function bizOgImage(slug: 'home' | 'musicals-since-reopening' | 'reviews-and-money' | 'fastest-recoups' | 'biggest-flops' | 'tony-winners' | 'stunt-casting', alt: string) {
  return card(slug, alt);
}

/**
 * A season page's card. A season that appeared after the last
 * generate-biz-og-images run gets the generic season card, never a 404.
 */
export function seasonOgImage(season: string) {
  const label = `${season.slice(0, 4)}–${season.slice(7)}`;
  if (/^\d{4}-\d{4}$/.test(season) && existsSync(path.join(OG_DIR, `season-${season}.png`))) {
    return card(`season-${season}`, `The ${label} Broadway season: Profitability Scorecard`);
  }
  return card('season', 'Profitability Scorecard: every Broadway season, show by show');
}
