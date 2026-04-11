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
  'off-west-end': {
    logoPrefix: 'Off-West End',
    logoSuffix: 'Scorecard',
    siteName: 'Off-West End Scorecard',
    /** Brand color for email inline styles (violet) */
    emailColor: '#a78bfa',
    gradientClass: 'bg-gradient-to-r from-violet-400 to-violet-500 bg-clip-text text-transparent',
  },
} as const;

export type MarketKey = keyof typeof MARKET_BRAND;

/** Get branding for a market, defaulting to Broadway */
export function getMarketBrand(market?: string) {
  return MARKET_BRAND[(market as MarketKey)] || MARKET_BRAND.broadway;
}
