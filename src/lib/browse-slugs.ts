/**
 * Browse-page slug mapping. Single source of truth for "given a market +
 * format, which /browse/* page lists that pool?"
 *
 * Used by:
 *   - src/app/show/[slug]/page.tsx — breadcrumb and structured data
 *   - src/components/show-page/WhereItRanks.tsx — rank-cell link targets
 *
 * Note: plays land on `best-broadway-dramas` (not `best-broadway-plays`)
 * because the historical browse page slug uses "dramas". Both pages exist
 * in src/config/browse-pages.ts, but `dramas` is what shows.json's breadcrumb
 * has linked to since 2025 — we keep that as the canonical mapping for
 * intra-site consistency.
 */

import type { ComputedShow } from '@/lib/data-types';
import { getSeasonForDate } from '../../scripts/lib/broadway-seasons';

/**
 * Returns null for `opera` and `special` (concerts, galas, immersive
 * experiences, cabaret, dance) — no browse page lists those pools yet, and
 * the binary `isMusical` check used to silently fall through to the
 * plays/dramas page, which is wrong for a concert or opera. Callers must
 * treat null as "no browse page exists" and render the breadcrumb/link
 * unlinked rather than guessing a mismatched destination.
 */
export function getBrowseSlug(category: ComputedShow['category'] | undefined, type: ComputedShow['type']): string | null {
  if (type === 'opera' || type === 'special') return null;
  const isMusical = type === 'musical';
  switch (category) {
    case 'west-end': return isMusical ? 'best-west-end-musicals' : 'best-west-end-plays';
    case 'off-west-end': return isMusical ? 'best-off-west-end-musicals' : 'best-off-west-end-plays';
    case 'off-broadway': return isMusical ? 'best-off-broadway-musicals' : 'best-off-broadway-plays';
    default: return isMusical ? 'best-broadway-musicals' : 'best-broadway-dramas';
  }
}

/** "Best of right now" landing per market. Used for Overall rank → openMarket cell. */
export function getBestRightNowSlug(category: ComputedShow['category'] | undefined): string {
  switch (category) {
    case 'west-end': return 'best-west-end-musicals'; // no equivalent "right-now" page; falls back to top-list
    case 'off-broadway': return 'best-off-broadway-shows';
    case 'off-west-end': return 'best-off-west-end-shows';
    default: return 'best-broadway-show-right-now';
  }
}

/** "All-time" landing per market. Used for Overall + CriticScore → allTime cell. */
export function getAllTimeSlug(category: ComputedShow['category'] | undefined): string | null {
  switch (category) {
    case 'broadway': return 'best-broadway-shows-all-time';
    // No all-time pages exist yet for WE / OB / OWE — return null so the cell renders unlinked.
    default: return null;
  }
}

/** Current season's browse slug for the market, e.g. "2024-2025-broadway-season".
 *  Returns null when no equivalent page exists yet (WE/OWE seasons aren't generated
 *  in src/config/browse-pages.ts as of v1). */
export function getSeasonSlug(category: ComputedShow['category'] | undefined, openingDate: string | null | undefined): string | null {
  if (category !== 'broadway' && category !== 'off-broadway') return null;
  // Match the season-slug pattern in src/config/browse-pages.ts:
  // `${firstYear}-${secondYear}-broadway-season`, Jul-Jun. Use the current
  // date as the anchor (not the show's own opening date) since the rank cell
  // links to "this season" — same regardless of which show is being viewed.
  const today = openingDate ?? new Date().toISOString().slice(0, 10);
  // Boundary math lives in scripts/lib/broadway-seasons.js (BRO-2563) — this
  // used to be a second, independent Jul1-Jun30 implementation here that
  // carried the same UTC/local-midnight boundary bug as that file, fixed
  // twice in parallel on 2026-08-30. Delegate instead of re-deriving.
  // Edge-case note (ship-check finding, 2026-08-31): getSeasonForDate's
  // "YYYY-MM-DDT..." matching is looser than this file's old inline regex
  // (any trailing T-suffix is accepted, not just a valid ISO time) — inert
  // today since the only caller (WhereItRanks.tsx) always passes `openingDate:
  // null`, routing through the plain-date branch below, not a datetime string.
  let season: string;
  try {
    season = getSeasonForDate(today);
  } catch {
    return null;
  }
  return `${season}-broadway-season`;
}

/** Display label for the open-market column header. */
export function getMarketLabel(category: ComputedShow['category'] | undefined): string {
  switch (category) {
    case 'broadway': return 'Broadway';
    case 'west-end': return 'West End';
    case 'off-broadway': return 'Off-Broadway';
    case 'off-west-end': return 'Off-West End';
    // Regional was missing, so a regional show fell through to 'Broadway' —
    // the same bare-fallback bug that made the LLM prompts reject regional
    // reviews as wrong_production (scripts/lib/market-label.js, 2026-07-30).
    // Latent today (WhereItRanks returns null for regional, which has no rank
    // pools) but wrong the moment regional gets one.
    case 'regional': return 'Regional';
    default: return 'Broadway';
  }
}
