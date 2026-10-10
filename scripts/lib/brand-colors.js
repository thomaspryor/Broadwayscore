/**
 * brand-colors.js — Single source of truth for BWSC brand colors.
 *
 * Canonical values mirror tailwind.config.ts and src/app/globals.css.
 * When updating a color, update ALL THREE places:
 *   1. This file
 *   2. tailwind.config.ts
 *   3. src/app/globals.css
 *
 * Consumers:
 *   - scripts/lib/email-templates.js (transactional + broadcast emails)
 *   - src/app/api/og/route.tsx (dynamic OG images)
 *   - public/brand-tokens.json (generated — see scripts/generate-brand-tokens.js)
 *   - src/app/brand/page.tsx (/brand public palette page)
 */

const BRAND_COLORS = {
  surface: {
    default: '#0f0f14',   // Page background
    raised: '#1a1a24',    // Cards, panels
    overlay: '#2a2a38',   // Hover states, popovers
    elevated: '#32323f',  // Modals, dropdowns
  },

  brand: {
    gold: '#d4a574',       // Primary brand
    goldHover: '#c4956a',  // Hover state
    goldLight: '#e4b584',  // Light variant
    goldMuted: 'rgba(212, 165, 116, 0.2)',
  },

  market: {
    broadway: '#d4a574',    // Gold
    westEnd: '#f472b6',     // Pink (pink-400)
    westEndDeep: '#ec4899', // Pink-500 for gradient stop
    offBroadway: '#d4a574', // Gold (same as Broadway)
  },

  // Score tier BADGE colors (used by .score-* CSS classes — what users actually see on scores)
  scores: {
    mustSee: {
      label: 'Critical Gold',
      range: '83-100',
      gradient: 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)',
      solid: '#FFD700',
      border: '#C8960E',
      text: '#1a1a1a',
    },
    great: {
      label: 'Recommended',
      range: '75-82',
      solid: '#22c55e',
      text: '#ffffff',
    },
    good: {
      label: 'Worth Seeing',
      range: '65-74',
      solid: '#14b8a6',
      text: '#ffffff',
    },
    tepid: {
      label: 'Skippable',
      range: '55-64',
      solid: '#d97706',
      text: '#1a1a1a',
    },
    skip: {
      label: 'Critical Miss',
      range: '0-54',
      solid: '#ef4444',
      text: '#ffffff',
    },
    pending: {
      label: 'Pending',
      range: 'null',
      solid: '#6b7280',
      text: '#9ca3af',
    },
  },

  // Text accent colors (used with bg-*/20 opacity for softer displays)
  accents: {
    amber: '#fbbf24',    // Gold text
    emerald: '#34d399',  // Green text
    sky: '#38bdf8',      // Blue text
    orange: '#f97316',   // Orange text
    red: '#f87171',      // Red text
    purple: '#a855f7',   // Purple (previews, special)
    cream: '#f5e6d3',    // Warm accent
  },

  text: {
    primary: '#ffffff',
    secondary: '#d1d5db', // gray-300
    muted: '#9ca3af',     // gray-400
    faint: '#6b7280',     // gray-500
    veryFaint: '#4b5563', // gray-600
  },

  status: {
    open: '#10b981',
    openBg: 'rgba(16, 185, 129, 0.2)',
    closed: '#6b7280',
    closedBg: 'rgba(107, 114, 128, 0.2)',
    previews: '#a855f7',
    previewsBg: 'rgba(168, 85, 247, 0.2)',
  },

  font: {
    family: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    familyShort: 'Inter, sans-serif',
    name: 'Inter',
    weights: {
      regular: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
    },
  },

  gradients: {
    brand: 'linear-gradient(135deg, #d4a574 0%, #b8956a 100%)',
    dark: 'linear-gradient(180deg, #1a1a24 0%, #0f0f14 100%)',
    westEnd: 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)',
  },
};

module.exports = BRAND_COLORS;
module.exports.default = BRAND_COLORS;
