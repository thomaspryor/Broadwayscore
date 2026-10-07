/**
 * Per-market branding constants — SINGLE SOURCE OF TRUTH.
 *
 * Use these when rendering logos, email headers, or any market-specific brand element.
 * Do NOT hardcode brand colors or logo text elsewhere.
 *
 * CSS/Tailwind: Broadway uses `text-gradient` (gold). West End uses `from-pink-400 to-pink-500`.
 * Email (inline styles): Use the `emailColor` values since CSS gradients don't work in email.
 */

export const MARKET_BRAND = {
  broadway: {
    /** Logo text: first part (white) */
    logoPrefix: 'Broadway',
    /** Logo text: second part (brand color) */
    logoSuffix: 'Scorecard',
    /** Full plain-text name */
    siteName: 'Broadway Scorecard',
    /** Brand color for email inline styles (gold) */
    emailColor: '#d4a574',
    /** Tailwind gradient class for logo suffix */
    gradientClass: 'text-gradient',
  },
  'west-end': {
    logoPrefix: 'West End',
    logoSuffix: 'Scorecard',
    siteName: 'West End Scorecard',
    /** Brand color for email inline styles (pink) */
    emailColor: '#f472b6',
    /** Tailwind gradient class for logo suffix */
    gradientClass: 'bg-gradient-to-r from-pink-400 to-pink-500 bg-clip-text text-transparent',
  },
  'off-broadway': {
    logoPrefix: 'Off-Broadway',
    logoSuffix: 'Scorecard',
    siteName: 'Off-Broadway Scorecard',
    emailColor: '#d4a574',
    gradientClass: 'text-gradient',
  },
} as const;

export type MarketKey = keyof typeof MARKET_BRAND;

/** Get branding for a market, defaulting to Broadway */
export function getMarketBrand(market?: string) {
  return MARKET_BRAND[(market as MarketKey)] || MARKET_BRAND.broadway;
}

/**
 * Social accounts — SINGLE SOURCE OF TRUTH.
 * Rendered in the site footer (FooterBranding) and in the opening-night email (buildSocialRowHtml).
 * Order in this array = display order in UI.
 * Handles pulled from Buffer API on 2026-04-24.
 */
export type SocialPlatform =
  | 'instagram'
  | 'threads'
  | 'bluesky'
  | 'twitter'
  | 'facebook';

export interface SocialAccount {
  platform: SocialPlatform;
  /** Human-readable handle without leading @ (e.g. "bwayscorecard") */
  handle: string;
  /** Full URL used in href */
  url: string;
  /** aria-label / alt text */
  label: string;
}

export const SOCIAL_ACCOUNTS: readonly SocialAccount[] = [
  {
    platform: 'instagram',
    handle: 'bwayscorecard',
    url: 'https://instagram.com/bwayscorecard',
    label: 'Instagram',
  },
  {
    platform: 'threads',
    handle: 'bwayscorecard',
    url: 'https://threads.net/@bwayscorecard',
    label: 'Threads',
  },
  {
    platform: 'bluesky',
    handle: 'bwayscorecard.bsky.social',
    url: 'https://bsky.app/profile/bwayscorecard.bsky.social',
    label: 'Bluesky',
  },
  {
    platform: 'twitter',
    handle: 'BwayScorecard',
    url: 'https://x.com/BwayScorecard',
    label: 'X (formerly Twitter)',
  },
  {
    platform: 'facebook',
    handle: 'BroadwayScorecard',
    url: 'https://facebook.com/BroadwayScorecard',
    label: 'Facebook',
  },
] as const;
